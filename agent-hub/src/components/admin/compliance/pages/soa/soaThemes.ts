/**
 * soaThemes — pure helpers for the Statement of Applicability register
 * (Compliance Center redesign, artboard 1d).
 *
 * The 93 Annex A controls arrive from `GET /api/compliance/iso/soa` as
 * `{ controls: [{ ref, theme, bucket, titleKey, objectiveKey, checks: [check_id], entry | null }], stats }`.
 * Everything the toolbar and the table need to know about them — which
 * theme a ref belongs to, what the row's DECISION is, which live check speaks
 * for it, how a filter narrows the list and how the pager slices it — is
 * computed here, React-free, so the table, the drawer and the tests share one
 * definition of "to review" and "excluded".
 *
 * Decision vocabulary: `todo | reviewed | approved | excluded`. `excluded` is
 * not a stored status — it is `entry.applicable === false` (the row still has
 * its own `status`, which the drawer restores when the row is made applicable
 * again). No English lives here: the labels are looked up by the callers.
 */

import type { TranslateFn } from '../../../../../hooks/useTranslation';

export type Decision = 'todo' | 'reviewed' | 'approved' | 'excluded';

/** The stored SoA entry of one control (null until the row is first touched). */
export interface SoaEntry {
    status?: string | null;
    applicable?: boolean | null;
    how_met?: string | null;
    justification?: string | null;
    owner_user_id?: string | null;
    updated_at?: string | null;
    updated_by?: string | null;
    [key: string]: unknown;
}

/** One Annex A control of GET /iso/soa. */
export interface SoaControl {
    ref?: string;
    theme?: number | string | null;
    titleKey?: string | null;
    objectiveKey?: string | null;
    checks?: string[] | null;
    entry?: SoaEntry | null;
    [key: string]: unknown;
}

/** One per-subject check row, keyed by check_id. */
export interface CheckRow {
    check_id?: string;
    status?: string;
    title?: string;
    titleKey?: string;
    regulation?: string;
    article?: string | null;
    last_run_at?: string | null;
    checked_at?: string | null;
    [key: string]: unknown;
}

/** The drawer's editable copy of a row. */
export interface SoaDraft {
    status: Decision;
    storedStatus: string;
    how_met: string;
    justification: string;
    owner_user_id: string;
}

/** The live check that speaks for a control (liveCheckOf). */
export type LiveCheck =
    | { kind: 'none' }
    | { kind: 'pending'; ids: string[] }
    | { kind: 'result'; check: CheckRow; status: string | undefined; others: CheckRow[] };

export const THEMES = Object.freeze([
    Object.freeze({ id: 'A.5', theme: 5, labelKey: 'compliance.soa_theme_a5', fallback: 'A.5 Organisational' }),
    Object.freeze({ id: 'A.6', theme: 6, labelKey: 'compliance.soa_theme_a6', fallback: 'A.6 People' }),
    Object.freeze({ id: 'A.7', theme: 7, labelKey: 'compliance.soa_theme_a7', fallback: 'A.7 Physical' }),
    Object.freeze({ id: 'A.8', theme: 8, labelKey: 'compliance.soa_theme_a8', fallback: 'A.8 Technological' }),
]);

export const THEME_IDS = Object.freeze(['all', ...THEMES.map(x => x.id)]);

export const DECISIONS: readonly Decision[] = Object.freeze(['todo', 'reviewed', 'approved', 'excluded'] as const);
export const DECISION_FILTERS: readonly (Decision | 'all')[] = Object.freeze(['all' as const, ...DECISIONS]);

export const PAGE_LIMIT = 12;

/** Worst-wins ranking of a check row's status (same table the legacy page used). */
export const CHECK_RANK: Readonly<Record<string, number>> = Object.freeze({ fail: 3, warn: 2, pass: 1, not_applicable: 0, pending: 0 });

/** 'A.5.20' → 'A.5'; a numeric `theme` (5..8) also resolves; anything else → null. */
export function themeOf(control: SoaControl | string | null | undefined): string | null {
    if (!control) return null;
    const ref = typeof control === 'string' ? control : control.ref;
    const m = typeof ref === 'string' ? /^A\.(\d)(?:\.|$)/i.exec(ref.trim()) : null;
    if (m) {
        const hit = THEMES.find(x => x.theme === Number(m[1]));
        if (hit) return hit.id;
    }
    if (typeof control === 'object' && control.theme != null) {
        const hit = THEMES.find(x => x.theme === Number(control.theme));
        if (hit) return hit.id;
    }
    return null;
}

/** The row's decision word — `excluded` wins over the stored status. */
export function decisionOf(control: SoaControl | null | undefined): Decision {
    const entry = control?.entry;
    if (!entry) return 'todo';
    if (entry.applicable === false) return 'excluded';
    return DECISIONS.includes(entry.status as Decision) ? (entry.status as Decision) : 'todo';
}

/** `{ all, todo, reviewed, approved, excluded }` over the loaded controls. */
export function countByDecision(controls: SoaControl[] | null | undefined): Record<'all' | Decision, number> {
    const out: Record<'all' | Decision, number> = { all: 0, todo: 0, reviewed: 0, approved: 0, excluded: 0 };
    for (const c of Array.isArray(controls) ? controls : []) {
        out.all += 1;
        out[decisionOf(c)] += 1;
    }
    return out;
}

