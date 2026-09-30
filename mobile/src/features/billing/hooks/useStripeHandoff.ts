/**
 * Checkout and the Customer Portal, opened in the in-app browser (a Chrome
 * Custom Tab), and what happens when the person comes back.
 *
 * On Android `openBrowserAsync` resolves as soon as the tab is open, so the
 * return is read from AppState instead: the tab puts the app in the
 * background, closing it brings the app back to `active`. A Checkout is then
 * settled (model/handoff.ts); after the portal, where a card or the plan may
 * have changed, the subscription and invoices are simply re-read.
 */

import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { describeError } from '@/core/api/errors';
import { getServerUrl } from '@/core/api/server';
import { useTranslation, type TranslateFn } from '@/core/i18n';

import { subscriptionQuery } from './queries';
import { getCheckoutSession, openBillingPortal, startCheckout } from '../api/endpoints';
import { billingKeys } from '../api/keys';
import { returnOrigin, settleCheckout, type CheckoutOutcome } from '../model/handoff';

type Pending = { kind: 'checkout'; sessionId: string | null } | { kind: 'portal' };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the screen says about a hand-off, inline (the web's `message` / `subMessage`). */
export interface HandoffNotice {
    tone: 'success' | 'error';
    text: string;
}

function outcomeNotice(outcome: CheckoutOutcome, t: TranslateFn): HandoffNotice {
    if (outcome === 'activated') return { tone: 'success', text: t('mobile.billing.activated', 'Subscription activated!') };
    if (outcome === 'cancelled') {
        return { tone: 'error', text: t('mobile.billing.checkout_cancelled', 'Checkout was cancelled. No changes were made.') };
    }
    return {
        tone: 'error',
        text: t(
            'mobile.billing.activation_slow',
            'Payment received, but activation is taking longer than expected. Refresh in a minute or email info@beeflow.nl.',
        ),
    };
}

export function useStripeHandoff(orgId: string | null) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const pending = useRef<Pending | null>(null);
    const alive = useRef(true);
    const [opening, setOpening] = useState<string | null>(null);
    const [settling, setSettling] = useState(false);
    const [notice, setNotice] = useState<HandoffNotice | null>(null);

    const onReturn = async (back: Pending) => {
        if (back.kind === 'portal' || !orgId) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.all });
            return;
        }
        setSettling(true);
        const outcome = await settleCheckout({
            session: () =>
                back.sessionId ? getCheckoutSession(back.sessionId) : Promise.resolve({ status: 'complete', subscriptionStatus: null }),
            subscription: () => queryClient.fetchQuery({ ...subscriptionQuery(orgId), staleTime: 0 }),
            wait,
            now: Date.now,
            cancelled: () => !alive.current,
        });
        if (!alive.current) return;
        setSettling(false);
        await queryClient.invalidateQueries({ queryKey: billingKeys.all });
        setNotice(outcomeNotice(outcome, t));
    };

    useEffect(() => {
        alive.current = true;
        const sub = AppState.addEventListener('change', (state) => {
            const back = pending.current;
            if (state !== 'active' || !back) return;
            pending.current = null;
            void onReturn(back);
        });
        return () => {
            alive.current = false;
            sub.remove();
        };
        // onReturn reads refs and the latest closure through them; the listener is set up once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orgId]);

    const open = async (key: string, start: () => Promise<{ url: string | null; next: Pending }>) => {
        setOpening(key);
        setNotice(null);
        try {
            const { url, next } = await start();
            if (!url) throw new Error(t('mobile.billing.no_url', 'Stripe did not return a page to open.'));
            pending.current = next;
            await WebBrowser.openBrowserAsync(url, { createTask: false });
        } catch (err) {
            pending.current = null;
            setNotice({ tone: 'error', text: describeError(err).message });
        } finally {
            setOpening(null);
        }
    };

    const origin = () => returnOrigin(getServerUrl());

    return {
        /** Which hand-off is being opened: a plan id, or 'portal'. */
        opening,
        settling,
        notice,
        dismissNotice: () => setNotice(null),
        checkout: (planId: string) =>
            open(planId, async () => {
                const started = await startCheckout(planId, origin());
                return { url: started.url, next: { kind: 'checkout', sessionId: started.sessionId } };
            }),
        portal: () =>
            open('portal', async () => ({ url: await openBillingPortal(origin()), next: { kind: 'portal' } })),
    };
}
