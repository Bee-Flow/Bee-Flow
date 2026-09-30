/**
 * The Compliance block's chip and signals line, and the lockstep with the
 * web's ComplianceBlock.jsx: the same outcome words under the same keys,
 * and the same chip rule.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AiActAssessment, AiActSignals } from '@/features/flow-editor/api';

import { chipLabel, chipState, OUTCOME_LABEL, outcomeWords, signalsLine } from './complianceModel';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const WEB = fs.readFileSync(
    path.resolve(__dirname, '../../../../../../agent-hub/src/components/admin/compliance/ladder/ComplianceBlock.jsx'),
    'utf8',
);

const NOW = new Date('2026-09-25T00:00:00Z').getTime();
const SIGNALS: AiActSignals = {
    containsAi: true, customerFacing: true, generatesContent: true, disclosurePresent: null, markingEnabled: null,
    aiSteps: 2, aiStepLabels: [], annexHints: [],
};
const signals = (patch: Partial<AiActSignals>): AiActSignals => ({ ...SIGNALS, aiSteps: null, ...patch });
const saved = (patch: Partial<AiActAssessment> = {}): AiActAssessment => ({
    outcome: 'minimal',
    attestedAt: '2026-09-01T10:00:00Z',
    expiresAt: '2027-09-01T10:00:00Z',
    current: true,
    signals: SIGNALS,
    answers: null,
    ...patch,
});

describe('the chip', () => {
    it('is "not assessed" until a declaration, then declared, expired, or red for a prohibited practice', () => {
        expect(chipState(null, NOW)).toEqual({ tone: 'neutral', state: 'none' });
        expect(chipState(saved({ attestedAt: null }), NOW).state).toBe('none');
        expect(chipState(saved(), NOW)).toEqual({ tone: 'success', state: 'declared' });
        expect(chipState(saved({ current: false }), NOW)).toEqual({ tone: 'warning', state: 'expired' });
        expect(chipState(saved({ expiresAt: '2026-01-01T00:00:00Z' }), NOW).state).toBe('expired');
        expect(chipState(saved({ outcome: 'prohibited' }), NOW)).toEqual({ tone: 'error', state: 'declared' });
        expect(chipLabel(null, t, NOW)).toBe('Not assessed');
        expect(chipLabel(saved({ current: false }), t, NOW)).toBe('Expired');
        expect(chipLabel(saved(), t, NOW)).toMatch(/^Self-declared /);
        expect(outcomeWords(saved({ outcome: 'high_risk' }), t)).toBe('High-risk (Annex III)');
    });

    it('says what the checks see, in the web’s order', () => {
        expect(signalsLine(saved(), t)).toBe('2 AI steps · customer-facing · generates content');
        expect(signalsLine(saved({ signals: signals({ containsAi: false, customerFacing: false, generatesContent: null }) }), t)).toBe('no AI steps · internal only');
        expect(signalsLine(saved({ signals: signals({ containsAi: true, customerFacing: null, generatesContent: null }) }), t)).toBe('contains AI');
        expect(signalsLine(null, t)).toBeNull();
    });
});

describe('lockstep with ComplianceBlock.jsx', () => {
    it('labels every outcome with the web’s key and words', () => {
        for (const [outcome, { key, en }] of Object.entries(OUTCOME_LABEL)) {
            expect(WEB).toContain(`${outcome}: { key: '${key}', en: '${en}' }`);
        }
    });

    it('keeps the chip rule', () => {
        expect(WEB).toContain("if (!assessment || !assessment.outcome || !assessment.attested_at) return { tone: 'neutral', state: 'none' };");
        expect(WEB).toContain("if (expired) return { tone: 'warning', state: 'expired' };");
        expect(WEB).toContain("if (assessment.outcome === 'prohibited') return { tone: 'error', state: 'declared' };");
    });
});
