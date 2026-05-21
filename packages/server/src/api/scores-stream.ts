/**
 * ═══════════════════════════════════════════════════════════════
 * SSE Scores Stream — GET /api/scores/stream
 *
 * µWebSockets SSE endpoint for real-time leaderboard updates.
 *
 * Wire protocol:
 *   GET /api/scores/stream?timeframe=weekly&game=mario&watch=rXxx
 *   → Content-Type: text/event-stream
 *   → data: {"type":"initial","data":[...],"timestamp":1234}\n\n
 *   → : ping\n\n  (every 15s)
 *   → data: {"type":"update","data":[...],"timestamp":1234}\n\n
 *
 * Features:
 *   - Initial payload: top 50 scores for the requested filter
 *   - Change stream: real-time updates via MongoDB change stream
 *   - Heartbeat: `: ping\n\n` every 15s to prevent proxy timeouts
 *   - Backpressure: caps queue at 10 events, drops oldest
 *   - Client disconnect: onAborted cleans up all resources
 *   - Query validation: enum timeframe, game whitelist, XRPL regex
 * ═══════════════════════════════════════════════════════════════
 */

import log from '@kaetram/common/util/log';
import ScoreChangeStream from './changeStream';

import type { Db, Collection } from 'mongodb';
import type { HttpResponse, HttpRequest } from 'uws';
import type {
    ArcadeScoreDocument,
    SSEScoreEntry,
    SSEMessage,
    SSEClient,
    SSEQueryResult,
    SSETimeframe
} from './types/sse';

import {
    VALID_GAME_SLUGS,
    XRPL_ADDRESS_RE,
    SSE_MAX_ENTRIES,
    SSE_HEARTBEAT_MS,
    SSE_MAX_QUEUE,
    SSE_CORS_ORIGINS
} from './types/sse';

/* ── Helper: ISO week key ── */

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

let clientIdCounter = 0;

/* ── SSE Stream Handler ── */

export default class ScoresStreamAPI {
    private collection: Collection<ArcadeScoreDocument>;
    private changeStream: ScoreChangeStream;
    private clients: Map<string, SSEClient> = new Map();
    private responseMap: Map<string, HttpResponse> = new Map();
    private pollingInterval: ReturnType<typeof setInterval> | null = null;

    public constructor(private database: Db) {
        this.collection = this.database.collection<ArcadeScoreDocument>('arcade_scores');

        // Initialize change stream (may fail gracefully on standalone MongoDB)
        this.changeStream = new ScoreChangeStream(this.database);
        this.changeStream.onChange(this.handleScoreChange.bind(this));
        this.changeStream.start();

        // Fallback: server-side polling every 30s for all connected clients.
        // This ensures SSE clients get periodic refreshes even without change streams.
        this.pollingInterval = setInterval(() => {
            this.pollAndBroadcast().catch((err: unknown) => {
                log.error('[SSE] Poll broadcast error:');
                log.error(err);
            });
        }, 30_000);

        // Log active clients periodically
        setInterval(() => {
            if (this.clients.size > 0) {
                log.debug(`[SSE] Active clients: ${this.clients.size}`);
            }
        }, 60_000);

        log.notice('[SSE] Scores stream API initialized.');
    }

    /**
     * Handle GET /api/scores/stream
     */
    public handleStream(response: HttpResponse, request: HttpRequest): void {
        // ── Validate query params ──
        const query = request.getQuery();
        const origin = request.getHeader('origin');
        const validation = this.validateQuery(query);

        if (!validation.valid) {
            response.cork(() => {
                response.writeStatus('400 Bad Request');
                response.writeHeader('Content-Type', 'application/json');
                this.writeCORS(response, origin);
                response.end(JSON.stringify({ ok: false, error: validation.error }));
            });
            return;
        }

        // ── Register client ──
        const clientId = `sse_${++clientIdCounter}_${Date.now()}`;
        const client: SSEClient = {
            id: clientId,
            game: validation.game,
            timeframe: validation.timeframe,
            watchWallet: validation.watch,
            weekKey: validation.weekKey,
            aborted: false,
            lastEventId: 0,
            queuedEvents: []
        };

        this.clients.set(clientId, client);
        this.responseMap.set(clientId, response);

        // ── Cleanup on disconnect ──
        response.onAborted(() => {
            client.aborted = true;
            this.removeClient(clientId);
        });

        // ── Write SSE headers ──
        response.cork(() => {
            response.writeStatus('200 OK');
            response.writeHeader('Content-Type', 'text/event-stream');
            response.writeHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            response.writeHeader('Connection', 'keep-alive');
            response.writeHeader('X-Accel-Buffering', 'no');
            this.writeCORS(response, origin);
        });

        // ── Send initial payload ──
        this.sendInitialPayload(clientId).catch((error: unknown) => {
            log.error(`[SSE] Failed to send initial payload to ${clientId}:`);
            log.error(error);
            this.removeClient(clientId);
        });

        // ── Start heartbeat ──
        const heartbeatInterval = setInterval(() => {
            if (client.aborted || !this.responseMap.has(clientId)) {
                clearInterval(heartbeatInterval);
                return;
            }

            this.sendRaw(clientId, ': ping\n\n');
        }, SSE_HEARTBEAT_MS);

        log.info(`[SSE] Client connected: ${clientId} (game=${validation.game || 'all'}, watch=${validation.watch || 'none'})`);
    }

