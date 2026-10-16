// The two requests a website form makes. Public and anonymous, so plain fetch
// with no credentials; the server (server/routes/cmsForms.js) decides
// everything that matters.

import { API_BASE } from '../../utils/helpers';
import { MIN_FORM_AGE_MS, fieldErrorsFromResponse } from './formBlockModel';
import type { FormErrors, SubmitPayload } from './formBlockModel';

export interface FormToken {
    token: string;
    issuedAt: number;
    /** Local time (ms) from which the server accepts a submission for this token. */
    readyAt: number;
}

/** The token fetch was refused for rate: worth trying again shortly. */
export const TOKEN_BUSY = 'busy';
export type TokenResult = FormToken | typeof TOKEN_BUSY | null;

// A little over the server's minimum, so clock rounding never lands a real
// visitor on the silent drop.
const READY_MARGIN_MS = 250;

const endpoint = (blockId: string) => `${API_BASE}/api/cms/forms/${encodeURIComponent(blockId)}`;

/** A signed token for this form; null when the form is not available. */
export async function fetchFormToken(blockId: string): Promise<TokenResult> {
    try {
        const res = await fetch(endpoint(blockId), { credentials: 'omit' });
        if (res.status === 429) return TOKEN_BUSY;
        if (!res.ok) return null;
        const body = (await res.json()) as { token?: unknown; issuedAt?: unknown; serverNow?: unknown };
        if (typeof body.token !== 'string' || typeof body.issuedAt !== 'number') return null;
        // Wait out the minimum age on the SERVER's clock, which may differ from ours.
        const serverNow = typeof body.serverNow === 'number' ? body.serverNow : body.issuedAt;
        const wait = Math.max(0, body.issuedAt + MIN_FORM_AGE_MS + READY_MARGIN_MS - serverNow);
        return { token: body.token, issuedAt: body.issuedAt, readyAt: Date.now() + wait };
    } catch {
        return null;
    }
}

export type SendOutcome =
    | { kind: 'done' }
    | { kind: 'invalid'; errors: FormErrors }
    | { kind: 'expired' }
    | { kind: 'gone' }
    | { kind: 'failed' };

/** What the server made of a submission, as the cases the form reacts to. */
export async function sendForm(blockId: string, payload: SubmitPayload): Promise<SendOutcome> {
    try {
        const res = await fetch(endpoint(blockId), {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (res.ok) return { kind: 'done' };
        if (res.status === 400) return { kind: 'invalid', errors: fieldErrorsFromResponse(await res.json().catch(() => null)) };
        if (res.status === 403) return { kind: 'expired' };
        if (res.status === 404) return { kind: 'gone' };
        return { kind: 'failed' };
    } catch {
        return { kind: 'failed' };
    }
}
