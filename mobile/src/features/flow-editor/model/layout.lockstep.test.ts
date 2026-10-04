/**
 * DIFFERENTIAL lockstep: auto-layout. The web's dagreLayout.js, arrange.js
 * and layout.js `seedPositions` run on the same @dagrejs/dagre as the port
 * (jest maps the web's import onto this package's copy), so every coordinate
 * must match — the phone and the browser draw one automation the same way.
 * Also the card geometry and the AI-tool edits the layout reads.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as aiTools from './aiTools';
import { arrangeDefinition, seedPositions } from './arrange';
import * as geometry from './geometry';
import * as layout from './layout';
import { rowLayoutPositions } from './rows';
import { clone, FIXTURES, templateDefinitions } from './testing/fixtures';
import type { FlowDefinition } from './types';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });
jest.mock('../../../../../agent-hub/src/components/automation/Builder/flow/inlineFlowlets', () => ({
    isInlineId: (id: unknown) => typeof id === 'string' && id.includes('/'),
    parseInlineId: (id: string) => ({ prefix: id.slice(0, id.lastIndexOf('/')), localId: id.slice(id.lastIndexOf('/') + 1) }),
    toDisplayPosition: (p: unknown) => p,
}));

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
/* eslint-disable @typescript-eslint/no-require-imports */
const webDagre = require(`${FLOW}/dagreLayout.js`);
const webArrange = require(`${FLOW}/arrange.js`);
const webLayout = require(`${FLOW}/layout.js`);
const webTools = require(`${FLOW}/aiToolNodes.js`);
const webColors = require(`${FLOW}/nodeTypeColors.js`);
const TEMPLATES_JS = path.resolve(__dirname, '../../../../../server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

const withInline: FlowDefinition = {
    ...clone(FIXTURES.branchy as FlowDefinition),
    steps: [...clone(FIXTURES.branchy as FlowDefinition).steps, { id: 'cl/x', type: 'set' }, { id: 'n', type: 'note', position: { x: 5, y: 5 } }],
};
const halfPlaced: FlowDefinition = { ...clone(FIXTURES.switchy as FlowDefinition) };
(halfPlaced.steps[1] as { position?: unknown }).position = undefined;

const CASES = Object.entries({ ...FIXTURES, ...TEMPLATES, withInline, halfPlaced });

describe('dagre', () => {
    it.each(CASES)('%s: graphNodes, graphPositions and runDagre', (_name, def) => {
        expect(layout.graphNodes(def)).toEqual(webDagre.graphNodes(def));
        expect([...layout.graphPositions(def)]).toEqual([...webDagre.graphPositions(def)]);
        const nodes = layout.graphNodes(def);
        const heights = geometry.toolLayoutHeights(nodes, 96);
        const spacing = { nodesep: 30, ranksep: 200 };
        expect([...layout.runDagre(nodes, def.edges, { heightById: heights, spacing })]).toEqual(
            [...webDagre.runDagre(nodes, def.edges, { width: 240, height: 96 }, heights, spacing)],
        );
        expect([...layout.graphPositions(def, { width: 100, height: 40 })]).toEqual([...webDagre.graphPositions(def, { width: 100, height: 40 })]);
    });

    it('agrees on the small things', () => {
        for (const p of [null, {}, { x: 1 }, { x: 1, y: 2 }, { x: NaN, y: 1 }, { x: '1', y: 2 }]) expect(layout.isFinitePos(p)).toBe(!!webDagre.isFinitePos(p));
        expect(layout.DEFAULT_SPACING).toEqual(webDagre.DEFAULT_SPACING);
        expect(layout.graphNodes(null)).toEqual([]);
        expect([...layout.graphPositions({ steps: [] } as never)]).toEqual([]);
    });

    it('remembers a layout, and forgets the oldest past eight shapes', () => {
        const nodes = [{ id: 'a' }, { id: 'b' }];
        const first = layout.runDagre(nodes, [{ from: 'a', to: 'b' }]);
        expect(layout.runDagre(nodes, [{ from: 'a', to: 'b' }])).toBe(first);
        for (let i = 0; i < 9; i++) layout.runDagre([{ id: `n${i}` }], []);
        expect(layout.runDagre(nodes, [{ from: 'a', to: 'b' }])).not.toBe(first);
    });
});

describe('rows, arrange and seeding', () => {
    const modes = ['compact', 'roomy', 'serpentine', 'bogus', undefined];
    const viewports = [{}, { viewportWidth: 800 }, { viewportWidth: 1200, viewportHeight: 700 }, { viewportWidth: 390, viewportHeight: 800 }];
    it.each(CASES)('%s: arrangeDefinition in every mode and viewport', (_name, def) => {
        for (const mode of modes) {
            for (const vp of viewports) {
                const opts = { mode, ...vp };
                expect({ mode, vp, out: arrangeDefinition(clone(def), opts as never) }).toEqual({ mode, vp, out: webArrange.arrangeDefinition(clone(def), opts) });
            }
        }
        for (const includeLayers of [true, false]) {
            expect(arrangeDefinition(clone(def), { mode: 'compact', includeLayers })).toEqual(webArrange.arrangeDefinition(clone(def), { mode: 'compact', includeLayers }));
        }
    });

    it.each(CASES)('%s: seedPositions and the row layout', (_name, def) => {
        expect(seedPositions(clone(def))).toEqual(webLayout.seedPositions(clone(def)));
        expect(seedPositions(clone(def), { width: 180, height: 60 })).toEqual(webLayout.seedPositions(clone(def), { width: 180, height: 60 }));
        const nodes = layout.graphNodes(def);
        for (const cols of [1, 2, 5]) {
            expect([...rowLayoutPositions(nodes, def.edges, { cols })]).toEqual([...webArrange.rowLayoutPositions(nodes, def.edges, { cols })]);
        }
    });

    it('leaves a definition without a trigger alone', () => {
        const def = { steps: [{ id: 'a', type: 'set' }], edges: [] } as FlowDefinition;
        expect(arrangeDefinition(def)).toBe(def);
        expect(seedPositions(def)).toBe(def);
        expect(arrangeDefinition(null)).toBeNull();
        expect([...rowLayoutPositions([], [])]).toEqual([]);
        expect([...rowLayoutPositions(null, [])]).toEqual([]);
        const placed = clone(FIXTURES.switchy as FlowDefinition);
        expect(seedPositions(placed)).toBe(placed);
    });
});

describe('geometry and AI tools', () => {
    it('cards grow with their ports exactly as on the web', () => {
        for (const n of [undefined, 'x', 0, 2, 3, 4, 9]) expect(geometry.cardHeightForPorts(n)).toBe(webColors.cardHeightForPorts(n));
        expect([geometry.CARD_W, geometry.CARD_H, geometry.PORT_PITCH, geometry.PORT_PAD]).toEqual([webColors.CARD_W, webColors.CARD_H, webColors.PORT_PITCH, webColors.PORT_PAD]);
        expect(geometry.TOOL_ROW_EXTRA_H).toBe(webTools.TOOL_ROW_EXTRA_H);
    });

    it.each(CASES)('%s: layout heights and tool states', (_name, def) => {
        const nodes = [...layout.graphNodes(def), null] as never[];
        expect([...geometry.toolLayoutHeights(nodes, 96)]).toEqual([...webTools.toolLayoutHeights(nodes, 96)]);
        expect([...geometry.toolLayoutHeights(nodes, 40)]).toEqual([...webTools.toolLayoutHeights(nodes, 40)]);
        for (const s of def.steps) expect(aiTools.toolStateOf(s)).toEqual(webTools.toolStateOf(s));
    });

    it('attach and detach agree, including the legacy all-tools step', () => {
        const def = clone(FIXTURES.multi as FlowDefinition);
        const all = ['gmail_search', 'kb_search', 'web_search'];
        for (const id of ['ai_1', 'ai_2', 'ai_3', 'flt', 'nope', '']) {
            for (const tool of ['gmail_search', 'web_search', '']) {
                expect(aiTools.attachTool(clone(def), id, tool, { allToolNames: all })).toEqual(webTools.attachTool(clone(def), id, tool, { allToolNames: all }));
                expect(aiTools.attachTool(clone(def), id, tool)).toEqual(webTools.attachTool(clone(def), id, tool));
                expect(aiTools.detachTool(clone(def), id, tool)).toEqual(webTools.detachTool(clone(def), id, tool));
            }
        }
        expect(aiTools.attachTool(null, 'a', 'b')).toBeNull();
        expect(aiTools.detachTool(undefined, 'a', 'b')).toBeUndefined();
        expect(aiTools.toolStateOf(null)).toEqual(webTools.toolStateOf(null));
    });
});
