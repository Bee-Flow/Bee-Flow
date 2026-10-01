import { MATCH_CASES } from '@shared/mapping/matchCases.mjs';
import { describe, it, expect } from 'vitest';
import {
    autoMapInputs, autoMapStep, applyAutoMapToStep,
    normalizeKey, sampleType, isSecretLikeKey, nearestArrayRef,
} from './autoMapInputs';

// Two upstream groups in topological order (nearest last), matching the
// computeUpstreamGroups shape.
const groups = [
    {
        id: 'trg', label: 'Trigger', kind: 'trigger', basePath: 'trigger.output',
        fields: [
            { key: 'text', path: 'trigger.output.text', sample: 'hello' },
            { key: 'count', path: 'trigger.output.count', sample: 3 },
        ],
    },
    {
        id: 's1', label: 'Gmail', kind: 'integration_action', basePath: 'steps.s1.output',
        fields: [
            { key: 'query', path: 'steps.s1.output.query', sample: 'q' },
            { key: 'results', path: 'steps.s1.output.results', sample: [{ id: 1 }] },
        ],
    },
];

describe('small helpers', () => {
    it('normalizeKey strips case + separators', () => {
        expect(normalizeKey('emailAddress')).toBe('emailaddress');
        expect(normalizeKey('max_results')).toBe('maxresults');
    });
    it('sampleType classifies values', () => {
        expect(sampleType([])).toBe('array');
        expect(sampleType(null)).toBe('null');
        expect(sampleType(2)).toBe('number');
        expect(sampleType('s')).toBe('string');
    });
    it('isSecretLikeKey flags credentials', () => {
        expect(isSecretLikeKey('apiKey')).toBe(true);
        expect(isSecretLikeKey('password')).toBe(true);
        expect(isSecretLikeKey('query')).toBe(false);
    });
    it('nearestArrayRef prefers the nearest array field', () => {
        expect(nearestArrayRef(groups)).toBe('steps.s1.output.results');
    });
});

describe('autoMapInputs (conservative)', () => {
    it('exact name match wins, preferring the nearest source', () => {
        const schema = { properties: { query: { type: 'string' } }, required: ['query'] };
        const patch = autoMapInputs(schema, {}, groups);
        // both trigger (no 'query') and s1 (has 'query') — exact match on s1.
        expect(patch.query).toEqual({ kind: 'ref', path: 'steps.s1.output.query' });
    });

    it('normalized name match (snake/camel)', () => {
        const schema = { properties: { maxResults: { type: 'number' } } };
        const g = [{ id: 'a', fields: [{ key: 'max_results', path: 'steps.a.output.max_results', sample: 5 }] }];
        const patch = autoMapInputs(schema, {}, g);
        expect(patch.maxResults).toEqual({ kind: 'ref', path: 'steps.a.output.max_results' });
    });

    it('never overwrites a field the user already set', () => {
        const schema = { properties: { query: { type: 'string' } } };
        const existing = { query: { kind: 'literal', value: 'mine' } };
        expect(autoMapInputs(schema, existing, groups)).toEqual({});
    });

    it('skips secret-like keys', () => {
        const schema = { properties: { apiKey: { type: 'string' } } };
        const g = [{ id: 'a', fields: [{ key: 'apiKey', path: 'steps.a.output.apiKey', sample: 'x' }] }];
        expect(autoMapInputs(schema, {}, g)).toEqual({});
    });

    it('respects the type gate (no number←array)', () => {
        const schema = { properties: { results: { type: 'number' } } };
        // only candidate named results is an array → rejected
        expect(autoMapInputs(schema, {}, groups)).toEqual({});
    });

    it('generic mode only fills existing keys, never invents them', () => {
        const existing = { text: { kind: 'literal', value: '' } }; // empty → eligible
        const patch = autoMapInputs(null, existing, groups);
        expect(patch.text).toEqual({ kind: 'ref', path: 'trigger.output.text' });
        expect(Object.keys(patch)).toEqual(['text']);
    });
});

