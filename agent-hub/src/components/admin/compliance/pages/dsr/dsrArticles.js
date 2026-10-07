/**
 * The DSR register's vocabulary (Compliance Center redesign, artboard 1c).
 *
 * Pure data + pure functions: which GDPR article a request type invokes, how a
 * row's state / channel / identity are read regardless of whether the old
 * columns (`status`, `subject_email`, `created_at`) or the BE-2 columns
 * (`state`, `subject_email_masked`, `received_at`, `due_at`, `extended_until`,
 * `identity_status`) are present, and the 30-day clock (Art. 12(3)).
 *
 * No React, no English: labels live in the components through `t()`.
 */
import { DAY_MS } from '../../../../shared/deadlineMath';

/** Request type → GDPR article. `deletion` is the stored word, `erasure` the legal one — both map. */
export const DSR_ARTICLE = Object.freeze({
    access: '15',
    rectification: '16',
    deletion: '17',
    erasure: '17',
    restriction: '18',
    portability: '20',
    objection: '21',
});

/** Existing `compliance.dsr_type_*` keys (DsrInboxPage's TYPE_LABEL_KEY, kept verbatim). */
export const DSR_TYPE_KEY = Object.freeze({
    access: 'compliance.dsr_type_access',
    rectification: 'compliance.dsr_type_rectification',
    deletion: 'compliance.dsr_type_deletion',
    erasure: 'compliance.dsr_type_deletion',
    portability: 'compliance.dsr_type_portability',
    restriction: 'compliance.dsr_type_restriction',
    objection: 'compliance.dsr_type_objection',
});

export const DSR_TYPES = Object.freeze(['access', 'rectification', 'deletion', 'restriction', 'portability', 'objection']);

/**
 * Intake channels as the UI names them; anything else renders as `other`.
 * The server stores `public_form | email_dpo | phone | letter | other`
 * (PLAN-BACKEND 3.13) — `channelOf` folds both spellings, `CHANNEL_WIRE`
 * is what a manual capture sends.
 */
export const DSR_CHANNELS = Object.freeze(['form', 'email', 'phone', 'letter', 'other']);
/** What a DPO can pick when recording a request by hand (the form records itself). */
export const CAPTURE_CHANNELS = Object.freeze(['email', 'phone', 'letter', 'other']);
export const CHANNEL_WIRE = Object.freeze({ form: 'public_form', email: 'email_dpo', phone: 'phone', letter: 'letter', other: 'other' });
const CHANNEL_ALIAS = Object.freeze({ public_form: 'form', dsr_form: 'form', web: 'form', email_dpo: 'email', mail: 'email', dpo_email: 'email', post: 'letter', telephone: 'phone' });

export const DSR_STATES = Object.freeze(['pending', 'in_progress', 'fulfilled', 'rejected']);
export const OPEN_STATES = Object.freeze(['pending', 'in_progress']);
export const CLOSED_STATES = Object.freeze(['fulfilled', 'rejected']);

/** GDPR Art. 12(3): one month, extendable by two more with a reason. */
export const DSR_WINDOW_DAYS = 30;
export const DSR_EXTENSION_DAYS = 60;
export const DSR_WINDOW_MS = DSR_WINDOW_DAYS * DAY_MS;
/** The clock turns urgent under five days — regulation-driven, passed to DeadlineClock by the host. */
export const DSR_URGENT_BELOW_MS = 5 * DAY_MS;

export function articleOf(requestType) {
    return DSR_ARTICLE[String(requestType || '').toLowerCase()] ?? null;
}

export function typeKeyOf(requestType) {
    return DSR_TYPE_KEY[String(requestType || '').toLowerCase()] ?? null;
}

/**
 * The lifecycle state (pending · in_progress · fulfilled · rejected). The
 * server's row carries it as `status`; its `state` is the CLOCK
 * (ok · urgent · overdue · none, routes/dsr.js listRow), so reading `state`
 * first turned every request into 'pending'. `state` still counts when it
 * holds a lifecycle word (older rows); the clock is the clock helpers' job.
 */
export function stateOf(row) {
    if (DSR_STATES.includes(row?.status)) return row.status;
    if (DSR_STATES.includes(row?.state)) return row.state;
    return 'pending';
}

export function isOpen(row) {
    return OPEN_STATES.includes(stateOf(row));
}

export function isClosed(row) {
    return CLOSED_STATES.includes(stateOf(row));
}

export function channelOf(row) {
    const raw = String(row?.channel || 'form').toLowerCase();
    const c = CHANNEL_ALIAS[raw] ?? raw;
    return DSR_CHANNELS.includes(c) ? c : 'other';
}

