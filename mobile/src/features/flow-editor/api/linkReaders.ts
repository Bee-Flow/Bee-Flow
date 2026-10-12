/**
 * Contract readers for what hangs off an automation without being part of its
 * flow: webhook URLs, public form links (routes/automation/webhooksAndRunOps.js
 * over stores/automationStore/{webhooks,forms}.js) and the sidebar folders
 * (stores/automationStore/folders.js).
 */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type { FlowFolder, FlowFormLink, FlowWebhook } from './types';

// ── Webhooks ─────────────────────────────────────────────────────────

/**
 * A webhook row. The list carries no secret (the store never selects it); a
 * create or a rotate carries it ONCE, and a rotate carries nothing else — so
 * every field but the slug has a stated default.
 */
export const readWebhook: (raw: unknown) => FlowWebhook = shapeOf({
    id: field.str(''),
    automationId: field.str(''),
    triggerStepId: field.strOrNull,
    url: field.str(''),
    allowMethods: field.strArrayOrNull,
    lastSeenAt: field.strOrNull,
    createdAt: field.strOrNull,
    secret: field.strOrNull,
});

export function readWebhookList(raw: unknown): FlowWebhook[] {
    return field.list(readWebhook)(pick(raw, 'webhooks')).filter((w) => w.id !== '');
}

/**
 * POST /:id/webhook answers `{ webhook, url }` with the absolute URL on both;
 * POST …/rotate answers `{ webhook: {id, automationId, secret} }` only.
 */
export function readWebhookResponse(raw: unknown): FlowWebhook | null {
    const webhook = nullable(readWebhook)(pick(raw, 'webhook'));
    if (!webhook) return null;
    return { ...webhook, url: webhook.url || field.str('')(pick(raw, 'url')) };
}

// ── Form links ───────────────────────────────────────────────────────

export const readFormLink: (raw: unknown) => FlowFormLink = shapeOf({
    id: field.str(''),
    automationId: field.str(''),
    triggerStepId: field.strOrNull,
    url: field.str(''),
    createdAt: field.strOrNull,
    lastSeenAt: field.strOrNull,
    submissions: field.num(0),
    audience: field.str('restricted'),
    sharedGroups: field.strArray,
    sharedUserIds: field.strArray,
});

export function readFormLinkList(raw: unknown): FlowFormLink[] {
    return field.list(readFormLink)(pick(raw, 'forms')).filter((f) => f.id !== '');
}

/** POST /:id/form and …/rotate: `{ form, url }`. */
export function readFormLinkResponse(raw: unknown): FlowFormLink | null {
    const form = nullable(readFormLink)(pick(raw, 'form'));
    if (!form) return null;
    return { ...form, url: form.url || field.str('')(pick(raw, 'url')) };
}

// ── Folders ──────────────────────────────────────────────────────────

export const readFolder: (raw: unknown) => FlowFolder = shapeOf({
    id: field.str(''),
    organizationId: field.strOrNull,
    name: field.str(''),
    icon: field.str('📁'),
    color: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
    automationCount: field.numOrNull,
});

export function readFolderList(raw: unknown): FlowFolder[] {
    return field.list(readFolder)(pick(raw, 'folders')).filter((f) => f.id !== '');
}

export function readFolderResponse(raw: unknown): FlowFolder | null {
    return nullable(readFolder)(pick(raw, 'folder'));
}

/** DELETE /folders/:id: how many automations were moved back to the top level. */
export function readFolderDeleted(raw: unknown): number {
    return field.num(0)(pick(raw, 'detached'));
}
