/**
 * The step ordinal the phone posts must be the one the server resolves.
 *
 * The server's flattenSteps (server/appStudio/actionSequence.js) cannot be
 * required here (its module pulls in the action executor), so it is lifted out
 * of the file's text and run; so are the web runner's buildStepIndexMap,
 * sequenceHasServerStep, caseMatches and resolveNavParams (useActionRunner.js
 * is a React hook module). All run on the same action trees as the port.
 */

import { tryEvaluate } from '@/shared/expr';

import { allFixtures } from '../testing/fixtures';
import { readRepo } from '../testing/loadWeb';
import { constSource, evalSource, functionSource } from '../testing/source';
import type { ActionStep } from '../types';
import * as port from './stepIndex';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actionSpecs = require('../../../../../../server/appStudio/componentSpecs/actionSpecs.js') as Record<string, string[]>;

const serverSrc = readRepo('server/appStudio/actionSequence.js');
const server = evalSource<{ flattenSteps: (s: unknown) => unknown[]; normalizeSequence: (a: unknown) => unknown[] }>(
    [functionSource(serverSrc, 'flattenSteps'), functionSource(serverSrc, 'normalizeSequence')],
    ['flattenSteps', 'normalizeSequence'],
);

const runnerSrc = readRepo('agent-hub/src/components/admin/Studio/AppStudio/runtime/useActionRunner.js');
const runner = evalSource<{
    SERVER_STEP_KINDS: Set<string>;
    MAX_LOOP_ITERATIONS: number;
    buildStepIndexMap: (s: unknown) => Map<unknown, number>;
    sequenceHasServerStep: (s: unknown) => boolean;
    caseMatches: (a: unknown, b: unknown) => boolean;
    resolveNavParams: (p: unknown, scope: unknown) => unknown;
    normalizeSequence: (a: unknown) => unknown[];
}>(
    [
        constSource(runnerSrc, 'SERVER_STEP_KINDS'),
        constSource(runnerSrc, 'MAX_LOOP_ITERATIONS'),
        ...['buildStepIndexMap', 'sequenceHasServerStep', 'caseMatches', 'resolveNavParams', 'normalizeSequence'].map(
            (name) => functionSource(runnerSrc, name),
        ),
    ],
    ['SERVER_STEP_KINDS', 'MAX_LOOP_ITERATIONS', 'buildStepIndexMap', 'sequenceHasServerStep', 'caseMatches', 'resolveNavParams', 'normalizeSequence'],
    { tryEvaluate },
);

const EXTRA: unknown[] = [
    null,
    { kind: 'toast' },
    { kind: 'sequence', steps: 'nope' },
    {
        kind: 'sequence',
        steps: [
            { kind: 'loop', steps: [{ kind: 'switch', cases: [null, { steps: [{ kind: 'create_record' }] }, { value: 1 }], default: [{ kind: 'condition', then: [{ kind: 'ai_browse' }], else: [{ kind: 'toast' }] }] }] },
            null,
            7,
            { kind: 'condition', then: 'x', else: [{ kind: 'send_email' }] },
        ],
    },
];

const actions = [...Object.values(allFixtures()).flatMap((def) => Object.values(def.actions || {})), ...EXTRA];

describe('step indices agree with the server and the web runner', () => {
    it.each(actions.map((a, i) => [i, a]))('action %i', (_i, action) => {
        const steps = port.normalizeSequence(action as ActionStep);
        expect(steps).toEqual(server.normalizeSequence(action));
        expect(steps).toEqual(runner.normalizeSequence(action));

        const serverOrder = server.flattenSteps(steps);
        expect(port.flattenSteps(steps)).toEqual(serverOrder);
        const map = port.buildStepIndexMap(steps);
        serverOrder.forEach((step, i) => expect(serverOrder[map.get(step as ActionStep) as number]).toBe(step));
        expect([...map]).toEqual([...runner.buildStepIndexMap(steps)]);
        expect(port.sequenceHasServerStep(steps)).toBe(runner.sequenceHasServerStep(steps));
    });

    it('classifies step kinds as the server and the runner do', () => {
        expect([...port.STEP_KINDS]).toEqual(actionSpecs.STEP_KINDS);
        expect([...port.SERVER_STEP_KINDS].sort()).toEqual([...(actionSpecs.DATA_MUTATING_STEP_KINDS as string[])].sort());
        expect([...port.SERVER_STEP_KINDS]).toEqual([...runner.SERVER_STEP_KINDS]);
        expect(port.CLIENT_STEP_KINDS).toEqual(actionSpecs.CLIENT_STEP_KINDS);
        expect(port.MAX_LOOP_ITERATIONS).toBe(runner.MAX_LOOP_ITERATIONS);
    });

    it('matches cases and resolves navigate params the same way', () => {
        const values = [1, '1', 'a', null, undefined, 0, '', true, 'true'];
        for (const a of values) for (const b of values) expect(port.caseMatches(a, b)).toBe(runner.caseMatches(a, b));
        const scope = { vars: { id: 7 }, item: { name: 'x' } };
        for (const params of [null, 'x', { a: { kind: 'static', value: 1 }, b: { kind: 'formula', expr: 'vars.id + 1' }, c: null, d: { kind: 'formula', expr: '((' }, e: { kind: 'other' } }]) {
            expect(port.resolveNavParams(params, scope)).toEqual(runner.resolveNavParams(params, scope));
        }
    });
});
