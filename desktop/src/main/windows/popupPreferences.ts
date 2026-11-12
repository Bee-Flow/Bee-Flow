/**
 * The preferences of a window a page opens with `window.open`.
 *
 * Those windows are the sign-in popups: a provider's pages, and the server's
 * own sign-in routes that hand the result back to the opener with
 * `postMessage` (server/auth/oauth). None of them uses `window.beeflow`, and a
 * popup can be pointed at any page the server's origin answers, including the
 * ones that show what a user or a model wrote. So a popup keeps every
 * isolation setting of the window that opened it and loses the preload: no
 * bridge, whatever page it ends up on.
 *
 * Deliberately free of `electron` (types only), so the tests can run it.
 */

import type { WebPreferences } from 'electron';

export function withoutBridge(preferences: WebPreferences | undefined): WebPreferences {
    const { preload: _preload, additionalArguments: _arguments, ...isolation } = preferences ?? {};
    return isolation;
}
