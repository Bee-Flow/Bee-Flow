/**
 * The probe's requests, sent through Chromium's network stack.
 *
 * The window loads the server through Chromium. If the probe used Node's
 * fetch instead, the two would disagree about everything that differs between
 * them: the system proxy (which Chromium honours on every OS and Node does
 * not), the certificates a user added to their OS or NSS store, and HSTS. The
 * probe would then refuse a server the window could load, or approve one it
 * cannot.
 *
 * `net.fetch` would be the obvious tool, but Electron documents its Response
 * `url` as incorrect, and the final URL after redirects is the one thing the
 * probe most needs from it. `net.request` with `redirect: 'manual'` reports
 * every hop, so this follows them itself and remembers where it ended up.
 *
 * `net` is passed in rather than imported, so this runs in the unit tests
 * against a fake and only the app hands it the real one.
 */

import type { FetchLike, ProbeResponse } from './probe.ts';

/** The slice of Electron's `net.request` this needs. */
export interface NetLike {
    request(options: { url: string; method?: string; redirect?: 'follow' | 'error' | 'manual'; useSessionCookies?: boolean }): ClientRequestLike;
}

export interface ClientRequestLike {
    setHeader(name: string, value: string): void;
    on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string) => void): this;
    on(event: 'response', listener: (response: IncomingLike) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    followRedirect(): void;
    abort(): void;
    end(): void;
}

export interface IncomingLike {
    statusCode: number;
    headers: Record<string, string | string[]>;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
}

/** More than any sane server chain; a loop fails instead of spinning. */
const MAX_REDIRECTS = 10;
/** A health check is a few hundred bytes; a web app page a few KB. */
const MAX_BODY_BYTES = 1024 * 1024;

export function chromiumFetch(net: NetLike): FetchLike {
    return (url, init) =>
        new Promise<ProbeResponse>((resolve, reject) => {
            if (init?.signal?.aborted) {
                reject(abortError());
                return;
            }
            // No cookies: the probe asks about the server, not about the
            // signed-in user, and must not send a session to an address the
            // user has not chosen yet.
            const request = net.request({ url, method: 'GET', redirect: 'manual', useSessionCookies: false });
            let finalUrl = url;
            let redirects = 0;
            let settled = false;
            const finish = (action: () => void) => {
                if (settled) return;
                settled = true;
                init?.signal?.removeEventListener('abort', onAbort);
                action();
            };
            const onAbort = () => {
                request.abort();
                finish(() => reject(abortError()));
            };
            init?.signal?.addEventListener('abort', onAbort);

            for (const [name, value] of Object.entries(init?.headers ?? {})) request.setHeader(name, value);

            request.on('redirect', (_statusCode, _method, redirectUrl) => {
                redirects += 1;
                if (redirects > MAX_REDIRECTS) {
                    request.abort();
                    finish(() => reject(new Error('net::ERR_TOO_MANY_REDIRECTS')));
                    return;
                }
                finalUrl = redirectUrl;
                request.followRedirect();
            });
            request.on('response', (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
                });
                response.on('error', (error) => finish(() => reject(error)));
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    finish(() =>
                        resolve({
                            status: response.statusCode,
                            url: finalUrl,
                            headers: { get: (name) => headerValue(response.headers, name) },
                            text: async () => body,
                        }),
                    );
                });
            });
            request.on('error', (error) => finish(() => reject(error)));
            request.end();
        });
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | null {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== wanted) continue;
        return Array.isArray(value) ? value.join(', ') : value;
    }
    return null;
}

function abortError(): Error {
    const error = new Error('The request was aborted');
    error.name = 'AbortError';
    return error;
}
