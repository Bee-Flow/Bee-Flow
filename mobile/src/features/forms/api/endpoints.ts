/**
 * Form endpoints, under /api/automation (routes/automation/crud.js). The mount
 * is gated by requireModule('automation') + requireLicenseFeature('automations'),
 * so a 402/403 is a normal answer.
 *
 * A form is not an object of its own: it is a routine whose trigger has
 * `kind: 'form'`. Its questions are saved through the ordinary PUT of the
 * routine (the flow editor's draft store does that), its link is one of the
 * routine's form links (the flow editor's links calls), and going live is
 * arming the routine. What is here is what exists for forms alone.
 */

import { api } from '@/core/api/client';
import { pick } from '@/core/api/contract';
import { absoluteUrl } from '@/features/webpages';

import { readAiDraft, readAnswersInfo, readAudienceResponse, readFormDetail, readForms } from './readers';
import { publicFormPath } from '../model/formPage';
import type { AiFormDraft, FormAnswersInfo, FormAudience, FormDetail, FormSummary } from '../model/types';

const formsPath = '/api/automation/forms';
const formPath = (automationId: string) => `${formsPath}/${encodeURIComponent(automationId)}`;

/**
 * Every form in the caller's organisation. Org-scoped on purpose: a form has
 * an address, and an address belongs to the organisation that hands it out.
 * `mine` marks the ones whose routine this caller owns; `canOpen` the ones
 * they may fill in.
 */
export async function listForms(signal?: AbortSignal): Promise<FormSummary[]> {
    return readForms(await api.get<unknown>(formsPath, { signal }));
}

/**
 * One form, for the Form page — by the ROUTINE's id. Same audience as the
 * list (404 outside the organisation); the definition comes along for the
 * owner only.
 */
export async function getFormDetail(automationId: string, signal?: AbortSignal): Promise<FormDetail | null> {
    return readFormDetail(await api.get<unknown>(formPath(automationId), { signal }));
}

/**
 * The absolute address of a form (see absoluteUrl for why it is built here),
 * or null while there is no address to give: no token yet, or no server
 * configured to make it absolute against.
 */
export function publicFormUrl(form: Pick<FormSummary, 'id' | 'url'>): string | null {
    const path = publicFormPath(form);
    if (!path) return null;
    try {
        return absoluteUrl(path);
    } catch {
        return null;
    }
}

/**
 * Who may fill the form in. Owner only; a group that is not the organisation's
 * or a person outside it is a 400 with a sentence — never silently dropped.
 */
export async function setFormAudience(automationId: string, audience: FormAudience): Promise<FormAudience> {
    const body = { audience: audience.mode, sharedGroups: audience.groups, sharedUserIds: audience.users };
    return readAudienceResponse(await api.put<unknown>(`${formPath(automationId)}/audience`, body, { retry: false }));
}

/** Make (or re-make) the answers table of a form that collects. Owner only. */
export async function provisionAnswersTable(automationId: string): Promise<FormAnswersInfo | null> {
    const res = await api.post<unknown>(`${formPath(automationId)}/answers-table`, undefined, { retry: false });
    return readAnswersInfo(pick(res, 'answers'));
}

/**
 * "Build it with AI". Nothing is stored: the draft lands in the unsaved
 * editor, and only the person's own Save writes it. Never retried — each call
 * is a model call, and the route allows ten a minute.
 */
export async function draftFormWithAi(body: Record<string, unknown>): Promise<AiFormDraft | null> {
    return readAiDraft(await api.post<unknown>(`${formsPath}/ai/draft`, body, { retry: false, timeoutMs: 120_000 }));
}
