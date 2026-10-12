// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { isSpecialCategory, withoutSpecialCategories } from './specialCategories';

/**
 * Health (GDPR Art. 9) is an organisation total only on this pane, as on the
 * server. These pin which stored values count as health: every spelling the
 * server reads as the kind 'health', and nothing else. The phone's lockstep
 * test (mobile/src/features/orgShield/model/activity.lockstep.test.ts) pins
 * the list itself against the server's.
 */

describe('isSpecialCategory', () => {
    it('knows the three canonical health ids', () => {
        for (const id of ['MedicalCondition', 'Medication', 'HealthInsuranceNumber']) {
            expect(isSpecialCategory(id), id).toBe(true);
        }
    });

    it('knows the older spellings, in any case or separator', () => {
        for (const v of ['Medical Condition', 'medical_condition', 'health insurance number', 'health', 'Medical', ' medication ']) {
            expect(isSpecialCategory(v), v).toBe(true);
        }
    });

    it('is false for every other kind, an audit marker, and nothing at all', () => {
        for (const v of ['Email', 'Person', 'NationalIdentificationNumber', 'DateOfBirth', 'scan_timeout', 'healthcare', '', '  ', null, undefined]) {
            expect(isSpecialCategory(v), String(v)).toBe(false);
        }
    });
});

describe('withoutSpecialCategories', () => {
    it('drops the health categories and keeps the order of the rest', () => {
        expect(withoutSpecialCategories(['Person', 'MedicalCondition', 'Email', 'Medication'])).toEqual(['Person', 'Email']);
        expect(withoutSpecialCategories([])).toEqual([]);
    });
});
