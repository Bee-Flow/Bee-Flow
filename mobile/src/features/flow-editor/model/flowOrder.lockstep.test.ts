/**
 * DIFFERENTIAL lockstep: run order, loop-body chaining and the terminal step
 * types, against the web builder's modules (and, for the terminal list and
 * the loop chain, the server they mirror).
 */

import fs from 'node:fs';
import path from 'node:path';

import { flowOrder, flowPosition, stepNumbers } from './flowOrder';
import { LOOP_ENTRY_ID, loopBodyEdges, orderLoopBody } from './loopBodyEdges';
import { isTerminalStep, isTerminalStepType, TERMINAL_STEP_TYPES } from './terminalSteps';
import { clone, FIXTURES, templateDefinitions } from './testing/fixtures';
import type { FlowDefinition, FlowStep } from './types';

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
const REPO = path.resolve(__dirname, '../../../../..');
/* eslint-disable @typescript-eslint/no-require-imports */
const webOrder = require(`${FLOW}/flowOrder.js`);
const webLoop = require(`${FLOW}/loopBodyEdges.js`);
const webTerminal = require(`${FLOW}/terminalSteps.js`);
const serverConstants = require(path.join(REPO, 'server/automation/validate/constants.js'));
const TEMPLATES_JS = path.join(REPO, 'server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

const CASES = Object.entries({ ...FIXTURES, ...TEMPLATES });
const inline = {
    isInlineId: (id: string) => id.includes('/'),
    parseInlineId: (id: string) => ({ prefix: id.slice(0, id.lastIndexOf('/')), localId: id.slice(id.lastIndexOf('/') + 1) }),
};

describe('flowOrder', () => {
    it.each(CASES)('%s: order, positions and step numbers', (_name, def) => {
        expect(flowOrder(def)).toEqual(webOrder.flowOrder(def));
        for (const id of [...flowOrder(def), 'missing']) expect(flowPosition(def, id)).toEqual(webOrder.flowPosition(def, id));
        expect([...stepNumbers(def)]).toEqual([...webOrder.stepNumbers(def)]);
    });

    it('numbers expanded children inside their parent, and skips notes', () => {
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger' },
            steps: [
                { id: 'cl1', type: 'call_layer' }, { id: 'cl1/lin', type: 'trigger' }, { id: 'cl1/a', type: 'set' },
                { id: 'cl1/b', type: 'set' }, { id: 'lp/__item__', type: 'loop_item' }, { id: 'lp/x', type: 'set' },
                { id: 'n', type: 'note' },
            ],
            edges: [
                { from: 'trg', to: 'cl1' }, { from: 'cl1', to: 'cl1/lin' }, { from: 'cl1/lin', to: 'cl1/a' },
                { from: 'cl1/a', to: 'cl1/b' }, { from: 'cl1/b', to: 'lp/__item__' }, { from: 'lp/__item__', to: 'lp/x' },
            ],
        };
        expect([...stepNumbers(def, inline)]).toEqual([...webOrder.stepNumbers(def, inline)]);
        expect(stepNumbers(def, inline).get('cl1/b')).toBe('2·2');
    });

    it('answers nothing for nothing', () => {
        for (const def of [null, undefined, {}, { steps: [null] }] as unknown as FlowDefinition[]) {
            expect(flowOrder(def)).toEqual(webOrder.flowOrder(def));
            expect(flowPosition(def, 'x')).toEqual(webOrder.flowPosition(def, 'x'));
        }
    });
});

describe('loopBodyEdges', () => {
    const bodies = [
        undefined, [], [null, { type: 'set' }],
        ...CASES.flatMap(([, def]) => def.steps.filter((s) => s.type === 'loop').map((s) => s.body)),
        [{ id: 'a', type: 'switch', cases: 'x' }, { id: 'b', type: 'set' }],
        [{ id: 'a', type: 'set' }, { id: 'b', type: 'condition' }, { id: 'c', type: 'switch', cases: [{ name: 'k' }] }, { id: 'd' }],
    ];
    it.each(bodies.map((b, i) => [i, b] as const))('body %i chains and re-orders the same way', (_i, body) => {
        expect(loopBodyEdges(body)).toEqual(webLoop.loopBodyEdges(body));
        expect(loopBodyEdges(body, 'root')).toEqual(webLoop.loopBodyEdges(body, 'root'));
        const steps = (Array.isArray(body) ? body : []) as FlowStep[];
        const edges = loopBodyEdges(body).filter((e) => e.from !== LOOP_ENTRY_ID);
        const shuffled = clone(steps).reverse();
        expect(orderLoopBody(shuffled, edges)).toEqual(webLoop.orderLoopBody(shuffled, edges));
    });

    it('re-orders stably, keeps a cycle, and counts a parallel edge once', () => {
        const steps = [{ id: 'c', type: 'set' }, { id: 'a', type: 'set' }, { id: 'b', type: 'set' }] as FlowStep[];
        const cases = [
            [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
            [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
            [{ from: 'a', to: 'b', label: 'case:x' }, { from: 'a', to: 'b', label: 'case:default' }, { from: 'a', to: 'a' }, { from: 'x', to: 'a' }, {}],
            null,
        ];
        for (const edges of cases) expect(orderLoopBody(steps, edges as never)).toEqual(webLoop.orderLoopBody(steps, edges));
        expect(LOOP_ENTRY_ID).toBe(webLoop.LOOP_ENTRY_ID);
    });

    it('mirrors the runtime chain: the server engine still builds a linear, brancher-aware body', () => {
        const src = fs.readFileSync(path.join(REPO, 'server/core/automationRunner/execFlow.js'), 'utf8');
        expect(src).toContain('function buildLinearEdges');
        expect(src).toMatch(/label: 'then'/);
        expect(src).toMatch(/case:default/);
    });
});

describe('terminal step types', () => {
    it('are exactly the server list, and the web list', () => {
        expect([...TERMINAL_STEP_TYPES].sort()).toEqual([...serverConstants.TERMINAL_STEP_TYPES].sort());
        expect([...TERMINAL_STEP_TYPES].sort()).toEqual([...webTerminal.TERMINAL_STEP_TYPES].sort());
    });

    it.each([null, undefined, 3, 'stop_error', 'return_to_app', 'layer_output', 'set'])('isTerminalStepType(%s)', (type) => {
        expect(isTerminalStepType(type)).toBe(webTerminal.isTerminalStepType(type));
        expect(isTerminalStep({ type })).toBe(webTerminal.isTerminalStep({ type }));
    });

    it('is false for no step at all', () => {
        expect(isTerminalStep(null)).toBe(false);
    });
});
