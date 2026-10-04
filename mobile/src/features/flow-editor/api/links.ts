/**
 * The addresses an automation can be reached at from outside
 * (routes/automation/webhooksAndRunOps.js): webhook URLs and public form
 * links. Owner only. Each belongs to one trigger node; `triggerStepId`
 * omitted means the primary trigger, and naming a trigger of the wrong kind
 * is a 400 with a sentence.
 *
 * A webhook's slug is its URL and a form's token is its URL AND its only
 * credential, so rotating a form mints a new link (the old one 404s at once),
 * while rotating a webhook keeps the URL and replaces its HMAC secret —
 * which the answer carries ONCE, to be copied before the screen closes.
 */

import { api } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';

import { flowPath } from './definition';
import {
    readFormLinkList,
    readFormLinkResponse,
    readWebhookList,
    readWebhookResponse,
} from './linkReaders';
import type { FlowFormLink, FlowWebhook } from './types';

const triggerBody = (triggerStepId?: string | null) => (triggerStepId ? { triggerStepId } : {});
const succeeded = (res: unknown) => field.bool(false)(pick(res, 'success'));

// ── Webhooks ─────────────────────────────────────────────────────────

export async function listWebhooks(id: string, signal?: AbortSignal): Promise<FlowWebhook[]> {
    return readWebhookList(await api.get<unknown>(`${flowPath(id)}/webhooks`, { signal }));
}

/** A new URL for a webhook trigger, with its secret (shown once). */
export async function createWebhook(id: string, triggerStepId?: string | null): Promise<FlowWebhook | null> {
    return readWebhookResponse(await api.post<unknown>(`${flowPath(id)}/webhook`, triggerBody(triggerStepId), { retry: false }));
}

/** A new secret for the same URL; callers still signing with the old one get 401 at once. */
export async function rotateWebhookSecret(id: string, slug: string): Promise<FlowWebhook | null> {
    const res = await api.post<unknown>(`${flowPath(id)}/webhook/${encodeURIComponent(slug)}/rotate`, undefined, { retry: false });
    return readWebhookResponse(res);
}

export async function deleteWebhook(id: string, slug: string): Promise<boolean> {
    return succeeded(await api.delete<unknown>(`${flowPath(id)}/webhook/${encodeURIComponent(slug)}`, { retry: false }));
}

// ── Form links ───────────────────────────────────────────────────────

export async function listFormLinks(id: string, signal?: AbortSignal): Promise<FlowFormLink[]> {
    return readFormLinkList(await api.get<unknown>(`${flowPath(id)}/forms`, { signal }));
}

/**
 * The public link of a form trigger. Idempotent on the server: asking twice
 * returns the link already handed out rather than orphaning it.
 */
export async function createFormLink(id: string, triggerStepId?: string | null): Promise<FlowFormLink | null> {
    return readFormLinkResponse(await api.post<unknown>(`${flowPath(id)}/form`, triggerBody(triggerStepId), { retry: false }));
}

/** Replace the link: the old address stops working immediately. */
export async function rotateFormLink(id: string, token: string): Promise<FlowFormLink | null> {
    const res = await api.post<unknown>(`${flowPath(id)}/form/${encodeURIComponent(token)}/rotate`, undefined, { retry: false });
    return readFormLinkResponse(res);
}

export async function deleteFormLink(id: string, token: string): Promise<boolean> {
    return succeeded(await api.delete<unknown>(`${flowPath(id)}/form/${encodeURIComponent(token)}`, { retry: false }));
}
