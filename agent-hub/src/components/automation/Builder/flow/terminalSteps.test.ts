// @vitest-environment node
//
// THE LIST GUARD (client half): the canvas and the server agree on which steps end a run.
//
// An `end` family means that some ten places know that no edge may follow this step. If you
// miss one, the same graph is valid in one place and not in another, and someone notices that
// only when an automation stops halfway, or when the editor accepts an edge that the validator
// refuses.
//
// This file fails in THREE ways, and those are precisely the three ways in which that knowledge
// drifts away:
//
//   1. THE TWO LISTS DIVERGE. No module crosses the server/agent-hub boundary, so
//      flow/terminalSteps.js is a COPY of validate/constants.js TERMINAL_STEP_TYPES. That copy is
//      read here against the source, as text, because the server side is CommonJS.
//   2. AN `end` FAMILY ARRIVES THAT IS TERMINAL NOWHERE. The family is pure presentation
//      (nodeDefs.js says so itself), and `layer_output` proves it: family `end`, but connectable.
//      That is precisely why a NEW end family must force a choice: terminal, or written down below
//      with a reason. Inheriting is not allowed.
//   3. A CANVAS PLACE RUNS ON A TYPE LITERAL AGAIN. Then the shared list still exists, but the rule
//      applies to one type only.
//
// The SERVER half is in server/automation/validate/terminalSteps.test.js.
//
// Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/flow/terminalSteps.test.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { NODE_DEFS, NODE_TYPE_KEYS, stepFamily } from './nodeDefs';
import { findNodeDropTarget } from './nodeDropTarget';
import { TERMINAL_STEP_TYPES, isTerminalStep, isTerminalStepType } from './terminalSteps';
import { describeNode } from '../mapping/upstream';
import { partial } from '@/test/mocks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../../..');
const readRepo = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const readHere = (rel: string) => fs.readFileSync(path.join(HERE, rel), 'utf8');
/**
 * Source with its comments removed.
 *
 * Needed because the rule below concerns the ABSENCE of something. A node that EXPLAINS in its
 * header that it deliberately does not pass `onAddAfter` may not stumble over that. That is
 * precisely the documentation you want.
 */
