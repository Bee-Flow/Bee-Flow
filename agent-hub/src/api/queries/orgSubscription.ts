// An organisation's Stripe subscription and what it could buy. Every call goes
// through cloudFetch, so a self-hosted install (no subscription routes) asks nothing
// and simply has no subscription.

import { useMutation, useQuery } from '@tanstack/react-query';
import { cloudFetch } from '../cloudFetch';
import { apiUrl } from '../typedRequest';
import { logger } from '../../utils/logger';
import { READ_ONCE } from './readOnce';

/** The cache key of one organisation's subscription, for the actions that write their answer into it. */
export const orgSubscriptionKey = (deploymentMode: string, orgId: string | undefined) => ['org-subscription', deploymentMode, orgId ?? null] as const;

/**
 * GET /api/subscriptions/orgs/{orgId}: the subscription, or null when there is none to
 * show (a 403 for a user outside the org or an org without a subscription, a self-hosted
 * install, or a server that could not be reached).
 */
export function useOrgSubscriptionQuery<T>(orgId: string | undefined, deploymentMode: string) {
    return useQuery<T | null, Error>({
        queryKey: orgSubscriptionKey(deploymentMode, orgId),
        queryFn: async () => {
            try {
                const res = await cloudFetch(deploymentMode, apiUrl('GET /api/subscriptions/orgs/{orgId}', { params: { orgId: orgId as string } }));
                return res?.ok ? ((await res.json()) as T | null) : null;
            } catch (err) {
                console.warn('[OrgInfoPanel] Failed to fetch subscription:', err);
                return null;
            }
        },
        enabled: !!orgId,
        ...READ_ONCE,
        gcTime: 0,
    });
}

/** What Stripe offers: each half is absent when its endpoint did not answer with a 2xx. */
export interface StripeOffer<Plan> { enabled?: boolean; plans?: Plan[] }

/** GET /api/stripe/status and /api/stripe/plans, together. */
export function useStripeOfferQuery<Plan>(deploymentMode: string) {
    return useQuery<StripeOffer<Plan>, Error>({
        queryKey: ['stripe-offer', deploymentMode],
        queryFn: async () => {
            try {
                const [statusRes, plansRes] = await Promise.all([
                    cloudFetch(deploymentMode, apiUrl('GET /api/stripe/status')),
                    cloudFetch(deploymentMode, apiUrl('GET /api/stripe/plans')),
                ]);
                const offer: StripeOffer<Plan> = {};
                if (statusRes?.ok) offer.enabled = ((await statusRes.json()) as { enabled: boolean }).enabled;
                if (plansRes?.ok) offer.plans = (await plansRes.json()) as Plan[];
                return offer;
            } catch (err) {
                console.warn('[OrgInfoPanel] Failed to fetch Stripe plans:', err);
                throw err;
            }
        },
        ...READ_ONCE,
    });
}

/** How long between two looks at the subscription, and for how long the return from checkout keeps looking. */
const SETTLE_EVERY_MS = 1500;
const SETTLE_FOR_MS = 30_000;

interface SettleCheckout {
    orgId: string;
    deploymentMode: string;
    /** The Stripe checkout session of the return URL, when it names one. */
    sessionId: string | null;
    /** Aborted when the page that came back from checkout goes away: the looking stops. */
    signal: AbortSignal;
}

/**
 * The return from a Stripe checkout: looks every 1.5 s, for up to 30 s, until the
 * subscription is active or trialing, and resolves with it; null when the time ran
 * out (or the caller left). Each look first reconciles straight from the Stripe
 * session, so activation does not depend on the webhook landing in time (or at all).
 */
export function useSettleCheckout<T extends { status?: string }>() {
    return useMutation<T | null, Error, SettleCheckout>({
        mutationFn: async ({ orgId, deploymentMode, sessionId, signal }) => {
            const deadline = Date.now() + SETTLE_FOR_MS;
            while (!signal.aborted && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, SETTLE_EVERY_MS));
                try {
                    if (sessionId) {
                        await cloudFetch(deploymentMode, apiUrl('GET /api/stripe/sessions/{id}', { params: { id: sessionId } })).catch(() => {});
                    }
                    const res = await cloudFetch(deploymentMode, apiUrl('GET /api/subscriptions/orgs/{orgId}', { params: { orgId } }));
                    if (res?.ok) {
                        const fresh = (await res.json()) as T | null;
                        if (fresh && (fresh.status === 'active' || fresh.status === 'trialing')) return fresh;
                    }
                } catch (err) { logger.debug('keep polling', err); }
            }
            return null;
        },
    });
}
