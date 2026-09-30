/**
 * The Stripe hand-offs, device-side: where Stripe sends the customer back to,
 * and what the app does once they come back from a Checkout.
 *
 * On the web a paid Checkout lands on `…/license?checkout=success&session_id=`
 * and OrgInfoPanel polls until the webhook has made the subscription active.
 * The phone opens Checkout in a Custom Tab and learns nothing from the
 * redirect, so it keeps the session id it was handed, and when the app is in
 * the foreground again asks the server about that session: still open or
 * expired means the customer left without paying (the web's
 * `?checkout=cancelled`); complete means paid, and the subscription is polled
 * the way the web polls it — every 1.5 s for up to 30 s.
 */

import { isSettled } from './subscription';
import type { CheckoutSession, Subscription } from './types';

/** The bare origin the server accepts (ORIGIN_RE in routes/stripe/checkout.js), or none. */
export function returnOrigin(serverUrl: string | null): string | undefined {
    if (!serverUrl) return undefined;
    try {
        const url = new URL(serverUrl);
        return /^https?:$/.test(url.protocol) ? `${url.protocol}//${url.host}` : undefined;
    } catch {
        return undefined;
    }
}

export type CheckoutOutcome = 'activated' | 'cancelled' | 'slow';

export interface SettleDeps {
    /** GET /api/stripe/sessions/:id — reconciles a paid session as it answers. */
    session: () => Promise<CheckoutSession>;
    subscription: () => Promise<Subscription | null>;
    wait: (ms: number) => Promise<void>;
    now: () => number;
    /** Checked between rounds: the screen went away. */
    cancelled?: () => boolean;
}

export const SETTLE_INTERVAL_MS = 1500;
export const SETTLE_DEADLINE_MS = 30_000;

/** The customer is back from Checkout: did they pay, and is it live yet? */
export async function settleCheckout(deps: SettleDeps): Promise<CheckoutOutcome> {
    const first = await deps.session().catch(() => null);
    if (first && first.status !== 'complete') return 'cancelled';
    const deadline = deps.now() + SETTLE_DEADLINE_MS;
    while (!deps.cancelled?.() && deps.now() < deadline) {
        const sub = await deps.subscription().catch(() => null);
        if (isSettled(sub)) return 'activated';
        await deps.wait(SETTLE_INTERVAL_MS);
        await deps.session().catch(() => null);
    }
    return 'slow';
}
