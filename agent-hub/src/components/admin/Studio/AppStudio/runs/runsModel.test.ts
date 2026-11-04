import { describe, expect, it } from 'vitest';
import { actorText, formatCost, formatDuration, statusTone, stepLabel } from './runsModel';

const t = (_key: string | undefined, fallback?: unknown, params?: Record<string, unknown> | null) => {
    let s = typeof fallback === 'string' ? fallback : '';
    for (const [k, v] of Object.entries(params ?? {})) s = s.replace(`{${k}}`, String(v));
    return s;
};

describe('runsModel', () => {
    it('durations read as ms, s and minutes', () => {
        expect(formatDuration(340)).toBe('340 ms');
        expect(formatDuration(2500)).toBe('2.5 s');
        expect(formatDuration(42_000)).toBe('42 s');
        expect(formatDuration(125_000)).toBe('2 min 5 s');
        expect(formatDuration(null)).toBe('—');
    });

    it('cost is shown per currency, small amounts with four decimals', () => {
        expect(formatCost({ USD: 0.0021 }, 'en-US')).toBe('$0.0021');
        expect(formatCost({ USD: 1.5, EUR: 0.25 }, 'en-US')).toBe('$1.50 · €0.25');
        expect(formatCost({}, 'en-US')).toBe('—');
    });

    it('status tones and who ran it', () => {
        expect(statusTone('success')).toBe('ok');
        expect(statusTone('error')).toBe('error');
        expect(statusTone('interrupted')).toBe('warning');
        expect(actorText({ kind: 'user', isYou: true }, t)).toBe('You');
        expect(actorText({ kind: 'user', isYou: false, name: 'Vera' }, t)).toBe('Vera');
        expect(actorText({ kind: 'user', isYou: false, name: null }, t)).toBe('A signed-in user');
        expect(actorText({ kind: 'visitor', isYou: false }, t)).toBe('Public visitor');
    });

    it('a step label names its path and kind, an unplaced step its position, a loop its item', () => {
        expect(stepLabel({ path: 'steps[2]', kind: 'update_record', iteration: null }, t)).toBe('steps[2] · update_record');
        expect(stepLabel({ path: '#3', kind: 'create_record', iteration: 1 }, t)).toBe('Step 4 · create_record · item 2');
    });
});
