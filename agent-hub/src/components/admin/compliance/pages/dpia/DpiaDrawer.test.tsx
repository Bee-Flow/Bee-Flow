import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { dpiaPill, EMPTY_FORM, formFromRecord, formReady, isExpired, mitigationList, questionnaireBody } from './DpiaDrawer';

const t: TranslateFn = (key, fallback, params) => {
    let out = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
    return out;
};
const NOW = Date.parse('2026-10-07T12:00:00Z');

describe('DpiaDrawer helpers', () => {
    it('reads the recorded measures as a list, whether stored as a list or as lines', () => {
        expect(mitigationList(['PII redaction', ' ', 'EU-hosted model '])).toEqual(['PII redaction', 'EU-hosted model']);
        expect(mitigationList('Redaction\n\nFour-eyes check ')).toEqual(['Redaction', 'Four-eyes check']);
        expect(mitigationList(null)).toEqual([]);
    });

    it('pre-fills the form from a record, and falls back to the empty form', () => {
        expect(formFromRecord({
            risk_level: 'high',
            answers: { purpose: 'Screen CVs', data_categories: 'CVs', automated_decisions: true, human_oversight: 'Recruiter' },
            mitigations: ['Redaction', 'Four-eyes check'],
        })).toEqual({
            purpose: 'Screen CVs', data_categories: 'CVs', automated_decisions: true,
            human_oversight: 'Recruiter', mitigations: 'Redaction\nFour-eyes check', risk_level: 'high',
        });
        expect(formFromRecord(null)).toEqual(EMPTY_FORM);
        expect(formFromRecord({ risk_level: 'extreme', answers: { purpose: 42 } }).risk_level).toBe('medium');
    });

    it('a questionnaire is ready only with purpose, data and oversight in words', () => {
        expect(formReady(EMPTY_FORM)).toBe(false);
        expect(formReady({ ...EMPTY_FORM, purpose: 'a', data_categories: 'b', human_oversight: ' ' })).toBe(false);
        expect(formReady({ ...EMPTY_FORM, purpose: 'a', data_categories: 'b', human_oversight: 'c' })).toBe(true);
    });

    it('sends trimmed answers, measures one per line, and a twelve-month expiry', () => {
        const body = questionnaireBody({ ...EMPTY_FORM, purpose: ' a ', data_categories: 'b', human_oversight: 'c', mitigations: 'x\n\ny' }, new Date('2026-10-07T00:00:00Z'));
        expect(body).toMatchObject({
            mode: 'questionnaire', risk_level: 'medium', mitigations: ['x', 'y'],
            answers: { purpose: 'a', data_categories: 'b', automated_decisions: false, human_oversight: 'c' },
        });
        expect(String(body.expires_at)).toContain('2027-10-07');
    });

    it('the pill: "No DPIA", "Assessed {date}" with how and until when, or "Expired {date}"', () => {
        expect(dpiaPill(null, t, 'en', NOW)).toEqual({ tone: 'error', label: 'No DPIA' });
        expect(dpiaPill({ mode: 'attestation', approved_at: '2026-07-25T10:00:00Z', expires_at: '2027-07-25T10:00:00Z' }, t, 'en', NOW))
            .toEqual({ tone: 'success', label: 'Assessed 25 Jul', title: 'attestation · Expires 25 Jul 2027' });
        expect(dpiaPill({ mode: 'questionnaire', approved_at: '2026-07-25T10:00:00Z' }, t, 'en', NOW))
            .toEqual({ tone: 'success', label: 'Assessed 25 Jul', title: 'questionnaire' });
        expect(dpiaPill({ mode: 'questionnaire', approved_at: '2024-07-25T10:00:00Z', expires_at: '2025-07-25T10:00:00Z' }, t, 'en', NOW))
            .toEqual({ tone: 'error', label: 'Expired 25 Jul 2025', title: 'questionnaire' });
        expect(isExpired({ expires_at: null }, NOW)).toBe(false);
    });
});
