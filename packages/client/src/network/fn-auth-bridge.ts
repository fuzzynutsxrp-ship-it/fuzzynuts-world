/**
 * fn-auth-bridge.ts - FuzzyNuts Lobby / Kaetram postMessage auth bridge.
 *
 * Injected into the Kaetram client so the FuzzyNuts lobby iframe parent
 * can pass a wallet session token into the game for auto-login.
 *
 * Protocol (3 messages):
 *   1. FN_GAME_READY      (child to parent): game signals readiness
 *   2. FN_AUTH_HANDSHAKE   (parent to child): lobby sends session token
 *   3. FN_AUTH_ACK         (child to parent): game confirms receipt
 *
 * CRITICAL: event.origin is verified on BOTH sides.
 * Token is stored in memory only - NEVER localStorage.
 */

const FN_ALLOWED_PARENT_ORIGINS = new Set(['https://www.fuzzynuts.xyz', 'http://localhost:3000']);

declare global {
    interface Window {
        __FN_AUTH_TOKEN__?: string;
        kaetramLogin?(tok: string): void;
    }
}

/** Store the token in memory. */
function storeToken(tok: string): void {
    window.__FN_AUTH_TOKEN__ = tok;
}

/** Trigger Kaetram internal login. */
function triggerLogin(tok: string): void {
    let { kaetramLogin } = window;
    if (typeof kaetramLogin === 'function') kaetramLogin(tok);
    else console.log('[fn-auth] tok received, kaetramLogin() not wired');
}

window.addEventListener('message', (event: MessageEvent) => {
    if (!FN_ALLOWED_PARENT_ORIGINS.has(event.origin)) return;
    let { data } = event;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'FN_AUTH_HANDSHAKE' && data.token) {
        storeToken(data.token);
        triggerLogin(data.token);
        let { source, origin } = event;
        if (source && typeof (source as WindowProxy).postMessage === 'function')
            (source as WindowProxy).postMessage(
                {
                    type: 'FN_AUTH_ACK',
                    gameId: data.gameId || 'kaetram',
                    timestamp: Date.now()
                },
                origin
            );
    }
});

function signalReady(): void {
    if (window.parent !== window)
        window.parent.postMessage({ type: 'FN_GAME_READY', timestamp: Date.now() }, '*');
}

if (document.readyState === 'complete' || document.readyState === 'interactive') signalReady();
else window.addEventListener('load', signalReady);

export {};