describe('autoMapStep + applyAutoMapToStep', () => {
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            { id: 's2', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item' },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    const catalog = {
        apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ id: 1 }] } }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };

    it('loop gets overRef from nearest upstream array when still scaffold default', () => {
        const { step, mappedKeys } = autoMapStep(definition.steps[1], definition, catalog);
        expect(mappedKeys).toEqual(['overRef']);
        expect(step.overRef).toBe('steps.s1.output.results');
    });

    it('applyAutoMapToStep records mapped input keys on step.autoMapped (not array refs)', () => {
        const out = applyAutoMapToStep(definition, 's2', catalog);
        const s2 = out.definition.steps.find(s => s.id === 's2');
        // overRef isn't an input → no autoMapped marker, but it is in mappedKeys
        expect(out.mappedKeys).toEqual(['overRef']);
        expect(s2.autoMapped).toBeUndefined();
    });
});

/**
 * C20 — Lists nodes never got their source list auto-mapped: the palette
 * seeded the literal 'trigger.output.items' and autoMapStep bailed on ANY
 * truthy arrayRef. Both the new empty seed and the legacy literal now count
 * as scaffold; a user-chosen ref is never overridden.
 */
describe('collection-op arrayRef auto-map (C20)', () => {
    const mkDef = (listStep) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            listStep,
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: listStep.id }],
    });
    const catalog = {
        apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ id: 1 }] } }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };

    it('an empty arrayRef (new palette seed) maps to the nearest upstream array', () => {
        for (const type of ['filter', 'limit', 'dedupe', 'aggregate', 'summarize']) {
            const listStep = { id: 'ls', type, arrayRef: '' };
            const { step, mappedKeys } = autoMapStep(listStep, mkDef(listStep), catalog);
            expect(mappedKeys, type).toEqual(['arrayRef']);
            expect(step.arrayRef, type).toBe('steps.s1.output.results');
        }
    });

    it('the legacy scaffold literal is healed on re-connect', () => {
        const listStep = { id: 'ls', type: 'filter', arrayRef: 'trigger.output.items', expr: 'true' };
        const { step, mappedKeys } = autoMapStep(listStep, mkDef(listStep), catalog);
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.arrayRef).toBe('steps.s1.output.results');
    });

    it('a user-chosen arrayRef is never overridden', () => {
        const listStep = { id: 'ls', type: 'filter', arrayRef: 'steps.other.output.rows', expr: 'true' };
        const { mappedKeys } = autoMapStep(listStep, mkDef(listStep), catalog);
        expect(mappedKeys).toEqual([]);
    });

    it('no upstream array → arrayRef stays empty (visible warning, not a silent guess)', () => {
        const listStep = { id: 'ls', type: 'limit', arrayRef: '', count: 5 };
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [listStep],
            edges: [{ from: 'trg', to: 'ls' }],
        };
        const { step, mappedKeys } = autoMapStep(listStep, def, catalog);
        expect(mappedKeys).toEqual([]);
        expect(step.arrayRef).toBe('');
    });
});

/**
 * The Condition node decides what it works on instead of asking. A freshly
 * dropped one is a `condition` (the whole run); wired below a step that hands
 * it a list it becomes a list-mode `filter` with the source already bound.
 */
describe('Condition node — list mode is detected, not configured', () => {
    const catalog = {
        apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ id: 1, subject: 'x' }] } }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const mkDef = (routeStep, extraEdges = []) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            routeStep,
            { id: 'after', type: 'notification', title: 'x' },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: routeStep.id }, ...extraEdges],
    });

    it('a fresh condition below a list becomes a list-mode filter', () => {
        const routeStep = { id: 'r1', type: 'condition', expr: 'true' };
        const { step, mappedKeys } = autoMapStep(routeStep, mkDef(routeStep), catalog);
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.type).toBe('filter');
        expect(step.arrayRef).toBe('steps.s1.output.results');
    });

    it('a condition the user already configured is left alone', () => {
        const routeStep = { id: 'r1', type: 'condition', expr: 'trigger.output.amount > 10' };
        const { step, mappedKeys } = autoMapStep(routeStep, mkDef(routeStep), catalog);
        expect(mappedKeys).toEqual([]);
        expect(step.type).toBe('condition');
    });

    it('no list upstream → it stays a whole-run condition', () => {
        const routeStep = { id: 'r1', type: 'condition', expr: 'true' };
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [routeStep],
            edges: [{ from: 'trg', to: 'r1' }],
        };
        const { step, mappedKeys } = autoMapStep(routeStep, def, catalog);
        expect(mappedKeys).toEqual([]);
        expect(step.type).toBe('condition');
    });

    it('the type flip re-points the outgoing edge in the same commit', () => {
        // A node spliced ONTO a connection already has an outgoing edge when
        // auto-map runs; `then` is not a port a filter has.
        const routeStep = { id: 'r1', type: 'condition', expr: 'true' };
        const def = mkDef(routeStep, [{ from: 'r1', to: 'after', label: 'then' }]);
        const { definition } = applyAutoMapToStep(def, 'r1', catalog);
        expect(definition.steps.find(s => s.id === 'r1').type).toBe('filter');
        expect(definition.edges).toContainEqual({ from: 'r1', to: 'after' });
        expect(definition.edges.some(e => e.label === 'then')).toBe(false);
    });

    it('a branch-mode switch never gets a source list bound behind the user\'s back', () => {
        const routeStep = { id: 'r1', type: 'switch', cases: [{ name: 'a', expr: 'x' }] };
        const { mappedKeys } = autoMapStep(routeStep, mkDef(routeStep), catalog);
        expect(mappedKeys).toEqual([]);
    });

    it('a switch already in list mode gets its blank source bound', () => {
        const routeStep = { id: 'r1', type: 'switch', arrayRef: '', cases: [{ name: 'a', expr: 'x' }] };
        const { step, mappedKeys } = autoMapStep(routeStep, mkDef(routeStep), catalog);
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.arrayRef).toBe('steps.s1.output.results');
    });
});

