/**
 * A request made from inside the main window's page, as the web app makes it.
 *
 * The server's session cookie is SameSite=Lax by default. A request from the
 * main process belongs to no page, so Chromium leaves a Lax cookie out of it,
 * also with `credentials: 'include'`, and the server answers 401 to a
 * signed-in user. Run from the page itself (same origin as the workspace), the
 * request carries the sign-in exactly like the app's own calls do.
 *
 * Only data crosses into the page: the URL and init are serialised with
 * JSON.stringify, never spliced in as code.
 */

import type { SessionFetch } from './pairing.ts';

/** The part of Electron's WebContents this needs, so it can be tested without Electron. */
export interface PageRunner {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

interface PageAnswer {
    ok: boolean;
    status: number;
    body: string;
}

function isPageAnswer(value: unknown): value is PageAnswer {
    if (!value || typeof value !== 'object') return false;
    const answer = value as Record<string, unknown>;
    return typeof answer.ok === 'boolean' && typeof answer.status === 'number' && typeof answer.body === 'string';
}

/** The page-side script: fetch, then hand back plain data (a Response cannot cross). */
export function pageFetchScript(url: string, init: Parameters<SessionFetch>[1]): string {
    return `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)})`
        + '.then(async (r) => ({ ok: r.ok, status: r.status, body: await r.text() }))';
}

export function pageFetch(page: PageRunner): SessionFetch {
    return async (url, init) => {
        const answer = await page.executeJavaScript(pageFetchScript(url, init), true);
        if (!isPageAnswer(answer)) return { ok: false, status: 0 };
        return { ok: answer.ok, status: answer.status, json: async () => JSON.parse(answer.body) as unknown };
    };
}
