/**
 * DIFFERENTIAL lockstep: dropping a node. The web's applyAddNode.js is
 * required from agent-hub and fed the same payloads, positions and source
 * ports as the port; both mint ids from the same (stubbed) random draws, so
 * the whole definition — ids, scaffolds, edges and the positions the row
 * layout seeds — must come out identical.
 *
 * Three web imports cannot load here and are replaced: Lucide (a canvas-only
 * dependency of the layout chain) by names, inlineFlowlets (it holds a React
 * hook) by its id helpers, and the two form components by their default
 * declarations evaluated from source — the same cut formDefaults.lockstep does.
 */

import fs from 'node:fs';
import path from 'node:path';

import { addedNodeId, applyAddNode, buildStepFromPayload, createsCycle } from './addNode';
import { clone, FIXTURES, templateDefinitions } from './testing/fixtures';
import type { FlowDefinition } from './types';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });
jest.mock('../../../../../agent-hub/src/components/automation/Builder/flow/inlineFlowlets', () => ({
    isInlineId: (id: unknown) => typeof id === 'string' && id.includes('/'),
    parseInlineId: (id: string) => ({ prefix: id.slice(0, id.lastIndexOf('/')), localId: id.slice(id.lastIndexOf('/') + 1) }),
    toDisplayPosition: (p: unknown) => p,
}));
jest.mock('../../../../../agent-hub/src/components/automation/Builder/flow/settings/FormBuilderFields', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src: string = require('node:fs').readFileSync(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:path').resolve(__dirname, '../../../../../agent-hub/src/components/automation/Builder/flow/settings/FormBuilderFields.jsx'),
        'utf8',
    );
    const cut = (start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)) + end.length);
    const presets = new Function(cut('export const THEME_PRESETS = [', '\n];').replace('export const THEME_PRESETS = ', 'return '))();
    const fn = (name: string) => new Function('THEME_PRESETS', `${cut(`export function ${name}() {`, '\n}\n').replace('export function', 'function')}\nreturn ${name};`)(presets);
    return {
        defaultFormDeclaration: fn('defaultFormDeclaration'),
        defaultFormPageDeclaration: fn('defaultFormPageDeclaration'),
        defaultFormEndingDeclaration: fn('defaultFormEndingDeclaration'),
    };
});
jest.mock('../../../../../agent-hub/src/components/automation/Builder/flow/settings/FormTriggerFields', () =>
    jest.requireMock('../../../../../agent-hub/src/components/automation/Builder/flow/settings/FormBuilderFields'),
);