/**
 * Same trust pattern for "Edit data" (set): a pristine scaffold below a list
 * becomes a list-mode step with the source bound; anything the user touched
 * is left alone.
 */
describe('Edit data (set) — list mode is detected, not configured', () => {
    const catalog = {
        apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ id: 1, subject: 'x' }] } }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const mkDef = (setStep) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            setStep,
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: setStep.id }],
    });

    it('a pristine set below a list becomes a list-mode set', () => {
        const setStep = { id: 'e1', type: 'set', fields: {} };
        const { step, mappedKeys } = autoMapStep(setStep, mkDef(setStep), catalog);
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.arrayRef).toBe('steps.s1.output.results');
        expect(step.type).toBe('set'); // no type flip — same runtime type, new mode
    });

    it('any user touch disables the detection: fields, forEach, or existing arrayRef', () => {
        for (const touched of [
            { id: 'e1', type: 'set', fields: { a: { kind: 'literal', value: 1 } } },
            { id: 'e1', type: 'set', fields: {}, forEach: { overRef: 'steps.s1.output.results', itemVar: 'item' } },
            { id: 'e1', type: 'set', fields: {}, arrayRef: 'steps.s1.output.results' },
            { id: 'e1', type: 'set', fields: {}, operations: [{ op: 'rowId', target: 'id' }] },
        ]) {
            const { mappedKeys } = autoMapStep(touched, mkDef(touched), catalog);
            expect(mappedKeys, JSON.stringify(touched)).toEqual([]);
        }
    });

    it('a blank source flipped on under Advanced still gets bound', () => {
        // arrayRef '' = list mode chosen but unsourced — treated like the
        // collection ops' scaffold.
        const setStep = { id: 'e1', type: 'set', fields: { a: { kind: 'literal', value: 1 } }, arrayRef: '' };
        const { step, mappedKeys } = autoMapStep(setStep, mkDef(setStep), catalog);
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.arrayRef).toBe('steps.s1.output.results');
    });

    it('no upstream list → stays a single-record step', () => {
        const setStep = { id: 'e1', type: 'set', fields: {} };
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [setStep],
            edges: [{ from: 'trg', to: 'e1' }],
        };
        const { step, mappedKeys } = autoMapStep(setStep, def, catalog);
        expect(mappedKeys).toEqual([]);
        expect(typeof step.arrayRef).not.toBe('string');
    });
});

