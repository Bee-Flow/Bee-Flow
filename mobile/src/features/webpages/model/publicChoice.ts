/**
 * The "make public" form as data: what it starts from, and the request it
 * turns into. Kept out of the sheet because the rules are the server's
 * (routes/webpagesAudience.js) and each one is a way to break a live link:
 *
 *   - `publicColumns` is sent ALWAYS, for every bound table: a table missing
 *     from it goes to zero public columns;
 *   - a password is sent only in password mode, and only when one was typed —
 *     any password counts as a change and mints a new token, which breaks the
 *     address everyone already has;
 *   - `expiresAt` is left out to keep the current expiry, `null` removes it.
 */

import type { PublicAccessMode, PublicChoice, WebpageAudience } from './audienceTypes';

export type ExpiryChoice = 'keep' | 'never' | '7' | '30';

export interface PublicDraft {
    accessMode: PublicAccessMode;
    password: string;
    emails: string;
    expiry: ExpiryChoice;
    columns: Record<string, string[]>;
}

export function initialDraft(audience: WebpageAudience): PublicDraft {
    const columns: Record<string, string[]> = {};
    for (const table of audience.columnGate.tables) columns[table.datatableId] = [...table.publicColumns];
    return {
        accessMode: audience.public.on ? audience.public.accessMode : 'unlisted',
        password: '',
        emails: audience.public.allowedEmails.join('\n'),
        expiry: audience.public.on && audience.public.expiresAt ? 'keep' : 'never',
        columns,
    };
}

/** Addresses split on commas, semicolons and whitespace, lower-cased, once each. */
export function parseEmails(text: string): string[] {
    const out: string[] = [];
    for (const part of text.split(/[\s,;]+/)) {
        const email = part.trim().toLowerCase();
        if (email && !out.includes(email)) out.push(email);
    }
    return out;
}

function expiryOf(choice: ExpiryChoice, now: number): string | null | undefined {
    if (choice === 'keep') return undefined;
    if (choice === 'never') return null;
    return new Date(now + Number(choice) * 24 * 60 * 60 * 1000).toISOString();
}

export function toChoice(draft: PublicDraft, now: number = Date.now()): PublicChoice {
    const expiresAt = expiryOf(draft.expiry, now);
    return {
        on: true,
        publicColumns: draft.columns,
        accessMode: draft.accessMode,
        ...(draft.accessMode === 'password' && draft.password ? { password: draft.password } : {}),
        ...(draft.accessMode === 'email' ? { allowedEmails: parseEmails(draft.emails) } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
}

/** Why the form cannot be sent yet, or null. The server refuses the same cases. */
export function draftProblem(draft: PublicDraft, hasPassword: boolean): 'password' | 'emails' | null {
    if (draft.accessMode === 'password') {
        if (draft.password.length > 0 && draft.password.length < 6) return 'password';
        if (!draft.password && !hasPassword) return 'password';
    }
    if (draft.accessMode === 'email' && parseEmails(draft.emails).length === 0) return 'emails';
    return null;
}

export function toggleColumn(draft: PublicDraft, tableId: string, column: string): PublicDraft {
    const current = draft.columns[tableId] ?? [];
    const next = current.includes(column) ? current.filter((c) => c !== column) : [...current, column];
    return { ...draft, columns: { ...draft.columns, [tableId]: next } };
}