const codeOf = (rel: Parameters<typeof readHere>[0]) => readHere(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TERMINALS = [...TERMINAL_STEP_TYPES];

/**
 * Step types with the `end` FAMILY that are deliberately NOT terminal, with the
 * reason. Anything else carrying that family has to be on the shared list.
 */
const END_NOT_TERMINAL: Record<string, string> = {
    layer_output: 'a flowlet RETURNS to its caller, and the caller carries on — the run does not end, so the node stays connectable (FlowletOutputNode passes onAddAfter)',
};

/**
 * The canvas gestures that must refuse a terminal step, each with the call it
 * has to make. All five used to know this as `type === \'stop_error\'`.
 */
const CLIENT_SITES = [
    { file: '../mapping/upstream/describeNode.ts', call: /isTerminalStepType\(node\.type\)/, what: 'geeft geen variabelengroep — niets kan aan de uitvoer binden' },
    { file: 'useStepDrop.ts', call: /isTerminalStep\(s\)/, what: 'weigert een stap erachter te droppen' },
    { file: 'nodeDropTarget.ts', call: /isTerminalStep\(stepById\.get\(from\)\)/, what: 'ketent er niet aan bij het slepen' },
    { file: 'useEdgeEditCallbacks.ts', call: /isTerminalStep\(sourceStep\)/, what: 'weigert een handmatig getekende rand' },
];

/** type → the node component file the canvas registers for it. */
function nodeComponentFor(type: string) {
    const src = readHere('nodeTypes.ts');
    const m = new RegExp(`^\\s*${type}:\\s*(\\w+),`, 'm').exec(src);
    if (!m) return null;
    const imp = new RegExp(`import ${m[1]} from '\\./nodes/([\\w.]+)'`).exec(src);
    return imp ? `nodes/${imp[1]}.tsx` : null;
}

describe('terminalSteps — the browser copy agrees with the server', () => {
    it('holds the same set the validator does', () => {
        const src = readRepo('server/core/automationModel/constants.js');
        const m = /const TERMINAL_STEP_TYPES = new Set\((\[[^\]]*\])\)/.exec(src);
        expect(m, 'TERMINAL_STEP_TYPES was not found in core/automationModel/constants.js — the scan has gone stale').toBeTruthy();
        const server = JSON.parse(m![1].replace(/'/g, '"'));
        expect([...TERMINAL_STEP_TYPES].sort()).toEqual([...server].sort());
    });

    it('is not empty, and names the two it has today explicitly', () => {
        // De datagestuurde lussen hieronder zouden stilletjes één keer minder
        // draaien als er eentje uit de set verdween.
        expect(TERMINAL_STEP_TYPES.has('stop_error')).toBe(true);
        expect(TERMINAL_STEP_TYPES.has('return_to_app')).toBe(true);
    });

    it('every terminal type is a type the canvas actually knows', () => {
        for (const type of TERMINALS) expect(NODE_TYPE_KEYS, `${type} has no presentation record`).toContain(type);
    });

    it('answers false — never throws — for an unknown type or a missing step', () => {
        expect(isTerminalStepType('no_such_type')).toBe(false);
        expect(isTerminalStepType(undefined)).toBe(false);
        expect(isTerminalStep(null)).toBe(false);
        expect(isTerminalStep({})).toBe(false);
    });
});

describe('terminalSteps — a new `end` family cannot inherit terminality by accident', () => {
    it('every end-family type is either terminal or exempted with a reason', () => {
        const endFamily = NODE_TYPE_KEYS.filter((t) => stepFamily(t) === 'end');
        expect(endFamily.length, 'nothing carries the end family — the scan has gone stale').toBeGreaterThan(1);
        for (const type of endFamily) {
            if (TERMINAL_STEP_TYPES.has(type)) continue;
            const reason = END_NOT_TERMINAL[type];
            expect(
                typeof reason === 'string' && reason.length > 20,
                `${type} is drawn as an END step but nothing ever stops a run there. Add it to TERMINAL_STEP_TYPES (server + client), or say here why it is different.`,
            ).toBe(true);
        }
    });

    it('every exemption names a type that really carries the family', () => {
        for (const type of Object.keys(END_NOT_TERMINAL)) {
            expect((NODE_DEFS as Record<string, unknown>)[type], `${type} is exempted but has no record`).toBeTruthy();
            expect(stepFamily(type), `${type} is exempted from the end-family rule but is not in that family`).toBe('end');
            expect(TERMINAL_STEP_TYPES.has(type), `${type} cannot be both exempted and terminal`).toBe(false);
        }
    });

    it('the family and the rule are separate ideas — layer_output proves it', () => {
        // This one is stated explicitly, because it is the whole reason that the list and the family
        // are two things. If it disappears, the proof disappears with it.
        expect(stepFamily('layer_output')).toBe('end');
        expect(isTerminalStepType('layer_output')).toBe(false);
        expect(codeOf('nodes/FlowletOutputNode.tsx')).toMatch(/onAddAfter/);
    });
});

describe('terminalSteps — every canvas gesture asks the shared list', () => {
    for (const site of CLIENT_SITES) {
        it(`${site.file} ${site.what}`, () => {
            const src = codeOf(site.file);
            expect(src, `${site.file} must import the shared list`).toMatch(/from '\.{1,2}\/(\.\.\/)*(flow\/)?terminalSteps'/);
            expect(src, `${site.file} must ask the shared list, not a type literal`).toMatch(site.call);
            expect(src.includes("=== 'stop_error'"), `${site.file} still hard-codes stop_error`).toBe(false);
        });
    }

    for (const type of TERMINALS) {
        it(`${type}'s card offers no way to continue past it`, () => {
            const rel = nodeComponentFor(type);
            expect(rel, `${type} has no canvas component registered in nodeTypes.js`).toBeTruthy();
            const src = codeOf(rel!);
            expect(src, `${rel} must refuse new outgoing connections`).toMatch(/sourceConnectable=\{false\}/);
            // LEAVING OUT onAddAfter is the rule: StepNodeBase draws the "+" button only if the prop is
            // there, and that file names no step type at all.
            expect(src.includes('onAddAfter'), `${rel} must not pass onAddAfter — there is nothing to add after a terminal step`).toBe(false);
        });
    }
});

// THE SIXTH CANVAS PLACE (THE PALETTE) is in stepPalette.nested.test.js, and not here. This file
// deliberately runs in the `node` environment (it reads server sources with fs), and stepPalette
// pulls `window` in via the icon layer. What is guarded there: what the validator refuses inside a
// flowlet/Step or a loop body (`layer.return_to_app_forbidden`, `return_to_app.nested_forbidden`)
// is not offered there either.

describe('terminalSteps — the behaviour, not just the wiring', () => {
    for (const type of TERMINALS) {
        it(`nothing downstream can bind to a ${type} step`, () => {
            const node = { id: 's1', type };
            expect(describeNode(node, { trigger: { id: 'trg', kind: 'manual' }, steps: [node], edges: [] }, partial<Parameters<typeof describeNode>[2]>({}), {})).toBeNull();
        });
    }

    it('dragging a loose card next to a terminal step does not chain onto it', () => {
        const term = { id: 's1', type: 'return_to_app', toast: { message: 'Done' } };
        const loose = { id: 's2', type: 'notification' };
        const definition = { trigger: { id: 'trg', kind: 'manual' }, steps: [term, loose], edges: [{ from: 'trg', to: 's1' }] };
        // s2 sits immediately to the RIGHT of s1 — the geometry that would
        // normally offer "wire s1 → s2".
        const nodes = [
            { id: 's1', position: { x: 0, y: 0 }, measured: { width: 240, height: 96 } },
            { id: 's2', position: { x: 300, y: 0 }, measured: { width: 240, height: 96 } },
        ];
        expect(findNodeDropTarget({ draggedId: 's2', nodes, renderedEdges: [], definition })).toBeNull();
    });

    it('…while the same geometry DOES chain onto an ordinary step', () => {
        // The counter-proof: without this, the test above would also pass if the geometry simply never
        // yielded a target.
        const ordinary = { id: 's1', type: 'notification' };
        const loose = { id: 's2', type: 'notification' };
        const definition = { trigger: { id: 'trg', kind: 'manual' }, steps: [ordinary, loose], edges: [{ from: 'trg', to: 's1' }] };
        const nodes = [
            { id: 's1', position: { x: 0, y: 0 }, measured: { width: 240, height: 96 } },
            { id: 's2', position: { x: 300, y: 0 }, measured: { width: 240, height: 96 } },
        ];
        const target = findNodeDropTarget({ draggedId: 's2', nodes, renderedEdges: [], definition });
        expect(target).toMatchObject({ kind: 'node', from: 's1', to: 's2' });
    });
});
