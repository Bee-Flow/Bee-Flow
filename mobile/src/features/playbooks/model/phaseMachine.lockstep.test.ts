/**
 * phaseMachine.ts held to the web's phaseMachine.js — a differential test:
 * both run on the same phases and events, and every answer (what is on
 * stage, what may be pressed, the exact wire each press sends) must agree.
 *
 * The one deliberate difference is a name: the web marks an unconfirmed
 * running phase `_optimistic`, the port `optimistic`.
 *
 * When this fails, the web side changed: update phaseMachine.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadWebModule } from '@/shared/testing/webModule';

import * as port from './phaseMachine';
import type { Phase, PhaseStatus } from './types';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Playbooks/phaseMachine.js');
const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

type Fn = (...args: unknown[]) => unknown;
const web = () => loadWebModule<Record<string, Fn | Set<string>>>(WEB);

const phase = (key: string, status: PhaseStatus, over: Partial<Phase> = {}): Phase => ({
    key,
    kind: null,
    label: null,
    status,
    attempt: 0,
    brief: null,
    artifacts: {},
    summary: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    requires: null,
    ...over,
});

const LISTS: Phase[][] = [
    [],
    [phase('table', 'ready'), phase('routine', 'pending'), phase('fill', 'pending')],
    [phase('table', 'done'), phase('routine', 'awaiting', { artifacts: { automationId: 'a1' } }), phase('fill', 'ready'), phase('app', 'pending')],
    [phase('t1', 'done', { kind: 'table' }), phase('d', 'running', { kind: 'design' }), phase('x', 'pending', { kind: 'app' })],
    [phase('table', 'done'), phase('approvals', 'locked'), phase('access', 'failed', { kind: 'access' })],
    [phase('table', 'done'), phase('routine', 'skipped'), phase('compliance', 'done', { kind: 'compliance' })],
    [phase('table', 'done'), phase('design', 'awaiting', { kind: 'design' }), phase('app', 'running', { kind: 'app' })],
];

const EVENTS: port.PlaybookEvent[] = [
    { type: 'start', key: 'table' },
    { type: 'start', key: 'routine', artifacts: { automationId: 'a1' } },
    { type: 'start', key: 'd' },
    { type: 'artifact', key: 'routine', artifacts: { automationId: 'a2' } },
    { type: 'finished', key: 'routine', summary: 'Built', artifacts: { automationId: 'a1' } },
    { type: 'markDone', key: 'app', artifacts: { appId: 'p1' } },
    { type: 'failed', key: 'app' },
    { type: 'failed', key: 'app', error: 'boom' },
    { type: 'continue', key: 'routine', nextKey: 'fill' },
    { type: 'continue', key: 'routine', nextKey: 'fill', brief: 'Edited brief' },
    { type: 'continue', key: 'routine', nextKey: null, brief: 'ignored' },
    { type: 'revise', key: 'design', feedback: 'Totals on top' },
    { type: 'skip', key: 'fill' },
    { type: 'retry', key: 'fill' },
    { type: 'stop' },
    { type: 'resume' },
    { type: 'nonsense' } as unknown as port.PlaybookEvent,
];

describeIfWeb('phaseMachine matches the web', () => {
    it('shares the run sets', () => {
        const w = web();
        expect([...port.SERVER_RUN].sort()).toEqual([...(w.SERVER_RUN as Set<string>)].sort());
        expect([...port.CLIENT_RUN].sort()).toEqual([...(w.CLIENT_RUN as Set<string>)].sort());
        expect([...port.TERMINAL].sort()).toEqual([...(w.TERMINAL as Set<string>)].sort());
        expect([...port.ACTIONABLE].sort()).toEqual([...(w.ACTIONABLE as Set<string>)].sort());
    });

    it('reads every phase list the same way', () => {
        const w = web();
        const call = (name: string, ...args: unknown[]) => (w[name] as Fn)(...args);
        for (const list of LISTS) {
            expect(port.nextActionable(list)).toEqual(call('nextActionable', list));
            expect(port.isComplete(list)).toBe(call('isComplete', list));
            expect(port.progress(list)).toEqual(call('progress', list));
            expect(port.canContinue(list)).toBe(call('canContinue', list));
            for (const p of list) {
                expect({ key: p.key, next: port.nextPending(list, p.key) }).toEqual({ key: p.key, next: call('nextPending', list, p.key) });
                expect({ key: p.key, v: [port.kindOf(p), port.canRetry(p), port.canSkip(p)] }).toEqual({ key: p.key, v: [call('kindOf', p), call('canRetry', p), call('canSkip', p)] });
            }
        }
    });

    it('sends the same wire for every event', () => {
        const w = web();
        for (const list of LISTS) {
            const pb = { version: 7, phases: list };
            for (const event of EVENTS) {
                expect({ event, wire: port.patchFor(event, pb) }).toEqual({ event, wire: (w.patchFor as Fn)(event, pb) });
            }
        }
        expect(port.patchFor(null, { version: 1, phases: [] })).toBe((w.patchFor as Fn)(null, { version: 1, phases: [] }));
    });

    it('moves a phase optimistically the same way', () => {
        const w = web();
        const clean = (phases: unknown) => JSON.parse(JSON.stringify(phases, (k, v) => (k === 'startedAt' || k === 'finishedAt' ? (v ? 'T' : v) : k === '_optimistic' ? undefined : k === 'optimistic' ? undefined : v)));
        const list = LISTS[2] as Phase[];
        for (const kind of ['started', 'artifacts', 'finished', 'failed', 'needs_input', 'dismiss_input', 'skipped', 'done'] as const) {
            const result = { kind, artifacts: { x: 1 }, summary: 'S', error: 'E' };
            expect({ kind, out: clean(port.applyPhaseResult(list, 'routine', result)) }).toEqual({ kind, out: clean((w.applyPhaseResult as Fn)(list, 'routine', result)) });
        }
    });
});

describe('isPolling', () => {
    it('polls only an active playbook with a server phase running', () => {
        const running = [phase('t', 'done', { kind: 'table' }), phase('f', 'running', { kind: 'fill' })];
        expect(port.isPolling({ status: 'active', phases: running })).toBe(true);
        expect(port.isPolling({ status: 'stopped', phases: running })).toBe(false);
        expect(port.isPolling({ status: 'active', phases: [phase('r', 'running', { kind: 'routine' })] })).toBe(false);
        expect(port.isPolling(null)).toBe(false);
    });
});