/* eslint-disable @typescript-eslint/no-require-imports */
const web = require('../../../../../agent-hub/src/components/automation/Builder/applyAddNode.js');
const TEMPLATES_JS = path.resolve(__dirname, '../../../../../server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

/** Every kind the web scaffolds, the triggers, and a few that are not placeable. */
const KINDS = [
    'integration_action', 'ai_step', 'data_extraction', 'condition', 'tokenize', 'untokenize', 'guard', 'loop',
    'notification', 'http_request', 'generate_document', 'slide', 'presentation', 'fill_document', 'form_page',
    'code', 'set', 'parse_json', 'datetime', 'wait', 'approval', 'stop_error', 'return_to_app', 'datatable',
    'knowledge_write', 'switch', 'filter', 'limit', 'dedupe', 'aggregate', 'summarize', 'call_layer', 'call_block',
    'layer_output', 'note', 'parallel', 'mystery',
];
const PAYLOADS: Record<string, unknown>[] = [
    ...KINDS.map((kind) => ({ kind })),
    ...KINDS.map((kind) => ({ kind, label: 'Named' })),
    { kind: 'integration_action', tool: 'gmail_send', appId: 'gmail', sideEffect: false },
    { kind: 'integration_action', tool: 'drive_list', sideEffect: null },
    { kind: 'tokenize', sourceRef: 'steps.a.output' },
    { kind: 'form_page', mode: 'ending' },
    { kind: 'call_layer', layerKey: 'enrich' },
    { kind: 'call_block', blockId: 'b1', icon: 'Mail' },
    { kind: 'note', text: 'hello' },
    { kind: 'note', text: 42 },
    ...['manual', 'form', 'schedule', 'webhook', 'app_event', 'agent_call', 'app_trigger', undefined].flatMap((triggerKind) => [
        { kind: 'trigger', triggerKind },
        { kind: 'trigger', triggerKind, asSecondaryTrigger: true, label: 'Hook' },
    ]),
    { kind: 'create_layer' },
    {},
];

/** Run `fn` twice from the same stubbed random draws: once for the web, once for the port. */
function sameDraws<T>(webFn: () => T, portFn: () => T): [T, T] {
    const uuid = jest.spyOn(globalThis.crypto, 'randomUUID');
    let n = 0;
    uuid.mockImplementation(() => `${(n++).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);
    const w = webFn();
    n = 0;
    const p = portFn();
    uuid.mockRestore();
    return [w, p];
}

describe('buildStepFromPayload', () => {
    it.each(PAYLOADS.map((p) => [JSON.stringify(p), p] as const))('%s', (_label, payload) => {
        const [w, p] = sameDraws(() => web.buildStepFromPayload(payload, { x: 5, y: 6 }), () => buildStepFromPayload(payload as never, { x: 5, y: 6 }));
        expect(p).toEqual(w);
        const [w2, p2] = sameDraws(() => web.buildStepFromPayload(payload), () => buildStepFromPayload(payload as never));
        expect(p2).toEqual(w2);
    });

    it('builds nothing for nothing', () => {
        expect(buildStepFromPayload(null)).toBeNull();
    });
});

const BASES: Record<string, unknown> = {
    ...FIXTURES, ...TEMPLATES,
    empty: {}, nothing: null, blank: { trigger: null, steps: [], edges: [] },
    flowlet: { trigger: { id: 'lin', type: 'trigger', kind: 'layer_input' }, steps: [], edges: [] },
};
const DROPS: [Record<string, unknown>, string | null, string | null][] = [
    [{ kind: 'set' }, null, null],
    [{ kind: 'notification' }, 'trg', null],
    [{ kind: 'wait' }, 'cond_1', 'then'],
    [{ kind: 'wait' }, 'sw', 'case:gold'],
    [{ kind: 'switch' }, 'act_a', 'on_error'],
    [{ kind: 'note' }, 'trg', null],
    [{ kind: 'trigger', triggerKind: 'schedule' }, null, null],
    [{ kind: 'trigger', triggerKind: 'webhook', asSecondaryTrigger: true }, null, null],
    [{ kind: 'create_layer' }, 'trg', null],
];

describe('applyAddNode', () => {
    it.each(Object.entries(BASES))('%s: every drop matches, positions included', (_name, base) => {
        for (const [payload, sourceId, sourceHandle] of DROPS) {
            const [w, p] = sameDraws(
                () => web.applyAddNode(clone(base), payload, null, sourceId, sourceHandle),
                () => applyAddNode(clone(base) as FlowDefinition, payload as never, { sourceId, sourceHandle }),
            );
            expect({ payload, def: p }).toEqual({ payload, def: w });
            const [w2, p2] = sameDraws(
                () => web.applyAddNode(clone(base), payload, { x: 1, y: 2 }),
                () => applyAddNode(clone(base) as FlowDefinition, payload as never, { position: { x: 1, y: 2 } }),
            );
            expect(p2).toEqual(w2);
        }
    });

    it('names the node it added', () => {
        const base = clone(FIXTURES.branchy as FlowDefinition);
        const next = applyAddNode(base, { kind: 'wait' }, { sourceId: 'act_a' });
        const id = addedNodeId(base, next);
        expect(next.steps?.find((s) => s.id === id)?.type).toBe('wait');
        expect(addedNodeId(base, base)).toBeNull();
        expect(applyAddNode(base, null)).toBe(base);
    });
});

describe('createsCycle', () => {
    it.each(Object.entries(BASES))('%s: agrees for every pair of nodes', (_name, base) => {
        const def = (base || {}) as Partial<FlowDefinition>;
        const ids = [def.trigger?.id, ...(def.steps || []).map((s) => s.id), 'ghost'].filter(Boolean) as string[];
        for (const from of ids) for (const to of ids) expect(createsCycle(def as FlowDefinition, from, to)).toBe(web.createsCycle(def, from, to));
    });
});
