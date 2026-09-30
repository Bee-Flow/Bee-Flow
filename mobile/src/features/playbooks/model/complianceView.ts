/**
 * What the compliance phase SHOWS — a port of the web's
 * stages/complianceView.js (the verdict, the finding groups, the severity in
 * the phase's own words, and the Art. 30 registration filled in from what is
 * really there), pinned by complianceView.lockstep.test.ts on the same
 * reviews.
 *
 * The verdict never claims a clean bill of health it did not earn: when
 * nothing was checked, that is its own verdict, and it is not green.
 */

import type { TranslateFn } from '@/core/i18n';

import { artList, artRecord, artRecords, textOf } from './artifacts';
import type { Artifacts } from './types';

type Loose = Record<string, unknown>;

export const SEVERITY_WORDS = Object.freeze({
    high: { key: 'playbooks.compliance.sev_high', en: 'Fix before you share' },
    medium: { key: 'playbooks.compliance.sev_medium', en: 'Worth doing' },
    low: { key: 'playbooks.compliance.sev_low', en: 'Good to know' },
});

export function severityWord(severity: string | null | undefined, t: TranslateFn): string {
    const entry = severity === 'high' || severity === 'medium' ? SEVERITY_WORDS[severity] : SEVERITY_WORDS.low;
    return t(entry.key, entry.en);
}

export type VerdictTone = 'none' | 'clear' | 'attention' | 'tidy';

export interface Verdict {
    total: number;
    high: number;
    clean: number | null;
    ran: number | null;
    nothingChecked: boolean;
    tone: VerdictTone;
    headline: string;
    cleanLine: string | null;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function verdictOf(artifacts: Artifacts | null | undefined, t: TranslateFn): Verdict {
    const findings = artRecords(artifacts, 'findings');
    const checks = artRecord(artifacts, 'checks');
    const high = findings.filter((f) => f.severity === 'high').length;
    const clean = finite(checks?.clean);
    const ran = finite(checks?.ran);
    const frameworks = artList(artifacts, 'frameworks') ?? [];
    const nothingChecked = ran === 0 || (ran === null && frameworks.length === 0);
    const headline = nothingChecked
        ? t('playbooks.compliance.verdict_none', 'Nothing was checked')
        : findings.length === 0
            ? t('playbooks.compliance.verdict_clean', 'Nothing to tidy up')
            : findings.length === 1
                ? t('playbooks.compliance.verdict_some_one', '1 thing to tidy up')
                : t('playbooks.compliance.verdict_some', '{n} things to tidy up', { n: findings.length });
    return {
        total: findings.length,
        high,
        clean,
        ran,
        nothingChecked,
        tone: nothingChecked ? 'none' : findings.length === 0 ? 'clear' : high > 0 ? 'attention' : 'tidy',
        headline,
        cleanLine: !nothingChecked && ran !== null
            ? t('playbooks.compliance.verdict_clean_count', '{clean} of {ran} checks came back clean', { clean: clean ?? 0, ran })
            : null,
    };
}

/** Where the personal-data judgement came from, in one honest line. */
export function methodLine(facts: Loose | null | undefined, t: TranslateFn): string | null {
    const table = artRecord(facts, 'table');
    const columns = artRecords(table, 'personal');
    if (!columns.length) return null;
    const names = columns.map((c) => textOf(c, 'name')).join(', ');
    return facts?.personalMethod === 'values'
        ? t('playbooks.compliance.method_values', 'Personal data found by reading the values in {names}', { names })
        : t('playbooks.compliance.method_names', 'Personal data assumed from the column names {names} — the privacy guard was not available to read the values', { names });
}

/** The three groups the list is drawn in; `low` sits behind a count. */
export function groupFindings<F extends { severity?: unknown }>(findings: readonly F[]): { high: F[]; medium: F[]; low: F[] } {
    return {
        high: findings.filter((f) => f.severity === 'high'),
        medium: findings.filter((f) => f.severity === 'medium'),
        low: findings.filter((f) => f.severity !== 'high' && f.severity !== 'medium'),
    };
}

/** Every datatable has these two stamps, and the retention job ages rows by either. */
export const SYSTEM_DATES = Object.freeze([
    { key: 'created_at', labelKey: 'playbooks.compliance.date_created', labelEn: 'When the row was added' },
    { key: 'updated_at', labelKey: 'playbooks.compliance.date_updated', labelEn: 'When the row last changed' },
]);

export interface DateColumn {
    key: string;
    name: string;
    system?: boolean;
}

/** Every date a retention period could count from, best first. */
export function dateColumns(table: Loose | null | undefined, t: TranslateFn | null = null): DateColumn[] {
    const cols = artRecords(table, 'columns');
    const dated = cols.filter((c) => /^(date|datetime|timestamp)$/i.test(String(c.type || '')));
    const score = (c: Loose) => {
        const text = `${textOf(c, 'key')} ${textOf(c, 'name')}`;
        if (/(created|added|received|ontvangen|aangemaakt|import)/i.test(text)) return 0;
        return /(due|verval|expiry)/i.test(text) ? 2 : 1;
    };
    const own = [...dated].sort((a, b) => score(a) - score(b));
    const mine = new Set(own.map((c) => textOf(c, 'key')));
    const system = SYSTEM_DATES.filter((d) => !mine.has(d.key)).map((d) => ({ key: d.key, name: t ? t(d.labelKey, d.labelEn) : d.labelEn, system: true }));
    const ownCols = own.map((c) => ({ key: textOf(c, 'key'), name: textOf(c, 'name') || textOf(c, 'key') }));
    return own.length && score(own[0] as Loose) === 0 ? [...ownCols, ...system] : [...system, ...ownCols];
}

/** Which column names the person a row is about — from the columns the review found personal data in. */
export function subjectColumns(table: Loose | null | undefined): Loose[] {
    const rank = (p: Loose) => {
        const kinds = Array.isArray(p.kinds) ? p.kinds : [p.kind];
        if (kinds.includes('name')) return 0;
        if (kinds.includes('email')) return 1;
        return kinds.includes('phone') ? 2 : 3;
    };
    return [...artRecords(table, 'personal')].sort((a, b) => rank(a) - rank(b));
}

export interface Registration {
    lawfulBasis: string;
    retentionDays: string;
    retentionField: string;
    subjectColumn: string;
}

/**
 * What the register form opens with. THE LEGAL BASIS IS NEVER PRE-SELECTED:
 * only the table's own recorded answer fills it — a default would be a legal
 * position nobody took.
 */
export function registrationDefaults(facts: Loose | null | undefined): Registration {
    const table = artRecord(facts, 'table') ?? {};
    const org = artRecord(facts, 'org') ?? {};
    const str = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(v));
    return {
        lawfulBasis: str(table.lawfulBasis),
        retentionDays: str(table.retentionDays || org.defaultRetentionDays),
        retentionField: str(table.retentionField) || (dateColumns(table)[0]?.key ?? ''),
        subjectColumn: str(table.subjectColumn) || textOf(subjectColumns(table)[0], 'key'),
    };
}

