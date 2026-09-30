/**
 * DIFFERENTIAL lockstep: the phase trail against the web's own module
 * (agent-hub/src/hooks/useChatEngine/phaseTrail.ts) and traceSpanMs against
 * agent-hub/src/components/chat/answerTrace.js, on the same events. The
 * fixtures are the cases the web's phaseTrail.test.js pins.
 */

import path from 'node:path';

import { appendPhase, MAX_TRAIL_STEPS, traceSpanMs, type PhaseEvent } from './phaseTrail';
import type { PhaseTrailEntry } from './types';

const WEB = path.resolve(__dirname, '../../../../agent-hub/src');
/* eslint-disable @typescript-eslint/no-require-imports */
const web = require(path.join(WEB, 'hooks/useChatEngine/phaseTrail.ts')) as {
    appendPhase: (t: unknown, d: unknown, now?: number) => unknown;
    MAX_TRAIL_STEPS: number;
};
const webTrace = require(path.join(WEB, 'components/chat/answerTrace.js')) as { traceSpanMs: (t: unknown) => unknown };
/* eslint-enable @typescript-eslint/no-require-imports */

const start = (stage: string, detail?: string): PhaseEvent => ({ stage, status: 'start', detail });
const end = (stage: string, durationMs?: number): PhaseEvent => ({ stage, status: 'end', durationMs });

/** Each case: a list of [event, now] folded from an empty trail. */
const CASES: Record<string, [PhaseEvent | null, number][]> = {
    'a start opens a row': [[start('kb_search'), 1000]],
    'the server measured duration wins': [[start('kb_search'), 1000], [end('kb_search', 137), 1500]],
    'our clock stands in': [[start('kb_search'), 1000], [{ stage: 'kb_search', status: 'end' }, 1500]],
    'an end without a start makes no row': [[end('guardrails', 20), 1000]],
    'a closed step is not reopened': [[start('kb_search'), 1000], [end('kb_search', 137), 1500], [end('kb_search', 999), 2000]],
    'a repeated start of an open stage is one step': [
        [start('privacy_scan_large', '1/6'), 1000],
        [start('privacy_scan_large', '2/6'), 1100],
        [start('privacy_scan_large', '3/6'), 1200],
    ],
    'a stage run twice gets two rows and two ends': [
        [start('kb_search'), 1000],
        [end('kb_search', 10), 1010],
        [start('kb_search'), 2000],
        [end('kb_search', 20), 2020],
    ],
    'overlapping stages close where they belong': [
        [start('guardrails'), 1000],
        [start('privacy_scan'), 1010],
        [end('privacy_scan', 40), 1050],
        [end('guardrails', 60), 1060],
    ],
    'junk changes nothing': [[start('kb_search'), 1], [null, 2], [{}, 3], [{ stage: '   ' }, 4], [{ stage: 5 }, 5]],
};

function foldMine(events: [PhaseEvent | null, number][]): PhaseTrailEntry[] | undefined {
    return events.reduce<PhaseTrailEntry[] | undefined>((trail, [e, now]) => appendPhase(trail, e, now), undefined);
}

function foldWeb(events: [PhaseEvent | null, number][]): unknown {
    return events.reduce<unknown>((trail, [e, now]) => web.appendPhase(trail, e, now), undefined);
}

describe('appendPhase matches the web', () => {
    it('has the same bound', () => {
        expect(MAX_TRAIL_STEPS).toBe(web.MAX_TRAIL_STEPS);
    });

    it.each(Object.entries(CASES))('%s', (_name, events) => {
        expect(foldMine(events)).toEqual(foldWeb(events));
    });

    it('stops growing at the bound but still closes', () => {
        const events: [PhaseEvent, number][] = [];
        for (let i = 0; i < MAX_TRAIL_STEPS + 2; i++) events.push([start(`s${i}`), 1000 + i]);
        events.push([end('s0', 5), 9999]);
        expect(foldMine(events)).toEqual(foldWeb(events));
        expect(foldMine(events)).toHaveLength(MAX_TRAIL_STEPS);
    });

    it('returns the same array when nothing changed', () => {
        const trail = foldMine([[start('kb_search'), 1000]]);
        expect(appendPhase(trail, end('guardrails'), 2000)).toBe(trail);
        expect(appendPhase(trail, start('kb_search'), 2000)).toBe(trail);
    });
});

describe('traceSpanMs', () => {
    it('is first start to last end, never a sum of overlapping steps', () => {
        const trail = foldMine(CASES['overlapping stages close where they belong'] ?? []);
        expect(traceSpanMs(trail)).toBe(60);
    });

    it.each(Object.entries(CASES))('matches the web on: %s', (_name, events) => {
        expect(traceSpanMs(foldMine(events))).toEqual(webTrace.traceSpanMs(foldWeb(events)));
    });

    it('is null for a trail with no closed step', () => {
        expect(traceSpanMs(foldMine([[start('kb_search'), 1000]]))).toBeNull();
        expect(traceSpanMs(undefined)).toBeNull();
    });
});
