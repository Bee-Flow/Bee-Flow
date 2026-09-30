/**
 * DIFFERENTIAL lockstep: agent-hub `Builder/flow/settings/formState.js` and the
 * per-family port extract the same drafts and build the same patches — over
 * a step of every type, and over every draft key set to a spread of values.
 * When this fails the web side changed — update the port, don't loosen the
 * test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as fs from './index';
import { chainDefinition } from '../bindings/testing/fixture';
import { BUILDER, requireWeb, webPath, webValue } from '../bindings/testing/web';
import type { FlowNode } from '../bindings/types';

const web = requireWeb(`${BUILDER}/flow/settings/formState.js`);

// templates.js is run from its source, not require()d. Its organisation
// template readers lazily require the automation and user stores, and a
// require() puts those stores and the ~1,300 server files behind them in the
// closure that serverClosure.test.ts holds ci.yml's mobile filter to. The two
// built-in readers used here need deliverableEvents.js and nothing else; any
// other require throws, so a new dependency of theirs fails here, loudly.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- server CommonJS, loaded as-is
const deliverableEvents: unknown = require('../../../../../server/automation/deliverableEvents.js');
const templates = (() => {
    const mod: { exports: unknown } = { exports: {} };
    const serverRequire = (spec: string): unknown => {
        if (spec === './deliverableEvents') return deliverableEvents;
        throw new Error(`templates.js now requires ${spec}: load it above and add it to ci.yml's mobile filter`);
    };
    const source = readFileSync(path.join(__dirname, '../../../../../server/automation/templates.js'), 'utf8');
    new Function('module', 'exports', 'require', source)(mod, mod.exports, serverRequire);
    return mod.exports as {
        listTemplates: () => { id: string }[];
        getTemplate: (id: string) => { definition?: { steps?: FlowNode[]; trigger?: FlowNode } };
    };
})();

const seat = (userId: string) => ({ userId });
const CRAFTED = [
    { id: 't1', type: 'trigger', kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'UTC', extra: 1 }, label: 'Schedule' },
    { id: 't2', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { from: 'a', to: '' } } },
    { id: 't3', type: 'trigger', kind: 'agent_call', toolName: 'do_it', description: 'Does it', parametersSchema: { type: 'object', properties: { q: { type: 'string', description: 'Q' } }, required: ['q'] } },
    { id: 't4', type: 'trigger', kind: 'form', form: { title: 'F', fields: [{ name: 'a' }] } },
    { id: 't5', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'number', required: true, description: 'X' }, { type: 'string' }] },
    { id: 't6', type: 'trigger' },
    { id: 'ai', type: 'ai_step', prompt: 'p', systemPrompt: ' sys ', modelTier: 'deep', allowTools: true, tools: ['a'], inputs: { q: { kind: 'literal', value: 'x' }, e: { kind: 'literal', value: '' } }, outputSchema: { type: 'object', properties: { a: { type: 'string', description: 'A' }, when: { type: 'string', format: 'date-time' }, rows: { type: 'array', items: { type: 'object', properties: { c1: { type: 'number' }, c2: { type: 'string', format: 'date' } } } }, tags: { type: 'array', items: { type: 'string' } }, obj: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'] } }, required: ['a'] }, knowledgeBaseIds: ['kb1', 5], agentId: ' ag ', skillIds: ['s1', 's1', 's2', 3], agentPermissions: { useTools: true, extra: true }, forEach: { overRef: 'x' }, retry: { max: 2, backoffMs: 500 } },
    { id: 'ai2', type: 'ai_step', outputSchema: { a: 'number', b: 'weird', c: { type: 'object' } }, retry: { max: 0 } },
    { id: 'ia', type: 'integration_action', tool: 'gmail_send', appId: 'gmail', sideEffect: true, inputs: { to: { kind: 'ref', path: 'x' } }, askOnce: { acrossRuns: true, ttlSeconds: 60.4 } },
    { id: 'ia2', type: 'integration_action', askOnce: {}, retry: 'x' },
    { id: 'cond', type: 'condition', expr: 'a > 1' },
    { id: 'sw', type: 'switch', expr: 'item.k', arrayRef: 'steps.x.output.items', cases: [{ name: 'a', value: 'A' }, { name: 'b', value: 'B' }], defaultBranch: 'a', routeStyle: 'value', maxItems: 5 },
    { id: 'flt', type: 'filter', arrayRef: 'x', expr: 'item.ok' },
    { id: 'g', type: 'guard', sourceRef: 'x', onFound: { stop: true, tokenize: true }, categories: ['Person'], confidence: 0.5 },
    { id: 'tk', type: 'tokenize' },
    { id: 'lp', type: 'loop', overRef: 'x', itemVar: '', maxIterations: 5000, batchSize: 0, body: [{ id: 'b', type: 'set' }] },
    { id: 'code', type: 'code', code: 'return 1', inputs: { a: { kind: 'expr', value: '' } } },
    { id: 'nt', type: 'notification', title: 'T', body: 'B', channels: ['email'] },
    { id: 'http', type: 'http_request', url: 'https://x', method: 'post', headers: { a: '1' }, body: '{}', timeoutMs: 999999, blockPrivateTargets: false, parseResponse: 'always', auth: { connectionId: 'c1', secret: 'no' }, askOnce: true, cacheInto: { datatableId: ' dt ', maxAgeDays: 2.6 } },
    { id: 'http2', type: 'http_request', cacheInto: { datatableId: '' }, auth: {} },
    { id: 'gd', type: 'generate_document', content: 'c', contentFormat: 'html', format: 'docx', title: 't', fileName: 'f', expiresInDays: '120' },
    { id: 'sl', type: 'slide', title: 'S', chart: { type: 'bar', data: [1, 2], labels: 'a,b', values: '1,2', stacked: true, unit: '%' }, stats: [{ v: 1 }, 's'], image: 'img', layout: 'timeline', style: 'dark' },
    { id: 'sl2', type: 'slide', chart: 'pie', stats: 'x', notes: 'n', style: 'other' },
    { id: 'sl3', type: 'slide', image: 'i', layout: 'auto' },
    { id: 'pr', type: 'presentation', slides: ['a', { title: 'x' }], title: 'P', format: 'pdf', houseStyle: false, preset: 'p', accent: '#f00', slideNumbers: false, template: 'none', saveCopy: true, copyName: 'c', expiresInDays: 0 },
    { id: 'pr2', type: 'presentation', slides: 'steps.a.output', slideNumbers: true },
    { id: 'fd', type: 'fill_document', documentId: 'd', documentVersionId: 'v', sectionOverrides: { a: 1 }, documentName: 'n', values: { a: ' x ', b: '', c: null, d: 3 }, format: 'pptx', saveCopy: true, copyName: 'c', expiresInDays: 30 },
    { id: 'de', type: 'data_extraction', source: { kind: 'ref', path: 'x' }, fields: [{ name: 'Invoice Date', type: 'date', description: ' d ', required: true }, { name: 'total', type: 'money' }, { name: 'total' }, { name: '' }, null], instructions: 'i', forEach: { overRef: 'y', maxIterations: 0 } },
    { id: 'de2', type: 'data_extraction', source: { kind: 'literal', value: ' ' } },
    { id: 'cl', type: 'call_layer', inputs: { a: { kind: 'ref', path: '' } } },
    { id: 'cb', type: 'call_block' },
    { id: 'lo', type: 'layer_output', fields: { a: 1, ' ': 2, b: null, c: { kind: 'ref', path: 'x' } } },
    { id: 'set', type: 'set', fields: { a: 'x' }, forEach: { overRef: 'l' } },
    { id: 'setList', type: 'set', arrayRef: '', maxItems: 3, operations: [{ op: 'rowId', target: ' n ', start: '' }, { op: 'rowId', start: 5 }, { op: 'groupId', keys: [' a ', ''] }, { op: 'rename', from: 'a', to: 'b' }, { op: 'keep', keys: 'x' }, { op: 'remove' }, { op: 'sort', key: 'k', direction: 'desc' }, { op: 'bogus' }, [], null] },
    { id: 'pj', type: 'parse_json', sourceRef: 's', itemsRef: 'i', mode: 'ai', fields: [{ name: ' a ', path: 'p', description: 'd', fallback: 0 }, { name: '' }, { name: 'b', path: 5 }] },
    { id: 'dt', type: 'datetime', op: 'add', input: 'x', amount: 3, format: 'f', part: 'p', unit: 'u', arrayRef: 's', target: 't' },
    { id: 'dt2', type: 'datetime' },
    { id: 'wait', type: 'wait', seconds: 0 },
    { id: 'ap', type: 'approval', prompt: 'ok?', approval: { expiresInHours: 0, assignee: { groupId: ' g ' }, details: 'd', attachments: [{ binding: 'x', label: 'L' }, { binding: ' ' }], fields: [{ name: 'q' }, {}], remindAfterHours: 3, escalateTo: { userId: 'u9' }, escalateAfterHours: 800, approvers: [seat('u1'), seat('u1'), { groupId: 'g' }, {}], rule: 'quorum', quorum: 9, finalApprover: seat('boss') } },
    { id: 'ap2', type: 'approval', expiresInHours: 12, approval: { stages: [{ key: 's1', approvers: [seat('a'), seat('a'), {}], rule: 'quorum', quorum: 5, name: ' Legal ', description: 'd', when: 'x > 1' }, { key: 's1', approvers: [seat('b')], rule: 'odd' }, { approvers: [] }, { approvers: [{ groupId: 'g' }], rule: 'first' }] } },
    { id: 'ap3', type: 'approval' },
    { id: 'stop', type: 'stop_error', message: 'm' },
    { id: 'rta', type: 'return_to_app', navigateTo: { screenId: 's', recordRef: 'r' }, toast: { message: 'hi', tone: 'success' }, refresh: 'all', onError: 'errorScreen' },
    { id: 'rta2', type: 'return_to_app' },
    { id: 'fp', type: 'form_page', mode: 'ending', form: { theme: null }, waitSeconds: 10 },
    { id: 'fp2', type: 'form_page', waitSeconds: 5 },
    { id: 'lim', type: 'limit', arrayRef: 'x', count: 3.7, mode: 'last', maxItems: 2 },
    { id: 'dd', type: 'dedupe', arrayRef: 'x', keyField: ' k ' },
    { id: 'ag', type: 'aggregate', field: 'f' },
    { id: 'sm', type: 'summarize', op: 'avg', maxItems: 0 },
    { id: 'dtab', type: 'datatable', datatableId: 'd', op: 'insert', where: [{ field: 'a', op: 'eq', value: 1 }, { value: 2 }], values: { a: 1, b: '', c: null }, matchColumn: 'a', limit: 5, forEach: { overRef: 'x' } },
    { id: 'kw', type: 'knowledge_write', knowledgeBaseId: 'kb', title: 't', content: 'c', sourceUri: 's', nearDuplicateStrategy: 'replace' },
    { id: 'note', type: 'note', label: 'N', icon: 'x' },
] as unknown as FlowNode[];

function corpus(): FlowNode[] {
    const out = [...CRAFTED, ...(chainDefinition().steps || [])];
    for (const { id } of templates.listTemplates()) {
        const def = templates.getTemplate(id).definition;
        if (def?.trigger) out.push({ ...def.trigger, type: 'trigger' });
        out.push(...(def?.steps || []));
    }
    return out;
}

const STEPS = corpus();
const FUZZ: unknown[] = ['', 'x', ' x ', null, undefined, 0, 7, true, false, [], ['a'], {}, { overRef: 'o' }];

/** Run the web function; undefined when IT throws (a shape it cannot read). */
function webOrSkip<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
    try {
        return { ok: true, value: fn() };
    } catch {
        return { ok: false };
    }
}

