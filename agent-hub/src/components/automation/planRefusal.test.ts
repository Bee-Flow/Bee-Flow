import { describe, it, expect } from 'vitest';
import { isPlanRefusal, planRefusalText } from './planRefusal';

/**
 * A plan refusal (server/automation/licensedSteps.js) on screen: the step
 * sentences, never the machine word the gate sends in `error`.
 */

const DETAILS = [
    { code: 'licence.privacy_steps', message: 'Step "Scan it" is a Privacy Shield step, and Privacy Shield steps in routines are part of the Enterprise plan.', hint: 'Remove the step, or upgrade to Enterprise.' },
];

describe('planRefusalText', () => {
    it('reads the step sentences off `details` (the automation API helper)', () => {
        const e = Object.assign(new Error('feature_locked: Step "Scan it" is …'), { status: 403, code: 'feature_locked', details: DETAILS });
        const text = planRefusalText(e);
        expect(text).toContain('"Scan it" is a Privacy Shield step');
        expect(text).toContain('Remove the step');
        expect(text).not.toMatch(/feature_locked/);
    });

    it('keeps the server\'s own sentence when that is all that travelled (the publish helper)', () => {
        const said = 'This routine cannot go live on your organisation\'s plan.: Step "Scan it" is a Privacy Shield step';
        const e = Object.assign(new Error(said), { status: 403, code: 'feature_locked' });
        expect(planRefusalText(e)).toBe(said);
    });

    it('strips the machine word from an older gate\'s message', () => {
        const e = Object.assign(new Error('feature_locked: Step "Scan it" is a Privacy Shield step — Remove the step'), { status: 403, code: 'feature_locked' });
        expect(planRefusalText(e)).toBe('Step "Scan it" is a Privacy Shield step — Remove the step');
    });

    it('a bare gate with no sentence at all still reads as one', () => {
        const e = Object.assign(new Error('feature_locked'), { status: 403 });
        const t = (key: string, fallback?: unknown) => `${key}|${String(fallback)}`;
        expect(planRefusalText(e, t)).toBe('automation.plan.refused|This is not part of your organisation\'s plan.');
        expect(planRefusalText(e)).toBe('This is not part of your organisation\'s plan.');
    });

    it('feature_disabled is a plan refusal too; anything else is not', () => {
        expect(isPlanRefusal({ code: 'feature_disabled' })).toBe(true);
        expect(isPlanRefusal(new Error('feature_disabled'))).toBe(true);
        expect(isPlanRefusal(new Error('Invalid definition: step s1 has no tool'))).toBe(false);
        expect(isPlanRefusal({ code: 'ai_act_check_required' })).toBe(false);
        expect(isPlanRefusal(null)).toBe(false);
        expect(planRefusalText(new Error('Invalid definition'))).toBeNull();
    });
});
