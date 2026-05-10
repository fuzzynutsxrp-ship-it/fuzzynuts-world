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

// ── Constants ──

const SCORE_CAPS: Record<string, number> = {
    mario: 99999,
    survivors: 999999,
    minigolf: 10500,
    kaetram: 9999999,
    nutracer: 99999
};

const VALID_GAMES = Object.keys(SCORE_CAPS);
const MIN_DURATION_SEC = 15;
const RATE_LIMIT_MS = 60 * 1000; // 1 submission per minute per wallet per game
const MAX_BODY_SIZE = 2048; // 2KB max request body
const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

// ── Rate limiting state (in-memory) ──

const rateLimits: Map<string, number> = new Map();

function isRateLimited(key: string): boolean {
    const last = rateLimits.get(key);
    if (last && Date.now() - last < RATE_LIMIT_MS) return true;
    rateLimits.set(key, Date.now());
    return false;
}

// Clean up old entries every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_MS * 2;
    for (const [key, time] of rateLimits) {
        if (time < cutoff) rateLimits.delete(key);
    }
}, 5 * 60 * 1000);

// ── Week key calculation (ISO 8601) ──

function getCurrentWeekKey(): string {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function truncateAddress(addr: string): string {
    if (!addr || addr.length < 10) return addr;
    return addr.slice(0, 6) + '...' + addr.slice(-4);
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
            await this.collection.createIndex(
                { wallet: 1, game: 1, weekKey: 1 },
                { unique: true }
            );
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
        response.onAborted(() => { aborted = true; });

        try {
            const query = request.getQuery();
            const params = new URLSearchParams(query);
            const weekKey = params.get('week') || getCurrentWeekKey();
            const game = params.get('game') || null;

            let entries: ScoreEntry[];

            if (game && VALID_GAMES.includes(game)) {
                // Per-game leaderboard
                entries = await this.collection
                    .find({ weekKey, game })
                    .sort({ score: -1 })
                    .limit(20)
                    .toArray();
            } else {
                // All games for the week
                entries = await this.collection
                    .find({ weekKey })
                    .sort({ score: -1 })
                    .limit(100)
                    .toArray();
            }

            // Build response — strip IP addresses
            const leaderboard = entries.map((e, i) => ({
                rank: i + 1,
                wallet: e.wallet,
                name: truncateAddress(e.wallet),
                game: e.game,
                score: e.score,
                weekKey: e.weekKey
            }));

            // Build combined leaderboard if no specific game requested
            let combined: { wallet: string; name: string; total: number; games: Record<string, number> }[] = [];

            if (!game) {
                const playerMap = new Map<string, { total: number; games: Record<string, number> }>();
                for (const e of entries) {
                    const existing = playerMap.get(e.wallet) || { total: 0, games: {} };
                    existing.games[e.game] = e.score;
                    existing.total += e.score;
                    playerMap.set(e.wallet, existing);
                }
                combined = Array.from(playerMap.entries())
                    .map(([wallet, data]) => ({
                        wallet,
                        name: truncateAddress(wallet),
                        total: data.total,
                        games: data.games
                    }))
                    .sort((a, b) => b.total - a.total)
                    .slice(0, 20);
            }

            const responseBody = JSON.stringify({
                ok: true,
                weekKey,
                game: game || 'combined',
                leaderboard: game ? leaderboard : undefined,
                combined: !game ? combined : undefined
            });

            if (!aborted) {
                response.cork(() => {
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(responseBody);
                });
            }
        } catch (error) {
            log.error('[ScoresAPI] GET error:');
            log.error(error);
            if (!aborted) {
                response.cork(() => {
                    response.writeStatus('500 Internal Server Error');
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(JSON.stringify({ ok: false, error: 'internal_error' }));
                });
            }
        }
    }

    // ── POST /api/scores ──

    public handlePost(response: HttpResponse, request: HttpRequest): void {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        const ip = request.getHeader('cf-connecting-ip') || 
                   request.getHeader('x-forwarded-for') || 
                   'unknown';

        // Read body with size limit
        let bodyBuffer = Buffer.alloc(0);

        response.onData((chunk, isLast) => {
            bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(chunk)]);

            if (bodyBuffer.length > MAX_BODY_SIZE) {
                if (!aborted) {
                    response.cork(() => {
                        response.writeStatus('413 Payload Too Large');
                        response.writeHeader('Content-Type', 'application/json');
                        response.writeHeader('Access-Control-Allow-Origin', '*');
                        response.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
                    });
                }
                return;
            }

            if (isLast) {
                this.processSubmission(bodyBuffer.toString(), ip, response, aborted);
            }
        });
    }

    private async processSubmission(
        body: string,
        ip: string,
        response: HttpResponse,
        aborted: boolean
    ): Promise<void> {
        try {
            const data: ScoreSubmission = JSON.parse(body);
            const { game, score, wallet, timestamp, duration } = data;

            // ── Validation ──

            if (!game || !VALID_GAMES.includes(game)) {
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_game' });
            }

            if (typeof score !== 'number' || score <= 0 || !isFinite(score)) {
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_score' });
            }

            if (!wallet || !XRPL_ADDRESS_RE.test(wallet)) {
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_wallet' });
            }

            // Score cap check
            const cap = SCORE_CAPS[game] || 999999;
            if (score > cap) {
                return this.respond(response, aborted, 400, { ok: false, error: 'score_exceeds_cap', cap });
            }

            // Duration check
            if (typeof duration === 'number' && duration < MIN_DURATION_SEC) {
                return this.respond(response, aborted, 400, { ok: false, error: 'duration_too_short' });
            }

            // Timestamp freshness check (must be within 5 minutes)
            if (timestamp && Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
                return this.respond(response, aborted, 400, { ok: false, error: 'timestamp_stale' });
            }

            // Rate limiting: wallet + game
            const rateKey = `${wallet}:${game}`;
            if (isRateLimited(rateKey)) {
                return this.respond(response, aborted, 429, { ok: false, error: 'rate_limited' });
            }

            // IP-based rate limiting
            const ipRateKey = `ip:${ip}`;
            if (isRateLimited(ipRateKey)) {
                return this.respond(response, aborted, 429, { ok: false, error: 'rate_limited' });
            }

            // ── Upsert: keep only best score per wallet+game+week ──

            const weekKey = getCurrentWeekKey();
            const flooredScore = Math.floor(score);

            const existing = await this.collection.findOne({ wallet, game, weekKey });

            if (existing) {
                if (flooredScore > existing.score) {
                    // New high score — update
                    await this.collection.updateOne(
                        { wallet, game, weekKey },
                        { $set: { score: flooredScore, submittedAt: Date.now(), ip } }
                    );
                    log.info(`[ScoresAPI] Updated score: ${wallet} ${game} ${existing.score} → ${flooredScore}`);
                } else {
                    // Existing score is higher — no-op
                    return this.respond(response, aborted, 200, {
                        ok: true,
                        action: 'no_update',
                        currentBest: existing.score,
                        submitted: flooredScore
                    });
                }
            } else {
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
        response.onAborted(() => { aborted = true; });

        try {
            const query = request.getQuery();
            const params = new URLSearchParams(query);
            const wallet = params.get('wallet');

            if (!wallet || !XRPL_ADDRESS_RE.test(wallet)) {
                return this.respond(response, aborted, 400, { ok: false, error: 'invalid_wallet' });
            }

            const rewardsCol = this.database.collection('reward_queue');
            const configCol = this.database.collection('achievement_rewards');

            // Fetch all rewards for this wallet
            const rewards = await rewardsCol
                .find({ wallet })
                .sort({ created_at: -1 })
                .limit(50)
                .toArray();

            // Fetch all active achievement reward configs for display
            const configs = await configCol
                .find({ active: true })
                .toArray();

            const configMap = new Map(configs.map((c: any) => [c.key, c]));

            // Build response — strip internal fields (ip, player_username)
            const rewardList = rewards.map((r: any) => ({
                achievement_id: r.achievement_id,
                achievement_name: (configMap.get(r.achievement_id) as any)?.name || r.achievement_id,
                achievement_desc: (configMap.get(r.achievement_id) as any)?.desc || '',
                amount: r.amount,
                status: r.status,
                tx_hash: r.tx_hash || null,
                unlocked_at: r.created_at,
                paid_at: r.processed_at || null
            }));

            // Available achievements (not yet unlocked by this wallet)
            const unlockedIds = new Set(rewards.map((r: any) => r.achievement_id));
            const available = configs
                .filter((c: any) => !unlockedIds.has(c.key))
                .map((c: any) => ({
                    achievement_id: c.key,
                    name: c.name,
                    desc: c.desc,
                    reward_nut: c.reward_nut
                }));

            const responseBody = JSON.stringify({
                ok: true,
                wallet: truncateAddress(wallet),
                rewards: rewardList,
                available,
                total_earned: rewardList.reduce((sum: number, r: any) => sum + r.amount, 0),
                total_paid: rewardList.filter((r: any) => r.status === 'paid').reduce((sum: number, r: any) => sum + r.amount, 0)
            });

            if (!aborted) {
                response.cork(() => {
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(responseBody);
                });
            }
        } catch (error) {
            log.error('[ScoresAPI] GET /api/rewards error:');
            log.error(error);
            if (!aborted) {
                response.cork(() => {
                    response.writeStatus('500 Internal Server Error');
                    response.writeHeader('Content-Type', 'application/json');
                    response.writeHeader('Access-Control-Allow-Origin', '*');
                    response.end(JSON.stringify({ ok: false, error: 'internal_error' }));
                });
            }
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
        const statusText = status === 200 ? '200 OK' :
                          status === 400 ? '400 Bad Request' :
                          status === 429 ? '429 Too Many Requests' :
                          status === 413 ? '413 Payload Too Large' :
                          '500 Internal Server Error';
        response.cork(() => {
            response.writeStatus(statusText);
            response.writeHeader('Content-Type', 'application/json');
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.end(JSON.stringify(body));
        });
    }
}
