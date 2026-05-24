/**
 * ═══════════════════════════════════════════════════════════════
 * SSE Types — Strict TypeScript for leaderboard streaming
 * ═══════════════════════════════════════════════════════════════
 */

/* ── Valid game slugs (must match SCORE_CAPS keys in scores.ts) ── */

export const VALID_GAME_SLUGS = [
    'mario',
    'survivors',
    'minigolf',
    'racer',
    'top-secret',
    'fuzzynuts-world'
] as const;

export type GameSlug = (typeof VALID_GAME_SLUGS)[number];

export type SSETimeframe = 'weekly' | 'alltime';

/* ── Score entry as sent to clients ── */

export interface SSEScoreEntry {
    rank: number;
    wallet: string;
    name: string;
    game: string;
    score: number;
    weekKey: string;
}

/* ── SSE message types ── */

export type SSEMessageType = 'initial' | 'update' | 'replace' | 'ping';

export interface SSEMessage {
    type: SSEMessageType;
    data: SSEScoreEntry[];
    timestamp: number;
}

/* ── MongoDB arcade_scores document shape ── */

export interface ArcadeScoreDocument {
    wallet: string;
    game: string;
    score: number;
    weekKey: string;
    submittedAt: number;
    ip: string;
}

/* ── SSE client tracking ── */

export interface SSEClient {
    id: string;
    game: string | null;
    timeframe: SSETimeframe;
    watchWallet: string | null;
    weekKey: string;
    aborted: boolean;
    lastEventId: number;
    queuedEvents: string[];
}

/* ── Query param validation result ── */

export interface SSEQueryParams {
    valid: true;
    timeframe: SSETimeframe;
    game: string | null;
    watch: string | null;
    weekKey: string;
}

export interface SSEQueryError {
    valid: false;
    error: string;
}

export type SSEQueryResult = SSEQueryParams | SSEQueryError;

/* ── Constants ── */

export const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export const SSE_MAX_ENTRIES = 50;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_MAX_QUEUE = 10;
export const SSE_CORS_ORIGINS = ['https://fuzzynuts.xyz', 'https://www.fuzzynuts.xyz'];
