import { mayStartRun } from './runAccess';
import { readAutomation, readRun } from '../api/readers';

describe('mayStartRun', () => {
    it('follows the server answer: a viewer may not, an editor or run-role user may', () => {
        expect(mayStartRun({ canStart: false })).toBe(false);
        expect(mayStartRun({ canStart: true })).toBe(true);
    });

    it('keeps the action for a payload without the field (an older server)', () => {
        expect(mayStartRun({})).toBe(true);
        expect(mayStartRun(null)).toBe(true);
        expect(mayStartRun(undefined)).toBe(true);
    });
});

describe('the readers carry canStart', () => {
    it('reads it off an automation and a run, and leaves it absent when the server sent none', () => {
        expect(readAutomation({ id: 'a1', canStart: false }).canStart).toBe(false);
        expect(readAutomation({ id: 'a1', canStart: true }).canStart).toBe(true);
        expect(readAutomation({ id: 'a1' }).canStart).toBeUndefined();
        expect(readRun({ id: 'r1', canStart: false }).canStart).toBe(false);
        expect(readRun({ id: 'r1' }).canStart).toBeUndefined();
    });
});
