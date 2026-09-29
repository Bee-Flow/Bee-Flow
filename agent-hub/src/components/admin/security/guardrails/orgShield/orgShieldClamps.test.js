// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { describeClamps, describeClampsOnLoad, describeSaveResult } from './orgShieldClamps';

/**
 * The sentence an admin reads after a save that landed but not exactly as
 * asked. The case worth protecting is the last one: a field the SERVER clamped
 * that this build has no label for. Reporting that as a clean save is how
 * someone ends up believing a setting took.
 */

const t = (key, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let out = hasStringFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
            out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
        }
    }
    return out;
};

describe('describeClamps', () => {
    it('names the setting instead of saying "some settings"', () => {
        // The whole point. "Some settings were adjusted" leaves an admin who
        // changed four things on two panes to either re-check all four or
        // assume it was fine.
        const { text } = describeClamps(['piiDetectionAction'], t);
        expect(text).toContain('Replace with placeholders');
        expect(text).toContain('messages are stopped instead');
        expect(text).not.toMatch(/some settings/i);
    });

    it('reassures that everything else did save', () => {
        const { text } = describeClamps(['webSearchGuardEnabled'], t);
        expect(text).toContain('Every other change did land');
    });

    it('lists several clamps in one sentence', () => {
        const { text } = describeClamps(['piiDetectionAction', 'webSearchGuardEnabled'], t);
        expect(text).toContain('Replace with placeholders');
        expect(text).toContain('Protect web searches');
        expect(text).toContain(';');
    });

    it('reports which panes to go and look at', () => {
        const { tabs } = describeClamps(['piiDetectionAction', 'toolPiiPolicy', 'webSearchGuardEnabled'], t);
        expect(tabs).toEqual(expect.arrayContaining(['processing', 'detection', 'outbound']));
    });

    it('dedupes the panes when two clamps share one', () => {
        const { tabs } = describeClamps(['webSearchGuardEnabled', 'webSearchGuardPiiCategories'], t);
        expect(tabs).toEqual(['outbound']);
    });

    it('counts a field it has no label for rather than dropping it', () => {
        // A newer server against an older client. Silence here would be a
        // clean-looking save over a setting that did not stick.
        const { text } = describeClamps(['piiDetectionAction', 'somethingNewerThanThisBuild'], t);
        expect(text).toContain('Replace with placeholders');
        expect(text).toContain('1 other settings');
    });

    it('falls back to the generic line when it recognises nothing at all', () => {
        const { text, tabs } = describeClamps(['entirelyUnknown'], t);
        expect(text).toContain('1 other settings');
        expect(tabs).toEqual([]);
    });

    it('survives an empty or missing list', () => {
        expect(describeClamps([], t).text).toMatch(/adjusted to your plan limits/);
        expect(describeClamps(undefined, t).text).toMatch(/adjusted to your plan limits/);
    });

    it('says in a sentence of its own that changes to Your own data did not land', () => {
        // On a plan without the feature the server keeps the stored types and
        // refuses every change except removing an old one. That is not "a
        // setting was emptied", it is "your edits there were not saved".
        const { text, tabs } = describeClamps(['customDataTypes'], t);
        expect(text).toBe('Saved, with notes. Your own kinds of data can only be changed with Enterprise. Your changes to them were not saved.');
        expect(tabs).toEqual(['owndata']);
    });

    it('keeps the list sentence and adds the own-data sentence after it', () => {
        const { text, tabs } = describeClamps(['piiDetectionAction', 'customDataTypes'], t);
        expect(text).toContain('Replace with placeholders');
        expect(text).toMatch(/Every other change did land\. Your own kinds of data can only be changed with Enterprise/);
        expect(text).not.toContain('other settings');
        expect(tabs).toEqual(expect.arrayContaining(['processing', 'owndata']));
    });
});

describe('describeSaveResult', () => {
    it('is a plain success when nothing was clamped or refused', () => {
        const out = describeSaveResult({ config: {} }, t);
        expect(out.message).toEqual({ type: 'success', text: 'Saved.' });
        expect(out.result).toEqual({ ok: true, clamped: [], termErrors: [], typeErrors: [] });
    });

    it('reports refused types as a partial save and points at their tab', () => {
        const out = describeSaveResult({ config: {}, typeErrors: [{ id: 'cdt_0123456789', field: 'pattern', code: 'pattern_unsafe', message: 'too slow' }] }, t);
        expect(out.message.type).toBe('warning');
        expect(out.message.text).toMatch(/1 of your own types were refused and are not in force/);
        expect(out.message.tabs).toEqual(['owndata']);
        expect(out.result.typeErrors).toHaveLength(1);
    });

    it('reflects a clamped action from the stored row', () => {
        const out = describeSaveResult({ config: { piiDetectionAction: 'block' }, clamped_fields: ['piiDetectionAction'] }, t);
        expect(out.clampedAction).toBe('block');
        expect(out.message.type).toBe('warning');
    });
});

describe('describeClampsOnLoad', () => {
    it('says what is in force rather than what was saved', () => {
        // On the READ path nothing was just submitted, so "every other change
        // did land" would be meaningless.
        const text = describeClampsOnLoad(['piiDetectionAction'], t);
        expect(text).toContain('Replace with placeholders');
        expect(text).toContain('what is in force');
        expect(text).not.toContain('Saved');
    });

    it('names Your own data on the read path too, without claiming a save', () => {
        const text = describeClampsOnLoad(['customDataTypes'], t);
        expect(text).toBe('Your own kinds of data can only be changed with Enterprise.');
    });

    it('degrades to one sentence when it recognises nothing', () => {
        expect(describeClampsOnLoad(['unknown'], t)).toMatch(/limited by your current plan/);
        expect(describeClampsOnLoad([], t)).toMatch(/limited by your current plan/);
    });
});
