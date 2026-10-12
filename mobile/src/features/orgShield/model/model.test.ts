/** The small pure modules: terms, clamps, posture words and activity labels. */

import type { TranslateFn } from '@/core/i18n';

import {
    actionLabel,
    categoriesLabel,
    categoryLabel,
    countriesOf,
    isSpecialCategory,
    namesSpecialCategory,
    surfaceLabel,
    withholdSpecialCategories,
} from './activity';
import { describeClamps, describeClampsOnLoad } from './clamps';
import { normaliseDoc } from './fields';
import { presetFor } from './piiCatalog';
import { derivePosture, type PostureInputs } from './posture';
import { postureHint, postureLabel, postureValue } from './postureText';
import { allowKey, allowProblem, labelTaken, newTermId, upsertTerm, validateTerm } from './terms';

const t: TranslateFn = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));

describe('terms', () => {
    it('validates like the server compiles', () => {
        expect(validateTerm({ pattern: ' ', type: 'literal', caseSensitive: false })).toEqual({ kind: 'missing_pattern' });
        expect(validateTerm({ pattern: 'x'.repeat(501), type: 'literal', caseSensitive: false })).toEqual({ kind: 'too_long' });
        expect(validateTerm({ pattern: 'a(b', type: 'literal', caseSensitive: false })).toBeNull();
        expect(validateTerm({ pattern: 'a(b', type: 'regex', caseSensitive: false })?.kind).toBe('bad_regex');
        expect(validateTerm({ pattern: 'PRJ-\\d+', type: 'regex', caseSensitive: true })).toBeNull();
    });

    it('adds, replaces and spots duplicate names', () => {
        const a = { id: 'a', label: 'Apollo', pattern: 'apollo', type: 'literal' as const, caseSensitive: false };
        const list = upsertTerm([], a);
        expect(upsertTerm(list, { ...a, pattern: 'APOLLO' })).toEqual([{ ...a, pattern: 'APOLLO' }]);
        expect(labelTaken(list, ' apollo ')).toBe(true);
        expect(labelTaken(list, 'Apollo', 'a')).toBe(false);
        expect(newTermId(1000, 0.5)).toBe('term-1000-500000');
    });

    it('compares allow entries on letters and digits only', () => {
        expect(allowKey('Coca-Cola ')).toBe('cocacola');
        expect(allowProblem(['coca cola'], 'Coca-Cola')).toBe('duplicate');
        expect(allowProblem([], '  - ')).toBe('empty');
        expect(allowProblem([], 'x'.repeat(121))).toBe('too_long');
        expect(allowProblem([], 'Shell')).toBeNull();
    });
});

describe('clamps', () => {
    it('names the clamped settings, both spellings of the tool list, and counts the unknown ones', () => {
        const r = describeClamps(['webSearchGuardEnabled', 'toolPiiPolicy.external', 'mystery'], t);
        expect(r.text).toContain('Protect web searches — switched back off');
        expect(r.text).toContain('tools outside your organisation');
        expect(r.text).toContain('1 other settings');
        expect(r.tabs).toEqual(['outbound', 'detection']);
        expect(describeClamps([], t)).toEqual({ text: 'Saved. Some settings were adjusted to your plan limits.', tabs: [] });
    });

    it('says what is in force on load', () => {
        expect(describeClampsOnLoad(['nothing'], t)).toBe('Some settings are limited by your current plan.');
        expect(describeClampsOnLoad(['webSearchGuardEnabled'], t)).toContain('What you see here is what is in force.');
    });
});

describe('posture', () => {
    const inputs: PostureInputs = {
        env: { hasWebSearchEnabled: true, hasEuModelsConfigured: true },
        canTokenize: false,
        canGuardWebSearch: true,
        guard: { configured: true, reachable: false },
        egress: { piiNonEuCount: 3, piiCategories: ['Email'] },
    };

    it('is empty while the shield is off', () => {
        expect(derivePosture(normaliseDoc({}), inputs)).toEqual({ off: true, rows: [], attention: 0 });
    });

    it('flags the guard, an empty category list, unlicensed tokenize and leaks abroad', () => {
        const f = { ...normaliseDoc({ enabled: true, piiDetectionAction: 'tokenize', showRawPayload: true }), piiAllowTerms: ['Shell'] };
        const p = derivePosture(f, inputs);
        const tone = Object.fromEntries(p.rows.map((r) => [r.id, r.tone]));
        expect(p.rows[0]?.id).toBe('guard');
        expect(tone).toMatchObject({ guard: 'error', categories: 'warn', action: 'warn', transparency: 'note', toolcalls: 'warn', eu: 'warn', allowlist: 'note', websearch: 'ok' });
        expect(p.attention).toBe(5);
        for (const row of p.rows) {
            expect(postureLabel(row.id, t)).toBeTruthy();
            expect(typeof postureValue(row, t)).toBe('string');
        }
        expect(postureHint(p.rows[0]!, t)).toContain('This service does the actual scanning');
    });

    it('words each value the web way', () => {
        const f = { ...normaliseDoc({ enabled: true, dlpEnabled: true, dlpMode: 'auto_redact', piiDetectionCategories: ['Person'] }), piiConfidenceThreshold: 0.62 };
        const p = derivePosture(f, { ...inputs, guard: null, egress: null, canTokenize: true });
        const value = Object.fromEntries(p.rows.map((r) => [r.id, postureValue(r, t)]));
        expect(value).toMatchObject({
            categories: '1 of 21',
            sensitivity: 'Custom (62%)',
            action: 'Do not send the message',
            dlp: 'On — hide automatically',
            toolcalls: 'outside tools 0/21',
            customterms: 'None',
            allowlist: 'Well-known companies only',
            automations: 'On',
        });
        expect(p.attention).toBe(0);
        expect(p.rows.every((r) => postureHint(r, t) === null)).toBe(true);
        expect(presetFor(0.7)?.id).toBe('balanced');
    });
});

