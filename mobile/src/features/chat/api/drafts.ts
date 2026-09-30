/**
 * Acting on a draft the assistant prepared: send or save an e-mail, post to
 * LinkedIn, or carry out a calendar, contacts or Keep action. One function per
 * route; each posts the allow-listed body (model/draftPayloads.ts).
 *
 * Some executors answer a refusal as `{ error }` under a 200 (keepTools.js,
 * for a consumer Gmail account); that is read as the failure it is, not as
 * "done".
 */

import { api } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';

import {
    calendarBody,
    contactsBody,
    emailBody,
    EXECUTE_PATH,
    isOutlook,
    keepBody,
    linkedInBody,
} from '../model/draftPayloads';
import type { DraftKind, DraftRecord } from '../model/types';

export class DraftRefusedError extends Error {}

/** A 200 whose body carries `error` did not happen. */
function checked(raw: unknown): unknown {
    const error = field.optStr(pick(raw, 'error'));
    if (error) throw new DraftRefusedError(error);
    return raw;
}

/** No retry: a send retried after a timeout is a second e-mail. */
const ONCE = { retry: false } as const;

export async function sendEmailDraft(draft: DraftRecord): Promise<void> {
    const provider = isOutlook(draft) ? 'outlook' : 'gmail';
    checked(await api.post<unknown>(`/api/integrations/${provider}/send`, emailBody(draft), ONCE));
}

/** Save to the mailbox's drafts. Gmail answers with a link to open it; Outlook does not. */
export async function saveEmailDraft(draft: DraftRecord): Promise<string | null> {
    const provider = isOutlook(draft) ? 'outlook' : 'gmail';
    const res = checked(await api.post<unknown>(`/api/integrations/${provider}/draft`, emailBody(draft), ONCE));
    return field.optStr(pick(res, 'gmailLink')) ?? null;
}

export async function postLinkedInDraft(draft: DraftRecord): Promise<void> {
    checked(await api.post<unknown>('/api/integrations/linkedin/post', linkedInBody(draft), ONCE));
}

const BODY: Readonly<Partial<Record<DraftKind, (d: DraftRecord) => Record<string, unknown>>>> = {
    calendar: calendarBody,
    contacts: contactsBody,
    keep: keepBody,
};

/** Carry out a calendar, contacts or Keep draft. */
export async function executeDraft(kind: 'calendar' | 'contacts' | 'keep', draft: DraftRecord): Promise<void> {
    const path = EXECUTE_PATH[kind] as string;
    const body = (BODY[kind] as (d: DraftRecord) => Record<string, unknown>)(draft);
    checked(await api.post<unknown>(path, body, ONCE));
}
