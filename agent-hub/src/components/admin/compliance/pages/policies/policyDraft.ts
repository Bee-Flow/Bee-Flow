/**
 * policyDraft: the policy drawer's form state and its publish rules, as pure
 * functions so the tests pin them without a DOM.
 *
 *   draftOf                  GET /iso/docs/:slug → the drawer's editable fields
 *   baselineOf               the frozen current version (ismsDocStore.getDoc's
 *                            `published`) to compare against, or null
 *   unchangedSincePublished  publishing would freeze the text that is already published
 *   publishQuestion          the inline confirm's sentence
 */

export interface FullPolicyDoc {
    title?: string | null;
    draft_body?: string | null;
    owner_user_id?: string | null;
    review_due_at?: string | null;
    edited?: boolean | null;
    status?: string | null;
    current_version?: number | null;
    ack_count?: number | null;
    published?: { version?: number; title?: string | null; body?: string | null } | null;
}

export interface PolicyDraft {
    title: string;
    body: string;
    owner_user_id: string;
    review_due_at: string;
    edited: boolean;
    status: string | null | undefined;
    current_version: number | null | undefined;
    ack_count: number | null | undefined;
}

export interface PolicyBaseline {
    title: string;
    body: string;
}

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** The editable fields, plus the facts the confirm needs. */
export function draftOf(full: FullPolicyDoc): PolicyDraft {
    return {
        title: full.title || '',
        body: full.draft_body || '',
        owner_user_id: full.owner_user_id || '',
        review_due_at: full.review_due_at ? String(full.review_due_at).slice(0, 10) : '',
        edited: !!full.edited,
        status: full.status,
        current_version: full.current_version,
        ack_count: full.ack_count,
    };
}

/** The frozen current version to compare against, or null when there is none to compare. */
export function baselineOf(full: FullPolicyDoc | null | undefined): PolicyBaseline | null {
    const p = full?.published;
    return p && typeof p.body === 'string' ? { title: String(p.title ?? ''), body: p.body } : null;
}

/** True when publishing would freeze the very text that is already published. */
export function unchangedSincePublished(
    draft: Pick<PolicyDraft, 'title' | 'body' | 'status'> | null | undefined,
    baseline: PolicyBaseline | null | undefined,
): boolean {
    if (!draft || !baseline || draft.status !== 'published') return false;
    return draft.title.trim() === baseline.title.trim() && draft.body === baseline.body;
}

/**
 * "Publish v4? 5 members will be asked to acknowledge again." when the
 * current version has acknowledgements to reset; otherwise the first-time
 * sentence (a draft, or a published version nobody acknowledged yet).
 */
export function publishQuestion(t: Translate, { published, acks, nextVersion }: { published: boolean; acks: number | null; nextVersion: number }): string {
    if (published && typeof acks === 'number' && acks > 0) {
        return acks === 1
            ? t('compliance.pol_publish_confirm_one', 'Publish v{n}? 1 member will be asked to acknowledge again.', { n: nextVersion })
            : t('compliance.pol_publish_confirm', 'Publish v{n}? {acks} members will be asked to acknowledge again.', { n: nextVersion, acks });
    }
    return t('compliance.pol_publish_confirm_first', 'Publish v{n}? Members will be asked to acknowledge this version.', { n: nextVersion });
}
