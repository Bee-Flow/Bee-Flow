/**
 * The retry row's rules against the web's RetrySection
 * (flow/settings/collectionEditors.jsx, read as text — it is a React module):
 * the two closed lists, the default, the long-wait line and the row cap.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
    activeRetry,
    RETRY_DEFAULT,
    RETRY_LONG_WAIT_MS,
    RETRY_TRY_COUNTS,
    RETRY_WAIT_MS,
    retryChoices,
    retryRowCap,
    retryTriesLabel,
    retryWaitLabel,
    retryWaitTotal,
} from './retry';

const REPO = path.resolve(__dirname, '../../../../../../../..');
const SRC = fs.readFileSync(path.join(REPO, 'agent-hub/src/components/automation/Builder/flow/settings/collectionEditors.jsx'), 'utf8');
const numbers = (name: string) =>
    (new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(SRC)?.[1] ?? '').split(',').map((n) => Number(n.trim().replace(/_/g, '')));

describe('against RetrySection', () => {
    it('offers the same closed lists and default', () => {
        expect([...RETRY_TRY_COUNTS]).toEqual(numbers('RETRY_TRY_COUNTS'));
        expect([...RETRY_WAIT_MS]).toEqual(numbers('RETRY_WAIT_MS'));
        expect(SRC).toContain(`const RETRY_DEFAULT = { max: ${RETRY_DEFAULT.max}, backoffMs: ${RETRY_DEFAULT.backoffMs} };`);
        expect(SRC).toContain('const RETRY_LONG_WAIT_MS = 150_000;');
        expect(RETRY_LONG_WAIT_MS).toBe(150_000);
    });

    it('caps the rows the way the runner does', () => {
        expect(SRC).toContain('return Math.min(Number(forEach.maxIterations) || 100, 1000);');
        expect(retryRowCap(null)).toBe(1);
        expect(retryRowCap({ overRef: '' })).toBe(1);
        expect(retryRowCap({ overRef: 'x' })).toBe(100);
        expect(retryRowCap({ overRef: 'x', maxIterations: 5000 })).toBe(1000);
    });
});

describe('the retry row', () => {
    it('reads max 0 as off', () => {
        expect(activeRetry({ max: 0, backoffMs: 5000 })).toBeNull();
        expect(activeRetry(null)).toBeNull();
        expect(activeRetry({ max: 2, backoffMs: 5000 })).toEqual({ max: 2, backoffMs: 5000 });
    });

    it('keeps a stored value that is not on the list', () => {
        expect(retryChoices(RETRY_TRY_COUNTS, 4)).toEqual([1, 2, 3, 4, 5]);
        expect(retryChoices(RETRY_TRY_COUNTS, 2)).toEqual([1, 2, 3, 5]);
    });

    it('words the choices as the web does', () => {
        expect([1, 2, 5].map(retryTriesLabel)).toEqual(['Once', 'Twice', '5 times']);
        expect([0, 1000, 2000, 60_000, 120_000].map(retryWaitLabel)).toEqual([
            'Straight away',
            'After 1 second',
            'After 2 seconds',
            'After 1 minute',
            'After 2 minutes',
        ]);
    });

    it('adds up the waiting, and says when it could outlast the run', () => {
        expect(retryWaitTotal({ max: 2, backoffMs: 5000 }, 1)).toEqual({ seconds: 10, long: false });
        expect(retryWaitTotal({ max: 2, backoffMs: 5000 }, 100)).toEqual({ seconds: 1000, long: true });
        expect(retryWaitTotal({ max: 2, backoffMs: 0 }, 1)).toBeNull();
    });
});
