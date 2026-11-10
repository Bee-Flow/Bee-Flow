/**
 * What a notification request is allowed to be.
 *
 * The request crosses the IPC boundary from the page, so its TypeScript type
 * is a wish, not a fact: `beeflow.notify()` with no argument arrived here as
 * `undefined`, and reading `.title` of it threw in the main process. Anything
 * that is not an object is no request at all; inside one, each field is read
 * for what it must be. No Electron here, so the rule has tests.
 */

export interface NotifyContent {
    title: string;
    body: string;
    silent: boolean;
    /** Opened when the notification is clicked. */
    deepLink: string | undefined;
}

export const MAX_TITLE = 200;
export const MAX_BODY = 1000;

/** The notification to show, or null when `input` is not a request. */
export function readNotifyInput(input: unknown): NotifyContent | null {
    if (!input || typeof input !== 'object') return null;
    const { title, body, silent, deepLink } = input as Record<string, unknown>;
    return {
        title: String(title ?? 'Bee Flow').slice(0, MAX_TITLE),
        body: String(body ?? '').slice(0, MAX_BODY),
        silent: silent === true,
        deepLink: typeof deepLink === 'string' ? deepLink : undefined,
    };
}