describe('per item is never automatic', () => {
    // gmail search (array of emails) → gmail read attachment (scalar inputs).
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            { id: 's2', type: 'integration_action', tool: 'gmail_read_attachment', inputs: {} },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    const catalog = {
        apps: [{
            actions: [
                { name: 'gmail_search', outputSample: { query: 'q', total: 1, results: [{ id: 'm1', subject: 's', from: 'a@b.c' }] } },
                {
                    name: 'gmail_read_attachment',
                    inputSchema: { properties: { messageId: { type: 'string' }, attachmentId: { type: 'string' } }, required: ['messageId', 'attachmentId'] },
                    outputSample: { data: '...' },
                },
            ],
        }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };

    it('a list upstream never switches "run once per item" on', () => {
        const { step, mappedKeys } = autoMapStep(definition.steps[1], definition, catalog);
        expect(mappedKeys).toEqual([]);
        expect(step.forEach).toBeUndefined();
        expect(step.repeat).toBeUndefined();
        const out = applyAutoMapToStep(definition, 's2', catalog);
        expect(out.definition).toBe(definition);
        expect(out).not.toHaveProperty('forEachEnabled');
    });

    it('a step the author set to run per item (legacy forEach) binds from its item: <entity>Id takes the item id', () => {
        const def = {
            ...definition,
            steps: [definition.steps[0], { ...definition.steps[1], forEach: { overRef: 'steps.s1.output.results', itemVar: 'mail', maxIterations: 5 } }],
        };
        const { step, mappedKeys } = autoMapStep(def.steps[1], def, catalog);
        expect(step.inputs.messageId).toEqual({ kind: 'ref', path: 'loop.mail.id' });
        // No attachment id exists in the search element → left empty for the user.
        expect(step.inputs.attachmentId).toBeUndefined();
        expect(mappedKeys).toEqual(['messageId']);
        expect(step.forEach).toEqual({ overRef: 'steps.s1.output.results', itemVar: 'mail', maxIterations: 5 });
    });

    it('a step set to repeat binds an each pick of its item', () => {
        const over = { root: 'steps', id: 's1', path: ['results'] };
        const def = { ...definition, steps: [definition.steps[0], { ...definition.steps[1], repeat: { over, max: 100 } }] };
        const { step } = autoMapStep(def.steps[1], def, catalog);
        expect(step.inputs.messageId).toEqual({ kind: 'pick', v: 1, from: { ...over, path: ['results', 'id'] }, take: 'each', as: 'native' });
        expect(step.repeat).toEqual({ over, max: 100 });
    });

    it('does not read the item when a scalar upstream already has the name', () => {
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 's1', type: 'integration_action', tool: 'get_one', inputs: {} },
                { id: 's2', type: 'integration_action', tool: 'reader', inputs: {} },
            ],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
        };
        const cat = {
            apps: [{
                actions: [
                    // top-level scalar messageId + an unrelated array
                    { name: 'get_one', outputSample: { messageId: 'm1', results: [{ id: 'x' }] } },
                    { name: 'reader', inputSchema: { properties: { messageId: { type: 'string' } }, required: ['messageId'] } },
                ],
            }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        };
        const { step } = autoMapStep(def.steps[1], def, cat);
        expect(step.forEach).toBeUndefined();
        expect(step.inputs.messageId).toEqual({ kind: 'ref', path: 'steps.s1.output.messageId' });
    });
});

/**
 * Regression (confirmed bug): manual auto-map after a forEach step picked an
 * OLDER list two steps back, or mapped nothing. Flow: list files → read each
 * file (forEach) → a step that needs `content`. The read step's entries are
 * the list now (its `results`), and its own output fields are reached under
 * `output.` of the current entry.
 */
