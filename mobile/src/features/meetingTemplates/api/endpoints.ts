/**
 * Summary-template endpoints, mounted at /api/summary-templates.
 *
 * Writes are gated per template on the server (`authorizeWrite`): a personal
 * template is its owner's, an org or group one an org admin's. A 403 here is
 * that answer, not a bug.
 */

import { api } from '@/core/api/client';

import { readOrgTemplates, readSummaryTemplates, readTemplate } from './readers';
import { createBody, patchBody } from '../model/draft';
import type { OrgTemplates, SummaryTemplate, SummaryTemplates, TemplateDraft } from '../model/types';

const BASE = '/api/summary-templates';
const templatePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** Built-ins plus every custom template the caller can see. */
export async function listSummaryTemplates(signal?: AbortSignal): Promise<SummaryTemplates> {
    return readSummaryTemplates(await api.get<unknown>(BASE, { signal, retry: false }));
}

/** The org's org and group templates, and its groups. Org admins only (else 403). */
export async function listOrgTemplates(signal?: AbortSignal): Promise<OrgTemplates> {
    return readOrgTemplates(await api.get<unknown>(`${BASE}/org`, { signal }));
}

export async function createSummaryTemplate(draft: TemplateDraft): Promise<SummaryTemplate> {
    return readTemplate(await api.post<unknown>(BASE, createBody(draft)));
}

export async function updateSummaryTemplate(id: string, draft: TemplateDraft): Promise<SummaryTemplate> {
    return readTemplate(await api.patch<unknown>(templatePath(id), patchBody(draft)));
}

export async function deleteSummaryTemplate(id: string): Promise<void> {
    await api.delete(templatePath(id));
}
