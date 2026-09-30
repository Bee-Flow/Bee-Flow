/**
 * The elapsed clock, held to the web's formatElapsed.js on the same inputs.
 */

import fs from 'node:fs';
import path from 'node:path';

import { formatElapsed, formatSeconds } from './elapsed';

const WEB = path.resolve(__dirname, '../../../../agent-hub/src/components/shared/builder/formatElapsed.js');
const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

const START = '2026-09-24T10:00:00.000Z';
const OFFSETS = [0, 999, 1_000, 59_999, 60_000, 65_000, 3_599_000, 3_600_000, 3_723_000, 90_000_000, -5_000];

describe('formatSeconds', () => {
    it('counts whole seconds, then minutes and seconds, then hours and minutes', () => {
        expect(formatSeconds(42.9)).toBe('42s');
        expect(formatSeconds(185)).toBe('3m 5s');
        expect(formatSeconds(4320)).toBe('1h 12m');
        expect(formatSeconds(-3)).toBe('0s');
    });
});

describe('formatElapsed', () => {
    it('is null without a readable start', () => {
        expect(formatElapsed(null)).toBeNull();
        expect(formatElapsed('not a date')).toBeNull();
    });
});

describeIfWeb('formatElapsed matches the web', () => {
    it('prints the same words for the same span', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const web = require(WEB) as { formatElapsed: (s: string | null, now?: number) => string | null };
        const base = Date.parse(START);
        for (const offset of OFFSETS) {
            expect({ offset, words: formatElapsed(START, base + offset) }).toEqual({ offset, words: web.formatElapsed(START, base + offset) });
        }
        expect(formatElapsed(null)).toBe(web.formatElapsed(null));
    });
});
