import { describe, expect, it } from 'vitest';
import { disclosureFails, isArt50Phase, shortTitlesOf } from './phaseRules';

const t = (key: string, fallback?: string) => ({
    'compliance.fw_aia_phase_gpai': 'GPAI rules',
    'compliance.fw_aia_phase_art50': 'Art. 50 transparency · enforcement',
} as Record<string, string>)[key] ?? fallback ?? key;

describe('phaseRules.isArt50Phase', () => {
    it('knows the Art. 50 step by calendar id, catalogue label_key or article', () => {
        expect(isArt50Phase({ id: 'aia_art50_enforcement' })).toBe(true);
        expect(isArt50Phase({ id: 'aia_0', label_key: 'compliance.fw_aia_phase_art50' })).toBe(true);
        expect(isArt50Phase({ article: '50(2)' })).toBe(true);
        expect(isArt50Phase({ id: 'aia_marking_transition_end', label_key: 'compliance.cal_ms_aia_marking_transition_end_label' })).toBe(false);
        expect(isArt50Phase({ id: 'aia_art500' })).toBe(false);
        expect(isArt50Phase(null)).toBe(false);
    });
});

describe('phaseRules.disclosureFails', () => {
    it('is true only for a failing AI Act Art. 50 check', () => {
        expect(disclosureFails([{ regulation: 'AIA', article: '50', status: 'fail' }])).toBe(true);
        expect(disclosureFails([{ regulation: 'aia', article: '50(2)', status: 'fail' }])).toBe(true);
        expect(disclosureFails([{ regulation: 'AIA', article: '50', status: 'warn' }])).toBe(false);
        expect(disclosureFails([{ regulation: 'GDPR', article: '50', status: 'fail' }])).toBe(false);
        expect(disclosureFails([null])).toBe(false);
        expect(disclosureFails(null)).toBe(false);
    });
});

describe('phaseRules.shortTitlesOf', () => {
    it('maps each date to the catalogue phase label, translated', () => {
        const map = shortTitlesOf({
            phases: [
                { date: '2025-08-02', label_key: 'compliance.fw_aia_phase_gpai' },
                { date: '2026-08-02', label_key: 'compliance.fw_aia_phase_art50' },
                { date: '2027-01-01', label: 'plain label' },
            ],
        }, t);
        expect(map.get('2025-08-02')).toBe('GPAI rules');
        expect(map.get('2026-08-02')).toBe('Art. 50 transparency · enforcement');
        expect(map.get('2027-01-01')).toBe('plain label');
    });

    it('leaves out a date with two catalogue phases, and anything without a date or label', () => {
        const map = shortTitlesOf({
            phases: [
                { date: '2026-01-01', label: 'one' },
                { date: '2026-01-01', label: 'two' },
                { date: null, label: 'undated' },
                { date: '2026-02-01' },
                null,
            ],
        }, t);
        expect([...map.keys()]).toEqual([]);
        expect(shortTitlesOf(null, t).size).toBe(0);
        expect(shortTitlesOf({ phases: null }, t).size).toBe(0);
    });
});
