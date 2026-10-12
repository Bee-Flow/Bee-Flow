/**
 * phaseRules: the decisions TimelineTab makes about a framework's phases
 * before TimelinePhases draws them. Pure, so the framework page and its
 * tests read the same rules.
 *
 * - The AI Act's Art. 50 phase is "missed" (not done) once its date has passed
 *   while an Art. 50 check fails today (isArt50Phase, disclosureFails).
 * - The track carries the catalogue's SHORT phase label ("GPAI rules") where
 *   the calendar row has a long one ("AI Act GPAI rules"): shortTitlesOf.
 */

export interface PhaseLike {
    id?: string | null;
    article?: string | number | null;
    label_key?: string | null;
    key?: string | null;
}

export interface CheckLike {
    status?: string | null;
    regulation?: string | null;
    article?: string | number | null;
}

export interface CatalogueRecord {
    phases?: Array<{ date?: string | null; label_key?: string | null; label?: string | null } | null> | null;
}

type Translate = (key: string, fallback?: string) => string;

const ART50_RE = /(^|_)art50($|_)/i;

/** Is this milestone / phase the AI Act's Art. 50 transparency step? (id or label_key slug, or an explicit article) */
export function isArt50Phase(phase: PhaseLike | null | undefined): boolean {
    if (!phase) return false;
    if (String(phase.article ?? '').startsWith('50')) return true;
    return ART50_RE.test(String(phase.id ?? '')) || ART50_RE.test(String(phase.label_key ?? phase.key ?? ''));
}

/** Does any AI Act Art. 50 check fail in the latest check rows? */
export function disclosureFails(checks: ReadonlyArray<CheckLike | null> | null | undefined): boolean {
    if (!Array.isArray(checks)) return false;
    return checks.some(c => !!c && c.status === 'fail'
        && String(c.regulation ?? '').toUpperCase() === 'AIA'
        && String(c.article ?? '').startsWith('50'));
}

/**
 * Date → the catalogue's short phase label (`record.phases[].label_key`), for
 * the dates that carry exactly one catalogue phase. The calendar's labels are
 * written for a list ("AI Act Art. 4 literacy · Art. 5 prohibited practices");
 * on a track only the short one fits.
 */
export function shortTitlesOf(record: CatalogueRecord | null | undefined, t: Translate): Map<string, string> {
    const out = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const p of Array.isArray(record?.phases) ? record.phases : []) {
        if (!p || !p.date) continue;
        seen.set(p.date, (seen.get(p.date) ?? 0) + 1);
        const label = p.label_key ? t(p.label_key, p.label ?? '') : (p.label ?? '');
        if (label) out.set(p.date, label);
    }
    for (const [date, n] of seen) if (n > 1) out.delete(date);
    return out;
}
