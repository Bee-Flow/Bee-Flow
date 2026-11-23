/**
 * The assistant's final check of a document filled in from a template, kept
 * on the document next to the values (settings.sampleValues), so everyone who
 * fills it in sees the same remarks at the same fields:
 *
 *   settings.fillReview = { at, by, source: 'form' | 'chat', checked,
 *                           findings: [{ key, kind, reason, suggestion?, was }] }
 *
 * A finding is about ONE filled-in field and is one of two kinds:
 *
 *   rewrite  the information is there, the wording is not good enough yet;
 *            `suggestion` is the better text (text fields only), which the
 *            person takes over with one click or leaves;
 *   doubt    the value does not look like the right information for the
 *            field; `reason` says why. Never a suggestion: only the person
 *            knows the right value, the assistant does not invent one.
 *
 * `was` is the value the finding was made about: a finding whose field has
 * another value now is gone (openFindings), whoever changed it and however.
 * Two writers produce a review, through this one cleaner: the form's "Check"
 * (core/documents/fillReviewer.mts asks a model) and the chat's
 * template_fill_review (the assistant in the conversation hands in its own).
 *
 * Pure: no store, no model.
 */

import type { Contract, Field, Settings } from './templateValues.mts';

export type FindingKind = 'rewrite' | 'doubt';
export type ReviewSource = 'form' | 'chat';

export interface Finding {
    key: string;
    kind: FindingKind;
    reason: string;
    suggestion?: string;
    /** The value the finding is about, as JSON. */
    was: string;
}

export interface FillReview {
    at: string;
    by: string;
    source: ReviewSource;
    /** How many filled-in fields were looked at. */
    checked: number;
    findings: Finding[];
}

export const MAX_FINDINGS = 60;
export const MAX_REASON = 300;
const MAX_SUGGESTION = 20000;

const isObject = (v: unknown): v is Settings => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const stamp = (v: unknown): string => JSON.stringify(v ?? null);

/** The fields that have a value: what a check looks at. */
export function filledFields(contract: Contract, values: Settings): Field[] {
    return contract.parameters.filter((p) => !isEmpty(values[p.key]));
}

/** One raw finding as a stored one, or null when it says nothing usable about a filled-in field. */
function cleanFinding(raw: unknown, byKey: Map<string, Field>, values: Settings): Finding | null {
    if (!isObject(raw)) return null;
    const field = typeof raw.key === 'string' ? byKey.get(raw.key) : undefined;
    if (!field || isEmpty(values[field.key])) return null;
    const reason = text(raw.reason, MAX_REASON);
    const base = { key: field.key, reason, was: stamp(values[field.key]) };
    if (raw.kind === 'doubt') return reason ? { ...base, kind: 'doubt' } : null;
    if (raw.kind !== 'rewrite' || field.type !== 'text') return null;
    const suggestion = text(raw.suggestion, MAX_SUGGESTION);
    if (!suggestion || suggestion === String(values[field.key]).trim()) return null;
    return { ...base, kind: 'rewrite', suggestion };
}

/**
 * What a writer handed in, as findings that can be stored: about a known,
 * filled-in field, of a known kind, one per field, a rewrite only for a text
 * field and only when it differs from what is there.
 */
export function cleanFindings(raw: unknown, contract: Contract, values: Settings): Finding[] {
    if (!Array.isArray(raw)) return [];
    const byKey = new Map(contract.parameters.map((p) => [p.key, p]));
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const item of raw) {
        const finding = cleanFinding(item, byKey, values);
        if (!finding || seen.has(finding.key)) continue;
        seen.add(finding.key);
        findings.push(finding);
        if (findings.length >= MAX_FINDINGS) break;
    }
    return findings;
}

const isFinding = (f: unknown): f is Finding => isObject(f) && typeof f.key === 'string' && typeof f.was === 'string'
    && (f.kind === 'rewrite' || f.kind === 'doubt') && typeof f.reason === 'string';

/** The review a document keeps, read defensively; null when it was never checked. */
export function reviewOf(settings: unknown): FillReview | null {
    const raw = isObject(settings) ? settings.fillReview : null;
    if (!isObject(raw) || typeof raw.at !== 'string' || !Array.isArray(raw.findings)) return null;
    return {
        at: raw.at, by: typeof raw.by === 'string' ? raw.by : '', source: raw.source === 'chat' ? 'chat' : 'form',
        checked: typeof raw.checked === 'number' ? raw.checked : 0, findings: raw.findings.filter(isFinding),
    };
}

/** The findings that still say something: their field has the value they were made about. */
export function openFindings(settings: unknown, values: Settings): Finding[] {
    return (reviewOf(settings)?.findings || []).filter((f) => f.was === stamp(values[f.key]));
}

/** The review as a reader is shown it (no `was`), or null. */
export function reviewView(settings: unknown, values: Settings): { at: string, by: string, source: ReviewSource, checked: number, findings: Array<Omit<Finding, 'was'>> } | null {
    const review = reviewOf(settings);
    if (!review) return null;
    return {
        at: review.at, by: review.by, source: review.source, checked: review.checked,
        findings: openFindings(settings, values).map(({ was: _was, ...rest }) => rest),
    };
}

/** The settings with a new review in place of the old one. */
export function withReview(settings: Settings, review: FillReview): Settings {
    return { ...settings, fillReview: review };
}

/** The settings without the findings on `keys`: the person looked at them, or the value changed. */
export function withoutFindings(settings: Settings, keys: string[]): Settings {
    const review = reviewOf(settings);
    if (!review || keys.length === 0) return settings;
    const gone = new Set(keys);
    const findings = review.findings.filter((f) => !gone.has(f.key));
    return findings.length === review.findings.length ? settings : { ...settings, fillReview: { ...review, findings } };
}