describe('activity labels', () => {
    it('labels actions, categories and markers, and passes unknown values through', () => {
        expect(actionLabel('blocked', t)).toBe('Stopped');
        expect(actionLabel('future', t)).toBe('future');
        expect(actionLabel(null, t)).toBe('—');
        expect(categoryLabel('Email', t)).toBe('Email Addresses');
        expect(categoryLabel('scan_timeout', t)).toBe('Check ran out of time');
        expect(categoriesLabel('Email, Email,Person', t)).toBe('Email Addresses, Person Names');
        expect(categoriesLabel('', t)).toBe('');
    });

    it('names the surface', () => {
        const row = { source: null, automationId: null, agentId: null, agentName: null };
        expect(surfaceLabel({ ...row, automationId: 'r1', agentName: 'Digest' }, t)).toBe('Automation — Digest');
        expect(surfaceLabel({ ...row, source: 'agent_chat' }, t)).toBe('Agent');
        expect(surfaceLabel({ ...row, source: 'direct_chat' }, t)).toBe('Direct chat');
        expect(surfaceLabel({ ...row, source: 'notebook' }, t)).toBe('Notebook');
        expect(surfaceLabel(row, t)).toBe('—');
    });

    it('folds destinations per country, busiest first', () => {
        const d = (code: string | null, total: number, pii = 0, local = false) => ({
            country_code: code, country_name: code, is_eu: code === 'NL', is_local: local, total, pii_events: pii,
        });
        expect(countriesOf([d('US', 2, 1), d('NL', 5), d('US', 4), d(null, 1, 0, true)])).toEqual([
            { code: 'US', name: 'US', isEu: false, isLocal: false, total: 6, piiEvents: 1 },
            { code: 'NL', name: 'NL', isEu: true, isLocal: false, total: 5, piiEvents: 0 },
            { code: 'local', name: 'local', isEu: false, isLocal: true, total: 1, piiEvents: 0 },
        ]);
    });
});

describe('health is an organisation total only (GDPR Art. 9)', () => {
    it('knows every spelling of a health category, and nothing else', () => {
        for (const v of ['MedicalCondition', 'Medication', 'HealthInsuranceNumber', 'Medical Condition', 'medical_condition', 'health', ' Medical ']) {
            expect(isSpecialCategory(v)).toBe(true);
        }
        for (const v of ['Email', 'Person', 'NationalIdentificationNumber', 'scan_timeout', 'healthcare', '', null, undefined]) {
            expect(isSpecialCategory(v)).toBe(false);
        }
    });

    it('strips health labels from rows that carry a person, and leaves out a row that named only health', () => {
        const rows = [
            { id: 1, userName: 'Bea', categories: 'MedicalCondition,Email' },
            { id: 2, userName: 'Bea', categories: 'Medication' },
            { id: 3, userName: 'Cas', categories: 'Person, Email' },
            { id: 4, userName: 'Cas', categories: '' },
        ];
        const before = JSON.stringify(rows);
        expect(withholdSpecialCategories(rows, 'categories')).toEqual([
            { id: 1, userName: 'Bea', categories: 'Email' },
            { id: 3, userName: 'Cas', categories: 'Person, Email' },
            { id: 4, userName: 'Cas', categories: '' },
        ]);
        // Copied, never changed in place; an untouched row is the same row.
        expect(JSON.stringify(rows)).toBe(before);
        expect(withholdSpecialCategories(rows, 'categories')[1]).toBe(rows[2]);
    });

    it('says when the window\'s totals name a health category', () => {
        expect(namesSpecialCategory([{ category: 'Email', count: 4 }, { category: 'MedicalCondition', count: 2 }])).toBe(true);
        expect(namesSpecialCategory([{ category: 'Email', count: 4 }, { category: 'Medication', count: 0 }])).toBe(false);
        expect(namesSpecialCategory([])).toBe(false);
    });
});