describe('regression: auto-map after a step that ran once per item', () => {
    const base = (third, listItems = [{ path: '/a.pdf', name: 'a.pdf' }]) => ({
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'list', type: 'integration_action', tool: 'files_list', inputs: {} },
                {
                    id: 'read', type: 'integration_action', tool: 'files_read',
                    inputs: { path: { kind: 'ref', path: 'loop.file.path' } },
                    forEach: { overRef: 'steps.list.output.files', itemVar: 'file', maxIterations: 100 },
                },
                { id: 'w', ...third },
            ],
            edges: [{ from: 'trg', to: 'list' }, { from: 'list', to: 'read' }, { from: 'read', to: 'w' }],
        },
        catalog: {
            apps: [{
                actions: [
                    { name: 'files_list', outputSample: { files: listItems } },
                    { name: 'files_read', inputSchema: { properties: { path: { type: 'string' } }, required: ['path'] }, outputSample: { path: '/a.pdf', content: 'text' } },
                    { name: 'notes_write', inputSchema: { properties: { content: { type: 'string' } }, required: ['content'] } },
                ],
            }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        },
    });

    it('never fans out over the older list, even when its items share the name', () => {
        const { definition, catalog } = base({ type: 'integration_action', tool: 'notes_write', inputs: {} }, [{ path: '/a.pdf', content: 'preview' }]);
        const { step, mappedKeys } = autoMapStep(definition.steps[2], definition, catalog);
        expect(step.forEach).toBeUndefined();
        expect(JSON.stringify(step.inputs || {})).not.toContain('steps.list');
        expect(mappedKeys).toEqual([]);
    });

    it('with "run once per item" over the read step\'s entries, content comes from that entry\'s output', () => {
        const { definition, catalog } = base({
            type: 'integration_action', tool: 'notes_write', inputs: {},
            forEach: { overRef: 'steps.read.output.results', itemVar: 'r', maxIterations: 100 },
        });
        const { step } = autoMapStep(definition.steps[2], definition, catalog);
        expect(step.inputs.content).toEqual({ kind: 'ref', path: 'loop.r.output.content' });
    });

    it('the same with a repeat: an each pick of the entry\'s output', () => {
        const over = { root: 'steps', id: 'read', path: ['results'] };
        const { definition, catalog } = base({ type: 'integration_action', tool: 'notes_write', inputs: {}, repeat: { over, max: 100 } });
        const { step } = autoMapStep(definition.steps[2], definition, catalog);
        expect(step.inputs.content).toEqual({ kind: 'pick', v: 1, from: { ...over, path: ['results', 'output', 'content'] }, take: 'each', as: 'native' });
    });

    it('a loop or list op below it takes the read step\'s entries, not the older list', () => {
        const { definition, catalog } = base({ type: 'loop', overRef: '', itemVar: 'item', body: [] });
        const { step } = autoMapStep(definition.steps[2], definition, catalog);
        expect(step.overRef).toBe('steps.read.output.results');
    });

    // The read step set to repeat (the way the step's Advanced section writes
    // it) hands on the same envelope as a legacy forEach: its entries, never
    // its flat tool output.
    const withRepeatedRead = (third, listItems) => {
        const { definition, catalog } = base(third, listItems);
        const read = { ...definition.steps[1], inputs: {}, repeat: { over: { root: 'steps', id: 'list', path: ['files'] }, max: 100 } };
        delete read.forEach;
        return { definition: { ...definition, steps: [definition.steps[0], read, definition.steps[2]] }, catalog };
    };

    it('regression: after a repeating step, auto-map does not bind its flat output', () => {
        const { definition, catalog } = withRepeatedRead({ type: 'integration_action', tool: 'notes_write', inputs: {} });
        const { step, mappedKeys } = autoMapStep(definition.steps[2], definition, catalog);
        expect(JSON.stringify(step.inputs || {})).not.toContain('steps.read.output.content');
        expect(mappedKeys).toEqual([]);
    });

    it('regression: a loop below a repeating step takes its entries, not the older list', () => {
        const { definition, catalog } = withRepeatedRead({ type: 'loop', overRef: '', itemVar: 'item', body: [] }, [{ path: '/a.pdf', content: 'x' }]);
        const { step } = autoMapStep(definition.steps[2], definition, catalog);
        expect(step.overRef).toBe('steps.read.output.results');
    });

    it('regression: a repeat over a repeating step\'s entries reads the entry\'s output', () => {
        const over = { root: 'steps', id: 'read', path: ['results'] };
        const { definition, catalog } = withRepeatedRead({ type: 'integration_action', tool: 'notes_write', inputs: {}, repeat: { over, max: 100 } });
        const { step } = autoMapStep(definition.steps[2], definition, catalog);
        expect(step.inputs.content).toEqual({ kind: 'pick', v: 1, from: { ...over, path: ['results', 'output', 'content'] }, take: 'each', as: 'native' });
    });
});

