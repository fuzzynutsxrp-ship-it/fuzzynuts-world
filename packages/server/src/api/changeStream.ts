/**
 * ═══════════════════════════════════════════════════════════════
 * MongoDB Change Stream Wrapper — Auto-reconnect + typed events
 *
 * Wraps a MongoDB change stream on `arcade_scores` with:
 *   - Automatic reconnect on cursor exhaustion or network drops
 *   - Resume token persistence for gapless recovery
 *   - Typed event callbacks for insert/update/replace operations
 *   - Graceful shutdown via close()
 * ═══════════════════════════════════════════════════════════════
 */

import log from '@kaetram/common/util/log';

import type { Db, ChangeStream, ChangeStreamDocument, ResumeToken } from 'mongodb';
import type { ArcadeScoreDocument } from './types/sse';

/* ── Callback types ── */

export type ScoreChangeCallback = (doc: ArcadeScoreDocument, operation: 'insert' | 'update') => void;

/* ── Reconnect config ── */

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = 20;

export default class ScoreChangeStream {
    private stream: ChangeStream<ArcadeScoreDocument> | null = null;
    private resumeToken: ResumeToken | null = null;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private changeCallback: ScoreChangeCallback | null = null;

    public constructor(private database: Db) {}

    /**
     * Start watching the arcade_scores collection.
     * Call this once after database is ready.
     */
    public start(): void {
        this.closed = false;
        this.reconnectAttempt = 0;
        try {
            this.openStream();
        } catch (err) {
            log.warning('[ChangeStream] Failed to start — SSE will use polling fallback only.');
            log.warning(`[ChangeStream] Reason: ${err}`);
            this.closed = true;
            return;
        }
        log.info('[ChangeStream] Watching arcade_scores for changes.');
    }

    /**
     * Register a callback for score changes.
     */
    public onChange(callback: ScoreChangeCallback): void {
        this.changeCallback = callback;
    }

    /**
     * Graceful shutdown — close cursor, clear timers.
     */
    public async close(): Promise<void> {
        this.closed = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.stream) {
            try {
                await this.stream.close();
            } catch {
                // Ignore close errors during shutdown
            }
            this.stream = null;
        }

        log.info('[ChangeStream] Closed.');
    }

    /* ── Internal ── */

    private openStream(): void {
        if (this.closed) return;

        try {
            const collection = this.database.collection<ArcadeScoreDocument>('arcade_scores');

            // Pipeline: only watch inserts and updates (not deletes)
            const pipeline = [
                {
                    $match: {
                        operationType: { $in: ['insert', 'update', 'replace'] }
                    }
                }
            ];

            const options: Record<string, unknown> = {
                fullDocument: 'updateLookup' as const,
                maxAwaitTimeMS: 30_000
            };

            // Resume from last known position if available
            if (this.resumeToken) {
                options.resumeAfter = this.resumeToken;
            }

            this.stream = collection.watch(pipeline, options);

            this.stream.on('change', (event: ChangeStreamDocument<ArcadeScoreDocument>) => {
                this.reconnectAttempt = 0; // Reset on successful event

                // Store resume token
                if (event._id) {
                    this.resumeToken = event._id;
                }

                // Extract the full document
                const doc = this.extractDocument(event);
                if (!doc) return;

                const operation = event.operationType === 'insert' ? 'insert' : 'update';
                this.changeCallback?.(doc, operation);
            });

            this.stream.on('error', (error: Error) => {
                // Prevent unhandled rejection crash
                const msg = String(error);
                if (msg.includes('not a replica set') || msg.includes('not supported') || msg.includes('no such command') || msg.includes('ChangeStream')) {
                    log.warning('[ChangeStream] ⚠️ Async error confirms standalone MongoDB — disabling change streams.');
                    this.closed = true;
                    try { this.stream?.close(); } catch { /* noop */ }
                    this.stream = null;
                    return;
                }
                log.error('[ChangeStream] Stream error:');
                log.error(error);
                this.scheduleReconnect();
            });

            this.stream.on('close', () => {
                if (!this.closed) {
                    log.warning('[ChangeStream] Stream closed unexpectedly — reconnecting.');
                    this.scheduleReconnect();
                }
            });

            if (this.reconnectAttempt > 0) {
                log.info(`[ChangeStream] Reconnected (attempt ${this.reconnectAttempt}).`);
            }
        } catch (error) {
            // Check if MongoDB doesn't support change streams (standalone mode)
            const msg = String(error);
            if (msg.includes('not a replica set') || msg.includes('not supported') || msg.includes('no such command')) {
                log.warning('[ChangeStream] ⚠️ MongoDB is not configured as a replica set.');
                log.warning('[ChangeStream] Change streams require a replica set. SSE will serve initial payloads only.');
                log.warning('[ChangeStream] To enable real-time updates: use MongoDB Atlas, or convert to replica set.');
                this.closed = true; // Don't retry — this is a permanent config issue
                return;
            }

            log.error('[ChangeStream] Failed to open stream:');
            log.error(error);
            this.scheduleReconnect();
        }
    }

    private extractDocument(event: ChangeStreamDocument<ArcadeScoreDocument>): ArcadeScoreDocument | null {
        if ('fullDocument' in event && event.fullDocument) {
            return event.fullDocument;
        }
        return null;
    }

    private scheduleReconnect(): void {
        if (this.closed) return;

        // Clean up existing stream
        if (this.stream) {
            try { this.stream.removeAllListeners(); } catch { /* noop */ }
            this.stream = null;
        }

        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            log.error(`[ChangeStream] Exhausted ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Giving up.`);
            // Reset resume token — stale token may be the problem
            this.resumeToken = null;
            this.reconnectAttempt = 0;
        }

        const delay = RECONNECT_DELAYS_MS[
            Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
        ];

        log.warning(`[ChangeStream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempt++;
            this.openStream();
        }, delay);
    }
}
