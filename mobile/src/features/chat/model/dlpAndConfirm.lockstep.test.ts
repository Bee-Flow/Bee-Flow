/**
 * DIFFERENTIAL lockstep: the DLP review spans (dlpFindingsState.js) and the
 * held-call state (toolConfirmStatus.js) against the web's own modules.
 */

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { buildRuns, mergeSpans, spansInRange, wordsOf } from './dlpSpans';
import { confirmDecisionOf } from './toolConfirm';
import type { DlpFinding, PendingToolCall } from './types';

/* eslint-disable @typescript-eslint/no-require-imports */
const webSpans = require(`${AGENT_HUB_SRC}/components/chat/dlpReview/dlpFindingsState.js`) as {
    mergeSpans: (a: unknown, m: unknown) => unknown[];
    spansInRange: (s: unknown, a: number, b: number) => unknown;
    buildRuns: (t: string, s: unknown) => unknown;
};
const webConfirm = require(`${AGENT_HUB_SRC}/components/chat/MessageItem/toolConfirmStatus.js`) as {
    confirmDecisionOf: (c: unknown, d?: unknown) => unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const TEXT = 'Call Ann de Vries on 06-12345678 about invoice NL91ABNA0417164300.';
const FINDINGS: DlpFinding[] = [
    { id: 'pii_0', label: 'person', category: 'Person', source: 'pii', offset: 5, length: 12 },
    { id: 'pii_1', label: 'phone', category: 'Phone', source: 'pii', offset: 21, length: 11 },
    { id: 'pii_2', label: 'first', category: 'Person', source: 'pii', offset: 5, length: 3 },
    { id: 'custom_0', label: 'iban', category: 'IBAN', source: 'custom', offset: 47, length: 18 },
    { id: 'bad', offset: -1, length: 2 },
    { id: 'bad2', offset: 3, length: 0 },
];

describe('the DLP spans match the web', () => {
    const MARKS = [[], [{ id: 'manual_1', offset: 38, length: 7, text: 'invoice' }], [{ id: 'manual_2', offset: 9, length: 12 }]];

    it.each(MARKS.map((m, i) => [i, m] as const))('merges with marks #%s', (_i, marks) => {
        const mine = mergeSpans(FINDINGS, marks);
        expect(mine).toEqual(webSpans.mergeSpans(FINDINGS, marks));
        expect(buildRuns(TEXT, mine)).toEqual(webSpans.buildRuns(TEXT, mine));
        expect(spansInRange(mine, 20, 50)).toEqual(webSpans.spansInRange(mine, 20, 50));
    });

    it('offers a plain run word by word, at its place in the whole text', () => {
        expect(wordsOf(' invoice  NL91 ', 37)).toEqual([
            { word: 'invoice', offset: 38, length: 7 },
            { word: 'NL91', offset: 47, length: 4 },
        ]);
    });
});

describe('the held-call state matches the web', () => {
    const CALLS: (PendingToolCall | null)[] = [
        null,
        { toolName: 'send', argsKey: 'k', callId: 'c1', status: 'pending' },
        { toolName: 'send', argsKey: 'k', callId: 'c1', status: 'approved' },
        { toolName: 'send', argsKey: 'k', callId: 'c1', status: 'declined' },
        { toolName: 'send', argsKey: 'k', callId: 'c1', status: 'weird' },
        { toolName: 'send', argsKey: 'k', status: 'pending' },
        { toolName: 'send', argsKey: 'k', callId: 'c2', status: 'pending' },
    ];
    const BOOKS: Record<string, string>[] = [{}, { c1: 'approve' }, { k: 'decline' }, { c1: 'decline', k: 'approve' }];

    it.each(CALLS.map((c, i) => [i, c] as const))('call #%s', (_i, call) => {
        for (const book of BOOKS) expect(confirmDecisionOf(call, book)).toEqual(webConfirm.confirmDecisionOf(call, book));
    });
});
