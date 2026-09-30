/**
 * The organisation's subscription and its Stripe hand-offs. Cloud only: on a
 * self-hosted install both roots answer 404 (`not_available_in_self_hosted`),
 * so the hooks never ask there.
 *
 * Verified against:
 * - server/routes/subscriptions.js — GET /orgs/:orgId for an org member (404
 *   without a subscription); POST /orgs/:orgId/{upgrade,cancel,reactivate} for
 *   its org admin; preview-change and cancel-downgrade behind requireAdmin,
 *   which an org admin passes (manage_users).
 * - server/routes/subscriptions/lifecycle.js — `{ planId }` (.strict()) for
 *   upgrade and preview-change; cancel, reactivate and cancel-downgrade take
 *   no body. Every lifecycle write answers the raw subscription row, which
 *   lacks `billing` and the pickers, so the hooks re-read the full GET.
 * - server/routes/stripe/{plans,checkout,portal,invoices}.js — GET /status,
 *   GET /plans; POST /checkout `{ planId, origin? }` (.strict()) → `{ url,
 *   sessionId }`; GET /sessions/:id reconciles a finished checkout; POST
 *   /portal `{ origin? }` → `{ url }`; GET /invoices → `{ invoices }`; GET
 *   /invoices/:id/pdf streams the PDF (ownership-checked).
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';
import { shareServerFile } from '@/core/api/shareFile';

import {
    readCheckoutSession,
    readCheckoutStart,
    readInvoices,
    readPlanChangePreview,
    readPlans,
    readPortalUrl,
    readStripeStatus,
    readSubscription,
} from './readers';
import type {
    CheckoutSession,
    CheckoutStart,
    Invoice,
    Plan,
    PlanChangePreview,
    StripeStatus,
    Subscription,
} from '../model/types';

const seg = encodeURIComponent;
const subPath = (orgId: string) => `/api/subscriptions/orgs/${seg(orgId)}`;

/** Null when the org has no subscription (404) or the caller may not see it (403). */
export async function getOrgSubscription(orgId: string, signal?: AbortSignal): Promise<Subscription | null> {
    return readSubscription(await optional(() => api.get<unknown>(subPath(orgId), { signal })));
}

export async function getStripeStatus(signal?: AbortSignal): Promise<StripeStatus> {
    return readStripeStatus(await api.get<unknown>('/api/stripe/status', { signal }));
}

/** The organisation plans on sale (the route's default `type`). */
export async function getStripePlans(signal?: AbortSignal): Promise<Plan[]> {
    return readPlans(await api.get<unknown>('/api/stripe/plans', { signal }));
}

/**
 * Start a Stripe Checkout for `planId`. `origin` is where Stripe sends the
 * customer back to (the web's own origin; the phone passes its server's).
 */
export async function startCheckout(planId: string, origin: string | undefined): Promise<CheckoutStart> {
    const body = origin ? { planId, origin } : { planId };
    return readCheckoutStart(await api.post<unknown>('/api/stripe/checkout', body));
}

/** Also reconciles a paid session the webhook has not applied yet. */
export async function getCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    return readCheckoutSession(await api.get<unknown>(`/api/stripe/sessions/${seg(sessionId)}`));
}

export async function openBillingPortal(origin: string | undefined): Promise<string | null> {
    return readPortalUrl(await api.post<unknown>('/api/stripe/portal', origin ? { origin } : {}));
}

export async function previewPlanChange(orgId: string, planId: string): Promise<PlanChangePreview> {
    return readPlanChangePreview(await api.post<unknown>(`${subPath(orgId)}/preview-change`, { planId }));
}

/** Upgrades apply now (prorated); downgrades are scheduled for the period end. */
export async function changePlan(orgId: string, planId: string): Promise<void> {
    await api.post(`${subPath(orgId)}/upgrade`, { planId });
}

export async function cancelDowngrade(orgId: string): Promise<void> {
    await api.post(`${subPath(orgId)}/cancel-downgrade`);
}

export async function cancelSubscription(orgId: string): Promise<void> {
    await api.post(`${subPath(orgId)}/cancel`);
}

export async function reactivateSubscription(orgId: string): Promise<void> {
    await api.post(`${subPath(orgId)}/reactivate`);
}

export async function listInvoices(signal?: AbortSignal): Promise<Invoice[]> {
    return readInvoices(await api.get<unknown>('/api/stripe/invoices', { signal }));
}

/** Fetch the PDF on the app's own session and open the share sheet on it. */
export async function shareInvoicePdf(invoice: Invoice): Promise<void> {
    const name = `${invoice.number || invoice.id}.pdf`;
    await shareServerFile(`/api/stripe/invoices/${seg(invoice.id)}/pdf`, name, 'application/pdf');
}
