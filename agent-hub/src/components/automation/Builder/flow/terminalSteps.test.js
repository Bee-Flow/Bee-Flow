// @vitest-environment node
//
// DE LIJST-BEWAKER (clienthelft) — het canvas en de server zijn het eens over
// welke stappen een run beëindigen.
//
// Een `end`-familie betekent dat een stuk of tien plekken weten dat er na deze
// stap geen rand meer mag komen. Mis je er één, dan is dezelfde graaf op de ene
// plek geldig en op de andere niet, en dat merkt iemand pas als een routine
// halverwege stopt of de editor een rand accepteert die de validator weigert.
//
// Dit bestand faalt op DRIE manieren, en dat zijn precies de drie manieren
// waarop die kennis wegdrijft:
//
//   1. DE TWEE LIJSTEN LOPEN UITEEN. Geen enkele module kruist de
//      server/agent-hub-grens, dus flow/terminalSteps.js is een KOPIE van
//      validate/constants.js TERMINAL_STEP_TYPES. Die kopie wordt hier tegen de
//      bron gelezen — als tekst, want de serverkant is CommonJS.
//   2. ER KOMT EEN `end`-FAMILIE BIJ DIE NERGENS TERMINAAL IS. De familie is
//      pure presentatie (nodeDefs.js zegt dat zelf), en `layer_output` bewijst
//      dat: familie `end`, maar wél connecteerbaar. Precies daarom moet een
//      NIEUWE end-familie een keuze afdwingen — terminaal, of hieronder
//      opgeschreven mét reden. Erven mag niet.
//   3. EEN CANVASPLEK GAAT WEER OP EEN TYPE-LITERAL DRAAIEN. Dan bestaat de
//      gedeelde lijst nog wel, maar geldt de regel weer voor één soort.
//
// De SERVERHELFT staat in server/automation/validate/terminalSteps.test.js.
//
// Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/flow/terminalSteps.test.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { NODE_DEFS, NODE_TYPE_KEYS, stepFamily } from './nodeDefs';
import { TERMINAL_STEP_TYPES, isTerminalStep, isTerminalStepType } from './terminalSteps';
import { findNodeDropTarget } from './nodeDropTarget';
import { describeNode } from '../mapping/upstream';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../../..');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const readHere = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
/**
 * Source with its comments removed.
 *
 * Nodig omdat de regel hieronder over het ONTBREKEN van iets gaat: een node die
 * in zijn koptekst UITLEGT dat hij `onAddAfter` bewust niet doorgeeft, mag daar
 * niet op struikelen — dat is juist de documentatie die je wilt.
 */
const codeOf = (rel) => readHere(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TERMINALS = [...TERMINAL_STEP_TYPES];

/**
 * Step types with the `end` FAMILY that are deliberately NOT terminal, with the
 * reason. Anything else carrying that family has to be on the shared list.
 */
const END_NOT_TERMINAL = {
    layer_output: 'a flowlet RETURNS to its caller, and the caller carries on — the run does not end, so the node stays connectable (FlowletOutputNode passes onAddAfter)',
};

/**
 * The canvas gestures that must refuse a terminal step, each with the call it
 * has to make. All five used to know this as `type === \'stop_error\'`.
 */
const CLIENT_SITES = [
    { file: '../mapping/upstream.ts', call: /isTerminalStepType: \(type\) => isTerminalStepType\(type\)/, what: 'geeft geen variabelengroep — niets kan aan de uitvoer binden' },
    { file: 'useStepDrop.js', call: /isTerminalStep\(s\)/, what: 'weigert een stap erachter te droppen' },
    { file: 'nodeDropTarget.js', call: /isTerminalStep\(stepById\.get\(from\)\)/, what: 'ketent er niet aan bij het slepen' },
    { file: 'useEdgeEditCallbacks.js', call: /isTerminalStep\(sourceStep\)/, what: 'weigert een handmatig getekende rand' },
];

/** type → the node component file the canvas registers for it. */
function nodeComponentFor(type) {
    const src = readHere('nodeTypes.js');
    const m = new RegExp(`^\\s*${type}:\\s*(\\w+),`, 'm').exec(src);
    if (!m) return null;
    const imp = new RegExp(`import ${m[1]} from '\\./nodes/([\\w.]+)'`).exec(src);
    return imp ? `nodes/${imp[1]}.jsx` : null;
}

describe('terminalSteps — the browser copy agrees with the server', () => {
    it('holds the same set the validator does', () => {
        const src = readRepo('server/automation/validate/constants.js');
        const m = /const TERMINAL_STEP_TYPES = new Set\((\[[^\]]*\])\)/.exec(src);
        expect(m, 'TERMINAL_STEP_TYPES was not found in validate/constants.js — the scan has gone stale').toBeTruthy();
        const server = JSON.parse(m[1].replace(/'/g, '"'));
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
            expect(NODE_DEFS[type], `${type} is exempted but has no record`).toBeTruthy();
            expect(stepFamily(type), `${type} is exempted from the end-family rule but is not in that family`).toBe('end');
            expect(TERMINAL_STEP_TYPES.has(type), `${type} cannot be both exempted and terminal`).toBe(false);
        }
    });

    it('the family and the rule are separate ideas — layer_output proves it', () => {
        // Deze staat er expliciet omdat hij de hele reden is dat de lijst en de
        // familie twee dingen zijn. Verdwijnt hij, dan verdwijnt het bewijs.
        expect(stepFamily('layer_output')).toBe('end');
        expect(isTerminalStepType('layer_output')).toBe(false);
        expect(codeOf('nodes/FlowletOutputNode.jsx')).toMatch(/onAddAfter/);
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
            const src = codeOf(rel);
            expect(src, `${rel} must refuse new outgoing connections`).toMatch(/sourceConnectable=\{false\}/);
            // Het WEGLATEN van onAddAfter is de regel: StepNodeBase tekent de
            // "+"-knop alleen als de prop er is, en dat bestand noemt geen
            // enkele stapsoort.
            expect(src.includes('onAddAfter'), `${rel} must not pass onAddAfter — there is nothing to add after a terminal step`).toBe(false);
        });
    }
});

// DE ZESDE CANVASPLEK — HET PALET — staat in stepPalette.nested.test.js, en
// niet hier: dit bestand draait bewust in de `node`-omgeving (het leest
// serverbronnen met fs) en stepPalette trekt via de icoonlaag `window` binnen.
// Wat daar bewaakt wordt: wat de validator binnen een flowlet/Step of een
// loop-body weigert (`layer.return_to_app_forbidden`,
// `return_to_app.nested_forbidden`), wordt daar ook niet aangeboden.

describe('terminalSteps — the behaviour, not just the wiring', () => {
    for (const type of TERMINALS) {
        it(`nothing downstream can bind to a ${type} step`, () => {
            const node = { id: 's1', type };
            expect(describeNode(node, { trigger: { id: 'trg', kind: 'manual' }, steps: [node], edges: [] }, {}, {})).toBeNull();
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
        // De tegenproef: zonder deze zou de test hierboven ook slagen als de
        // geometrie gewoon nooit een doel oplevert.
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