describe('extractFormState / buildPatch', () => {
    it.each(STEPS.map((s, i) => [`${i}:${s.id}:${s.type}`, s]))('%s', (_label, step) => {
        const draft = fs.extractFormState(step);
        expect(draft).toStrictEqual(web.extractFormState?.(step));
        expect(fs.buildPatch(step, draft)).toStrictEqual(web.buildPatch?.(step, draft));
        let compared = 0;
        for (const key of [...Object.keys(draft), 'label', 'icon', 'forEach', 'retry', 'askOnce']) {
            for (const value of FUZZ) {
                const next = { ...draft, [key]: value };
                const theirs = webOrSkip(() => web.buildPatch?.(step, next));
                if (!theirs.ok) continue;
                expect({ key, value, patch: fs.buildPatch(step, next) }).toStrictEqual({ key, value, patch: theirs.value });
                compared += 1;
            }
        }
        expect(compared).toBeGreaterThan(0);
    });

    it('extracts nothing from nothing', () => {
        expect(fs.extractFormState(null)).toStrictEqual(web.extractFormState?.(null));
    });

    it('covers every type the web edits, and the corpus exercises every one', () => {
        const src = readFileSync(webPath(`${BUILDER}/flow/settings/formState.js`), 'utf8');
        const branched = new Set([...src.matchAll(/step\.type === '([a-z_]+)'/g)].map((m) => m[1] as string));
        const unified = ['condition', 'switch', 'filter', 'guard', 'tokenize', 'untokenize'];
        expect([...fs.FORM_STEP_TYPES].sort()).toStrictEqual([...branched, ...unified].sort());
        const seen = new Set(STEPS.map((s) => s.type));
        for (const type of fs.FORM_STEP_TYPES) expect(seen.has(type)).toBe(true);
    });
});

