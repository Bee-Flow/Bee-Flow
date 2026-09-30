/** The PIN forms' own refusals, checked in the order the fields appear. */

import { MIN_PIN_LENGTH, pinSetupProblem, pinUnlockProblem, recoveryProblem } from './pin';

const GOOD = 'x'.repeat(MIN_PIN_LENGTH);

describe('pinSetupProblem', () => {
    it('wants the minimum length, then two matching entries', () => {
        expect(pinSetupProblem('12345', '12345')).toBe(`Your PIN needs at least ${MIN_PIN_LENGTH} characters.`);
        expect(pinSetupProblem(GOOD, `${GOOD}y`)).toBe('Those two PINs are not the same.');
        expect(pinSetupProblem(GOOD, GOOD)).toBeNull();
    });
});

describe('pinUnlockProblem', () => {
    it('only wants something typed', () => {
        expect(pinUnlockProblem('')).toBe('Enter your encryption PIN.');
        expect(pinUnlockProblem('1')).toBeNull();
    });
});

describe('recoveryProblem', () => {
    it('wants the key, then a long enough new PIN, then a match', () => {
        expect(recoveryProblem('  ', GOOD, GOOD)).toMatch(/Paste the recovery key/);
        expect(recoveryProblem('KEY', '1', '1')).toBe(`Your new PIN needs at least ${MIN_PIN_LENGTH} characters.`);
        expect(recoveryProblem('KEY', GOOD, 'other1')).toBe('Those two PINs are not the same.');
        expect(recoveryProblem('KEY', GOOD, GOOD)).toBeNull();
    });
});
