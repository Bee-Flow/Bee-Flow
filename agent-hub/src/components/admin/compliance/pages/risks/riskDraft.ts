/**
 * riskDraft: the risk drawer's form state and the bodies it sends, as pure
 * functions so the tests pin them without a DOM.
 *
 *   draftOf        a register row → the drawer's editable fields
 *   patchOf        PUT /iso/risks/:id body (the legacy page's allow-list)
 *   acceptPatchOf  the "Accept risk" write: the whole draft plus the status
 *   treatmentOf    POST /iso/risks/:id/treatments body
 *   memberOptions  the owner select's options
 */

export interface RiskRow {
    title?: string | null;
    description?: string | null;
    category?: string | null;
    likelihood?: number | string | null;
    impact?: number | string | null;
    status?: string | null;
    owner_user_id?: string | null;
    review_due_at?: string | null;
}

export interface RiskDraft {
    title: string;
    description: string;
    category: string;
    likelihood: number | string;
    impact: number | string;
    status: string;
    owner_user_id: string;
    review_due_at: string;
}

export interface RiskPatch {
    title: string | undefined;
    description: string | null;
    category: string;
    likelihood: number;
    impact: number;
    status: string;
    owner_user_id: string | null;
    review_due_at: string | null;
}

export interface TreatmentDraft {
    option: string;
    description: string;
    due_at: string;
}

export interface Member {
    id: string;
    displayName?: string | null;
    email?: string | null;
}

/** `value` when it is set (not '', 0, null or undefined), else `fallback`. */
function or<T>(value: T | null | undefined, fallback: T): T {
    return value ? value : fallback;
}

/** A register row → the drawer's editable fields (a date input wants 'YYYY-MM-DD'). */
export function draftOf(r: RiskRow | null | undefined): RiskDraft {
    const row = r ?? {};
    return {
        title: or(row.title, ''),
        description: or(row.description, ''),
        category: or(row.category, 'confidentiality'),
        likelihood: or(row.likelihood, 3),
        impact: or(row.impact, 3),
        status: or(row.status, 'open'),
        owner_user_id: or(row.owner_user_id, ''),
        review_due_at: row.review_due_at ? String(row.review_due_at).slice(0, 10) : '',
    };
}

/** PUT /iso/risks/:id body: the legacy page's allow-list, unchanged. */
export function patchOf(draft: RiskDraft): RiskPatch {
    return {
        title: String(draft.title || '').trim() || undefined,
        description: String(draft.description || '').trim() || null,
        category: draft.category,
        likelihood: Number(draft.likelihood),
        impact: Number(draft.impact),
        status: draft.status,
        owner_user_id: draft.owner_user_id || null,
        review_due_at: draft.review_due_at || null,
    };
}

/**
 * The "Accept risk" write: the draft as it stands plus the accepted status,
 * so an owner or a review date typed before clicking is saved with it. The
 * server bumps updated_at on every write and the drawer's draft resets on
 * updated_at, so a status-only write would throw those edits away.
 */
export function acceptPatchOf(draft: RiskDraft): RiskPatch {
    return { ...patchOf(draft), status: 'accepted' };
}

/** POST /iso/risks/:id/treatments body. */
export function treatmentOf(treat: TreatmentDraft): { option: string; description: string | undefined; due_at: string | undefined } {
    return {
        option: treat.option,
        description: String(treat.description || '').trim() || undefined,
        due_at: treat.due_at || undefined,
    };
}

const nameOf = (u: Member) => String(u?.displayName || '').trim();

/**
 * Owner options: the member's display name; the e-mail address is added only
 * when two members share that name (and is the label of a member who has no
 * name at all), so the list never shows more personal data than it needs to
 * tell people apart. A stored owner who is no longer a member keeps an
 * option, or the select would silently show "No owner".
 */
export function memberOptions(orgUsers: Member[] | null | undefined, currentId = ''): { value: string; label: string }[] {
    const list = Array.isArray(orgUsers) ? orgUsers : [];
    const seen = new Map<string, number>();
    for (const u of list) {
        const key = nameOf(u).toLowerCase();
        if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const labelOf = (u: Member) => {
        const name = nameOf(u);
        if (!name) return u.email || String(u.id);
        const shared = (seen.get(name.toLowerCase()) ?? 0) > 1;
        return shared && u.email ? `${name} (${u.email})` : name;
    };
    const options = list.map(u => ({ value: String(u.id), label: labelOf(u) }));
    if (currentId && !list.some(u => String(u.id) === String(currentId))) options.push({ value: String(currentId), label: '—' });
    return options;
}