describe('the shared matching cases (shared/mapping/matchCases.mjs, also run by the server\'s AI auto-bind)', () => {
    for (const c of MATCH_CASES) {
        it(c.name, () => {
            const properties = Object.fromEntries(Object.entries(c.inputs).map(([k, v]) => [k, { type: v.type }]));
            const target = { name: 'target', inputSchema: { properties, required: Object.keys(c.inputs) } };
            const steps = c.fanout
                ? [
                    { id: 'src', type: 'integration_action', tool: 'lister', inputs: {} },
                    { id: 'up', type: 'integration_action', tool: 'reader', inputs: {}, forEach: { overRef: 'steps.src.output.rows', itemVar: 'x' } },
                    { id: 't', type: 'integration_action', tool: 'target', inputs: {}, forEach: { overRef: 'steps.up.output.results', itemVar: 'row' } },
                ]
                : [
                    { id: 'up', type: 'integration_action', tool: 'lister', inputs: {} },
                    { id: 't', type: 'integration_action', tool: 'target', inputs: {}, forEach: { overRef: 'steps.up.output.rows', itemVar: 'row' } },
                ];
            const definition = {
                trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
                steps,
                edges: steps.map((s, i) => ({ from: i ? steps[i - 1].id : 'trg', to: s.id })),
            };
            const catalog = {
                apps: [{ actions: [
                    { name: 'lister', outputSample: { rows: c.fanout ? [{ n: 1 }] : [c.item] } },
                    { name: 'reader', outputSample: c.item },
                    target,
                ] }],
                triggerOutputs: { __manual: { fields: [], sample: {} } },
            };
            const { step } = autoMapStep(steps[steps.length - 1], definition, catalog);
            for (const [key, path] of Object.entries(c.expect)) {
                if (path === null) expect(step.inputs?.[key]).toBeUndefined();
                else expect(step.inputs[key]).toEqual({ kind: 'ref', path: `loop.row.${path}` });
            }
        });
    }
});

describe('regression: [*] element children never auto-map into scalar params', () => {
    // A collection group (e.g. Filter) exposes the element fields as
    // items[*].<key> children whose SAMPLE is a scalar — but at runtime the
    // [*] flatten resolves to an ARRAY. Auto-mapping one into a scalar
    // string input would silently bind an array. They must be skipped even
    // on an exact name + type match.
    const collectionGroups = [
        {
            id: 'B', label: 'Filter', kind: 'collection', basePath: 'steps.B.output',
            fields: [
                {
                    key: 'items', path: 'steps.B.output.items', sample: [{ email: 'a@b.c' }],
                    children: [{ key: 'email', path: 'steps.B.output.items[*].email', sample: 'a@b.c' }],
                },
                { key: 'count', path: 'steps.B.output.count', sample: 0 },
            ],
        },
    ];

    it('leaves a scalar string param named after a [*] child unmapped', () => {
        const schema = { properties: { email: { type: 'string' } }, required: ['email'] };
        const patch = autoMapInputs(schema, {}, collectionGroups);
        expect(patch.email).toBeUndefined();
        expect(patch).toEqual({});
    });

    it('still maps a non-wildcard field from the same group', () => {
        const schema = { properties: { email: { type: 'string' }, count: { type: 'number' } } };
        const patch = autoMapInputs(schema, {}, collectionGroups);
        expect(patch.email).toBeUndefined();
        expect(patch.count).toEqual({ kind: 'ref', path: 'steps.B.output.count' });
    });
});

/**
 * The run/pinned-data gap: a step that just produced 10 real records upstream
 * of a freshly added node used to auto-map as if it produced nothing, because
 * the catalog had no outputSample for its tool. With opts.realOutputById the
 * real output IS the sample.
 */
