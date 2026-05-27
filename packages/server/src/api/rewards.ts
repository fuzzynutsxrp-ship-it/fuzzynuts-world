/**
 * ═══════════════════════════════════════════════════════════════
 * FUZZYNUTS ARCADE — Prize Rewards API
 *
 * Endpoints for the Prize Claiming UI on the /profile page.
 * Mounted on the existing uws server alongside scores.ts.
 *
 * GET  /api/rewards/eligibility?wallet=rXXX&week=2026-W20
 * POST /api/rewards/claim       { wallet, week }
 *
 * Uses the same µWebSockets patterns as scores.ts.
 * ═══════════════════════════════════════════════════════════════
 */

import log from '@kaetram/common/util/log';

import type { Db, Collection } from 'mongodb';
import type { HttpResponse, HttpRequest } from 'uws';

// Dynamic import for xrpl — used in health check
let xrplModule: any = null;
try {
    xrplModule = require('xrpl');
} catch {
    // Will be loaded lazily in claim handler
}

// ── Types ──

interface ClaimRecord {
    type: string;
    weekKey: string;
    wallet: string;
    rank: number;
    amount: string;
    usd_value?: number | null;
    snapshot_price?: number | null;
    nut_amount_paid?: string;
    score: number;
    status: string;
    createdAt: Date;
    completedAt?: Date;
    txHash: string | null;
    xrplResult?: string;
    error?: string;
}

interface PrizeDistributionRecord {
    weekKey: string;
    payouts: Array<{
        wallet: string;
        status: string;
        txHash?: string;
    }>;
}

interface UsdTier {
    rank: number;
    usd: number;
    label: string;
}

interface WeeklyTierDoc {
    weekKey: string;
    weekly_prize_usd_tiers: UsdTier[];
    nut_price_snapshot_usd: number;
    snapshot_timestamp: Date;
    calculated_nut_amounts: string[];
    cap_applied: boolean;
    max_weekly_nut_emission: number;
    price_source: string;
}

interface Winner {
    wallet: string;
    total: number;
    rank: number;
    usd_value?: number | null;
    nut_amount?: string | null;
}

// ── Constants ──

const NUT_CURRENCY = 'NUT';
const NUT_ISSUER = 'rpL6HfoV578CAkZoNbm3UEK5BgVY9DxMP7';
const XRPL_SERVERS = [
    'wss://xrplcluster.com',
    'wss://s1.ripple.com',
    'wss://s2.ripple.com'
];
const XRPL_CONNECT_TIMEOUT_MS = 10_000;
const MAX_BODY_SIZE = 2048;

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const WEEK_KEY_RE = /^\d{4}-W\d{2}$/;

// Announced weekly prize values in USD. NUT amounts are computed at snapshot.
const PRIZE_USD_TIERS: UsdTier[] = [
    { rank: 1, usd: Number(process.env.PRIZE_USD_1 || 250), label: '1st Place' },
    { rank: 2, usd: Number(process.env.PRIZE_USD_2 || 150), label: '2nd Place' },
    { rank: 3, usd: Number(process.env.PRIZE_USD_3 || 100), label: '3rd Place' }
];

// Soft cap on total NUT emitted per week (protects the Community Nut Jar). 2x legacy 500k.
const MAX_WEEKLY_NUT_EMISSION = Number(process.env.MAX_WEEKLY_NUT_EMISSION || 1_000_000);

// Price guard: only trust the on-chain AMM price when it is within this fraction
// of the fallback anchor (default 25%). A thin/sniped pool can swing wildly, so
// outside this band we use the controlled fallback price instead.
const MAX_PRICE_DEVIATION = Number(process.env.MAX_PRICE_DEVIATION || 0.25);

// NUT AMM pool counter-asset. Default XRP. For a USD-stable pair set the
// NUT_AMM_COUNTER_* vars and NUT_AMM_COUNTER_IS_XRP=false.
const NUT_AMM_COUNTER_IS_XRP = (process.env.NUT_AMM_COUNTER_IS_XRP ?? 'true') === 'true';
const NUT_AMM_COUNTER_CURRENCY = process.env.NUT_AMM_COUNTER_CURRENCY || '';
const NUT_AMM_COUNTER_ISSUER = process.env.NUT_AMM_COUNTER_ISSUER || '';

// On-chain XRP→USD reference AMM (used only when NUT is XRP-paired). Default RLUSD.
const USD_REF_CURRENCY = process.env.USD_REF_CURRENCY || 'RLUSD';
const USD_REF_ISSUER = process.env.USD_REF_ISSUER || 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

// Off-chain fallback (USD per NUT). Used ONLY if the on-chain AMM query fails.
const NUT_USD_PRICE_FALLBACK = process.env.NUT_USD_PRICE_FALLBACK
    ? Number(process.env.NUT_USD_PRICE_FALLBACK)
    : null;

