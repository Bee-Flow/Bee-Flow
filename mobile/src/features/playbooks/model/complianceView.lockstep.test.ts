/**
 * complianceView.ts held to the web's complianceView.js on the same reviews:
 * the verdict (and above all "nothing was checked", which is never green),
 * the finding groups, the severity words, the registration the form opens
 * with, the legal-basis order and what the register wrote. The web's one
 * import (a tone table from its icon kit) is stubbed; the phone does not use it.
 *
 * Two deliberate differences, compared as such: the port hands the form
 * strings (the web may hand a number of days), and a date column is
 * `{ key, name }` rather than the whole column object.
 *
 * When this fails, the web side changed: update complianceView.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import {
    LAWFUL_BASES,
    SEVERITY_WORDS,
    basisOptions,
    dateColumns,
    failedLine,
    groupFindings,
    methodLine,
    registrationBody,
    registrationDefaults,
    retentionInput,
    severityWord,
    subjectColumns,
    verdictOf,
    writtenWords,
} from './complianceView';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Playbooks/stages/complianceView.js');
const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

type Fn = (...args: unknown[]) => unknown;
const t = (_k: string, en: string, p: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, n: string) => (n in p ? String(p[n]) : m));

const REVIEWS: Record<string, unknown>[] = [
    {},
    { frameworks: [] },
    { frameworks: ['GDPR'], checks: { ran: 0, clean: 0 } },
    { frameworks: ['GDPR'], checks: { ran: 5, clean: 5 }, findings: [] },
    { frameworks: ['GDPR'], checks: { ran: 5, clean: 3 }, findings: [{ code: 'a', severity: 'high' }, { code: 'b', severity: 'low' }] },
    { frameworks: ['GDPR', 'ISO'], findings: [{ code: 'c', severity: 'medium' }] },
    { checks: { ran: 2, clean: 1 }, findings: [{ code: 'd', severity: 'weird' }] },
];

const TABLE = {
    name: 'Invoices',
    columns: [
        { key: 'due', name: 'Due date', type: 'date' },
        { key: 'received', name: 'Received on', type: 'datetime' },
        { key: 'who', name: 'Customer', type: 'text' },
        { key: 'amount', name: 'Amount', type: 'number' },
    ],
    personal: [{ key: 'mail', name: 'E-mail', kinds: ['email'] }, { key: 'who', name: 'Customer', kinds: ['name'] }, { key: 'tel', name: 'Phone', kind: 'phone' }],
};

const FACTS: Record<string, unknown>[] = [
    {},
    { table: TABLE, personalMethod: 'values', org: { legalBases: ['consent', 'bogus', 'contract'], defaultRetentionDays: 365 } },
    { table: { ...TABLE, lawfulBasis: 'contract', retentionDays: 30, retentionField: 'due', subjectColumn: 'who' }, org: {} },
    { table: { name: 'Plain', columns: [{ key: 'created_at', name: 'Created', type: 'timestamp' }], personal: [] } },
];

describeIfWeb('complianceView matches the web', () => {
    const web = () => loadWebModule<Record<string, Fn>>(WEB, { toneOfSeverity: () => 'neutral' });

    it('reaches the same verdict and groups', () => {
        for (const review of REVIEWS) {
            expect({ review, verdict: verdictOf(review, t) }).toEqual({ review, verdict: web().verdictOf!(review, t) });
            const findings = (review.findings as Record<string, unknown>[] | undefined) ?? [];
            expect(groupFindings(findings)).toEqual(web().groupFindings!(findings));
        }
        expect(SEVERITY_WORDS).toEqual(web().SEVERITY_WORDS);
        for (const s of ['high', 'medium', 'low', 'other', null]) expect(severityWord(s, t)).toBe(web().severityWord!(s, t));
    });

    it('opens the registration on the same values', () => {
        const asStrings = (o: unknown) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' || v === null || v === undefined ? '' : String(v)]));
        for (const facts of FACTS) {
            expect(registrationDefaults(facts)).toEqual(asStrings(web().registrationDefaults!(facts)));
            expect(methodLine(facts, t)).toBe(web().methodLine!(facts, t));
            expect(basisOptions(facts)).toEqual(web().basisOptions!(facts, [...LAWFUL_BASES]));
            const table = (facts.table ?? null) as Record<string, unknown> | null;
            expect(dateColumns(table, t).map((c) => c.key)).toEqual((web().dateColumns!(table, t) as { key: string }[]).map((c) => c.key));
            expect(subjectColumns(table)).toEqual(web().subjectColumns!(table));
        }
    });

    it('says what the register wrote the same way', () => {
        for (const registered of [null, {}, { written: ['processing_register', 'risks:1', 'evidence'] }, { written: ['risks:3', 'unknown'] }]) {
            expect(writtenWords(registered, t)).toEqual(web().writtenWords!(registered, t));
        }
    });
});

describe('registrationBody', () => {
    it('sends only what was filled in, and the days as a number', () => {
        expect(registrationBody({ lawfulBasis: 'contract', retentionDays: '365', retentionField: 'created_at', subjectColumn: '' }, ['a'])).toEqual({
            registration: { lawfulBasis: 'contract', retentionDays: 365, retentionField: 'created_at', subjectColumn: undefined },
            risks: ['a'],
        });
        expect(registrationBody({ lawfulBasis: '', retentionDays: '', retentionField: '', subjectColumn: '' }, [])).toEqual({
            registration: { lawfulBasis: undefined, retentionDays: undefined, retentionField: undefined, subjectColumn: undefined },
            risks: [],
        });
    });
});

describe('what the register refused', () => {
    it('reads the failed list in its own words, the error first (the web register())', () => {
        expect(failedLine([])).toBeNull();
        expect(failedLine(undefined)).toBeNull();
        expect(failedLine([
            { what: 'processing_register', error: 'a retention period is between 1 and 3650 days' },
            { what: 'risk:a', error: null },
        ])).toBe('a retention period is between 1 and 3650 days, risk:a');
    });

    it('keeps typed days to digits and under the ceiling the route refuses past', () => {
        expect(retentionInput('5000')).toBe('3650');
        expect(retentionInput('3650')).toBe('3650');
        expect(retentionInput('36a5')).toBe('365');
        expect(retentionInput('')).toBe('');
    });
});