describe('auto-map with real run/pinned data', () => {
    // Tool unknown to the catalog — the design-time group is empty.
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 's1', type: 'integration_action', tool: 'mystery_tool', inputs: {} },
            { id: 'f1', type: 'filter', arrayRef: '' },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'f1' }],
    };
    const catalog = { apps: [], triggerOutputs: {} };
    const realOutputById = new Map([['s1', { results: [{ id: 7, subject: 'hi' }] }]]);

    it('without real data the source stays unbound (the old failure)', () => {
        const { mappedKeys } = autoMapStep(definition.steps[1], definition, catalog);
        expect(mappedKeys).toEqual([]);
    });

    it('a collection op binds its arrayRef from the real output', () => {
        const { step, mappedKeys } = autoMapStep(definition.steps[1], definition, catalog, { realOutputById });
        expect(mappedKeys).toEqual(['arrayRef']);
        expect(step.arrayRef).toBe('steps.s1.output.results');
    });

    it('a pristine condition flips to list-mode filter on real rows', () => {
        const def = {
            ...definition,
            steps: [definition.steps[0], { id: 'c1', type: 'condition', expr: '' }],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'c1' }],
        };
        const { step } = autoMapStep(def.steps[1], def, catalog, { realOutputById });
        expect(step.type).toBe('filter');
        expect(step.arrayRef).toBe('steps.s1.output.results');
    });

    it('a step set to run per item reads its element shape from real rows', () => {
        const def = {
            ...definition,
            steps: [
                definition.steps[0],
                { id: 'act', type: 'integration_action', tool: 'read_message', inputs: {}, forEach: { overRef: 'steps.s1.output.results', itemVar: 'result' } },
            ],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'act' }],
        };
        const cat = {
            apps: [{ actions: [{ name: 'read_message', inputSchema: { properties: { messageId: { type: 'number' } }, required: ['messageId'] } }] }],
            triggerOutputs: {},
        };
        const { step } = autoMapStep(def.steps[1], def, cat, { realOutputById });
        expect(step.inputs.messageId).toEqual({ kind: 'ref', path: 'loop.result.id' });
    });

    it('applyAutoMapToStep forwards realOutputById through opts', () => {
        const out = applyAutoMapToStep(definition, 'f1', catalog, { realOutputById });
        expect(out.mappedKeys).toEqual(['arrayRef']);
        expect(out.definition.steps.find(s => s.id === 'f1').arrayRef).toBe('steps.s1.output.results');
    });
});

describe('guard — the source is bound on arrival, not asked for', () => {
    // A guard dropped below a step means "check what that step just produced".
    // Leaving it unbound is how you get a node that greets you with a warning,
    // and — before the validator was softened — one the definition could not
    // even save, so Execute failed with "step not found in definition".
    const guard = (over = {}) => ({ id: 'g1', type: 'guard', ...over });
    const mkDef = (g, upstream) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [upstream, g],
        edges: [{ from: 'trg', to: upstream.id }, { from: upstream.id, to: g.id }],
    });
    const catalogWith = (outputSample) => ({
        apps: [{ actions: [{ name: 'gmail_read', outputSample }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    });
    const reader = { id: 's1', type: 'integration_action', tool: 'gmail_read', inputs: {} };

    it('prefers a field that holds the text a person wrote', () => {
        const g = guard();
        const catalog = catalogWith({ id: 'm1', subject: 'Hi', body: 'Dear Jan, …' });
        const { step, mappedKeys } = autoMapStep(g, mkDef(g, reader), catalog);
        expect(step.sourceRef).toBe('steps.s1.output.body');
        expect(mappedKeys).toEqual(['sourceRef']);
    });

    it('falls back to any upstream text', () => {
        const g = guard();
        const catalog = catalogWith({ id: 'm1', headline: 'Quarterly figures' });
        expect(autoMapStep(g, mkDef(g, reader), catalog).step.sourceRef).toBe('steps.s1.output.id');
    });

    it('falls back to the whole nearest output when nothing is a string', () => {
        // An object is scanned as its JSON, so "everything that step produced"
        // is a real answer rather than a guess.
        const g = guard();
        const catalog = catalogWith({ total: 4, unread: true });
        expect(autoMapStep(g, mkDef(g, reader), catalog).step.sourceRef).toBe('steps.s1.output');
    });

    it('never overrides a source the author already chose', () => {
        const g = guard({ sourceRef: 'trigger.output.text' });
        const catalog = catalogWith({ body: 'Dear Jan, …' });
        const { step, mappedKeys } = autoMapStep(g, mkDef(g, reader), catalog);
        expect(step.sourceRef).toBe('trigger.output.text');
        expect(mappedKeys).toEqual([]);
    });
});

describe('the restore step binds itself to what was hidden', () => {
    // The pairing that matters: drop "Show real values again" after "Hide
    // personal data" and it should already point at that step's output.text.
    it('auto-binds to the tokenize step above it', () => {
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'tok', type: 'tokenize', sourceRef: 'trigger.output.body' },
                { id: 'un', type: 'untokenize' },
            ],
            edges: [{ from: 'trg', to: 'tok' }, { from: 'tok', to: 'un' }],
        };
        const catalog = { apps: [], triggerOutputs: { __manual: { fields: [], sample: {} } } };
        const { step, mappedKeys } = autoMapStep({ id: 'un', type: 'untokenize' }, def, catalog);
        expect(step.sourceRef).toBe('steps.tok.output.text');
        expect(mappedKeys).toEqual(['sourceRef']);
    });
});