export const IDENTITY_STATES = Object.freeze(['verified_link', 'verified_manual', 'employee', 'pending', 'unknown']);

/**
 * Identity: BE-2's `identity_status` (`verified_email_link | verified_manual |
 * unverified`), else `identity_verified_at`, else unknown. Anything that
 * starts with "verified" counts as confirmed.
 */
export function identityOf(row) {
    const s = String(row?.identity_status || '').toLowerCase();
    if (s === 'verified_email_link' || s === 'verified_link' || s === 'email_link') return 'verified_link';
    if (s === 'verified_manual' || s === 'manual') return 'verified_manual';
    if (s.startsWith('verified') || s === 'confirmed') return 'verified_link';
    if (s === 'employee' || s === 'sso' || s === 'account') return 'employee';
    if (row?.identity_verified_at) return 'verified_link';
    if (s === 'pending' || s === 'unverified' || s === 'not_verified') return 'pending';
    return 'unknown';
}

export function isIdentityVerified(row) {
    return identityOf(row).startsWith('verified');
}

function ms(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(n) ? n : null;
}

/** The clock starts at receipt, not when a handler starts working. */
export function receivedAtOf(row) {
    return ms(row?.received_at) ?? ms(row?.created_at);
}

/** `due_at` from the server wins; an extension without a due date is the due date; else receipt + 30 d. */
export function dueAtOf(row) {
    const due = ms(row?.due_at);
    if (due !== null) return due;
    const extended = ms(row?.extended_until);
    if (extended !== null) return extended;
    const received = receivedAtOf(row);
    return received === null ? null : received + DSR_WINDOW_MS;
}

/** When a closed row was closed — the best column we have, or null. */
export function completedAtOf(row) {
    if (!isClosed(row)) return null;
    return ms(row?.completed_at) ?? ms(row?.resolved_at) ?? ms(row?.fulfilled_at) ?? ms(row?.updated_at);
}

/** Everything DeadlineClock needs for one row. Closed rows are 'done' whatever the due date says. */
export function clockPropsOf(row) {
    const closed = isClosed(row);
    return {
        dueAt: dueAtOf(row),
        startedAt: receivedAtOf(row),
        doneAt: closed ? completedAtOf(row) : null,
        state: closed ? 'done' : undefined,
        urgentBelowMs: DSR_URGENT_BELOW_MS,
    };
}

/** True when the row is open and its deadline has passed. */
export function isOverdue(row, now = Date.now()) {
    if (!isOpen(row)) return false;
    const due = dueAtOf(row);
    return due !== null && due < now;
}

/** Filter value → predicate. `open` = pending + in_progress (the artboard's "Lopend"). */
export const FILTERS = Object.freeze(['open', 'overdue', 'fulfilled', 'rejected']);

export function matchesFilter(row, filter, now = Date.now()) {
    switch (filter) {
        case 'open': return isOpen(row);
        case 'overdue': return isOverdue(row, now);
        case 'fulfilled': return stateOf(row) === 'fulfilled';
        case 'rejected': return stateOf(row) === 'rejected';
        default: return true;
    }
}

export function countByFilter(rows, now = Date.now()) {
    const out = { open: 0, overdue: 0, fulfilled: 0, rejected: 0 };
    for (const r of rows || []) {
        for (const f of FILTERS) if (matchesFilter(r, f, now)) out[f] += 1;
    }
    return out;
}

/**
 * "By deadline": open rows first (soonest due at the top — overdue rows are the
 * soonest of all), closed rows after, most recently received first.
 */
export function sortByDeadline(rows) {
    return [...(rows || [])].sort((a, b) => {
        const ao = isOpen(a), bo = isOpen(b);
        if (ao !== bo) return ao ? -1 : 1;
        if (ao) return (dueAtOf(a) ?? Infinity) - (dueAtOf(b) ?? Infinity);
        return (receivedAtOf(b) ?? 0) - (receivedAtOf(a) ?? 0);
    });
}

/**
 * Search: by number ("#2038", "2038") or by e-mail (the masked form — the list
 * never holds the full address, so the query is matched against what is shown
 * plus the domain).
 */
export function matchesQuery(row, query, shownEmail) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const num = q.replace(/^#/, '');
    if (num && String(row?.id ?? '') === num) return true;
    if (String(row?.id ?? '').includes(num) && /^\d+$/.test(num)) return true;
    const email = String(shownEmail || '').toLowerCase();
    if (email && email.includes(q)) return true;
    const domain = email.includes('@') ? email.slice(email.indexOf('@') + 1) : '';
    return Boolean(domain && domain.includes(q.replace(/^@/, '')));
}
