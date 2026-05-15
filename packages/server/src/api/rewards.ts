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

// ── Types ──

interface ClaimRecord {
    type: string;
    weekKey: string;
    wallet: string;
    rank: number;
    amount: string;
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

// ── Constants ──

const NUT_CURRENCY = 'NUT';
const NUT_ISSUER = 'rpL6HfoV578CAkZoNbm3UEK5BgVY9DxMP7';
const XRPL_SERVER = 'wss://xrplcluster.com';
const MAX_BODY_SIZE = 2048;

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const WEEK_KEY_RE = /^\d{4}-W\d{2}$/;

const PRIZES = [
    { rank: 1, amount: '250000', label: '1st Place' },
    { rank: 2, amount: '150000', label: '2nd Place' },
    { rank: 3, amount: '100000', label: '3rd Place' }
];

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

// ── API Handler Class ──

export default class RewardsAPI {
    private scoresCol!: Collection;
    private prizesCol!: Collection<ClaimRecord>;

    public constructor(private database: Db) {
        this.scoresCol = this.database.collection('arcade_scores');
        this.prizesCol = this.database.collection<ClaimRecord>('prize_distributions');
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
            log.info('[RewardsAPI] MongoDB indexes created.');
        } catch (error) {
            log.error('[RewardsAPI] Failed to create indexes:');
            log.error(error);
        }
    }

    // ── Top 3 Winners for a Week ──

    private async getTopWinners(weekKey: string): Promise<Array<{ wallet: string; total: number; rank: number }>> {
        const scores = await this.scoresCol.find({ weekKey }).toArray();
        if (scores.length === 0) return [];

        const playerMap = new Map<string, number>();
        for (const entry of scores) {
            if (!entry.wallet) continue;
            const existing = playerMap.get(entry.wallet) || 0;
            playerMap.set(entry.wallet, existing + (entry.score || 0));
        }

        return Array.from(playerMap.entries())
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 3)
            .map((entry, i) => ({ ...entry, rank: i + 1 }));
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

            // Get top 3
            const winners = await this.getTopWinners(weekKey);
            const match = winners.find(
                (w) => w.wallet.toLowerCase() === wallet.toLowerCase()
            );

            if (!match) {
                return this.respond(response, aborted, 200, {
                    eligible: false,
                    rank: null,
                    game: null,
                    prize: null,
                    claimed: false,
                    txHash: null
                });
            }

            // Check claimed status
            const { claimed, txHash } = await this.checkClaimed(weekKey, wallet);
            const prize = PRIZES[match.rank - 1];

            return this.respond(response, aborted, 200, {
                eligible: true,
                rank: match.rank,
                game: 'combined',
                prize: parseInt(prize.amount, 10),
                claimed,
                txHash
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

            // ── Re-verify eligibility (defense in depth) ──

            const winners = await this.getTopWinners(weekKey);
            const match = winners.find(
                (w) => w.wallet.toLowerCase() === wallet.toLowerCase()
            );

            if (!match) {
                return this.respond(response, aborted, 403, {
                    error: 'not_eligible'
                });
            }

            const prize = PRIZES[match.rank - 1];
            if (!prize) {
                return this.respond(response, aborted, 403, {
                    error: 'no_prize_tier'
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
                amount: prize.amount,
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

            const xrplClient = new xrpl.Client(XRPL_SERVER);

            try {
                await xrplClient.connect();
                log.info(`[RewardsAPI] Connected to XRPL for claim: ${wallet}`);

                const distributorWallet = xrpl.Wallet.fromSeed(seed);

                const payment = {
                    TransactionType: 'Payment',
                    Account: distributorWallet.address,
                    Destination: wallet,
                    Amount: {
                        currency: NUT_CURRENCY,
                        issuer: NUT_ISSUER,
                        value: prize.amount
                    },
                    Memos: [{
                        Memo: {
                            MemoType: Buffer.from('fuzzynuts-arcade-prize', 'utf8').toString('hex').toUpperCase(),
                            MemoData: Buffer.from(
                                `Fuzzynuts Reward W${weekKey} R${match.rank} Score:${match.total}`,
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

                if (txResult === 'tesSUCCESS') {
                    await this.updateClaimStatus(weekKey, wallet, 'success', txHash, undefined, txResult);

                    log.info(`[RewardsAPI] ✅ Claim successful: ${txHash}`);
                    return this.respond(response, aborted, 200, {
                        success: true,
                        txHash
                    });
                } else {
                    await this.updateClaimStatus(weekKey, wallet, 'failed', null, txResult);

                    log.error(`[RewardsAPI] ❌ XRPL rejected: ${txResult}`);
                    return this.respond(response, aborted, 502, {
                        error: `xrpl_transaction_failed: ${txResult}`
                    });
                }

            } catch (xrplErr: any) {
                await this.updateClaimStatus(weekKey, wallet, 'error', null, xrplErr?.message);

                log.error(`[RewardsAPI] ❌ XRPL error: ${xrplErr?.message}`);
                return this.respond(response, aborted, 502, {
                    error: 'xrpl_network_error'
                });

            } finally {
                try { await xrplClient.disconnect(); } catch { /* noop */ }
            }

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
        xrplResult?: string
    ): Promise<void> {
        try {
            await this.prizesCol.updateOne(
                {
                    weekKey,
                    wallet: { $regex: new RegExp(`^${wallet}$`, 'i') } as any,
                    type: 'individual_claim'
                },
                {
                    $set: {
                        status,
                        txHash,
                        completedAt: new Date(),
                        ...(error && { error }),
                        ...(xrplResult && { xrplResult })
                    }
                }
            );
        } catch (dbError) {
            log.error(`[RewardsAPI] Failed to update claim status: ${dbError}`);
        }
    }

    // ── CORS Preflight ──

    public handleOptions(response: HttpResponse): void {
        response.cork(() => {
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.writeHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.writeHeader('Access-Control-Max-Age', '86400');
            response.end();
        });
    }

    // ── Response Helper ──

    private respond(response: HttpResponse, aborted: boolean, status: number, body: object): void {
        if (aborted) return;
        const statusText = status === 200 ? '200 OK' :
                          status === 400 ? '400 Bad Request' :
                          status === 403 ? '403 Forbidden' :
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
