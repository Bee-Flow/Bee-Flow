/**
 * DIFFERENTIAL + TEXTUAL lockstep: the canvas against the web's DiagramPane.
 *
 *   - the edge model (edgeModel.ts) against flow/layout.js `buildLayout`'s
 *     edges: port, chip, port-labelled, identity, case slot, lanes, ids;
 *   - the top-level positions (scene.ts) against `buildLayout`'s nodes;
 *   - open loops (inlineLoops.ts) against flow/inlineFlowlets.js: container
 *     sizes, origins, children, their positions, the neighbour shift, and
 *     the open/close rule;
 *   - line colours (edgeColors.ts) against flow/edgeColors.js and
 *     edgeColoring.js's "branches" mode;
 *   - by text, the numbers only a component holds: the ports' placement
 *     (StepNodeBase), the handle ids (ConditionNode, GuardNode, SwitchNode,
 *     LoopNode), an open loop's port offsets, and the lane pitches (edges.jsx).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FlowDefinition, FlowStep } from '@/features/flow-editor/model';
import { clone, FIXTURES, templateDefinitions } from '@/features/flow-editor/model/testing/fixtures';

import * as colors from './edgeColors';
import { classifyEdges } from './edgeModel';
import { CHIP_PITCH, LANE_PITCH } from './edgePath';
import * as loops from './inlineLoops';
import { topPositions } from './scene';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });

const BUILDER = path.resolve(__dirname, '../../../../../../agent-hub/src/components/automation/Builder');
const FLOW = `${BUILDER}/flow`;
/* eslint-disable @typescript-eslint/no-require-imports */
const webLayout = require(`${FLOW}/layout.js`);
const webInline = require(`${FLOW}/inlineFlowlets.js`);
const webColors = require(`${FLOW}/edgeColors.js`);
const webColoring = require(`${FLOW}/edgeColoring.js`);
const TEMPLATES_JS = path.resolve(__dirname, '../../../../../../server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

const read = (rel: string) => fs.readFileSync(path.join(BUILDER, rel), 'utf8');

/** A loop inside a loop, a placed body and an empty one: the shapes an open loop must draw right. */
const nested: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
    steps: [
        {
            id: 'outer', type: 'loop', position: { x: 320, y: 0 }, batchSize: 3,
            body: [
                { id: 'a', type: 'set', position: { x: 300, y: 40 } },
                { id: 'inner', type: 'loop', position: { x: 600, y: -30 }, body: [{ id: 'b', type: 'condition' }, { id: 'c', type: 'set' }] },
            ],
        },
        { id: 'empty', type: 'loop', position: { x: 320, y: 300 }, body: [] },
        { id: 'right', type: 'set', position: { x: 640, y: 10 } },
        { id: 'below', type: 'notification', position: { x: 330, y: 150 } },
    ],
    edges: [{ from: 'trg', to: 'outer' }, { from: 'outer', to: 'right' }, { from: 'outer', to: 'below', label: 'on_error' }, { from: 'right', to: 'empty' }],
};

const CASES = Object.entries({ ...FIXTURES, ...TEMPLATES, nested }).map(([name, def]) => [name, clone(def)] as [string, FlowDefinition]);
const EXPANSIONS: Record<string, string[]> = { loopy: ['loop_1'], nested: ['outer', 'outer/inner', 'empty'] };

describe('the edge model', () => {
    it.each(CASES)('%s: every line as buildLayout draws it', (_name, def) => {
        const web = webLayout.buildLayout(def, {}).edges.map((e: { id: string; source: string; target: string; data: Record<string, unknown> }) => ({
            id: e.id, from: e.source, to: e.target, sourceHandle: e.data.sourceHandle, kind: e.data.kind ?? null, labelledAtPort: e.data.labelledAtPort,
            defLabel: e.data.defLabel, defCaseName: e.data.defCaseName, defColor: e.data.defColor, caseIndex: e.data.caseIndex,
            parallelIndex: e.data.parallelIndex ?? 0, parallelCount: e.data.parallelCount ?? 1,
        }));
        const nodes = [def.trigger, ...(def.triggers || []), ...def.steps].filter(Boolean) as { id: string; type: string }[];
        expect(classifyEdges(nodes, def.edges)).toEqual(web);
    });
});

describe('top-level positions', () => {
    it.each(CASES)('%s: where buildLayout puts every node', (_name, def) => {
        const web = new Map(webLayout.buildLayout(def, {}).nodes.map((n: { id: string; position: unknown }) => [n.id, n.position]));
        expect(topPositions(def).positions).toEqual(web);
    });
});

