/**
 * TEXTUAL + evaluated lockstep for agent-hub `Builder/mapping/ToolInputForm.jsx`
 * and the pieces it was split into (`mapping/toolInput/`).
 *
 * The components cannot be required here (they import React, lucide and the
 * web kit), so this test cuts their helper functions and state updaters out of
 * the SOURCE TEXT, evaluates them with stubs for React state, and runs them
 * beside the port; the pure helpers (toolInputHelpers.ts) are required as-is. When the web file changes shape the cut fails loudly; when its
 * behaviour changes the comparison does. Update the port, don't loosen this.
 */

import fs from 'node:fs';

import { buildSchemaFormModel, describeExample, isMultilineProp } from './model';
import * as rows from './rows';
import { BUILDER, requireWeb, webPath } from '../bindings/testing/web';
import type { JsonSchemaProp } from '../bindings/types';

const SRC = fs.readFileSync(webPath(`${BUILDER}/mapping/ToolInputForm.jsx`), 'utf8');
// One user-named row (the field-name input, its reserved names and path test).
const ROW_SRC = fs.readFileSync(webPath(`${BUILDER}/mapping/toolInput/GenericRow.tsx`), 'utf8');
const webHelpers = requireWeb('utils/bindingHelpers.js');
const webToolInput = requireWeb(`${BUILDER}/mapping/toolInput/toolInputHelpers.ts`);
const webPartition = requireWeb(`${BUILDER}/mapping/partitionInputs.js`);

