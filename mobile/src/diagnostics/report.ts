/**
 * Crash reporting for the Android app.
 *
 * Until now a JS exception on the phone did one of two things: in a release
 * build it took the whole app down to a grey screen with no message, and either
 * way it left no trace anywhere anyone could read. The server has had
 * `/api/client-errors` the whole time — the web ErrorBoundary posts to it — so
 * the missing half was entirely on this side.
 *
 * Three deliberate constraints:
 *
 *   1. **Fire and forget, and never throw.** A reporter that can fail is a
 *      second crash on top of the first, in the one code path with nothing left
 *      to catch it. Every call site here swallows.
 *
 *   2. **Scrubbed, and no route.** See scrub.ts. The server also truncates, but
 *      truncating on arrival is too late for anything that should not have been
 *      sent — the payload has already crossed the network and, for a customer
 *      running this behind their own proxy, some of their logs.
 *
 *   3. **Rate limited on the device.** A render loop that throws every frame
 *      would otherwise turn one bug into a sustained POST flood against the
 *      customer's own server. The cap is per app session and deliberately low;
 *      the tenth identical stack tells you nothing the first did not.
 *
 * Reports carry no user identifier. The server attaches one from the session if
 * it happens to have it, which is the right place for that decision.
 *
 * One acknowledged gap: a crash before the user has chosen a server has nowhere
 * to go, because there is no server to send it to. Those reports are dropped.
 * The alternative — a hardcoded fallback host — would make a self-hosted
 * install phone an address its operator never agreed to, to report a bug.
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { scrubMessage, scrubStack } from './scrub';
import { authHeaders } from '../api/client';
import { apiUrl } from '../api/server';

/** Per app session, across all labels. */
const MAX_REPORTS_PER_SESSION = 12;
/** No more than one report per this window, whatever fires. */
const MIN_INTERVAL_MS = 5_000;

let sent = 0;
let lastSentAt = 0;
const seen = new Set<string>();

/** RN installs this global; typing it here avoids pulling in @types/react-native. */
interface ErrorUtilsLike {
    setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
}

let installed = false;

export interface ErrorReport {
    /** Where it fired: 'error-boundary', 'global-handler', a feature name. */
    label: string;
    message: string;
    stack?: string;
    componentStack?: string;
}

/**
 * Decide whether to send. Exported for the test — the interesting behaviour of
 * a rate limiter is the requests it drops, and that is unobservable through
 * the network in a unit test.
 */
export function shouldSend(fingerprint: string, now: number): boolean {
    if (sent >= MAX_REPORTS_PER_SESSION) return false;
    // The same stack twice is the same bug. This matters more than the
    // interval: a boundary that re-renders and re-throws produces bursts of
    // one identical report.
    if (seen.has(fingerprint)) return false;
    if (now - lastSentAt < MIN_INTERVAL_MS) return false;
    seen.add(fingerprint);
    sent += 1;
    lastSentAt = now;
    return true;
}

/** Test seam — the counters are module state by design. */
export function _resetReporter(): void {
    sent = 0;
    lastSentAt = 0;
    seen.clear();
}

function buildExtra(): { commitSha?: string; buildProfile?: string } {
    return (Constants.expoConfig?.extra ?? {}) as { commitSha?: string; buildProfile?: string };
}

/**
 * Send one report. Returns a promise only so tests can await it; nothing in the
 * app should, and nothing in the app should catch it either — it does not
 * reject.
 */
export async function reportClientError(report: ErrorReport): Promise<void> {
    try {
        const message = scrubMessage(report.message);
        const stack = scrubStack(report.stack ?? '');
        // The component stack is React's own text — component names and, in
        // dev, source paths. It gets the message pass, because a component
        // name can be a screen name and the file paths in it are ours, not the
        // user's.
        const componentStack = scrubMessage(report.componentStack ?? '', 4000);

        // Fingerprint on the scrubbed text, so two crashes that differ only in
        // a redacted id count as one.
        if (!shouldSend(`${report.label}|${message}|${stack.slice(0, 400)}`, Date.now())) return;

        const extra = buildExtra();
        // Deliberately NOT api.post(): a failing report must not retry (the
        // client retries twice by default, which is three POSTs per crash) and
        // must not trip the global 401 handler, which would show a lock screen
        // to someone whose only problem was a render error.
        const res = await fetch(apiUrl('/api/client-errors'), {
            method: 'POST',
            credentials: 'include',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                label: scrubMessage(report.label, 64),
                message,
                stack,
                componentStack,
                // `url` is omitted on purpose — see scrub.ts. The server's
                // schema has the field; this client never fills it.
                userAgent: `BeeFlow-Android/${Constants.expoConfig?.version ?? '0'} (${Platform.OS} ${String(Platform.Version)})`,
                at: new Date().toISOString(),
                buildSha: extra.commitSha ?? '',
            }),
        });
        // A 429 means the server's own limiter caught us. Stop for the session
        // rather than keep knocking.
        if (res.status === 429) sent = MAX_REPORTS_PER_SESSION;
    } catch {
        /* A crash reporter that reports its own failure has nowhere to report it. */
    }
}

/**
 * Catch what the ErrorBoundary cannot: a throw in an event handler, a rejected
 * promise nobody awaited, a native module callback.
 *
 * `ErrorUtils` is React Native's own global handler hook — it is what prints
 * the red box in dev and what shows the grey screen in release. Chaining the
 * previous handler rather than replacing it is what keeps both of those
 * working; a reporter that silently disables the red box would cost more in
 * developer time than it ever returns in reports.
 */
export function installGlobalErrorHandler(): void {
    const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (!utils?.setGlobalHandler) return;
    if (installed) return;
    installed = true;

    const previous = utils.getGlobalHandler?.();
    utils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        const err = error instanceof Error ? error : new Error(String(error));
        void reportClientError({
            label: isFatal ? 'global-fatal' : 'global-handler',
            message: err.message,
            stack: err.stack,
        });
        previous?.(error, isFatal);
    });
}
