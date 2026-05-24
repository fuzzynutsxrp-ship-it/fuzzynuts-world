/**
 * ═══════════════════════════════════════════════════════════════
 * FUZZYNUTS ARCADE — Scores API
 *
 * Lightweight REST endpoints for the arcade leaderboard.
 * Mounted on the existing uws server alongside the game WS.
 *
 * GET  /api/scores?week=2024-W26&game=mario
 * POST /api/scores  { game, score, wallet, timestamp }
 * ═══════════════════════════════════════════════════════════════
 */

import log from '@kaetram/common/util/log';

import type { Db, Collection } from 'mongodb';
import type { HttpResponse, HttpRequest } from 'uws';

// ── Types ──

interface ScoreEntry {
    wallet: string;
    game: string;
    score: number;
    weekKey: string;
    submittedAt: number;
    ip: string;
}

interface ScoreSubmission {
    game: string;
    score: number;
    wallet: string;
    timestamp: number;
    duration?: number;
}

/* ── Reward collection shapes (handleRewardsGet) ── */

interface RewardConfig {
    key: string;
    name: string;
    desc: string;
    reward_nut: number;
    active: boolean;
}

interface RewardEntry {
    wallet: string;
    achievement_id: string;
    amount: number;
    status: string;
    tx_hash?: string | null;
    created_at: number;
    processed_at?: number | null;
}

// ── Constants ──

// Slug keys MUST match what the iframe's fuzzy-score.js POSTs and what
// the frontend's slugAliases.ts translates to. Frontend canonical slugs
// `fuzzy-survivors` / `nut-racer` get aliased to `survivors` / `racer`
// before the request hits this server.
const SCORE_CAPS: { [key: string]: number } = {
        mario: 99_999,
        survivors: 999_999,
        minigolf: 10_500,
        racer: 99_999,
        'top-secret': 999_999,
        'fuzzynuts-world': 10_000_000
    },
    VALID_GAMES = Object.keys(SCORE_CAPS),
    MIN_DURATION_SEC = 15,
    RATE_LIMIT_MS = 60 * 1000, // 1 submission per minute per wallet per game
    MAX_BODY_SIZE = 2048, // 2KB max request body
    XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
    // ── Rate limiting state (in-memory) ──

    rateLimits: Map<string, number> = new Map();

// ── Anti-bot reward velocity tracker (in-memory) ──
// Tracks reward_queue insertions per wallet per hour. Flags >10/hr for review.

interface VelocityEntry {
    timestamps: number[];
    flagged: boolean;
    flaggedAt?: number;
}

const rewardVelocity: Map<string, VelocityEntry> = new Map(),
    VELOCITY_WINDOW_MS = 60 * 60 * 1000, // 1 hour
    VELOCITY_THRESHOLD = 10; // Max rewards per hour before flagging

/**
 * Record a reward event for velocity tracking. Returns true if the wallet
 * is now flagged (superhuman rate detected).
 */
export function trackRewardVelocity(wallet: string): boolean {
    let now = Date.now(),
        entry = rewardVelocity.get(wallet);
    if (!entry) entry = { timestamps: [], flagged: false };

    // Trim old timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < VELOCITY_WINDOW_MS);
    entry.timestamps.push(now);

    if (entry.timestamps.length > VELOCITY_THRESHOLD && !entry.flagged) {
        entry.flagged = true;
        entry.flaggedAt = now;
        log.warning(
            `[AntiBot] 🚨 Wallet ${wallet} flagged: ${entry.timestamps.length} rewards in 1hr (threshold: ${VELOCITY_THRESHOLD})`
        );
    }

    rewardVelocity.set(wallet, entry);
    return entry.flagged;
}

/**
 * Get all currently flagged wallets for admin review.
 */
export function getFlaggedWallets(): { wallet: string; count: number; flaggedAt: number }[] {
    let flagged: { wallet: string; count: number; flaggedAt: number }[] = [],
        now = Date.now();
    for (let [wallet, entry] of rewardVelocity)
        if (entry.flagged) {
            let recentCount = entry.timestamps.filter((t) => now - t < VELOCITY_WINDOW_MS).length;
            flagged.push({ wallet, count: recentCount, flaggedAt: entry.flaggedAt! });
        }

    return flagged;
}