    /**
     * Handle OPTIONS /api/scores/stream (CORS preflight)
     */
    public handleOptions(response: HttpResponse, request: HttpRequest): void {
        const origin = request.getHeader('origin');
        response.cork(() => {
            this.writeCORS(response, origin);
            response.writeHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            response.writeHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Cache-Control');
            response.writeHeader('Access-Control-Max-Age', '86400');
            response.end();
        });
    }

    /**
     * Graceful shutdown — close all clients, change stream, and polling.
     */
    public async shutdown(): Promise<void> {
        log.info(`[SSE] Shutting down — disconnecting ${this.clients.size} clients.`);

        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        for (const clientId of this.clients.keys()) {
            this.removeClient(clientId);
        }

        await this.changeStream.close();
    }

    /* ═══════════════════════════════════════════════════════════════
       Internal Methods
       ═══════════════════════════════════════════════════════════════ */

    /**
     * Fetch initial leaderboard and send to a newly connected client.
     */
    private async sendInitialPayload(clientId: string): Promise<void> {
        const client = this.clients.get(clientId);
        if (!client || client.aborted) return;

        const filter: Record<string, string> = { weekKey: client.weekKey };
        if (client.game) filter.game = client.game;

        const entries = await this.collection
            .find(filter)
            .sort({ score: -1 })
            .limit(SSE_MAX_ENTRIES)
            .toArray();

        const scores = this.formatEntries(entries);

        const message: SSEMessage = {
            type: 'initial',
            data: scores,
            timestamp: Date.now()
        };

        this.sendEvent(clientId, message);
    }

    /**
     * Handle a score change from the MongoDB change stream.
     * Fan out to all connected SSE clients whose filters match.
     */
    private handleScoreChange(doc: ArcadeScoreDocument, operation: 'insert' | 'update'): void {
        const entry = this.formatEntry(doc, 0); // Rank will be recalculated by client

        for (const [clientId, client] of this.clients) {
            if (client.aborted) continue;

            // ── Filter: does this change match the client's subscription? ──
            if (client.game && client.game !== doc.game) continue;
            if (client.weekKey !== doc.weekKey) continue;

            const message: SSEMessage = {
                type: 'update',
                data: [entry],
                timestamp: Date.now()
            };

            this.sendEvent(clientId, message);
        }

        log.debug(`[SSE] Broadcast ${operation} for ${doc.wallet} ${doc.game}: ${doc.score}`);
    }

    /**
     * Server-side polling fallback — re-query and send full leaderboard to all clients.
     * Used when change streams are unavailable (standalone MongoDB).
     */
    private async pollAndBroadcast(): Promise<void> {
        if (this.clients.size === 0) return;

        // Group clients by their filter to avoid redundant queries
        const filterGroups = new Map<string, string[]>();

        for (const [clientId, client] of this.clients) {
            if (client.aborted) continue;
            const key = `${client.weekKey}|${client.game || 'all'}`;
            const group = filterGroups.get(key) || [];
            group.push(clientId);
            filterGroups.set(key, group);
        }

        for (const [filterKey, clientIds] of filterGroups) {
            const [weekKey, game] = filterKey.split('|');
            const filter: Record<string, string> = {};
            if (weekKey) filter.weekKey = weekKey;
            if (game !== 'all') filter.game = game;

            const entries = await this.collection
                .find(filter)
                .sort({ score: -1 })
                .limit(SSE_MAX_ENTRIES)
                .toArray();

            const scores = this.formatEntries(entries);
            const message: SSEMessage = {
                type: 'replace',
                data: scores,
                timestamp: Date.now()
            };

            for (const clientId of clientIds) {
                this.sendEvent(clientId, message);
            }
        }
    }