// Shared secret guarding the announcement-time snapshot endpoint.
const REWARDS_ADMIN_SECRET = process.env.REWARDS_ADMIN_SECRET || '';

// Fixed total supply (for market-cap display on the public price endpoint).
const NUT_TOTAL_SUPPLY = Number(process.env.NUT_TOTAL_SUPPLY || 321_000_000_000);

// Live-price cache so the public /price endpoint doesn't hit XRPL on every hit.
let _priceCache: { price: number; source: string; ts: number } | null = null;
const PRICE_CACHE_MS = 60_000;

// ── Rate limiting for claim endpoint ──

const claimRateLimits: Map<string, number> = new Map();
const CLAIM_RATE_LIMIT_MS = 30 * 1000; // 30s between claim attempts

setInterval(() => {
    const cutoff = Date.now() - CLAIM_RATE_LIMIT_MS * 2;
    for (const [key, time] of claimRateLimits) {
        if (time < cutoff) claimRateLimits.delete(key);
    }
}, 5 * 60 * 1000);

// ── Helpers ──

function getCurrentWeekKey(): string {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// XRPL currency code normalizer: 'XRP' and standard 3-char codes pass through;
// longer human codes (e.g. 'RLUSD') become their 160-bit hex form, which is what
// rippled requires (ASCII 'RLUSD' returns issueMalformed).
function xrplCurrency(code: string): string {
    if (!code || code === 'XRP' || code.length === 3) return code;
    if (/^[0-9A-Fa-f]{40}$/.test(code)) return code.toUpperCase();
    return Buffer.from(code, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
}

// Price of `base` denominated in `counter` from an XRPL AMM pool.
// XRP assets are passed as { currency: 'XRP' } (no issuer).
async function ammPrice(client: any, base: any, counter: any): Promise<number> {
    const info = await client.request({ command: 'amm_info', asset: base, asset2: counter });
    const amm = info.result && info.result.amm;
    if (!amm) throw new Error('amm_info returned no pool');

    const toNum = (x: any) => (typeof x === 'string' ? Number(x) / 1_000_000 : Number(x.value)); // drops→XRP
    const isXrp = (a: any) => a.currency === 'XRP' && !a.issuer;
    const matches = (amt: any, asset: any) =>
        typeof amt === 'string' ? isXrp(asset) : (amt.currency === asset.currency && amt.issuer === asset.issuer);

    const baseAmt = matches(amm.amount, base) ? toNum(amm.amount) : toNum(amm.amount2);
    const counterAmt = matches(amm.amount, base) ? toNum(amm.amount2) : toNum(amm.amount);
    if (!(baseAmt > 0) || !(counterAmt > 0)) throw new Error('Empty AMM reserves');
    return counterAmt / baseAmt; // counter units per 1 base
}

// Primary on-chain NUT/USD price. NUT/XRP × XRP/USD when XRP-paired, else NUT/<stable>.
async function fetchNutUsdPrice(): Promise<{ price: number; source: string }> {
    let xrpl: any;
    try {
        xrpl = require('xrpl');
    } catch {
        throw new Error('xrpl module not available');
    }

    let lastErr = '';
    for (const server of XRPL_SERVERS) {
        const client = new xrpl.Client(server, { connectionTimeout: XRPL_CONNECT_TIMEOUT_MS });
        try {
            await client.connect();
            const NUT = { currency: xrplCurrency(NUT_CURRENCY), issuer: NUT_ISSUER };
            let out: { price: number; source: string };
            if (NUT_AMM_COUNTER_IS_XRP) {
                const nutInXrp = await ammPrice(client, NUT, { currency: 'XRP' }); // XRP per NUT
                const xrpInUsd = await ammPrice(
                    client,
                    { currency: 'XRP' },
                    { currency: xrplCurrency(USD_REF_CURRENCY), issuer: USD_REF_ISSUER }
                ); // USD per XRP
                out = { price: nutInXrp * xrpInUsd, source: `amm:NUT/XRP*XRP/${USD_REF_CURRENCY}` };
            } else {
                const nutInUsd = await ammPrice(
                    client,
                    NUT,
                    { currency: xrplCurrency(NUT_AMM_COUNTER_CURRENCY), issuer: NUT_AMM_COUNTER_ISSUER }
                ); // USD per NUT
                out = { price: nutInUsd, source: `amm:NUT/${NUT_AMM_COUNTER_CURRENCY}` };
            }
            try { await client.disconnect(); } catch { /* noop */ }
            return out;
        } catch (e: any) {
            lastErr = e?.message || 'amm query failed';
            try { await client.disconnect(); } catch { /* noop */ }
        }
    }
    throw new Error(lastErr || 'all XRPL servers failed');
}

// USD tiers → integer NUT amounts (strings), applying the soft emission cap.
function computeNutAmounts(priceUsd: number): { amounts: string[]; capApplied: boolean } {
    const raw = PRIZE_USD_TIERS.map((t) => Math.floor(t.usd / priceUsd));
    const total = raw.reduce((s, n) => s + n, 0);
    let amounts = raw;
    let capApplied = false;
    if (total > MAX_WEEKLY_NUT_EMISSION) {
        const factor = MAX_WEEKLY_NUT_EMISSION / total;
        amounts = raw.map((n) => Math.floor(n * factor));
        capApplied = true;
    }
    return { amounts: amounts.map(String), capApplied };
}

// Live NUT/USD price (raw AMM market price, not the guarded anchor), cached.
async function getLivePriceUsd(): Promise<{ price: number; source: string; cached: boolean }> {
    if (_priceCache && Date.now() - _priceCache.ts < PRICE_CACHE_MS) {
        return { price: _priceCache.price, source: _priceCache.source, cached: true };
    }
    const { price, source } = await fetchNutUsdPrice();
    _priceCache = { price, source, ts: Date.now() };
    return { price, source, cached: false };
}

// ── API Handler Class ──

export default class RewardsAPI {
    private scoresCol!: Collection;
    private prizesCol!: Collection<ClaimRecord>;
    private tiersCol!: Collection;

    public constructor(private database: Db) {
        this.scoresCol = this.database.collection('arcade_scores');
        this.prizesCol = this.database.collection<ClaimRecord>('prize_distributions');
        this.tiersCol = this.database.collection('weekly_prize_tiers');
        this.ensureIndexes();
        log.notice('[RewardsAPI] Prize rewards API initialized.');
    }

    private async ensureIndexes(): Promise<void> {
        try {
            // Unique index: one claim per wallet+week
            await this.prizesCol.createIndex(
                { weekKey: 1, wallet: 1, type: 1 },
                { unique: true, partialFilterExpression: { type: 'individual_claim' } }
            );
            // Unique index: one price snapshot per week
            await this.tiersCol.createIndex({ weekKey: 1 }, { unique: true });
            log.info('[RewardsAPI] MongoDB indexes created.');
        } catch (error) {
            log.error('[RewardsAPI] Failed to create indexes:');
            log.error(error);
        }
    }

    // ── Top 3 Winners for a Week ──

    private async getTopWinners(weekKey: string, snapshot: WeeklyTierDoc | null = null): Promise<Winner[]> {
        const scores = await this.scoresCol.find({ weekKey }).toArray();
        if (scores.length === 0) return [];

        const playerMap = new Map<string, number>();
        for (const entry of scores) {
            if (!entry.wallet) continue;
            const existing = playerMap.get(entry.wallet) || 0;
            playerMap.set(entry.wallet, existing + (entry.score || 0));
        }

        const ranked: Winner[] = Array.from(playerMap.entries())
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 3)
            .map((entry, i) => ({ ...entry, rank: i + 1 }));

        if (!snapshot) return ranked;
        return ranked.map((w) => ({
            ...w,
            usd_value: snapshot.weekly_prize_usd_tiers[w.rank - 1]?.usd ?? null,
            nut_amount: snapshot.calculated_nut_amounts[w.rank - 1] ?? null
        }));
    }

    // ── Weekly Price Snapshot (announcement-time only) ──

    private async getWeeklySnapshot(weekKey: string): Promise<WeeklyTierDoc | null> {
        return (await this.tiersCol.findOne({ weekKey })) as unknown as WeeklyTierDoc | null;
    }

    private async createWeeklySnapshot(weekKey: string, force = false): Promise<WeeklyTierDoc> {
        if (!force) {
            const existing = await this.tiersCol.findOne({ weekKey });
            if (existing) return existing as unknown as WeeklyTierDoc;
        }

        // Resolve price with a deviation guard. A thin/sniped AMM can swing
        // wildly, so we only trust the on-chain price when it is within
        // MAX_PRICE_DEVIATION of the fallback anchor; otherwise we use the
        // controlled fallback. With no fallback set, we trust the AMM (or fail).
        let ammUsd: number | null = null;
        let ammSource = '';
        try {
            const r = await fetchNutUsdPrice();
            ammUsd = r.price;
            ammSource = r.source;
        } catch {
            ammUsd = null;
        }

        const fb = NUT_USD_PRICE_FALLBACK;
        let price: number;
        let source: string;

        if (ammUsd != null && ammUsd > 0 && isFinite(ammUsd)) {
            if (fb != null && fb > 0) {
                const deviation = Math.abs(ammUsd - fb) / fb;
                if (deviation <= MAX_PRICE_DEVIATION) {
                    price = ammUsd;
                    source = ammSource;
                } else {
                    price = fb;
                    source = `fallback:amm-out-of-band(${Math.round(deviation * 100)}%)`;
                }
            } else {
                price = ammUsd;
                source = ammSource;
            }
        } else if (fb != null && fb > 0) {
            price = fb;
            source = 'fallback:env';
        } else {
            throw new Error('no usable price: AMM query failed and no fallback configured');
        }

        if (!(price > 0) || !isFinite(price)) throw new Error('invalid NUT/USD price');

        const { amounts, capApplied } = computeNutAmounts(price);
        const doc: WeeklyTierDoc = {
            weekKey,
            weekly_prize_usd_tiers: PRIZE_USD_TIERS,
            nut_price_snapshot_usd: price,
            snapshot_timestamp: new Date(),
            calculated_nut_amounts: amounts,
            cap_applied: capApplied,
            max_weekly_nut_emission: MAX_WEEKLY_NUT_EMISSION,
            price_source: source
        };

        if (force) await this.tiersCol.replaceOne({ weekKey }, doc as any, { upsert: true });
        else await this.tiersCol.updateOne({ weekKey }, { $setOnInsert: doc as any }, { upsert: true }); // first writer wins
        return (await this.tiersCol.findOne({ weekKey })) as unknown as WeeklyTierDoc;
    }

    private tiersPayload(snapshot: WeeklyTierDoc): Array<{ rank: number; label: string; usd_value: number; nut_amount: string | null }> {
        return snapshot.weekly_prize_usd_tiers.map((t, i) => ({
            rank: t.rank,
            label: t.label,
            usd_value: t.usd,
            nut_amount: snapshot.calculated_nut_amounts[i] ?? null
        }));
    }

    // ── Check if Already Claimed ──

    private async checkClaimed(weekKey: string, wallet: string): Promise<{ claimed: boolean; txHash: string | null }> {
        // Check individual claims
        const individual = await this.prizesCol.findOne({
            weekKey,
            wallet: { $regex: new RegExp(`^${wallet}$`, 'i') },
            type: 'individual_claim',
            status: 'success'
        } as any);

        if (individual) return { claimed: true, txHash: individual.txHash };

        // Check bulk distribution records (from distribute-prizes.js)
        const bulk = await this.prizesCol.findOne({
            weekKey,
            'payouts.wallet': { $regex: new RegExp(`^${wallet}$`, 'i') },
            'payouts.status': 'success'
        } as any) as unknown as PrizeDistributionRecord | null;

        if (bulk) {
            const payout = bulk.payouts.find(
                (p) => p.wallet.toLowerCase() === wallet.toLowerCase() && p.status === 'success'
            );
            return { claimed: true, txHash: payout?.txHash || null };
        }

        return { claimed: false, txHash: null };
    }

    // ═══════════════════════════════════════════════════════════
    //  GET /api/rewards/eligibility?wallet=rXXX&week=2026-W20
    // ═══════════════════════════════════════════════════════════

    public async handleEligibility(response: HttpResponse, request: HttpRequest): Promise<void> {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        try {
            const query = request.getQuery();
            const params = new URLSearchParams(query);
            const wallet = params.get('wallet');
            const weekParam = params.get('week');

            // Validate wallet
            if (!wallet || !XRPL_ADDRESS_RE.test(wallet)) {
                return this.respond(response, aborted, 400, {
                    eligible: false, error: 'invalid_wallet'
                });
            }

            // Validate / default week
            const weekKey = (weekParam && WEEK_KEY_RE.test(weekParam)) ? weekParam : getCurrentWeekKey();

            // Get top 3 (with snapshot-locked prize amounts when announced)
            const snapshot = await this.getWeeklySnapshot(weekKey);
            const winners = await this.getTopWinners(weekKey, snapshot);
            const match = winners.find(
                (w) => w.wallet.toLowerCase() === wallet.toLowerCase()
            );

            const snapshotMeta = {
                announced: !!snapshot,
                snapshot_price: snapshot ? snapshot.nut_price_snapshot_usd : null,
                snapshot_timestamp: snapshot ? snapshot.snapshot_timestamp : null,
                cap_applied: snapshot ? snapshot.cap_applied : null,
                tiers: snapshot ? this.tiersPayload(snapshot) : null
            };

            if (!match) {
                return this.respond(response, aborted, 200, {
                    eligible: false,
                    rank: null,
                    game: null,
                    prize: null,
                    usd_value: null,
                    nut_amount: null,
                    claimed: false,
                    txHash: null,
                    ...snapshotMeta
                });
            }

            // Check claimed status
            const { claimed, txHash } = await this.checkClaimed(weekKey, wallet);

            return this.respond(response, aborted, 200, {
                eligible: true,
                rank: match.rank,
                game: 'combined',
                prize: match.nut_amount != null ? parseInt(match.nut_amount, 10) : null,
                usd_value: match.usd_value ?? null,
                nut_amount: match.nut_amount ?? null,
                claimed,
                txHash,
                ...snapshotMeta
            });

        } catch (error) {
            log.error('[RewardsAPI] Eligibility error:');
            log.error(error);
            return this.respond(response, aborted, 500, {
                eligible: false, error: 'internal_error'
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  POST /api/rewards/claim   { wallet, week }
    // ═══════════════════════════════════════════════════════════

    public handleClaim(response: HttpResponse, request: HttpRequest): void {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        // Capture IP for logging
        const ip = request.getHeader('cf-connecting-ip') ||
                   request.getHeader('x-forwarded-for') ||
                   'unknown';

        // Read body with size limit (same pattern as scores.ts)
        let bodyBuffer = Buffer.alloc(0);

        response.onData((chunk, isLast) => {
            bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(chunk)]);

            if (bodyBuffer.length > MAX_BODY_SIZE) {
                return this.respond(response, aborted, 413, {
                    error: 'payload_too_large'
                });
            }

            if (isLast) {
                this.processClaim(bodyBuffer.toString(), ip, response, aborted);
            }
        });
    }

    private async processClaim(
        body: string,
        ip: string,
        response: HttpResponse,
        aborted: boolean
    ): Promise<void> {
        try {
            const data = JSON.parse(body);
            const { wallet, week } = data;

            // ── Validate input ──

            if (!wallet || !XRPL_ADDRESS_RE.test(wallet)) {
                return this.respond(response, aborted, 400, { error: 'invalid_wallet' });
            }

            const weekKey = (week && WEEK_KEY_RE.test(week)) ? week : getCurrentWeekKey();

            // ── Rate limit ──

            const rateKey = `claim:${wallet}`;
            const lastAttempt = claimRateLimits.get(rateKey);
            if (lastAttempt && Date.now() - lastAttempt < CLAIM_RATE_LIMIT_MS) {
                return this.respond(response, aborted, 429, { error: 'rate_limited' });
            }
            claimRateLimits.set(rateKey, Date.now());

            // ── Check COMMUNITY_NUT_JAR_SEED ──

            const seed = process.env.COMMUNITY_NUT_JAR_SEED;
            if (!seed) {
                log.error('[RewardsAPI] COMMUNITY_NUT_JAR_SEED not set');
                return this.respond(response, aborted, 503, {
                    error: 'reward_distribution_unavailable'
                });
            }

            // ── Snapshot is mandatory: NEVER price at claim time ──

            const snapshot = await this.getWeeklySnapshot(weekKey);
            if (!snapshot) {
                return this.respond(response, aborted, 409, {
                    error: 'not_announced'
                });
            }

            // ── Re-verify eligibility against the locked snapshot (defense in depth) ──

            const winners = await this.getTopWinners(weekKey, snapshot);
            const match = winners.find(
                (w) => w.wallet.toLowerCase() === wallet.toLowerCase()
            );

            if (!match) {
                return this.respond(response, aborted, 403, {
                    error: 'not_eligible'
                });
            }

            const nutAmount = match.nut_amount;
            const usdValue = match.usd_value ?? null;
            const snapshotPrice = snapshot.nut_price_snapshot_usd;
            if (!nutAmount) {
                return this.respond(response, aborted, 409, {
                    error: 'prize_amount_unavailable'
                });
            }

            // ── Check for double claim ──

            const { claimed, txHash: existingTx } = await this.checkClaimed(weekKey, wallet);
            if (claimed) {
                return this.respond(response, aborted, 409, {
                    error: 'already_claimed',
                    txHash: existingTx
                });
            }

            // ── Insert pending claim record (atomic lock) ──

            const claimRecord: ClaimRecord = {
                type: 'individual_claim',
                weekKey,
                wallet,
                rank: match.rank,
                amount: nutAmount,
                usd_value: usdValue,
                snapshot_price: snapshotPrice,
                score: match.total,
                status: 'pending',
                createdAt: new Date(),
                txHash: null
            };

            let isNewClaim = false;
            try {
                const lockResult = await this.prizesCol.updateOne(
                    {
                        weekKey,
                        wallet: { $regex: new RegExp(`^${wallet}$`, 'i') } as any,
                        type: 'individual_claim'
                    },
                    { $setOnInsert: claimRecord as any },
                    { upsert: true }
                );
                isNewClaim = !!lockResult.upsertedId;
            } catch {
                // Duplicate key = another request beat us
                const existing = await this.prizesCol.findOne({
                    weekKey,
                    wallet: { $regex: new RegExp(`^${wallet}$`, 'i') } as any,
                    type: 'individual_claim'
                } as any);

                if (existing?.status === 'success') {
                    return this.respond(response, aborted, 409, {
                        error: 'already_claimed',
                        txHash: existing.txHash
                    });
                }

                // If pending from another request, let this proceed
                isNewClaim = false;
            }

            // ── Execute XRPL Payment ──

            log.info(`[RewardsAPI] Processing claim: wallet=${wallet} week=${weekKey} rank=${match.rank} ip=${ip}`);

            let xrpl;
            try {
                xrpl = require('xrpl');
            } catch {
                await this.updateClaimStatus(weekKey, wallet, 'error', null, 'xrpl_module_not_installed');
                return this.respond(response, aborted, 500, {
                    error: 'xrpl_unavailable'
                });
            }

            // Try each XRPL server until one works
            let lastError = '';

            for (const server of XRPL_SERVERS) {
                const xrplClient = new xrpl.Client(server, {
                    connectionTimeout: XRPL_CONNECT_TIMEOUT_MS
                });

                try {
                    log.info(`[RewardsAPI] Connecting to ${server}...`);
                    await xrplClient.connect();
                    log.info(`[RewardsAPI] Connected to ${server} for claim: ${wallet}`);

                    // Auto-detect seed format and create wallet accordingly
                    let distributorWallet;
                    const trimmedSeed = seed.trim();

                    if (/^[\d\s]+$/.test(trimmedSeed)) {
                        // Xaman secret numbers format: "123456 234567 345678 ..."
                        log.info('[RewardsAPI] Detected secret numbers format, using walletFromSecretNumbers()');
                        distributorWallet = xrpl.walletFromSecretNumbers(trimmedSeed);
                    } else if (trimmedSeed.startsWith('s')) {
                        // Base58 family seed: "sEdV19..."
                        log.info('[RewardsAPI] Using Wallet.fromSeed()');
                        distributorWallet = xrpl.Wallet.fromSeed(trimmedSeed);
                    } else {
                        // Mnemonic phrase: "word1 word2 word3 ..."
                        log.info('[RewardsAPI] Using Wallet.fromMnemonic()');
                        distributorWallet = xrpl.Wallet.fromMnemonic(trimmedSeed);
                    }

                    log.info(`[RewardsAPI] Distributor address: ${distributorWallet.address}`);

                    const payment = {
                        TransactionType: 'Payment',
                        Account: distributorWallet.address,
                        Destination: wallet,
                        Amount: {
                            currency: NUT_CURRENCY,
                            issuer: NUT_ISSUER,
                            value: nutAmount
                        },
                        Memos: [{
                            Memo: {
                                MemoType: Buffer.from('fuzzynuts-arcade-prize', 'utf8').toString('hex').toUpperCase(),
                                MemoData: Buffer.from(
                                    `Fuzzynuts Reward week=${weekKey} rank=${match.rank} usd_value=${usdValue} ` +
                                    `snapshot_price=${snapshotPrice} nut_amount_paid=${nutAmount} score=${match.total}`,
                                    'utf8'
                                ).toString('hex').toUpperCase()
                            }
                        }]
                    };

                    const prepared = await xrplClient.autofill(payment);
                    const signed = distributorWallet.sign(prepared);
                    const result = await xrplClient.submitAndWait(signed.tx_blob);

                    const txResult = result.result.meta?.TransactionResult;
                    const txHash = result.result.hash;

                    try { await xrplClient.disconnect(); } catch { /* noop */ }

                    if (txResult === 'tesSUCCESS') {
                        await this.updateClaimStatus(weekKey, wallet, 'success', txHash, undefined, txResult, {
                            nut_amount_paid: nutAmount,
                            usd_value: usdValue,
                            snapshot_price: snapshotPrice
                        });

                        log.info(`[RewardsAPI] ✅ Claim successful: ${txHash}`);
                        return this.respond(response, aborted, 200, {
                            success: true,
                            txHash,
                            nut_amount_paid: nutAmount,
                            usd_value: usdValue,
                            snapshot_price: snapshotPrice
                        });
                    } else {
                        await this.updateClaimStatus(weekKey, wallet, 'failed', null, txResult);

                        log.error(`[RewardsAPI] ❌ XRPL rejected: ${txResult}`);
                        return this.respond(response, aborted, 502, {
                            error: `xrpl_transaction_failed`,
                            detail: txResult
                        });
                    }

                } catch (xrplErr: any) {
                    lastError = xrplErr?.message || 'Unknown XRPL error';
                    log.error(`[RewardsAPI] ❌ ${server} failed: ${lastError}`);
                    try { await xrplClient.disconnect(); } catch { /* noop */ }
                    // Try next server...
                }
            }

            // All servers failed
            await this.updateClaimStatus(weekKey, wallet, 'error', null, lastError);
            log.error(`[RewardsAPI] ❌ All XRPL servers failed. Last error: ${lastError}`);
            return this.respond(response, aborted, 502, {
                error: 'xrpl_network_error',
                detail: lastError
            });

        } catch (parseError) {
            log.error('[RewardsAPI] Claim parse error:');
            log.error(parseError);
            return this.respond(response, aborted, 400, {
                error: 'invalid_request_body'
            });
        }
    }

    // ── Update Claim Record ──

    private async updateClaimStatus(
        weekKey: string,
        wallet: string,
        status: string,
        txHash: string | null,
        error?: string,
        xrplResult?: string,
        extra?: Record<string, unknown>
    ): Promise<void> {
        try {
            const $set: Record<string, unknown> = {
                status,
                completedAt: new Date(),
                ...(txHash != null && { txHash }),
                ...(error && { error }),
                ...(xrplResult && { xrplResult }),
                ...(extra || {})
            };

            // On success, remove stale error field entirely
            const update: Record<string, unknown> = { $set };
            if (status === 'success') {
                update.$unset = { error: '' };
            }

            await this.prizesCol.updateOne(
                {
                    weekKey,
                    wallet: { $regex: new RegExp(`^${wallet}$`, 'i') } as any,
                    type: 'individual_claim'
                },
                update as any
            );
        } catch (dbError) {
            log.error(`[RewardsAPI] Failed to update claim status: ${dbError}`);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GET /api/rewards/claim/status?wallet=rXXX&week=2026-W20
    //  Used by the frontend to poll transaction status after claim
    // ═══════════════════════════════════════════════════════════

    public async handleClaimStatus(response: HttpResponse, request: HttpRequest): Promise<void> {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        try {
            const query = request.getQuery();
            const params = new URLSearchParams(query);
            const wallet = params.get('wallet');
            const weekParam = params.get('week');

            if (!wallet || !XRPL_ADDRESS_RE.test(wallet)) {
                return this.respond(response, aborted, 400, { error: 'invalid_wallet' });
            }

            const weekKey = (weekParam && WEEK_KEY_RE.test(weekParam)) ? weekParam : getCurrentWeekKey();

            // Look up the claim record
            const claim = await this.prizesCol.findOne({
                weekKey,
                wallet: { $regex: new RegExp(`^${wallet}$`, 'i') } as any,
                type: 'individual_claim'
            } as any);

            if (!claim) {
                return this.respond(response, aborted, 404, {
                    status: 'not_found',
                    txHash: null
                });
            }

            return this.respond(response, aborted, 200, {
                status: claim.status,
                txHash: claim.txHash || null,
                rank: claim.rank,
                amount: claim.amount,
                error: claim.error || null
            });

        } catch (error) {
            log.error('[RewardsAPI] Claim status error:');
            log.error(error);
            return this.respond(response, aborted, 500, { error: 'internal_error' });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GET /api/rewards/health
    //  Returns service status, XRPL connectivity, and DB state
    // ═══════════════════════════════════════════════════════════

    public async handleHealth(response: HttpResponse, _request: HttpRequest): Promise<void> {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        let mongoConnected = false;
        let xrplConnected = false;
        let seedConfigured = false;

        // Check MongoDB
        try {
            await this.database.command({ ping: 1 });
            mongoConnected = true;
        } catch {
            mongoConnected = false;
        }

        // Check COMMUNITY_NUT_JAR_SEED
        seedConfigured = !!process.env.COMMUNITY_NUT_JAR_SEED;

        // Quick XRPL connectivity test (1s timeout)
        if (xrplModule) {
            const client = new xrplModule.Client(XRPL_SERVERS[0], {
                connectionTimeout: 3000
            });
            try {
                await client.connect();
                xrplConnected = true;
                await client.disconnect();
            } catch {
                xrplConnected = false;
                try { await client.disconnect(); } catch { /* noop */ }
            }
        }

        return this.respond(response, aborted, 200, {
            ok: true,
            service: 'fuzzynuts-rewards',
            timestamp: new Date().toISOString(),
            mongoConnected,
            xrplConnected,
            seedConfigured,
            prizePool: PRIZE_USD_TIERS
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  POST /api/rewards/snapshot   (admin: x-admin-secret header)
    //  Body: { week?, force? } — locks the week's NUT/USD price + amounts
    // ═══════════════════════════════════════════════════════════

    public handleSnapshot(response: HttpResponse, request: HttpRequest): void {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        // Headers must be read synchronously before onData.
        const provided = request.getHeader('x-admin-secret');

        let bodyBuffer = Buffer.alloc(0);
        response.onData((chunk, isLast) => {
            bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(chunk)]);

            if (bodyBuffer.length > MAX_BODY_SIZE) {
                return this.respond(response, aborted, 413, { error: 'payload_too_large' });
            }

            if (isLast) this.processSnapshot(bodyBuffer.toString(), provided, response, aborted);
        });
    }

    private async processSnapshot(
        body: string,
        provided: string,
        response: HttpResponse,
        aborted: boolean
    ): Promise<void> {
        try {
            if (!REWARDS_ADMIN_SECRET || provided !== REWARDS_ADMIN_SECRET) {
                return this.respond(response, aborted, 401, { error: 'unauthorized' });
            }

            let data: any = {};
            if (body && body.trim()) {
                try { data = JSON.parse(body); } catch { data = {}; }
            }

            const week = data.week;
            const force = !!data.force;
            const weekKey = (week && WEEK_KEY_RE.test(week)) ? week : getCurrentWeekKey();

            const snap = await this.createWeeklySnapshot(weekKey, force);
            return this.respond(response, aborted, 200, {
                ok: true,
                weekKey,
                nut_price_snapshot_usd: snap.nut_price_snapshot_usd,
                snapshot_timestamp: snap.snapshot_timestamp,
                calculated_nut_amounts: snap.calculated_nut_amounts,
                cap_applied: snap.cap_applied,
                price_source: snap.price_source
            });
        } catch (err: any) {
            log.error('[RewardsAPI] Snapshot error:');
            log.error(err);
            return this.respond(response, aborted, 502, {
                error: 'snapshot_failed',
                detail: err?.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GET /api/rewards/tiers?week=2026-W20   (wallet-independent)
    // ═══════════════════════════════════════════════════════════

    public async handleTiers(response: HttpResponse, request: HttpRequest): Promise<void> {
        let aborted = false;
        response.onAborted(() => { aborted = true; });

        try {
            const query = request.getQuery();
            const params = new URLSearchParams(query);
            const weekParam = params.get('week');
            const weekKey = (weekParam && WEEK_KEY_RE.test(weekParam)) ? weekParam : getCurrentWeekKey();

            const snapshot = await this.getWeeklySnapshot(weekKey);
            if (!snapshot) {
                return this.respond(response, aborted, 200, {
                    announced: false,
                    weekKey,
                    tiers: null,
                    snapshot_price: null,
                    snapshot_timestamp: null
                });
            }

            return this.respond(response, aborted, 200, {
                announced: true,
                weekKey,
                tiers: this.tiersPayload(snapshot),
                snapshot_price: snapshot.nut_price_snapshot_usd,
                snapshot_timestamp: snapshot.snapshot_timestamp,
                cap_applied: snapshot.cap_applied
            });
        } catch (error) {
            log.error('[RewardsAPI] Tiers error:');
            log.error(error);
            return this.respond(response, aborted, 500, { error: 'internal_error' });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GET /api/rewards/price — live NUT price + market cap (public)
    // ═══════════════════════════════════════════════════════════

    public async handlePrice(response: HttpResponse, _request: HttpRequest): Promise<void> {
        let aborted = false;
        response.onAborted(() => { aborted = true; });
        try {
            const { price, source, cached } = await getLivePriceUsd();
            return this.respond(response, aborted, 200, {
                price_usd: price,
                market_cap: price * NUT_TOTAL_SUPPLY,
                total_supply: NUT_TOTAL_SUPPLY,
                source,
                cached
            });
        } catch (err: any) {
            log.error('[RewardsAPI] Price error:');
            log.error(err);
            return this.respond(response, aborted, 502, { error: 'price_unavailable' });
        }
    }

    // ── CORS Preflight ──

    public handleOptions(response: HttpResponse): void {
        response.cork(() => {
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.writeHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.writeHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
            response.writeHeader('Access-Control-Max-Age', '86400');
            response.end();
        });
    }

    // ── Response Helper ──

    private respond(response: HttpResponse, aborted: boolean, status: number, body: object): void {
        if (aborted) return;
        const statusText = status === 200 ? '200 OK' :
                          status === 400 ? '400 Bad Request' :
                          status === 401 ? '401 Unauthorized' :
                          status === 403 ? '403 Forbidden' :
                          status === 404 ? '404 Not Found' :
                          status === 409 ? '409 Conflict' :
                          status === 413 ? '413 Payload Too Large' :
                          status === 429 ? '429 Too Many Requests' :
                          status === 502 ? '502 Bad Gateway' :
                          status === 503 ? '503 Service Unavailable' :
                          '500 Internal Server Error';
        response.cork(() => {
            response.writeStatus(statusText);
            response.writeHeader('Content-Type', 'application/json');
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.end(JSON.stringify(body));
        });
    }
}
