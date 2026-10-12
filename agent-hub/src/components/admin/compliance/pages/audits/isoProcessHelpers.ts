import { fmtDate } from './auditForms';

/**
 * isoProcessHelpers: the pure rules behind the ISMS-process tabs (internal
 * audits, management reviews, nonconformities), kept out of the component
 * files so those export components only.
 *
 *   editPatch        an NC drawer's edits as one update patch (NcsTab sends
 *                    it with Save AND with every step, so a corrective action
 *                    typed into the drawer is never lost)
 *   notRaisedCount   the findings "Close audit?" counts (AuditsTab)
 *   MR_INPUT_LABELS  the clause 9.3.2 agenda keys in words (ReviewsTab), with
 *   mrInputLabel     mrInputValue writing a date key as a date
 */

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

export interface NcEdit {
    corrective_action?: string | null;
    due_at?: string | null;
    effectiveness_review_due_at?: string | null;
    owner_user_id?: string | null;
}

export interface NcPatch {
    corrective_action?: string;
    due_at?: string;
    effectiveness_review_due_at?: string;
    owner_user_id?: string;
}

/** The drawer's edits as an update patch; an emptied field is left out, as Save always did. */
export function editPatch(edit: NcEdit | null | undefined): NcPatch {
    if (!edit) return {};
    return {
        corrective_action: String(edit.corrective_action || '').trim() || undefined,
        due_at: edit.due_at || undefined,
        effectiveness_review_due_at: edit.effectiveness_review_due_at || undefined,
        owner_user_id: edit.owner_user_id || undefined,
    };
}

export interface AuditFinding {
    severity?: string | null;
    nonconformity_id?: string | number | null;
}

/** Findings with weight (not an observation) that were never raised as a nonconformity. */
export function notRaisedCount(findings: AuditFinding[] | null | undefined): number {
    return (Array.isArray(findings) ? findings : []).filter(f => f.severity !== 'observation' && !f.nonconformity_id).length;
}

/** 'open_incidents' → 'Open incidents': a key nobody labelled, in its own words. */
export function labelize(key: unknown): string {
    const words = String(key).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

const asText = (x: unknown): string => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));

/** Any stored input value as one line of text; '—' for nothing. */
export function fmtVal(v: unknown): string {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) return v.map(asText).join(', ') || '—';
    if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${labelize(k)}: ${asText(x)}`).join(' · ');
    return String(v);
}

interface MrInputLabel {
    readonly labelKey: string;
    readonly en: string;
    readonly date?: boolean;
}

/** The 9.3.2 agenda keys the server collects (routes/compliance/isoProcess.js), with their labels. */
export const MR_INPUT_LABELS: Readonly<Record<string, MrInputLabel>> = Object.freeze({
    score_now: Object.freeze({ labelKey: 'compliance.mr_input_score_now', en: 'Compliance score now' }),
    score_90d_ago: Object.freeze({ labelKey: 'compliance.mr_input_score_90d_ago', en: 'Score 90 days ago' }),
    failing_checks: Object.freeze({ labelKey: 'compliance.mr_input_failing_checks', en: 'Failing checks' }),
    open_nonconformities: Object.freeze({ labelKey: 'compliance.mr_input_open_ncs', en: 'Open nonconformities' }),
    open_incidents: Object.freeze({ labelKey: 'compliance.mr_input_open_incidents', en: 'Open incidents' }),
    risks_open: Object.freeze({ labelKey: 'compliance.mr_input_risks_open', en: 'Open risks' }),
    risks_high: Object.freeze({ labelKey: 'compliance.mr_input_risks_high', en: 'High risks' }),
    soa_approved: Object.freeze({ labelKey: 'compliance.mr_input_soa_approved', en: 'SoA controls approved' }),
    last_internal_audit: Object.freeze({ labelKey: 'compliance.mr_input_last_internal_audit', en: 'Last internal audit closed', date: true }),
    collected_at: Object.freeze({ labelKey: 'compliance.mr_input_collected_at', en: 'Collected' }),
});

const labelEntry = (key: string): MrInputLabel | undefined => (Object.hasOwn(MR_INPUT_LABELS, key) ? MR_INPUT_LABELS[key] : undefined);

/** The label of an input key: its own words when MR_INPUT_LABELS does not know it. */
export function mrInputLabel(t: Translate, key: string): string {
    const entry = labelEntry(key);
    return entry ? t(entry.labelKey, entry.en) : labelize(key);
}

/** An input's value: a date key (`…_at`, or marked `date`) as a date, anything else as fmtVal. */
export function mrInputValue(key: string, value: unknown, locale?: string): string {
    const isDate = String(key).endsWith('_at') || !!labelEntry(key)?.date;
    if (isDate && value) return fmtDate(value, locale);
    return fmtVal(value);
}