    /**
     * Send a JSON SSE event to a client with backpressure handling.
     */
    private sendEvent(clientId: string, message: SSEMessage): void {
        const payload = `data: ${JSON.stringify(message)}\n\n`;
        this.sendRaw(clientId, payload);
    }

    /**
     * Send raw SSE data to a client.
     * Implements backpressure: queues up to SSE_MAX_QUEUE events, drops oldest.
     */
    private sendRaw(clientId: string, data: string): void {
        const client = this.clients.get(clientId);
        const response = this.responseMap.get(clientId);

        if (!client || !response || client.aborted) return;

        try {
            // Try to write directly
            const ok = response.write(data);

            if (!ok) {
                // Backpressure — queue the event
                client.queuedEvents.push(data);

                // Cap queue size — drop oldest
                while (client.queuedEvents.length > SSE_MAX_QUEUE) {
                    client.queuedEvents.shift();
                }

                // Drain when ready
                response.onWritable((_offset: number) => {
                    if (client.aborted) return true;

                    while (client.queuedEvents.length > 0) {
                        const queued = client.queuedEvents.shift()!;
                        const written = response.write(queued);
                        if (!written) return false; // Still under pressure
                    }

                    return true; // Fully drained
                });
            }
        } catch (error) {
            log.error(`[SSE] Write error for ${clientId}:`);
            log.error(error);
            this.removeClient(clientId);
        }
    }

    /**
     * Remove a client and clean up resources.
     */
    private removeClient(clientId: string): void {
        const client = this.clients.get(clientId);
        if (client) {
            client.aborted = true;
            client.queuedEvents.length = 0;
        }

        this.clients.delete(clientId);
        this.responseMap.delete(clientId);

        log.debug(`[SSE] Client disconnected: ${clientId} (remaining: ${this.clients.size})`);
    }

    /**
     * Validate and parse SSE query parameters.
     */
    private validateQuery(query: string): SSEQueryResult {
        const params = new URLSearchParams(query);

        // Timeframe
        const timeframe = (params.get('timeframe') || 'weekly') as SSETimeframe;
        if (timeframe !== 'weekly' && timeframe !== 'alltime') {
            return { valid: false, error: 'invalid_timeframe: must be weekly|alltime' };
        }

        // Game filter
        const game = params.get('game') || null;
        if (game && !VALID_GAME_SLUGS.includes(game as typeof VALID_GAME_SLUGS[number])) {
            return { valid: false, error: `invalid_game: must be one of ${VALID_GAME_SLUGS.join(',')}` };
        }

        // Watch wallet
        const watch = params.get('watch') || null;
        if (watch && !XRPL_ADDRESS_RE.test(watch)) {
            return { valid: false, error: 'invalid_watch: must be valid XRPL r-address' };
        }

        // Week key
        const weekKey = timeframe === 'alltime' ? '' : getCurrentWeekKey();

        return { valid: true, timeframe, game, watch, weekKey };
    }

    /**
     * Format MongoDB documents into SSE-safe score entries.
     */
    private formatEntries(docs: ArcadeScoreDocument[]): SSEScoreEntry[] {
        return docs.map((doc, index) => this.formatEntry(doc, index + 1));
    }

    private formatEntry(doc: ArcadeScoreDocument, rank: number): SSEScoreEntry {
        return {
            rank,
            wallet: doc.wallet,
            name: truncateAddress(doc.wallet),
            game: doc.game,
            score: doc.score,
            weekKey: doc.weekKey
        };
    }

    /**
     * Write CORS headers — allow only fuzzynuts.xyz origins.
     */
    private writeCORS(response: HttpResponse, origin: string): void {
        const allowed = SSE_CORS_ORIGINS.includes(origin) ? origin : SSE_CORS_ORIGINS[0];
        response.writeHeader('Access-Control-Allow-Origin', allowed);
        response.writeHeader('Access-Control-Allow-Credentials', 'true');
    }
}
