import { describe, expect, it } from 'vitest';
import { AUDIT_STATUS, NC_SOURCE, OBJ_STATUS, labelOf, toneOf } from './auditForms';

/**
 * labelOf / toneOf read a status table with a value that may be missing. The
 * lookup is written with an explicit null check so it can be typed; a missing
 * value answers exactly what it did.
 */

const t = (key, en) => `${key}|${en}`;

describe('labelOf', () => {
    it('reads the label of a known value', () => {
        expect(labelOf(t, AUDIT_STATUS, 'planned')).toBe('compliance.audit_status_planned|Planned');
    });

    it('an unknown value renders its raw word with spaces', () => {
        expect(labelOf(t, AUDIT_STATUS, 'on_hold')).toBe('on hold');
    });

    it('a missing value is a dash', () => {
        expect(labelOf(t, AUDIT_STATUS, null)).toBe('—');
        expect(labelOf(t, AUDIT_STATUS, undefined)).toBe('—');
        expect(labelOf(t, AUDIT_STATUS, '')).toBe('—');
    });

    it('works for a table without tones', () => {
        expect(labelOf(t, NC_SOURCE, 'manual')).toBe('compliance.nc_source_manual|Manual');
    });
});

describe('toneOf', () => {
    it('reads the tone of a known value', () => {
        expect(toneOf(AUDIT_STATUS, 'closed')).toBe('success');
        expect(toneOf(OBJ_STATUS, 'dropped')).toBe('neutral');
    });

    it('falls back for an unknown, missing or toneless value', () => {
        expect(toneOf(AUDIT_STATUS, 'on_hold')).toBe('neutral');
        expect(toneOf(AUDIT_STATUS, null)).toBe('neutral');
        expect(toneOf(AUDIT_STATUS, undefined)).toBe('neutral');
        expect(toneOf(AUDIT_STATUS, '')).toBe('neutral');
        expect(toneOf(NC_SOURCE, 'manual')).toBe('neutral');
        expect(toneOf(AUDIT_STATUS, null, 'warning')).toBe('warning');
        expect(toneOf(AUDIT_STATUS, 'on_hold', 'error')).toBe('error');
    });
});
