/**
 * checkSearch — the rail search over checks (ComplianceRail, from two
 * characters).
 *
 * A check matches on its title, its article as a lawyer writes it
 * ("AI Act Art. 50", "Art. 50", "ISO A.5.20" — shared/ArticleRef
 * formatArticleRef), its raw article or its id; dots and spaces are optional,
 * so "art 50" finds "Art. 50". A per-source check arrives once per subject:
 * it is ONE hit, with `scopes` = how many subjects it runs for.
 */
import { formatArticleRef } from '../shared/ArticleRef';

export interface SearchableCheck {
    check_id?: string | null;
    regulation?: string | null;
    article?: string | null;
    titleKey?: string | null;
    scope_id?: string | null;
}

export interface CheckHit<C extends SearchableCheck = SearchableCheck> {
    check: C;
    title: string;
    scopes: number;
}

type Translate = (key: string, fallback?: string, vars?: Record<string, unknown>) => string;

const compact = (s: string) => s.replace(/[\s.]+/g, '');

export function searchChecks<C extends SearchableCheck>(
    checks: ReadonlyArray<C | null | undefined> | null | undefined,
    query: string | null | undefined,
    t: Translate,
    limit = 8,
): CheckHit<C>[] {
    const q = String(query ?? '').trim().toLowerCase();
    if (q.length < 2) return [];
    const qc = compact(q);
    const hits = new Map<string, { check: C; title: string; scopes: Set<string> }>();
    for (const c of checks ?? []) {
        if (!c?.check_id) continue;
        const seen = hits.get(c.check_id);
        if (seen) { seen.scopes.add(c.scope_id ?? ''); continue; }
        const title = t(c.titleKey ?? '', c.check_id);
        const hay = [title, c.article, formatArticleRef(c.regulation, c.article, t), c.check_id]
            .map(x => String(x ?? '').toLowerCase());
        if (!hay.some(h => h.includes(q) || (qc.length >= 2 && compact(h).includes(qc)))) continue;
        hits.set(c.check_id, { check: c, title, scopes: new Set([c.scope_id ?? '']) });
    }
    return [...hits.values()].slice(0, limit).map(h => ({ check: h.check, title: h.title, scopes: h.scopes.size }));
}
