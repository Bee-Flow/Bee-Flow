import { describe, it, expect } from 'vitest';
import { RUN_FORBIDDEN_CODE, mayStartRun, runStartRefusal, viewOnlyRunHint } from './runAccess';
import { AutomationRequestError } from './http';

const t = ((_key: string, fallback: string) => fallback) as Parameters<typeof viewOnlyRunHint>[0];

describe('mayStartRun', () => {
    it('follows the server answer: a viewer may not, an editor or run-role user may', () => {
        expect(mayStartRun({ canStart: false })).toBe(false);
        expect(mayStartRun({ canStart: true })).toBe(true);
    });

    it('treats a payload without the field as "not known", so the action stays on offer', () => {
        expect(mayStartRun({})).toBe(true);
        expect(mayStartRun({ canStart: null })).toBe(true);
        expect(mayStartRun(null)).toBe(true);
        expect(mayStartRun(undefined)).toBe(true);
    });

    it('does not read myRole: a view share beside a run share is the server\'s call', () => {
        expect(mayStartRun({ myRole: 'view', canStart: true } as { canStart: boolean })).toBe(true);
    });
});

describe('runStartRefusal', () => {
    it('maps automation_run_forbidden, from either error class, to the friendly sentence', () => {
        const hint = 'You can view this automation but not start it. Ask the owner for run access.';
        expect(viewOnlyRunHint(t)).toBe(hint);
        expect(runStartRefusal(t, new AutomationRequestError('POST x 403', 403, RUN_FORBIDDEN_CODE))).toBe(hint);
        expect(runStartRefusal(t, Object.assign(new Error('raw'), { code: RUN_FORBIDDEN_CODE }))).toBe(hint);
        expect(runStartRefusal(t, { code: RUN_FORBIDDEN_CODE })).toBe(hint);
    });

    it('leaves every other error to its caller', () => {
        expect(runStartRefusal(t, new AutomationRequestError('POST x 403', 403, 'automation_forbidden'))).toBeNull();
        expect(runStartRefusal(t, new Error('boom'))).toBeNull();
        expect(runStartRefusal(t, null)).toBeNull();
        expect(runStartRefusal(t, undefined)).toBeNull();
    });
});
