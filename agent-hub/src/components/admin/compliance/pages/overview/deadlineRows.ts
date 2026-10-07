// deadlineRows — the rules behind a deadline row, shared by the Overview's
// Deadlines card and the phone's deadline list: which clocks are pressing,
// which identifier a row prints, which empty registers share one line, and
// where a row goes.
//
// What is pressing comes first: overdue and urgent clocks and anything due
// within 30 days, at most six. The rest (a self-assessment that expires in
// eleven months) waits behind one "Show {n} later" toggle, so the card never
// lists a clock a year out next to a 72-hour one.

import { DAY_MS, toMs } from '../../../../shared/deadlineMath';
import { complianceActionPath, resolveTarget } from '../../data/actions';

/** A row from GET /deadlines (or the client fallback, data/aggregates.deadlinesFromRegisters). */
export interface DeadlineRowItem {
    id?: string;
    kind?: string;
    ref?: string | null;
    title?: string | null;
    state?: string;
    due_at?: string | null;
    target?: string | { section?: string; id?: string | null; tab?: string | null } | null;
}

export interface EmptyLineEntry {
    key: string;
    en: string;
    /** A whole sentence ("CRA: no open vulnerability"), printed without a kind label. */
    sentence?: boolean;
}

/** Clocks due within this window count as pressing, whatever their state. */
const SOON_MS = 30 * DAY_MS;
/** At most this many pressing clocks before the "Show {n} later" toggle. */
export const MAX_SOON = 6;

// The three CRA kinds share one sentence: three lines that all said "no open
// vulnerability" were one fact printed three times.
const CRA_EMPTY: EmptyLineEntry = Object.freeze({ key: 'compliance.ovw_no_open_cra', en: 'CRA: no open vulnerability', sentence: true });
const EMPTY_LINE: Readonly<Record<string, EmptyLineEntry>> = Object.freeze({
    cra_vulnerability: CRA_EMPTY,
    cra_early_warning: CRA_EMPTY,
    cra_full_report: CRA_EMPTY,
    dsr: Object.freeze({ key: 'compliance.ovw_no_open_dsr', en: 'no open request' }),
    incident: Object.freeze({ key: 'compliance.ovw_no_open_incident', en: 'no open incident' }),
});
const EMPTY_FALLBACK: EmptyLineEntry = Object.freeze({ key: 'compliance.ovw_no_open_item', en: 'nothing open' });

// A request and an incident carry an identifier worth reading (#2417,
// INC-31). An obligation's or attestation's `ref` is the KIND of subject
// ("training", "Agent"), which reads as a label, not an id.
const REF_KINDS: ReadonlySet<string> = new Set(['dsr', 'incident', 'cra_early_warning', 'cra_full_report']);

const hasRef = (item: Pick<DeadlineRowItem, 'kind' | 'ref'> | null | undefined): boolean =>
    !!item?.kind && REF_KINDS.has(item.kind);

/** The identifier printed before the title, or null for kinds whose ref is only a subject kind. */
export function deadlineRef(item: Pick<DeadlineRowItem, 'kind' | 'ref'> | null | undefined): string | null {
    return hasRef(item) && item?.ref ? String(item.ref) : null;
}

/** "Training", "Agent": the subject kind of an obligation or attestation row, in sentence case; else null. */
export function deadlineSubjectKind(item: Pick<DeadlineRowItem, 'kind' | 'ref'> | null | undefined): string | null {
    if (hasRef(item) || !item?.ref) return null;
    const s = String(item.ref).trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null;
}

/** `{ soon, later }`: overdue, urgent and due-within-30-days rows (at most MAX_SOON) first, the rest in order. */
export function splitDeadlines<T extends Pick<DeadlineRowItem, 'state' | 'due_at'>>(
    items: ReadonlyArray<T> | null | undefined, now: number = Date.now(),
): { soon: T[]; later: T[] } {
    const soon: T[] = [];
    const later: T[] = [];
    for (const item of Array.isArray(items) ? items : []) {
        const due: number | null = toMs(item?.due_at);
        const pressing = item?.state === 'overdue' || item?.state === 'urgent'
            || (item?.state !== 'done' && due !== null && due - now <= SOON_MS);
        (pressing && soon.length < MAX_SOON ? soon : later).push(item);
    }
    return { soon, later };
}

/** One entry per distinct EMPTY_LINE sentence: the three CRA kinds collapse into one line. */
export function emptyLines(kinds: ReadonlyArray<string> | null | undefined): Array<{ id: string; kind: string; entry: EmptyLineEntry }> {
    const seen = new Set<string>();
    const out: Array<{ id: string; kind: string; entry: EmptyLineEntry }> = [];
    for (const kind of Array.isArray(kinds) ? kinds : []) {
        const known = Object.hasOwn(EMPTY_LINE, kind) ? EMPTY_LINE[kind] : null;
        const id = known ? known.key : `kind:${kind}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, kind, entry: known || EMPTY_FALLBACK });
    }
    return out;
}

/** `{ section, id, tab }` for a row's target: an app path (server) or `{ section, id }` (client fallback); null when it leaves the hub. */
export function targetOf(item: Pick<DeadlineRowItem, 'target'> | null | undefined): { section: string; id?: string; tab?: string } | null {
    const tgt = item?.target;
    if (!tgt) return null;
    if (typeof tgt === 'object') return tgt.section ? { section: tgt.section, id: tgt.id ?? undefined, tab: tgt.tab ?? undefined } : null;
    const hit = resolveTarget(complianceActionPath(tgt) || '');
    return hit ? { section: hit.section, id: hit.id ?? undefined, tab: hit.tab ?? undefined } : null;
}
