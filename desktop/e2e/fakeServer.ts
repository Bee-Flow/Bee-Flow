/**
 * A stand-in Bee Flow server for the end-to-end tests.
 *
 * It reproduces exactly the parts of the real server the desktop client
 * depends on when it connects, and nothing else:
 *
 * - `GET /api/health` answers `{ status: 'ok' }` (server/index.js).
 * - `GET /` is the SPA: an HTML page with a `#root`, like agent-hub's
 *   index.html. With `spa: false` it is instead Express's default 404, which is
 *   what the API port of a Docker install answers, because the SPA lives in the
 *   separate nginx container.
 * - The Origin gate: a request carrying an `Origin` the server does not list
 *   gets `403 {"error":"Origin not allowed"}` before any route runs, whatever
 *   the method (server/index.js, the CORS_ORIGIN check).
 * - `GET /auth/setup-status` reports `serverUrl`, the address the SPA sends
 *   single sign-on to (server/auth/login/setupRoutes.js).
 *
 * The SPA page records what the desktop bridge gives it on `window.__e2e`, so
 * a test can ask the page what it saw rather than inferring it.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServerOptions {
    /** Address to bind; defaults to 127.0.0.1. */
    host?: string;
    /** Port to bind; 0 picks a free one. */
    port?: number;
    /** Serve the SPA at `/`. False makes this look like the bare API port. */
    spa?: boolean;
    /**
     * Origins the gate accepts. `'self'` (the default) accepts the origin this
     * server is reached at, which is what a correctly configured CORS_ORIGIN
     * does. An explicit list reproduces a server whose CORS_ORIGIN names some
     * other address — the stock `http://localhost:5176`, typically.
     */
    allowedOrigins?: 'self' | string[];
    /** Answer every request with a 301 to this origin, keeping the path. */
    redirectTo?: string;
    /** What `/auth/setup-status` reports as `serverUrl`. */
    ssoServerUrl?: string;
    /** After an SSO hop, where `/auth/login/<provider>` sends the browser back to. */
    ssoReturnTo?: string;
}

export interface FakeServer {
    readonly origin: string;
    readonly port: number;
    readonly host: string;
    /** Every request seen, oldest first. */
    readonly requests: Array<{ method: string; path: string; origin: string | undefined; client: string | undefined }>;
    close(): Promise<void>;
}

const SPA_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Bee Flow - AI</title>
</head>
<body>
<div id="root">e2e workspace</div>
<script>
window.__e2e = {
    hasBridge: typeof window.beeflow === 'object' && window.beeflow !== null,
    commands: [],
    secureContext: window.isSecureContext === true,
    subtle: typeof (window.crypto && window.crypto.subtle) === 'object',
};
if (window.beeflow && typeof window.beeflow.onCommand === 'function') {
    window.beeflow.onCommand(function (command) { window.__e2e.commands.push(command); });
}
</script>
</body>
</html>
`;

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
    const host = options.host ?? '127.0.0.1';
    const requests: FakeServer['requests'] = [];
    let origin = '';

    const server = http.createServer((req, res) => {
        // Redirecting is this fixture's job, and only onto the origin the test configures.
        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect2
        const url = new URL(req.url ?? '/', 'http://placeholder');
        const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        const client = typeof req.headers['x-beeflow-client'] === 'string' ? req.headers['x-beeflow-client'] : undefined;
        requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, origin: requestOrigin, client });

        if (options.redirectTo) {
            // Joined as strings onto the configured origin: `new URL(path, base)`
            // reads a path that normalises to `//other.host` as protocol-relative.
            res.writeHead(301, { Location: `${new URL(options.redirectTo).origin}${url.pathname}${url.search}` });
            res.end();
            return;
        }

        // The gate runs before every route, as it does on the real server.
        if (requestOrigin) {
            const allowed = options.allowedOrigins === undefined || options.allowedOrigins === 'self' ? [origin] : options.allowedOrigins;
            if (!allowed.includes(requestOrigin)) {
                sendJson(res, 403, { error: 'Origin not allowed' });
                return;
            }
        }

        if (url.pathname === '/api/health') {
            sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString(), appVersion: 'e2e', otel: false });
            return;
        }
        if (url.pathname === '/auth/setup-status') {
            sendJson(res, 200, { needsSetup: false, serverUrl: options.ssoServerUrl ?? '' });
            return;
        }
        if (url.pathname.startsWith('/auth/login/')) {
            res.writeHead(302, { Location: options.ssoReturnTo ?? `${origin}/?signed-in=1` });
            res.end();
            return;
        }
        if (url.pathname === '/slow') {
            // Long enough for the page to replace this navigation with another.
            setTimeout(() => {
                if (!res.writableEnded) sendHtml(res, 200, SPA_HTML);
            }, 5_000);
            return;
        }
        if (options.spa === false) {
            // Express's own 404 for an unknown route.
            sendHtml(res, 404, '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /</pre>\n</body>\n</html>\n');
            return;
        }
        sendHtml(res, 200, SPA_HTML);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, host, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

    return {
        origin,
        port,
        host,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}