function isRateLimited(key: string): boolean {
    let last = rateLimits.get(key);
    if (last && Date.now() - last < RATE_LIMIT_MS) return true;
    rateLimits.set(key, Date.now());
    return false;
}

// Clean up old entries every 5 minutes
setInterval(
    () => {
        let cutoff = Date.now() - RATE_LIMIT_MS * 2;
        for (let [key, time] of rateLimits) if (time < cutoff) rateLimits.delete(key);
    },
    5 * 60 * 1000
);

// ── Week key calculation (ISO 8601) ──

function getCurrentWeekKey(): string {
    let now = new Date(),
        d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    let yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)),
        weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function truncateAddress(addr: string): string {
    if (!addr || addr.length < 10) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ── API Handler Class ──

export default class ScoresAPI {
    private collection!: Collection<ScoreEntry>;

    public constructor(private database: Db) {
        this.collection = this.database.collection<ScoreEntry>('arcade_scores');
        this.ensureIndexes();
        log.notice('[ScoresAPI] Arcade scores API initialized.');
    }

    /**
     * Create MongoDB indexes for efficient queries.
     */
    private async ensureIndexes(): Promise<void> {
        try {
            // Compound unique index: one score per wallet+game+week (idempotency)
            await this.collection.createIndex({ wallet: 1, game: 1, weekKey: 1 }, { unique: true });
            // For leaderboard queries
            await this.collection.createIndex({ weekKey: 1, game: 1, score: -1 });
            await this.collection.createIndex({ weekKey: 1, score: -1 });
            log.info('[ScoresAPI] MongoDB indexes created.');
        } catch (error) {
            log.error('[ScoresAPI] Failed to create indexes:');
            log.error(error);
        }
    }

    // ── GET /api/scores ──

    public async handleGet(response: HttpResponse, request: HttpRequest): Promise<void> {
        // uws requires us to cork and handle aborted connections
        let aborted = false;
        response.onAborted(() => {
            aborted = true;
        });

        try {
            let query = request.getQuery(),
                params = new URLSearchParams(query),
                weekKey = params.get('week') || getCurrentWeekKey(),
                game = params.get('game') || null,
                entries: ScoreEntry[];

            if (game && !VALID_GAMES.includes(game))
                // Unknown game slug — return empty list. The previous behavior
                // (falling through to the all-games branch and returning the
                // entire week's combined leaderboard under the unknown slug)
                // caused the frontend to show e.g. mario scores under a
                // `?game=racer` query, which looked like data leakage between
                // games on the per-game leaderboard tabs.
                entries = [];
            else if (game)
                // Per-game leaderboard
                entries = await this.collection
                    .find({ weekKey, game })
                    .sort({ score: -1 })
                    .limit(20)
                    .toArray();
            // No game param — combined leaderboard for the week
            else
                entries = await this.collection
                    .find({ weekKey })
                    .sort({ score: -1 })
                    .limit(100)
                    .toArray();

            // Build response — strip IP addresses
            let leaderboard = entries.map((e, i) => ({
                    rank: i + 1,
                    wallet: e.wallet,
                    name: truncateAddress(e.wallet),
                    game: e.game,
                    score: e.score,
                    weekKey: e.weekKey
                })),
                // Build combined leaderboard if no specific game requested
                combined: {
                    wallet: string;
                    name: string;
                    total: number;
                    games: { [key: string]: number };
                }[] = [];

            if (!game) {
                let playerMap = new Map<
                    string,
                    { total: number; games: { [key: string]: number } }
                >();
                for (let e of entries) {
                    let existing = playerMap.get(e.wallet) || { total: 0, games: {} };
                    existing.games[e.game] = e.score;
                    existing.total += e.score;
                    playerMap.set(e.wallet, existing);
                }
                combined = [...playerMap.entries()]
                    .map(([wallet, data]) => ({
                        wallet,
                        name: truncateAddress(wallet),
                        total: data.total,
                        games: data.games
                    }))
                    .sort((a, b) => b.total - a.total)
                    .slice(0, 20);
            }

            let responseBody = JSON.stringify({
                ok: true,
                weekKey,
                game: game || 'combined',
                leaderboard: game ? leaderboard : undefined,
                combined: game ? undefined : combined
            });

            if (!aborted)
                response.cork(() => {
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(responseBody);
                });
        } catch (error) {
            log.error('[ScoresAPI] GET error:');
            log.error(error);
            if (!aborted)
                response.cork(() => {
                    response.writeStatus('500 Internal Server Error');
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(JSON.stringify({ ok: false, error: 'internal_error' }));
                });
        }
    }

    // ── POST /api/scores ──

    public handlePost(response: HttpResponse, request: HttpRequest): void {
        let aborted = false;
        response.onAborted(() => {
            aborted = true;
        });

        let ip =
                request.getHeader('cf-connecting-ip') ||
                request.getHeader('x-forwarded-for') ||
                'unknown',
            // Read body with size limit
            bodyBuffer = Buffer.alloc(0);

        response.onData((chunk, isLast) => {
            bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(chunk)]);

            if (bodyBuffer.length > MAX_BODY_SIZE) {
                if (!aborted)
                    response.cork(() => {
                        response.writeStatus('413 Payload Too Large');
                        response.writeHeader('Content-Type', 'application/json');
                        response.writeHeader('Access-Control-Allow-Origin', '*');
                        response.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
                    });

                return;
            }

            if (isLast) this.processSubmission(bodyBuffer.toString(), ip, response, aborted);
        });
    }

    private async processSubmission(
        body: string,
        ip: string,
        response: HttpResponse,
        aborted: boolean
    ): Promise<void> {
        try {
            let data: ScoreSubmission = JSON.parse(body),
                { game, score, wallet, timestamp, duration } = data;

            // ── Validation ──

            if (!game || !VALID_GAMES.includes(game))
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_game' });

            if (typeof score !== 'number' || score <= 0 || !isFinite(score))
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_score' });

            if (!wallet || !XRPL_ADDRESS_RE.test(wallet))
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_wallet' });

            // Score cap check
            let cap = SCORE_CAPS[game] || 999_999;
            if (score > cap)
                return this.respond(response, aborted, 400, {
                    ok: false,
                    error: 'score_exceeds_cap',
                    cap
                });

            // Duration check
            if (typeof duration === 'number' && duration < MIN_DURATION_SEC)
                return this.respond(response, aborted, 400, {
                    ok: false,
                    error: 'duration_too_short'
                });

            // Timestamp freshness check (must be within 5 minutes)
            if (timestamp && Math.abs(Date.now() - timestamp) > 5 * 60 * 1000)
                return this.respond(response, aborted, 400, {
                    ok: false,
                    error: 'timestamp_stale'
                });

            // Rate limiting: wallet + game
            let rateKey = `${wallet}:${game}`;
            if (isRateLimited(rateKey))
                return this.respond(response, aborted, 429, { ok: false, error: 'rate_limited' });

            // IP-based rate limiting
            let ipRateKey = `ip:${ip}`;
            if (isRateLimited(ipRateKey))
                return this.respond(response, aborted, 429, { ok: false, error: 'rate_limited' });

            // ── Upsert: keep only best score per wallet+game+week ──

            let weekKey = getCurrentWeekKey(),
                flooredScore = Math.floor(score),
                existing = await this.collection.findOne({ wallet, game, weekKey });

            if (existing)
                if (flooredScore > existing.score) {
                    // New high score — update
                    await this.collection.updateOne(
                        { wallet, game, weekKey },
                        { $set: { score: flooredScore, submittedAt: Date.now(), ip } }
                    );
                    log.info(
                        `[ScoresAPI] Updated score: ${wallet} ${game} ${existing.score} → ${flooredScore}`
                    );
                }
                // Existing score is higher — no-op
                else
                    return this.respond(response, aborted, 200, {
                        ok: true,
                        action: 'no_update',
                        currentBest: existing.score,
                        submitted: flooredScore
                    });
            else {
                // New entry
                await this.collection.insertOne({
                    wallet,
                    game,
                    score: flooredScore,
                    weekKey,
                    submittedAt: Date.now(),
                    ip
                });
                log.info(`[ScoresAPI] New score: ${wallet} ${game} ${flooredScore}`);
            }

            return this.respond(response, aborted, 200, {
                ok: true,
                action: 'saved',
                score: flooredScore,
                weekKey
            });
        } catch (error) {
            log.error('[ScoresAPI] POST processing error:');
            log.error(error);
            return this.respond(response, aborted, 500, { ok: false, error: 'internal_error' });
        }
    }

    // ── OPTIONS /api/scores (CORS preflight) ──

    public handleOptions(response: HttpResponse): void {
        response.cork(() => {
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.writeHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.writeHeader('Access-Control-Max-Age', '86400');
            response.end();
        });
    }

    // ── GET /api/rewards?wallet=rXXX ──

    public async handleRewardsGet(response: HttpResponse, request: HttpRequest): Promise<void> {
        let aborted = false;
        response.onAborted(() => {
            aborted = true;
        });

        try {
            let query = request.getQuery(),
                params = new URLSearchParams(query),
                wallet = params.get('wallet');

            if (!wallet || !XRPL_ADDRESS_RE.test(wallet))
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_wallet' });

            let rewardsCol = this.database.collection<RewardEntry>('reward_queue'),
                configCol = this.database.collection<RewardConfig>('achievement_rewards'),
                // Fetch all rewards for this wallet
                rewards = await rewardsCol
                    .find({ wallet })
                    .sort({ created_at: -1 })
                    .limit(50)
                    .toArray(),
                // Fetch all active achievement reward configs for display
                configs = await configCol.find({ active: true }).toArray(),
                configMap = new Map<string, RewardConfig>(configs.map((c) => [c.key, c])),
                // Build response — strip internal fields (ip, player_username)
                rewardList = rewards.map((r) => ({
                    achievement_id: r.achievement_id,
                    achievement_name: configMap.get(r.achievement_id)?.name || r.achievement_id,
                    achievement_desc: configMap.get(r.achievement_id)?.desc || '',
                    amount: r.amount,
                    status: r.status,
                    tx_hash: r.tx_hash || null,
                    unlocked_at: r.created_at,
                    paid_at: r.processed_at || null
                })),
                // Available achievements (not yet unlocked by this wallet)
                unlockedIds = new Set(rewards.map((r) => r.achievement_id)),
                available = configs
                    .filter((c) => !unlockedIds.has(c.key))
                    .map((c) => ({
                        achievement_id: c.key,
                        name: c.name,
                        desc: c.desc,
                        reward_nut: c.reward_nut
                    })),
                responseBody = JSON.stringify({
                    ok: true,
                    wallet: truncateAddress(wallet),
                    rewards: rewardList,
                    available,
                    total_earned: rewardList.reduce((sum, r) => sum + r.amount, 0),
                    total_paid: rewardList
                        .filter((r) => r.status === 'paid')
                        .reduce((sum, r) => sum + r.amount, 0)
                });

            if (!aborted)
                response.cork(() => {
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(responseBody);
                });
        } catch (error) {
            log.error('[ScoresAPI] GET /api/rewards error:');
            log.error(error);
            if (!aborted)
                response.cork(() => {
                    response.writeStatus('500 Internal Server Error');
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(JSON.stringify({ ok: false, error: 'internal_error' }));
                });
        }
    }

    // ── OPTIONS /api/rewards (CORS preflight) ──

    public handleRewardsOptions(response: HttpResponse): void {
        response.cork(() => {
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.writeHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            response.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.writeHeader('Access-Control-Max-Age', '86400');
            response.end();
        });
    }

    // ── Helper ──

    private respond(response: HttpResponse, aborted: boolean, status: number, body: object): void {
        if (aborted) return;
        let statusText =
            status === 200
                ? '200 OK'
                : status === 400
                ? '400 Bad Request'
                : status === 429
                ? '429 Too Many Requests'
                : status === 413
                ? '413 Payload Too Large'
                : '500 Internal Server Error';
        response.cork(() => {
            response.writeStatus(statusText);
            response.writeHeader('Content-Type', 'application/json');
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.end(JSON.stringify(body));
        });
    }
}
