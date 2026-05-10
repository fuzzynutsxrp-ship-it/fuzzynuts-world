import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

import type Connection from './connection';
import type SocketHandler from './sockethandler';
import type { HttpRequest, HttpResponse } from 'uws';

// Resolve client dist directory relative to cwd (packages/server/ when run via yarn workspace)
const clientDist = join(process.cwd(), '..', 'client', 'dist');

// Log resolved path for debugging
console.log(`[Static] Client dist path: ${clientDist}`);
console.log(`[Static] Client dist exists: ${existsSync(clientDist)}`);
if (existsSync(clientDist)) {
    try { console.log(`[Static] Client dist contents: ${readdirSync(clientDist).join(', ')}`); }
    catch { console.log('[Static] Could not list client dist contents'); }
}

const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.webp': 'image/webp',
    '.webmanifest': 'application/manifest+json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.map': 'application/json'
};

export default abstract class WebSocket {
    public addCallback?: (connection: Connection) => void;
    public initializedCallback?: () => void;

    protected constructor(
        protected host: string,
        protected port: number,
        protected socketHandler: SocketHandler
    ) {}

    /**
     * Serves static files from the client dist directory.
     * Falls back to index.html for SPA routing.
     */

    public httpResponse(response: HttpResponse, request: HttpRequest): void {
        let url = request.getUrl();

        // Default to index.html
        if (url === '/' || url === '') url = '/index.html';

        // Try the exact path, then with index.html appended (for directories)
        let filePath = join(clientDist, url);

        if (!existsSync(filePath)) {
            // Try adding index.html for directory paths
            filePath = join(clientDist, url, 'index.html');
        }

        if (!existsSync(filePath)) {
            // SPA fallback — serve root index.html
            filePath = join(clientDist, 'index.html');
        }

        try {
            let data = readFileSync(filePath);
            let ext = extname(filePath);
            let contentType = mimeTypes[ext] || 'application/octet-stream';

            response.writeHeader('Content-Type', contentType);
            response.writeHeader('Access-Control-Allow-Origin', '*');
            response.end(data);
        } catch {
            response.writeStatus('404 Not Found');
            response.end('Not found');
        }
    }

    /**
     * Callback for when a connection is added.
     * @param callback Contains the connection that was just added.
     */

    public onAdd(callback: (connection: Connection) => void): void {
        this.addCallback = callback;
    }

    /**
     * Callback for when the web socket has finished initializing.
     */

    public onInitialize(callback: () => void): void {
        this.initializedCallback = callback;
    }
}
