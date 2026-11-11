/**
 * The step ordinal the phone posts must be the one the server resolves.
 *
 * The server's flattenSteps (server/appStudio/actionSequence.js) cannot be
 * required here (its module pulls in the action executor), so it is lifted out
 * of the file's text and run, with the two pure child-slot helpers it calls. The web runner's buildStepIndexMap,
 * sequenceHasServerStep, caseMatches and resolveNavParams come from its pure
 * step-walk module (runtime/actionRunner/stepWalk.ts). All run on the same
 * action trees as the port.
 */

import { allFixtures } from '../testing/fixtures';
import { loadWeb, readRepo } from '../testing/loadWeb';
import { evalSource, functionSource } from '../testing/source';
import type { ActionStep } from '../types';
import * as port from './stepIndex';

// The port is pinned on the BASE kinds (the catalogue before the step registry,
// server/appStudio/componentSpecs/steps/): a kind added there is not ported, and must not turn this red.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const baseKinds = require('../../../../../../server/appStudio/componentSpecs/actionSpecsActionKinds.js') as {
    BASE_STEP_KINDS: string[];
    BASE_DATA_MUTATING_STEP_KINDS: string[];
};

// flattenSteps reads which fields of a kind hold numbered steps from the shared child-slot table
// (server/shared/appDefinition/stepFlow.mjs, pure), so those two helpers are passed in.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stepFlow = require('../../../../../../server/shared/appDefinition/stepFlow.mjs') as Record<string, unknown>;

const serverSrc = readRepo('server/appStudio/actionSequence.js');
const server = evalSource<{ flattenSteps: (s: unknown) => unknown[]; normalizeSequence: (a: unknown) => unknown[] }>(
    [functionSource(serverSrc, 'flattenSteps'), functionSource(serverSrc, 'normalizeSequence')],
    ['flattenSteps', 'normalizeSequence'],
    { numberedChildLists: stepFlow.numberedChildLists, handlerStepsOf: stepFlow.handlerStepsOf },
);

// The web runner's pure step walk lives in its own React-free module, so it is
// loaded as a module rather than lifted out of the hook's text.
const runner = loadWeb<{
    SERVER_STEP_KINDS: Set<string>;
    MAX_LOOP_ITERATIONS: number;
    buildStepIndexMap: (s: unknown) => Map<unknown, number>;
    sequenceHasServerStep: (s: unknown) => boolean;
    caseMatches: (a: unknown, b: unknown) => boolean;
    resolveNavParams: (p: unknown, scope: unknown) => unknown;
    normalizeSequence: (a: unknown) => unknown[];
}>('runtime/actionRunner/stepWalk.ts');

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
    // Error handlers follow the whole tree (nested handlers after their owner's);
    // a transaction's children are not numbered; the legacy array form counts too.
    {
        kind: 'sequence',
        steps: [
            { kind: 'ai_generate', onError: { steps: [{ kind: 'toast' }, { kind: 'create_record', onError: { steps: [{ kind: 'set_variable' }] } }] } },
            { kind: 'condition', then: [{ kind: 'update_record', retry: { times: 2 }, onError: { steps: [{ kind: 'toast' }], stop: true } }] },
            { kind: 'transaction', steps: [{ kind: 'create_record' }, { kind: 'delete_record' }], onError: { steps: [{ kind: 'toast' }] } },
            { kind: 'kb_query', onError: [{ kind: 'toast' }] },
            { kind: 'call_action', actionId: 'x', onError: { steps: 'nope' } },
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
        const { BASE_STEP_KINDS, BASE_DATA_MUTATING_STEP_KINDS } = baseKinds;
        expect([...port.STEP_KINDS]).toEqual(BASE_STEP_KINDS);
        expect([...port.SERVER_STEP_KINDS].sort()).toEqual([...BASE_DATA_MUTATING_STEP_KINDS].sort());
        // The web runner appends the server kinds of the registry after its own base list.
        expect([...port.SERVER_STEP_KINDS]).toEqual([...runner.SERVER_STEP_KINDS].filter((kind) => BASE_STEP_KINDS.includes(kind)));
        expect(port.CLIENT_STEP_KINDS).toEqual(BASE_STEP_KINDS.filter((kind) => !BASE_DATA_MUTATING_STEP_KINDS.includes(kind)));
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