/** `{ all, 'A.5', 'A.6', 'A.7', 'A.8' }` — a ref outside Annex A counts only under `all`. */
export function countByTheme(controls: SoaControl[] | null | undefined): Record<string, number> {
    const out: Record<string, number> = { all: 0 };
    for (const th of THEMES) out[th.id] = 0;
    for (const c of Array.isArray(controls) ? controls : []) {
        out.all += 1;
        const id = themeOf(c);
        if (id) out[id] += 1;
    }
    return out;
}

/**
 * Index the per-subject check rows by `check_id`, keeping the WORST row per
 * check (a check that fails for one agent fails for the control).
 */
export function indexChecks(checks: CheckRow[] | null | undefined): Map<string, CheckRow> {
    const map = new Map<string, CheckRow>();
    for (const row of Array.isArray(checks) ? checks : []) {
        if (!row || !row.check_id) continue;
        const prev = map.get(row.check_id);
        if (!prev || (CHECK_RANK[row.status as string] ?? 0) > (CHECK_RANK[prev.status as string] ?? 0)) map.set(row.check_id, row);
    }
    return map;
}

/**
 * The live check that speaks for a control:
 *   { kind: 'none' }                         — the control links no automated check (or is excluded)
 *   { kind: 'pending', ids }                 — linked, but no result yet
 *   { kind: 'result', check, status, others } — the worst linked result; `others` = the remaining linked check rows
 */
export function liveCheckOf(control: SoaControl | null | undefined, checksById: Map<string, CheckRow> | null | undefined): LiveCheck {
    const ids: string[] = Array.isArray(control?.checks) ? control.checks : [];
    if (!ids.length || decisionOf(control) === 'excluded') return { kind: 'none' };
    const rows = ids.map(id => checksById?.get?.(id)).filter((r): r is CheckRow => Boolean(r))
        .sort((a, b) => (CHECK_RANK[b.status as string] ?? 0) - (CHECK_RANK[a.status as string] ?? 0));
    if (!rows.length) return { kind: 'pending', ids };
    const [check, ...others] = rows;
    return { kind: 'result', check, status: check.status, others };
}

/** `approved` may not be chosen while the linked check is open (warn/fail). */
export function approvedBlocked(live: LiveCheck | null | undefined): boolean {
    return live?.kind === 'result' && (live.status === 'warn' || live.status === 'fail');
}

/** Excluding a control needs a written justification (ISO 27001 6.1.3 d). */
export function justificationMissing(draft: Partial<SoaDraft> | null | undefined): boolean {
    return draft?.status === 'excluded' && !String(draft.justification || '').trim();
}

const norm = (s: unknown): string => String(s || '').toLowerCase();

/**
 * Narrow the controls by decision pill, theme segment and free text. `t`
 * translates `titleKey` so a search for a translated title also hits; the
 * ref, the stored `how_met` and the justification are searched as-is.
 */
export function filterControls(
    controls: SoaControl[] | null | undefined,
    { decision = 'all', theme = 'all', query = '', t }: { decision?: string; theme?: string; query?: string; t?: TranslateFn } = {},
): SoaControl[] {
    const q = norm(query).trim();
    return (Array.isArray(controls) ? controls : []).filter(c => {
        if (decision !== 'all' && decisionOf(c) !== decision) return false;
        if (theme !== 'all' && themeOf(c) !== theme) return false;
        if (!q) return true;
        const hay = [
            c.ref,
            typeof t === 'function' && c.titleKey ? t(c.titleKey, '') : '',
            c.entry?.how_met,
            c.entry?.justification,
        ].map(norm).join(' ');
        return hay.includes(q);
    });
}

/** Client-side page over the filtered rows; an offset past the end clamps onto the last page. */
export function pageSlice<T>(rows: T[] | null | undefined, offset = 0, limit = PAGE_LIMIT): { rows: T[]; offset: number; limit: number; total: number } {
    const list = Array.isArray(rows) ? rows : [];
    const size = Math.max(1, Number(limit) || PAGE_LIMIT);
    const total = list.length;
    const lastStart = total === 0 ? 0 : Math.floor((total - 1) / size) * size;
    const start = Math.min(Math.max(0, Number(offset) || 0), lastStart);
    return { rows: list.slice(start, start + size), offset: start, limit: size, total };
}

/** The drawer's editable copy of a row. */
export function draftOf(control: SoaControl | null | undefined): SoaDraft {
    const entry = control?.entry || null;
    return {
        status: decisionOf(control),
        // the stored status survives an exclude → include round trip
        storedStatus: DECISIONS.includes(entry?.status as Decision) ? (entry?.status as string) : 'todo',
        how_met: entry?.how_met || '',
        justification: entry?.justification || '',
        owner_user_id: entry?.owner_user_id || '',
    };
}

/** The PUT body for `/iso/soa/:ref` — an explicit allow-list, never the row itself. */
export function patchOf(draft: SoaDraft): Record<string, unknown> {
    const excluded = draft.status === 'excluded';
    return {
        status: excluded ? (draft.storedStatus || 'todo') : draft.status,
        applicable: !excluded,
        justification: String(draft.justification || '').trim() || null,
        how_met: String(draft.how_met || '').trim() || null,
        owner_user_id: draft.owner_user_id || null,
    };
}