/** Art. 6(1) — the six the datatable accepts, in the order they are used (the web's RegisterPanel). */
export const LAWFUL_BASES = ['contract', 'legal_obligation', 'legitimate_interests', 'consent', 'public_task', 'vital_interests'] as const;

/** The six grounds with the organisation's own configured ones first. Ordering is help; selecting is a position. */
export function basisOptions(facts: Loose | null | undefined, all: readonly string[] = LAWFUL_BASES): { id: string; configured: boolean }[] {
    const org = artRecord(facts, 'org');
    const configured = (artList(org, 'legalBases') ?? []).filter((b): b is string => typeof b === 'string' && all.includes(b));
    return [
        ...configured.map((id) => ({ id, configured: true })),
        ...all.filter((id) => !configured.includes(id)).map((id) => ({ id, configured: false })),
    ];
}

/** What the register wrote, as sentences. */
export function writtenWords(registered: Loose | null | undefined, t: TranslateFn): string[] {
    const out: string[] = [];
    for (const w of artList(registered, 'written') ?? []) {
        if (w === 'processing_register') out.push(t('playbooks.compliance.wrote_ropa', 'the table is in the processing register'));
        else if (w === 'evidence') out.push(t('playbooks.compliance.wrote_evidence', 'this review is on the evidence chain'));
        else if (String(w).startsWith('risks:')) {
            const n = Number(String(w).slice(6)) || 0;
            out.push(n === 1
                ? t('playbooks.compliance.wrote_risks_one', '1 item opened in the risk register')
                : t('playbooks.compliance.wrote_risks', '{n} items opened in the risk register', { n }));
        }
    }
    return out;
}

/** The body the route reads: empty fields left out, days as a number. */
export function registrationBody(reg: Registration, risks: readonly string[]): Record<string, unknown> {
    const days = Number(reg.retentionDays);
    return {
        registration: {
            lawfulBasis: reg.lawfulBasis || undefined,
            retentionDays: Number.isFinite(days) && days > 0 ? days : undefined,
            retentionField: reg.retentionField || undefined,
            subjectColumn: reg.subjectColumn || undefined,
        },
        risks,
    };
}

/** The route's own ceiling on a retention period (complianceRoutes.js MAX_RETENTION_DAYS). */
export const MAX_RETENTION_DAYS = 3650;

/** Typed days, digits only and never above the ceiling the route refuses past. */
export function retentionInput(text: string): string {
    const digits = text.replace(/\D/g, '');
    return digits && Number(digits) > MAX_RETENTION_DAYS ? String(MAX_RETENTION_DAYS) : digits;
}

/**
 * What the register refused, in its own words (the web's register()). The
 * route answers 200 with a `failed` list and still stamps the phase as
 * registered, so a refusal only shows if somebody reads this.
 */
export function failedLine(failed: readonly { what: string; error: string | null }[] | null | undefined): string | null {
    if (!failed || !failed.length) return null;
    return failed.map((f) => f.error || f.what).join(', ');
}