/** The source of the block that starts at `head`, through its matching brace. */
function cut(head: string, src = SRC): string {
    const start = src.indexOf(head);
    if (start < 0) throw new Error(`${src === SRC ? 'ToolInputForm.jsx' : 'GenericRow.tsx'} no longer contains: ${head}`);
    const open = src.indexOf('{', start + head.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced block after ${head}`);
}

type Fn = (...args: unknown[]) => unknown;

/** Evaluate a cut-out declaration with the named values in scope, returning `name`. */
function evaluate(source: string, name: string, scope: Record<string, unknown> = {}): Fn {
    const factory = new Function(...Object.keys(scope), `${source}\nreturn ${name};`) as (...a: unknown[]) => Fn;
    return factory(...Object.values(scope));
}

const webDescribeExample = webToolInput.describeExample as Fn;
const webIsMultiline = webToolInput.isMultilineProp as Fn;
const RESERVED_LINE = /const RESERVED_FIELD_NAMES = (new Set\(\[[^\]]*\]\));/.exec(ROW_SRC)?.[1] as string;
// The row is TypeScript: the one annotation is dropped so the arrow evaluates as JS.
const PATH_LINE = `(s) => ${/const looksLikePath = \(s: string\) => ([^;]+);/.exec(ROW_SRC)?.[1] as string}`;

const PROPS: (JsonSchemaProp | null)[] = [
    null, {}, { example: 'ex' }, { example: 0 }, { default: 10 }, { enum: ['a', 'b'] }, { enum: ['a', 'b', 'c', 'd'] }, { enum: [] },
    { type: 'string' }, { type: 'number' }, { type: 'integer' }, { type: 'boolean' }, { type: 'array' }, { type: 'object' },
    { format: 'multiline' }, { format: 'textarea' }, { title: 'Message body' }, { title: 'Notes' }, { title: 'Name' },
];

describe('the helpers cut from the component', () => {
    it.each(PROPS.map((p) => [JSON.stringify(p), p]))('describeExample / isMultilineProp %s', (_l, prop) => {
        expect(describeExample(prop)).toBe(webDescribeExample(prop));
        expect(isMultilineProp(prop)).toBe(webIsMultiline(prop));
    });

    it('reserved names and the path test', () => {
        const reserved = new Function(`return ${RESERVED_LINE};`)() as Set<string>;
        expect([...rows.RESERVED_FIELD_NAMES]).toStrictEqual([...reserved]);
        const looks = new Function(`return ${PATH_LINE};`)() as (s: string) => boolean;
        for (const s of ['name', 'a.b', 'a b', 'x[0]', 'x]']) expect(rows.looksLikePath(s)).toBe(looks(s));
    });
});

/** Run the web FieldNameInput `commit` with its React state stubbed, and say what it did. */
function webCommit(raw: string, fieldKey: string, siblingKeys: string[], canAdopt: boolean): rows.NameCommit {
    const effects: { error?: unknown; renamed?: string; adopted?: [string, string]; text?: string } = {};
    const head = 'const commit = (raw?: string) =>';
    const commit = evaluate(`const commit = (raw) =>${cut(head, ROW_SRC).slice(head.length)};`, 'commit', {
        fieldKey, siblingKeys, text: fieldKey,
        setText: (v: string) => { effects.text = v; },
        setError: (e: unknown) => { effects.error = e; },
        onCommit: (n: string) => { effects.renamed = n; },
        onAdoptPath: canAdopt ? (p: string, s: string) => { effects.adopted = [p, s]; } : null,
        toKey: webHelpers.suggestKeyFromPath,
        looksLikePath: new Function(`return ${PATH_LINE};`)(),
        RESERVED_FIELD_NAMES: new Function(`return ${RESERVED_LINE};`)(),
    });
    commit(raw);
    if (effects.adopted) return { action: 'adopt', path: effects.adopted[0], suggested: effects.adopted[1] };
    if (effects.renamed) return { action: 'rename', name: effects.renamed };
    if (typeof effects.error === 'string' && effects.error.includes('reserved')) return { action: 'reserved', name: (/“(.+)”/.exec(effects.error) as RegExpExecArray)[1] as string };
    if (typeof effects.error === 'string' && effects.error.includes('already exists')) return { action: 'duplicate', name: (/“(.+)”/.exec(effects.error) as RegExpExecArray)[1] as string };
    if (effects.error) return { action: 'revert' };
    return { action: 'keep' };
}

describe('the field-name commit', () => {
    it.each([
        ['field', 'field'], ['  ', 'field'], ['subject', 'field'], ['taken', 'field'], ['__proto__', 'field'],
        ['steps.a.output.subject', 'field'], ['trigger.output.x', 'x'], ['my key', 'field'], ['a.constructor', 'field'],
        ['steps.a.output.taken', 'field'], ['foo.field', 'field'],
    ])('%p on %p', (raw, fieldKey) => {
        for (const canAdopt of [true, false]) {
            const siblings = ['taken', 'other'];
            const mine = rows.commitFieldName(raw, { fieldKey, siblingKeys: siblings, canAdopt });
            expect(mine).toStrictEqual(webCommit(raw, fieldKey, siblings, canAdopt));
            const message = rows.nameCommitMessage(mine);
            expect(message === null).toBe(mine.action === 'keep' || mine.action === 'rename' || mine.action === 'adopt');
        }
    });
});

describe('the state updaters cut from the component', () => {
    const INPUTS = { a: { kind: 'literal', value: 'x' }, b: { kind: 'ref', path: '' }, c: { kind: 'ref', path: 'steps.s.output' } };

    it('updateField / renameField / removeField', () => {
        for (const keepEmptyFields of [false, true]) {
            let out: unknown = null;
            const scope = { inputs: INPUTS, keepEmptyFields, autoMappedKeys: [], setConsumed: () => {}, onChange: (n: unknown) => { out = n; }, isEmptyBinding: webPartition.isEmptyBinding };
            const update = evaluate(`const updateField = ${cut('const updateField = (key, binding) =>').slice('const updateField = '.length)};`, 'updateField', scope);
            for (const binding of [null, { kind: 'literal', value: '' }, { kind: 'expr', value: 'x' }]) {
                update('a', binding);
                expect(rows.updateInput(INPUTS, 'a', binding, keepEmptyFields)).toStrictEqual(out);
            }
        }
        let renamed: unknown = null;
        const rename = evaluate(`const renameField = ${cut('const renameField = (oldKey, newKey) =>').slice('const renameField = '.length)};`, 'renameField', { inputs: INPUTS, onChange: (n: unknown) => { renamed = n; } });
        for (const name of ['z', ' b ', '', 'a']) {
            renamed = null;
            rename('a', name);
            expect(rows.renameInput(INPUTS, 'a', name)).toStrictEqual(renamed);
        }
        let removed: unknown = null;
        const remove = evaluate(`const removeField = ${cut('const removeField = (key) =>').slice('const removeField = '.length)};`, 'removeField', { inputs: INPUTS, onChange: (n: unknown) => { removed = n; } });
        remove('b');
        expect(rows.removeInput(INPUTS, 'b')).toStrictEqual(removed);
    });

    it('the adopt-a-path row edit', () => {
        const body = /onAdoptPath=\{(\(path, suggested\) => \{[\s\S]*?\n {20}\})\}/.exec(SRC)?.[1] as string;
        expect(body).toBeTruthy();
        for (const [k, suggested] of [['b', 'subject'], ['a', 'subject'], ['b', 'c'], ['b', '']] as const) {
            let out: unknown = null;
            const adopt = evaluate(`const adopt = ${body};`, 'adopt', { inputs: INPUTS, k, onChange: (n: unknown) => { out = n; }, isEmptyBinding: webPartition.isEmptyBinding });
            adopt('steps.x.output.subject', suggested);
            expect(rows.adoptPathIntoRow(INPUTS, k, 'steps.x.output.subject', suggested)).toStrictEqual(out);
        }
    });
});

describe('the port on its own', () => {
    it('adds, commits and suggests rows', () => {
        expect(rows.uniqueKey(['field', 'field2'])).toBe('field3');
        expect(rows.addInputField({ field: null }, { keepEmptyFields: true })).toStrictEqual({ inputs: { field: null, field2: { kind: 'literal', value: '' } }, focusKey: 'field2' });
        const pending = rows.addInputField({}, { pending: [{ id: 1, key: 'field', binding: null }], nextId: 2 });
        expect(pending).toStrictEqual({ pending: { id: 2, key: 'field2', binding: { kind: 'literal', value: '' } } });
        expect(rows.addInputField(null)).toStrictEqual({ pending: { id: 1, key: 'field', binding: { kind: 'literal', value: '' } } });
        expect(rows.commitPendingRow({ a: 1 }, { id: 1, key: ' a ', binding: { kind: 'literal', value: 'v' } })).toStrictEqual({ a: 1, a2: { kind: 'literal', value: 'v' } });
        expect(rows.commitPendingRow({}, { id: 1, key: 'a', binding: { kind: 'literal', value: '' } })).toBe(null);
        expect(rows.commitPendingRow(null, null)).toBe(null);
        expect(rows.addFieldFromPath({ subject: 1 }, ' steps.a.output.subject ')).toStrictEqual({
            inputs: { subject: 1, subject2: { kind: 'ref', path: 'steps.a.output.subject' } }, key: 'subject2',
        });
        expect(rows.updateInput(null, 'x', null, true)).toStrictEqual({ x: { kind: 'literal', value: '' } });
        expect(rows.removeInput(null, 'x')).toStrictEqual({});
        expect(rows.renameInput(null, 'x', 'y')).toStrictEqual({});
        expect(rows.adoptPathIntoRow(null, 'x', 'p', 's')).toStrictEqual({});
    });

    it('builds the schema and generic models', () => {
        const schema = {
            properties: {
                query: { type: 'string', title: 'Query', description: 'What to find' },
                format: { type: 'string', enum: ['full', 'raw'] },
                limit: { type: 'integer', 'x-advanced': true },
                tags: { type: 'array', items: { type: 'object' } },
            },
            required: ['query'],
        };
        const model = buildSchemaFormModel({
            inputSchema: schema, inputs: { limit: { kind: 'literal', value: 3 }, extra: 'x' }, autoMappedKeys: ['limit', 'tags', 'extra'], consumedKeys: new Set(['tags']),
        });
        expect(model.mode).toBe('schema');
        expect(model.essential.map((f) => f.key)).toStrictEqual(['query', 'limit']);
        expect(model.advanced.map((f) => [f.key, f.expectKind, f.expectShape, f.options, f.autoMapped])).toStrictEqual([
            ['format', 'choice', 'scalar', ['full', 'raw'], false],
            ['tags', 'table', 'list', null, false],
        ]);
        expect(model.essential[0]).toMatchObject({ label: 'Query', hint: 'What to find', required: true, value: null, placeholder: '' });
        expect(model.essential[1]).toMatchObject({ autoMapped: true, value: { kind: 'literal', value: 3 }, placeholder: 'e.g. 42' });
        expect(model.advancedAutoCount).toBe(0);
        expect(model.rows).toStrictEqual([{ key: 'extra', value: 'x', siblingKeys: ['limit'], autoMapped: true }]);
        const generic = buildSchemaFormModel({ inputs: { a: null, b: null } });
        expect(generic).toStrictEqual({
            mode: 'generic', essential: [], advanced: [], advancedAutoCount: 0,
            rows: [{ key: 'a', value: null, siblingKeys: ['b'], autoMapped: false }, { key: 'b', value: null, siblingKeys: ['a'], autoMapped: false }],
        });
        expect(buildSchemaFormModel({ inputs: null }).rows).toStrictEqual([]);
        expect(buildSchemaFormModel({ inputSchema: { properties: { a: {} } }, inputs: null }).essential.map((f) => f.key)).toStrictEqual(['a']);
    });
});
