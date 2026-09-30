/**
 * DIFFERENTIAL lockstep: the graph surgery (normalize, edge identity, node
 * delete / detach / duplicate / patch) against the web builder's own modules,
 * required straight from agent-hub and run on the same fixtures. When one of
 * these fails the web changed: port the change, do not loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as edgesPort from './branchEdges';
import * as opsPort from './nodeOps';
import * as normalizePort from './normalize';
import { clone, FIXTURES, templateDefinitions } from './testing/fixtures';
import type { FlowDefinition } from './types';

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
/* eslint-disable @typescript-eslint/no-require-imports */
const webEdges = require(`${FLOW}/branchEdges.js`);
const webNormalize = require(`${FLOW}/normalizeDefinition.js`);
const webOps = require(`${FLOW}/nodeOps.js`);
const TEMPLATES_JS = path.resolve(__dirname, '../../../../../server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

const ALL: Record<string, FlowDefinition> = { ...FIXTURES, ...TEMPLATES };
const CASES = Object.entries(ALL);

/** Every node id in a definition, plus one that is not there. */
const idsOf = (d: FlowDefinition) => [d.trigger?.id, ...(d.triggers || []).map((t) => t.id), ...d.steps.map((s) => s.id), 'nope'].filter(Boolean) as string[];

describe('the fixtures are real', () => {
    it('includes the server templates, so an empty glob cannot pass everything', () => {
        expect(Object.keys(TEMPLATES).length).toBeGreaterThan(10);
        for (const def of Object.values(TEMPLATES)) expect(Array.isArray(def.steps)).toBe(true);
    });
});

describe('normalizeDefinition', () => {
    const inputs: unknown[] = [null, undefined, 0, 'x', [], {}, { trigger: null }, { steps: [] }, { triggers: [{ id: 'a' }] },
        { trigger: { id: 't' } }, { steps: 'no', edges: null, vars: { a: 1 } }, ...Object.values(ALL)];
    it.each(inputs.map((v, i) => [i, v] as const))('input %i', (_i, input) => {
        expect(normalizePort.isBlankDefinition(input)).toBe(webNormalize.isBlankDefinition(input));
        expect(normalizePort.normalizeDefinitionShape(input)).toEqual(webNormalize.normalizeDefinitionShape(input));
    });
    it('keeps the identity of a well-formed definition, and seeds the same empty graph', () => {
        const def = clone(ALL.branchy as FlowDefinition);
        expect(normalizePort.normalizeDefinitionShape(def)).toBe(def);
        expect(normalizePort.emptyGraph()).toEqual(webNormalize.emptyGraph());
        expect(normalizePort.asDefinition(null)).toEqual(webNormalize.emptyGraph());
    });
});

describe('branchEdges', () => {
    const handles = [null, undefined, '', 'then', 'else', 'on_error', 'case:vip', 'case:default', 'out', 42];
    it.each(handles.map((h) => [String(h), h] as const))('branchFromHandle(%s)', (_l, h) => {
        expect(edgesPort.branchFromHandle(h)).toEqual(webEdges.branchFromHandle(h));
    });

    const identities = [null, {}, { label: 'then' }, { label: 'else' }, { label: 'case:gold' }, { caseName: 'silver' },
        { label: 'case:bronze', caseName: 'bronze' }, { label: 'on_error' }, { caseName: 'default' }];
    const edges = ALL.switchy?.edges ?? [];
    it('matchesEdgeIdentity, edgeKey and edgeIdentity agree for every edge × identity', () => {
        for (const e of [...edges, ...(ALL.branchy?.edges ?? [])]) {
            expect(edgesPort.edgeKey(e)).toBe(webEdges.edgeKey(e));
            expect(edgesPort.edgeIdentity(e)).toEqual(webEdges.edgeIdentity(e));
            for (const id of identities) {
                expect({ e, id, m: edgesPort.matchesEdgeIdentity(e, id) }).toEqual({ e, id, m: webEdges.matchesEdgeIdentity(e, id) });
            }
        }
        expect(edgesPort.edgeIdentity(null)).toEqual(webEdges.edgeIdentity(null));
    });

    it('copyExtraEdgeKeys, spliceStepIntoEdge and removeEdgesByIdentity agree', () => {
        expect(edgesPort.copyExtraEdgeKeys(null, { a: 1 })).toEqual(webEdges.copyExtraEdgeKeys(null, { a: 1 }));
        for (const e of edges) {
            expect(edgesPort.copyExtraEdgeKeys(e, {})).toEqual(webEdges.copyExtraEdgeKeys(e, {}));
            for (const port of [null, { label: 'then' }, { label: 'case:x', caseName: 'x' }]) {
                const identity = { label: e.label, caseName: e.caseName };
                const spec = { insertedId: 'new', sourceId: e.from, targetId: e.to, identity, insertedPort: port };
                expect(edgesPort.spliceStepIntoEdge(edges, spec)).toEqual(webEdges.spliceStepIntoEdge(edges, 'new', e.from, e.to, identity, port));
            }
            expect(edgesPort.removeEdgesByIdentity(edges, e)).toEqual(webEdges.removeEdgesByIdentity(edges, e));
            expect(edgesPort.removeEdgesByIdentity(edges, [e, null])).toEqual(webEdges.removeEdgesByIdentity(edges, [e, null]));
        }
        expect(edgesPort.spliceStepIntoEdge(null, { insertedId: 'n', sourceId: 'a', targetId: 'b' })).toEqual(
            webEdges.spliceStepIntoEdge(null, 'n', 'a', 'b', undefined, undefined),
        );
        expect(edgesPort.removeEdgesByIdentity(undefined, null)).toEqual(webEdges.removeEdgesByIdentity(undefined, null));
    });
});

describe('nodeOps', () => {
    it.each(CASES)('%s: bridge, delete, detach, patch and the can* guards', (_name, def) => {
        for (const id of idsOf(def)) {
            expect(opsPort.bridgeEdges(def.edges, id)).toEqual(webOps.bridgeEdges(def.edges, id));
            expect(opsPort.applyDeleteNodes(clone(def), id)).toEqual(webOps.applyDeleteNodes(clone(def), id));
            expect(opsPort.applyDetachNode(clone(def), id)).toEqual(webOps.applyDetachNode(clone(def), id));
            expect(opsPort.applyPatchStep(clone(def), id, { label: 'L', x: 1 })).toEqual(webOps.applyPatchStep(clone(def), id, { label: 'L', x: 1 }));
            expect(opsPort.canDeleteNode(def, id)).toBe(webOps.canDeleteNode(def, id));
            expect(opsPort.canDuplicateNode(def, id)).toBe(webOps.canDuplicateNode(def, id));
            expect(opsPort.canDetachNode(def, id)).toBe(webOps.canDetachNode(def, id));
        }
        const all = idsOf(def);
        expect(opsPort.applyDeleteNodes(clone(def), all)).toEqual(webOps.applyDeleteNodes(clone(def), all));
    });

    it('returns the same object when there is nothing to do', () => {
        const def = clone(ALL.branchy as FlowDefinition);
        expect(opsPort.applyDeleteNodes(def, 'trg')).toBe(def);
        expect(opsPort.applyDeleteNodes(def, [])).toBe(def);
        expect(opsPort.applyPatchStep(def, 'act_a', null)).toBe(def);
        expect(opsPort.applyPatchStep(def, 'act_a', ['x'] as unknown as Record<string, unknown>)).toBe(def);
        expect(opsPort.applyDetachNode(def, 'trg')).toBe(def);
        for (const guard of [opsPort.canDeleteNode, opsPort.canDuplicateNode, opsPort.canDetachNode]) {
            expect(guard(null, 'x')).toBe(false);
            expect(guard(def, '')).toBe(false);
        }
        expect(opsPort.applyDeleteNodes({ steps: 'bad' } as unknown as FlowDefinition, 'x')).toEqual(webOps.applyDeleteNodes({ steps: 'bad' }, 'x'));
    });

    it.each(CASES)('%s: duplicate matches, down to the id minted', (_name, def) => {
        const uuid = jest.spyOn(globalThis.crypto, 'randomUUID');
        for (const id of idsOf(def)) {
            let n = 0;
            uuid.mockImplementation(() => `${(n++).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);
            const web = webOps.applyDuplicateNode(clone(def), id);
            n = 0;
            const port = opsPort.applyDuplicateNode(clone(def), id);
            expect(port).toEqual(web);
        }
        uuid.mockRestore();
    });

    it('never mints a colliding id, even when every random draw collides', () => {
        const def = clone(ALL.branchy as FlowDefinition);
        def.steps.push({ id: 'act_00000000', type: 'integration_action' });
        const uuid = jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
        const { newStepId } = opsPort.applyDuplicateNode(def, 'act_a');
        uuid.mockRestore();
        expect(newStepId).toMatch(/^act_\d+_[0-9a-z]+$/);
    });

    it('draws ids from Math.random where the runtime has no randomUUID', () => {
        const saved = globalThis.crypto.randomUUID;
        Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
        try {
            const { newStepId } = opsPort.applyDuplicateNode(clone(ALL.loopy as FlowDefinition), 'lim');
            expect(newStepId).toMatch(/^step_[0-9a-z]{1,8}$/);
        } finally {
            Object.defineProperty(globalThis.crypto, 'randomUUID', { value: saved, configurable: true });
        }
    });
});
