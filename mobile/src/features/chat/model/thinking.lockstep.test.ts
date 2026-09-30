/**
 * DIFFERENTIAL lockstep: the reasoning panel's pure half against the web's
 * own functions, loaded one by one out of ThinkingPanel.jsx.
 */

import { loadWebFunctions } from '@/shared/testing/webModule';

import { formatThinkingDuration, thinkingDurationMs, thinkingPartsOf } from './thinking';
import type { ThinkingPart } from './types';

const web = loadWebFunctions<{
    resolveParts: (m: unknown) => ThinkingPart[];
    computeDurationMs: (parts: unknown, m: unknown) => number | null;
    formatDuration: (ms: number | null) => string;
}>('components/chat/MessageItem/ThinkingPanel.jsx', ['resolveParts', 'computeDurationMs', 'formatDuration']);

const PARTS: ThinkingPart[] = [
    { id: 'a', text: 'one', startedAt: 1000, endedAt: 4400 },
    { id: 'b', text: 'two', startedAt: 5000, endedAt: null },
    { id: 'c', text: '', startedAt: 6000, endedAt: 7250, redacted: true },
];

describe('the reasoning panel matches the web', () => {
    it('resolves the parts the same way', () => {
        for (const message of [{ thinkingParts: PARTS }, { thinking: 'legacy' }, {}]) {
            expect(thinkingPartsOf(message)).toEqual(web.resolveParts(message));
        }
    });

    it('measures the same span from the parts', () => {
        for (const parts of [PARTS, PARTS.slice(1, 2), [], [{ id: 'x', text: 'y', startedAt: null, endedAt: null }]]) {
            expect(thinkingDurationMs(parts)).toBe(web.computeDurationMs(parts, {}));
        }
    });

    it('formats durations the same', () => {
        for (const ms of [null, 0, 950, 3400, 9999, 12_400, 59_600, 60_000, 125_300]) {
            expect(formatThinkingDuration(ms)).toBe(web.formatDuration(ms));
        }
    });
});
