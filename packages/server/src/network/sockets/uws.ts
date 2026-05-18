import WebSocket from '../websocket';
import Connection from '../connection';
import ScoresAPI from '../../api/scores';
import RewardsAPI from '../../api/rewards';

import log from '@kaetram/common/util/log';
import config from '@kaetram/common/config';
import Utils from '@kaetram/common/util/utils';
import { Modules } from '@kaetram/common/network';
import { App, DISABLED } from 'uws';

import type SocketHandler from '../sockethandler';
import type { HeaderWebSocket } from '../connection';
import type { WebSocket as WS, HttpRequest, HttpResponse, us_socket_context_t } from 'uws';
import type { ConnectionInfo } from '@kaetram/common/types/network';
import type MongoDB from '@kaetram/common/database/mongodb/mongodb';

export default class UWS extends WebSocket {
    private scoresAPI?: ScoresAPI;
    private rewardsAPI?: RewardsAPI;

    public constructor(socketHandler: SocketHandler, database?: MongoDB) {
        super(config.host, config.port, socketHandler);

        // Initialize the Scores API if database is available
        const db = database?.getDb();
        if (db) {
            this.scoresAPI = new ScoresAPI(db);
            log.info('[UWS] Scores API routes registered at /api/scores');

            this.rewardsAPI = new RewardsAPI(db);
            log.info('[UWS] Prize Rewards API routes registered at /api/rewards/eligibility, /api/rewards/claim');
        }

        const app = App({});

        // ── Register API routes BEFORE catch-all static handler ──
        app.get('/api/scores', (res: HttpResponse, req: HttpRequest) => {
            if (this.scoresAPI) this.scoresAPI.handleGet(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.post('/api/scores', (res: HttpResponse, req: HttpRequest) => {
            if (this.scoresAPI) this.scoresAPI.handlePost(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.options('/api/scores', (res: HttpResponse) => {
            if (this.scoresAPI) this.scoresAPI.handleOptions(res);
            else {
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end();
            }
        });

        // ── Achievement Rewards API routes ──
        app.get('/api/rewards', (res: HttpResponse, req: HttpRequest) => {
            if (this.scoresAPI) this.scoresAPI.handleRewardsGet(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.options('/api/rewards', (res: HttpResponse) => {
            if (this.scoresAPI) this.scoresAPI.handleRewardsOptions(res);
            else {
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end();
            }
        });

        // ── Prize Rewards API routes (eligibility + claiming + health) ──
        app.get('/api/rewards/eligibility', (res: HttpResponse, req: HttpRequest) => {
            if (this.rewardsAPI) this.rewardsAPI.handleEligibility(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.get('/api/rewards/claim/status', (res: HttpResponse, req: HttpRequest) => {
            if (this.rewardsAPI) this.rewardsAPI.handleClaimStatus(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.get('/api/rewards/health', (res: HttpResponse, req: HttpRequest) => {
            if (this.rewardsAPI) this.rewardsAPI.handleHealth(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.post('/api/rewards/claim', (res: HttpResponse, req: HttpRequest) => {
            if (this.rewardsAPI) this.rewardsAPI.handleClaim(res, req);
            else {
                res.writeStatus('503 Service Unavailable');
                res.writeHeader('Content-Type', 'application/json');
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ ok: false, error: 'database_unavailable' }));
            }
        });

        app.options('/api/rewards/*', (res: HttpResponse) => {
            if (this.rewardsAPI) this.rewardsAPI.handleOptions(res);
            else {
                res.writeHeader('Access-Control-Allow-Origin', '*');
                res.writeHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
                res.end();
            }
        });

        // ── Static file handler (catch-all) ──
        app.get('/*', this.httpResponse.bind(this));

        // ── WebSocket handler ──
        app.ws('/*', {
                compression: DISABLED,
                idleTimeout: 15,
                maxPayloadLength: 32 * 1024 * 1024,

                upgrade: this.handleUpgrade.bind(this),
                open: this.handleConnection.bind(this),
                message: this.handleMessage.bind(this),
                close: this.handleClose.bind(this)
            })
            .listen(config.port, (socket: WS<ConnectionInfo>) => {
                if (!socket) throw new Error(`Failed to listen on port ${config.port}`);

                this.initializedCallback?.();
            });
    }

    /**
     * Upgrades the HTTP connection to a WebSocket connection. We use this
     * to extract the reverse proxy IP address through the headers.
     */

    private handleUpgrade(
        response: HttpResponse,
        request: HttpRequest,
        context: us_socket_context_t
    ): void {
        response.upgrade(
            {
                url: request.getUrl(),
                remoteAddress: request.getHeader('cf-connecting-ip')
            },
            request.getHeader('sec-websocket-key'),
            request.getHeader('sec-websocket-protocol'),
            request.getHeader('sec-websocket-extensions'),
            context
        );
    }

    /**
     * Handles the creation and organizing of a socket. With UWS we store the instance
     * into the socket's user data so that we can identify the socket later on.
     * @param socket The socket that the connection will be created for.
     */

    private handleConnection(socket: WS<ConnectionInfo>): void {
        let instance = Utils.createInstance(Modules.EntityType.Player),
            connection = new Connection(instance, socket as HeaderWebSocket);

        socket.getUserData().instance = instance;

        this.addCallback?.(connection);
    }

    /**
     * Responsible for converting the buffer into a string and then parsing it into JSON.
     * @param socket The socket that the message was received from (used to identify the connection).
     * @param data Contains buffer data that we convert into a string.
     */

    private handleMessage(socket: WS<ConnectionInfo>, data: ArrayBuffer): void {
        let connection = this.socketHandler.get(socket.getUserData().instance);

        // Prevent the server from crashing if the connection is not found.
        if (!connection)
            return log.error(`No connection found for ${socket.getUserData().instance}`);

        // Increment the rate for the connection.
        connection.messageRate++;

        // Reject the connection once we reach the rate limit threshold.
        if (connection.messageRate > config.messageLimit) return connection.reject('ratelimit');

        try {
            // Convert the buffer into a string.
            let message = new TextDecoder().decode(data);

            // Prevent duplicates in a short period of time.
            if (connection.isDuplicate(message)) return;

            // Pass the parsed JSON onto the message handler.
            connection.messageCallback?.(JSON.parse(message));
        } catch (error) {
            log.error(`Message could not be parsed: ${new TextDecoder().decode(data)}.`);
            log.error(error);
        }
    }

    /**
     * Handles closing the socket and removing our connection from the handler.
     * @param socket The socket that we are closing (used to identify the connection).
     */

    private handleClose(socket: WS<ConnectionInfo>): void {
        let connection = this.socketHandler.get(socket.getUserData().instance);

        if (!connection)
            return log.error(`No connection found closing ${socket.getUserData().instance}`);

        // Mark the connection as closed to prevent any further messages from being sent.
        connection.closed = true;

        this.socketHandler.remove(connection.instance);

        connection.handleClose();
    }
}