describe('the exported helpers', () => {
    it('constants', () => {
        for (const name of ['MAX_APPROVAL_STAGES', 'MAX_SEATS_PER_STAGE', 'MAX_TOTAL_STAGE_SEATS', 'MAX_STAGE_NAME_LEN', 'MAX_STAGE_DESCRIPTION_LEN',
            'STAGE_RULES', 'EXTRACTION_FIELD_TYPES', 'MAX_EXTRACTION_FIELDS', 'MAX_EXTRACTION_INSTRUCTIONS', 'AI_STEP_AGENT_PERMISSION_KEYS',
            'MAX_AI_STEP_SKILL_IDS', 'OUTPUT_FIELD_TYPES', 'COLUMN_TYPES']) {
            expect((fs as Record<string, unknown>)[name]).toStrictEqual(webValue(web, name));
        }
        for (const name of ['FOREACH_FORM_TYPES', 'RETRY_FORM_TYPES', 'ASK_ONCE_FORM_TYPES']) {
            expect([...((fs as Record<string, unknown>)[name] as Set<string>)]).toStrictEqual([...webValue<Set<string>>(web, name)]);
        }
        expect(String(fs.EXTRACTION_NAME_RE)).toBe(String(webValue(web, 'EXTRACTION_NAME_RE')));
    });

    it('values, retries and toggles', () => {
        const bindings = [null, { value: 'v' }, { path: 'p' }, { value: 3 }, {}, 'bare'];
        for (const b of bindings) {
            for (const [from, to] of [['literal', 'ref'], ['ref', 'literal'], ['expr', 'template'], ['ref', 'expr'], ['a', 'a'], ['a', 'weird']]) {
                expect(fs.convertValue(b, from, to)).toStrictEqual(web.convertValue?.(b, from, to));
            }
        }
        for (const v of [null, true, false, 'x', [], {}, { max: 0 }, { max: 2.4, backoffMs: -1 }, { max: 'a' }, { acrossRuns: true }, { ttlSeconds: '9' }, { datatableId: 'd', maxAgeDays: 'x' }, { datatableId: 5 }]) {
            expect(fs.normalizeRetry(v)).toStrictEqual(web.normalizeRetry?.(v));
            expect(fs.normalizeAskOnce(v)).toStrictEqual(web.normalizeAskOnce?.(v));
            expect(fs.normalizeCacheInto(v)).toStrictEqual(web.normalizeCacheInto?.(v));
        }
        for (const step of [{ type: 'integration_action', tool: 'x' }, { type: 'integration_action' }, { type: 'trigger', kind: 'form' }, { type: 'trigger' }, { type: 'set' }]) {
            expect(fs.defaultLabelPlaceholder(step)).toBe(web.defaultLabelPlaceholder?.(step));
        }
    });

    it('approval chains and seats', () => {
        const stages = (CRAFTED.find((s) => s.id === 'ap2')?.approval as { stages: unknown[] }).stages;
        const many = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, approvers: Array.from({ length: 9 }, (__, j) => seat(`u${i}_${j}`)) }));
        for (const chain of [stages, many, null, 'x', [null, []]]) {
            expect(fs.sanitizeApprovalStages(chain)).toStrictEqual(web.sanitizeApprovalStages?.(chain));
            expect(fs.totalStageSeats(chain)).toBe(web.totalStageSeats?.(chain));
            expect(fs.newStageKey(chain)).toBe(web.newStageKey?.(chain));
        }
        const full = Array.from({ length: 99 }, (_, i) => ({ key: `s${i + 1}` }));
        expect(fs.newStageKey(full)).toMatch(/^s[0-9a-z]+$/);
        for (const s of [null, [], {}, { userId: ' u ' }, { groupId: 'g' }, { userId: ' ', groupId: ' ' }]) {
            expect(fs.cleanApprovalSeat(s)).toStrictEqual(web.cleanApprovalSeat?.(s));
        }
        expect(fs.stageSeats({ approvers: Array.from({ length: 12 }, (_, i) => seat(`u${i}`)) })).toStrictEqual(
            web.stageSeats?.({ approvers: Array.from({ length: 12 }, (_, i) => seat(`u${i}`)) }),
        );
        expect(fs.approvalSeatKey({ groupId: 'g' })).toBe(web.approvalSeatKey?.({ groupId: 'g' }));
    });

    it('carryPendingRows', () => {
        const prev = {
            attachments: [{ binding: 'x' }, { binding: ' ' }, {}],
            approvalFields: [{ name: 'a' }, {}],
            approvers: [seat('u'), {}],
            stages: [{ key: 's1', approvers: [seat('a'), {}] }, { key: 's2', approvers: [] }, { name: 'draft' }, 'junk'],
        };
        const incomings = [{}, { attachments: [{ binding: 'x' }], stages: [{ key: 's1', approvers: [seat('a')] }, { key: 's9' }, null] }, { stages: 'x' }];
        for (const incoming of incomings) {
            expect(fs.carryPendingRows(incoming, prev)).toStrictEqual(web.carryPendingRows?.(incoming, prev));
            expect(fs.carryPendingRows(incoming, null)).toStrictEqual(web.carryPendingRows?.(incoming, null));
            expect(fs.carryPendingRows(incoming, { stages: [] })).toStrictEqual(web.carryPendingRows?.(incoming, { stages: [] }));
            expect(fs.carryPendingRows(incoming, { stages: [{ key: 's1', approvers: [seat('a')] }] })).toStrictEqual(
                web.carryPendingRows?.(incoming, { stages: [{ key: 's1', approvers: [seat('a')] }] }),
            );
        }
    });

    it('extraction, operations, outputs and agents', () => {
        for (const raw of ['Invoice Date', '€ totaal', '9lives', '', null, 'a-b c', 'X'.repeat(50)]) {
            expect(fs.coerceExtractionName(raw)).toBe(web.coerceExtractionName?.(raw));
        }
        for (const b of [null, 'x', { kind: 'ref', path: ' ' }, { kind: 'literal', value: 0 }, { kind: 'expr', value: 'x' }, { kind: 'odd' }]) {
            expect(fs.isEmptyExtractionSource(b)).toBe(web.isEmptyExtractionSource?.(b));
        }
        const rows = [{ name: 'a' }, { name: 'a', type: 'number' }, null, { name: 'Bad Name', description: ' ' }, ...Array.from({ length: 35 }, (_, i) => ({ name: `f${i}` }))];
        for (const r of [rows, [], null]) {
            expect(fs.readExtractionFields(r)).toStrictEqual(web.readExtractionFields?.(r));
            expect(fs.sanitizeExtractionFields(r)).toStrictEqual(web.sanitizeExtractionFields?.(r));
            expect(fs.sanitizeOperations(r)).toStrictEqual(web.sanitizeOperations?.(r));
            expect(fs.sanitizeParseJsonFields(r)).toStrictEqual(web.sanitizeParseJsonFields?.(r));
        }
        expect(fs.emptyExtractionField()).toStrictEqual(web.emptyExtractionField?.());
        const schemas = [null, 'x', { a: 'string', b: { type: 'array', items: { type: 'object', properties: { '': {}, c: null } } } }, { properties: { x: { type: 'object' } } }];
        for (const s of schemas) {
            const fields = fs.schemaToFields(s);
            expect(fields).toStrictEqual(web.schemaToFields?.(s));
            expect(fs.fieldsToSchema(fields)).toStrictEqual(web.fieldsToSchema?.(fields));
        }
        const cols = [{ key: 'a', type: 'array', columns: [{ key: ' ' }, null, { key: 'c', type: 'datetime' }] }, { key: 'b', type: 'array', columns: [] }, { key: ' ' }, null];
        expect(fs.fieldsToSchema(cols)).toStrictEqual(web.fieldsToSchema?.(cols));
        expect(fs.fieldsToSchema(null)).toStrictEqual(web.fieldsToSchema?.(null));
        for (const p of [null, [], { useTools: true, startAutomations: 'yes' }]) expect(fs.readAgentPermissions(p)).toStrictEqual(web.readAgentPermissions?.(p));
        for (const s of [null, 'x', ['a', 'a', '', 1, 'b']]) expect(fs.readSkillIds(s)).toStrictEqual(web.readSkillIds?.(s));
        for (const [a, b] of [[{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }], [[1], { 0: 1 }], [{ a: 1 }, { a: 1, b: 2 }], [[1, 2], [1]], [null, undefined], [1, '1']]) {
            expect(fs.deepEqual(a, b)).toBe(web.deepEqual?.(a, b));
        }
    });
});