describe('open loops', () => {
    const loopCases = CASES.filter(([name]) => EXPANSIONS[name]);

    it.each(loopCases)('%s: containers, children and the neighbour shift', (name, def) => {
        const want = new Set(EXPANSIONS[name]);
        const web = webInline.composeInlineGraph(def, def, want);
        const mine = loops.composeLoops(def.steps as FlowStep[], want);
        expect([...mine.containers.keys()]).toEqual([...web.sidecar.keys()]);
        expect(mine.containers.size).toBe(want.size);
        for (const [prefix, entry] of mine.containers) {
            const w = web.sidecar.get(prefix);
            expect({ ...entry, entryId: undefined }).toEqual({
                prefix: w.prefix, callStepId: w.callStepId, parentPrefix: w.parentPrefix, depth: w.depth,
                origin: w.origin, childIds: w.childIds, size: w.size, entryId: undefined,
            });
            expect(entry.entryId).toBe(w.triggerId);
        }
        const webSteps = new Map(web.graph.steps.map((s: { id: string; position: unknown }) => [s.id, s.position]));
        for (const [id, child] of mine.children) {
            expect(child.position).toEqual(webSteps.get(id));
            expect(loops.toDisplayPosition(id, child.position, mine.containers)).toEqual(webInline.toDisplayPosition(id, child.position, web.sidecar));
        }
        // The body chains and the links into each "Each item": every web edge that ends inside a container.
        expect(mine.edges).toEqual(web.graph.edges.filter((e: { to: string }) => e.to.includes('/')));
        const topLevel = [def.trigger, ...def.steps].filter(Boolean) as FlowStep[];
        expect(loops.shiftForExpansion(topLevel, mine.containers)).toEqual(webInline.shiftForExpansion(web.graph, web.sidecar));
    });

    it('opens and closes like the web: closing takes the nested ones with it', () => {
        const states = [new Set<string>(), new Set(['a']), new Set(['a', 'a/b']), new Set(['a', 'a/b', 'c'])];
        for (const prev of states) {
            for (const prefix of ['a', 'a/b', 'c']) {
                expect(loops.toggleExpanded(prev, prefix)).toEqual(webInline.nextExpanded(prev, prefix));
            }
        }
        expect(loops.CONTAINER_PAD).toBe(webInline.CONTAINER_PAD);
        expect(loops.CONTAINER_HEADER).toBe(webInline.CONTAINER_HEADER);
        expect(loops.MAX_INLINE_DEPTH).toBe(webInline.MAX_INLINE_DEPTH);
        for (const id of ['a', 'a/b', 'a/b/c', '']) expect(loops.parseInlineId(id)).toEqual(webInline.parseInlineId(id));
    });
});

describe('line colours', () => {
    it('has the same swatches, series and case colours', () => {
        expect(Object.keys(colors.EDGE_COLOR_HEX)).toEqual(webColors.EDGE_COLOR_KEYS);
        for (const key of [...webColors.EDGE_COLOR_KEYS, 'purple', null, 3]) expect(colors.resolveEdgeColor(key)).toBe(webColors.resolveEdgeColor(key));
        for (const i of [0, 1, 6, 7, 13, -1, -8, 2.5, null]) expect(colors.autoCaseColor(i)).toBe(webColors.autoCaseColor(i));
    });

    it('colours a line as the "branches" mode does', () => {
        const cases = [{ defColor: 'rose', caseIndex: 2 }, { defColor: null, caseIndex: 2 }, { defColor: null, caseIndex: null }, { defColor: 'bogus', caseIndex: 0 }];
        for (const data of cases) {
            expect(colors.identityColor({ color: data.defColor, caseIndex: data.caseIndex })).toBe(webColoring.identityColorForEdge(data, 'branches'));
        }
    });
});

describe('what only the web components say', () => {
    it('places two ports at thirds and more on 22px rows (StepNodeBase)', () => {
        const base = read('flow/nodes/StepNodeBase.jsx');
        expect(base).toContain('? PORT_PAD + PORT_PITCH * (i + 0.5)');
        expect(base).toContain(': `${((i + 1) / (branchHandles.length + 1)) * 100}%`');
    });

    it('names the handles the edge model reports', () => {
        expect(read('flow/nodes/ConditionNode.jsx')).toMatch(/\{ id: 'then'[^}]*\},\s*\{ id: 'else'/);
        expect(read('flow/nodes/GuardNode.jsx')).toMatch(/\{ id: 'then', label: 'personal data'[^}]*\},\s*\{ id: 'else', label: 'clean'/);
        expect(read('flow/nodes/SwitchNode.jsx')).toContain("{ id: 'case:default', label: 'otherwise', tone: 'default' }");
        const loop = read('flow/nodes/LoopNode.jsx');
        expect(loop).toMatch(/\{ id: 'done', label: t\('automations\.canvas\.loop_port_done', 'Done'\), tone: 'then' \},\s*\{ id: 'on_error', label: t\('automations\.canvas\.loop_port_on_error', 'On error'\), tone: 'error' \}/);
        // An open loop keeps its ports on its header strip.
        expect(loop).toContain('id="done"\n                style={{ top: CONTAINER_HEADER / 2 - 8 }}');
        expect(loop).toContain('id="on_error"\n                style={{ top: CONTAINER_HEADER / 2 + 10 }}');
        expect(loop).toContain('id="in"\n                style={{ top: CONTAINER_HEADER / 2 }}');
    });

    it('fans parallel lines out by the same pitches (edges.jsx)', () => {
        const edges = read('flow/edges.jsx');
        expect(edges).toContain(`const LANE_PITCH = ${LANE_PITCH};`);
        expect(edges).toContain(`const CHIP_PITCH = ${CHIP_PITCH};`);
        expect(edges).toContain('borderRadius: 12');
    });
});
