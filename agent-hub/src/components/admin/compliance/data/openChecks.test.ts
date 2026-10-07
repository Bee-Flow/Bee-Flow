import { describe, it, expect } from 'vitest';
import { openChecksFor } from './openChecks';

const CHECKS = [
    { status: 'fail', regulation: 'GDPR' },
    { status: 'warn', regulation: 'GDPR' },
    { status: 'pass', regulation: 'GDPR' },
    { status: 'fail', frameworks: [{ regulation: 'AI Act' }] },
];

describe('openChecksFor', () => {
    it('counts only the failing and warning checks of a regulation', () => {
        expect(openChecksFor(CHECKS, 'GDPR')).toBe(2);
        expect(openChecksFor(CHECKS, 'AI Act')).toBe(1);
        expect(openChecksFor(CHECKS, 'NIS2')).toBe(0);
    });

    it('counts a check under every framework its evidence serves', () => {
        const checks = [{ status: 'fail', regulation: 'ISO27001', frameworks: [{ regulation: 'ISO27001' }, { regulation: 'NIS2' }] }];
        expect(openChecksFor(checks, 'ISO27001')).toBe(1);
        expect(openChecksFor(checks, 'NIS2')).toBe(1);
    });

    it('counts a per-source check once per scope, as the attention list does', () => {
        const checks = [
            { status: 'fail', regulation: 'AIA', check_id: 'AIA-Art50-content-marking', scope_id: 'a' },
            { status: 'warn', regulation: 'AIA', check_id: 'AIA-Art50-content-marking', scope_id: 'b' },
        ];
        expect(openChecksFor(checks, 'AIA')).toBe(2);
    });

    it('is undefined, not 0, while the checks have not loaded or no regulation is named', () => {
        expect(openChecksFor(null, 'GDPR')).toBeUndefined();
        expect(openChecksFor(undefined, 'GDPR')).toBeUndefined();
        expect(openChecksFor(CHECKS, null)).toBeUndefined();
        expect(openChecksFor([null], 'GDPR')).toBe(0);
    });
});
