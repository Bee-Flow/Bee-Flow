/**
 * The Form page's rules — from the web's Studio/Forms/FormPage.jsx and
 * FormsStudio.jsx (formPage.lockstep.test.ts reads both):
 *
 *   - the OWNER sees Questions · Share · Answers · Settings; a colleague the
 *     answers table is shared with sees Answers only;
 *   - the page is keyed by the ROUTINE's id. The page token is the form's
 *     whole credential and never travels in a route — an old link that still
 *     carries one is resolved to its routine through the forms list.
 */

import { TOKEN_RE } from './fillValues';
import type { FormAudience, FormSummary } from './types';

export type FormTab = 'questions' | 'share' | 'answers' | 'settings';

/** A form's page: by its routine's id. */
export const formPagePath = (automationId: string): string => `/forms/${encodeURIComponent(automationId)}`;
/** Filling a form in: by its page token — the one route the token may travel in. */
export const formFillPath = (token: string): string => `/forms/fill/${encodeURIComponent(token)}`;

export const TABS_OWNER: readonly FormTab[] = ['questions', 'share', 'answers', 'settings'];
export const TABS_VIEWER: readonly FormTab[] = ['answers'];

export const tabsFor = (mine: boolean): readonly FormTab[] => (mine ? TABS_OWNER : TABS_VIEWER);

/** The tab a page opens on: the one asked for when it is allowed, else the first. */
export function initialTab(mine: boolean, asked: string | null | undefined): FormTab {
    const allowed = tabsFor(mine);
    return allowed.includes(asked as FormTab) ? (asked as FormTab) : (allowed[0] as FormTab);
}

/** Whether THIS caller can open the routine behind a form. True, never "not false". */
export function canOpenRoutine(form: Pick<FormSummary, 'mine' | 'automationId'> | null | undefined): boolean {
    return form?.mine === true && typeof form?.automationId === 'string' && !!form.automationId;
}

/** Whether THIS caller may open the Form page: the owner, or a reader of its answers table. */
export function canOpenForm(form: Pick<FormSummary, 'mine' | 'automationId' | 'answers'> | null | undefined): boolean {
    return canOpenRoutine(form) || (!!form?.answers?.grade && typeof form?.automationId === 'string' && !!form.automationId);
}

export type Liveness = 'live' | 'off' | 'unknown';
export function formLiveness(form: { live?: unknown } | null | undefined): Liveness {
    if (form?.live === true) return 'live';
    if (form?.live === false) return 'off';
    return 'unknown';
}

/** The form's address path (`/f/<token>`), or null. */
export function publicFormPath(form: { url?: unknown; id?: unknown } | null | undefined): string | null {
    const url = form?.url;
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
    const id = form?.id;
    return typeof id === 'string' && id ? `/f/${id}` : null;
}

/** The owner's one-glance answer to "who can fill this in". */
export type AudienceGist = { kind: 'org' } | { kind: 'nobody' } | { kind: 'some'; count: number };
export function audienceGist(audience: FormAudience | null | undefined): AudienceGist {
    if (audience?.mode !== 'restricted') return { kind: 'org' };
    const count = audience.groups.length + audience.users.length;
    return count ? { kind: 'some', count } : { kind: 'nobody' };
}

/**
 * The routine a Form page route means. `ref` is a routine id — or, from an
 * older link, a page token: that one is looked up in the forms list and
 * answered with its routine (`redirect`), so the screen can swap its route
 * for one that does not carry the credential. Null while the answer depends
 * on a list that has not arrived.
 */
export function resolveFormRef(
    ref: string,
    forms: readonly Pick<FormSummary, 'id' | 'automationId'>[] | undefined,
): { automationId: string; redirect: boolean } | null {
    if (!ref) return { automationId: '', redirect: false };
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- TOKEN_RE is anchored with one bounded class, ^[a-f0-9]{24,64}$, so it cannot backtrack
    if (!TOKEN_RE.test(ref)) return { automationId: ref, redirect: false };
    if (!forms) return null;
    if (forms.some((f) => f.automationId === ref)) return { automationId: ref, redirect: false };
    const byToken = forms.find((f) => f.id === ref);
    return byToken ? { automationId: byToken.automationId, redirect: true } : { automationId: ref, redirect: false };
}

/** Where tapping a form in the list goes: its Form page, or — for a colleague's — straight to filling it in. */
export function listTarget(form: FormSummary): { kind: 'page'; automationId: string } | { kind: 'fill'; token: string } | null {
    if (canOpenForm(form)) return { kind: 'page', automationId: form.automationId };
    if (form.canOpen && form.id) return { kind: 'fill', token: form.id };
    return null;
}
