/**
 * What the app does with a deep link the OS hands it.
 *
 * There is exactly one today, and it is not a destination: `beeflow://oauth`
 * is the OAuth handoff. Its whole purpose is to reach MainActivity so that
 * expo-web-browser's lifecycle listener closes the Custom Tab
 * (WebBrowserPackage.onNewIntent → finishAndRemoveTask). Nothing should
 * navigate — the sign-in flow is already running on the login screen and the
 * auth gate decides what happens next.
 *
 * Without this file that link is actively destructive rather than merely
 * useless. There is no `app/oauth` route, so expo-router falls through to the
 * `+not-found` screen it injects automatically; ExpoRoot renders only the
 * focused root route, so app/_layout.tsx — and with it the auth gate and the
 * login screen — UNMOUNTS. login.tsx's cleanup then aborts the in-flight SSO
 * controller, and the sign-in it was about to complete dies on the doorstep.
 *
 * Returning `null` is what prevents that: expo-router treats a falsy return as
 * "no redirection, stay where you are" on both the initial-URL path and the
 * subscription path (see getLinkingConfig.js and link/linking.js). Returning a
 * href instead — even '/' — still performs a navigation, which on a signed-out
 * app re-runs the gate's replace.
 *
 * The pass-through arm is load-bearing: this hook sees EVERY deep link the app
 * will ever receive, so anything not matched here must be returned untouched.
 */

/**
 * True for the OAuth handoff link.
 *
 * `path` is the RAW url (`beeflow://oauth`), not a router segment — hence the
 * scheme in the comparison. Matched by prefix because the server appends
 * `?error=<code>` when the round trip failed: the app ignores the detail (it
 * finds out by whether a token appears) but the link still has to be swallowed
 * rather than navigated to.
 */
export function isOAuthHandoff(path: string): boolean {
    return /^beeflow:\/\/oauth(\/|\?|#|$)/i.test(path);
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
    try {
        return isOAuthHandoff(path) ? null : path;
    } catch {
        // Documented as crashing the app if this throws, so it cannot be
        // allowed to. A link we failed to classify is better delivered.
        return path;
    }
}
