/**
 * When the Tailwind `utilities` layer (src/tailwind-utilities.css) is fetched.
 *
 * It is the bulk of the stylesheet and only the signed-in product, the embeds
 * and the lazy public pages use it, so a marketing pageview must not block its
 * first paint on it (issue 245). A server-rendered CMS page carries the inlined
 * `#__BEEFLOW_CMS__` payload (server/routes/publicRender.js); that, and nothing
 * else, marks a marketing shell. Everything else (the app, the embed, the
 * login screen of a self-host with no CMS) waits for the CSS before React
 * renders, which is exactly the old behaviour for those routes.
 */

export const CMS_PAYLOAD_ID = '__BEEFLOW_CMS__';

type UtilitiesLoader = () => Promise<unknown>;

export function isServerRenderedMarketingPage(doc: Pick<Document, 'getElementById'>): boolean {
    return doc.getElementById(CMS_PAYLOAD_ID) !== null;
}

interface Scheduler {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
}

/**
 * Resolves when React may render. A marketing shell resolves at once and the
 * utilities arrive after idle (the few classes marketing shares, such as an
 * icon's `w-4 h-4`); anything else resolves after the CSS has loaded. A failed
 * load is reported through `onError` and never blocks the render.
 */
export async function ensureAppUtilities(
    doc: Pick<Document, 'getElementById'>,
    load: UtilitiesLoader,
    onError: (err: unknown) => void,
    win: Scheduler = window,
): Promise<void> {
    const run = (): Promise<void> => load().then(() => undefined, onError);
    if (!isServerRenderedMarketingPage(doc)) {
        await run();
        return;
    }
    if (typeof win.requestIdleCallback === 'function') {
        win.requestIdleCallback(() => void run(), { timeout: 3000 });
    } else {
        setTimeout(() => void run(), 1000);
    }
}
