/**
 * DIFFERENTIAL lockstep: the privacy line against the web's privacyLine.js.
 */

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { describePrivacyLine, findTurnTokenMap, normaliseScanWarnings } from './privacyLine';
import { readMessage } from '../api/messageReader';

// No imports of its own, so it runs through Jest's Babel as it is.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require(`${AGENT_HUB_SRC}/components/chat/MessageItem/privacyLine.js`) as {
    describePrivacyLine: (a: unknown) => unknown;
    normaliseScanWarnings: (v: unknown) => unknown;
    findTurnTokenMap: (m: unknown[], i: number) => unknown;
};

const MAP = { '[email_1]': 'ann@example.com', '[person_1]': 'Ann de Vries', '[x_1]': 'ab' };

const LINES = [
    { count: 0, messageText: 'x' },
    { count: 2, messageText: 'Mail Ann de Vries at ann@example.com', tokenMap: MAP },
    { count: 1, messageText: 'Mail Ann de Vries at ann@example.com', tokenMap: MAP },
    { count: 5, messageText: 'Mail ann@example.com', tokenMap: MAP, scanIncomplete: true },
    { count: 2, messageText: 'nothing here', tokenMap: MAP },
    { count: 3, messageText: 'ab ab', tokenMap: MAP },
    { count: 4, messageText: 'Ann de Vries ann@example.com', tokenMap: MAP, limit: 1 },
];

describe('the privacy line matches the web', () => {
    it.each(LINES.map((l, i) => [i, l] as const))('#%s', (_i, line) => {
        expect(describePrivacyLine(line)).toEqual(web.describePrivacyLine(line));
    });

    it('reads scan warnings the same, unknown as "we do not know"', () => {
        for (const v of [null, undefined, false, '', [], [null], [{ filename: 'a' }, 'x'], { reason: 'timeout' }, 7]) {
            expect(normaliseScanWarnings(v)).toEqual(web.normaliseScanWarnings(v));
        }
    });

    it('finds the turn’s token map on the answer after the question', () => {
        const raw = [
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1', tokenisationInfo: { tokenMap: { '[a_1]': 'x' } } },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' },
        ];
        const mine = raw.map(readMessage);
        const webMessages = raw.map((m) => ({ ...m, tokenisationInfo: m.tokenisationInfo }));
        for (const i of [0, 1, 2, 3]) expect(findTurnTokenMap(mine, i)).toEqual(web.findTurnTokenMap(webMessages, i));
    });
});
