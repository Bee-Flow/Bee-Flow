/**
 * Edit data held to the web: the six table tools are setOperations.js's
 * SET_OP_DEFS (titles, hints, defaults, order); `suggestFieldName` and
 * `parseSampleSource` are cut out of ParseJsonFields.jsx and run beside the
 * port; the key-list edit is SetOperationsEditor's; and a draft edited here
 * saves the way the web's form saves it (formState's set patch).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState } from '@/features/flow-editor/formState';

import { flip, pickRows } from './jsonPick';
import { addJsonField, baseColumnsOf, collisionOf, columnsAt, jsonCandidates, keyRows, parseSampleSource, SET_OP_DEFS, setKeyAt, suggestFieldName } from './setModel';

const FLOW = path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const webOps = require(path.join(FLOW, 'setOperations.js'));
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const bindingHelpers = require(path.resolve(FLOW, '../../../../utils/bindingHelpers.js'));
const parseJsonSrc = fs.readFileSync(path.join(FLOW, 'settings/ParseJsonFields.jsx'), 'utf8');

function cut(src: string, name: string): string {
    const at = src.indexOf(`export function ${name}(`);
    if (at < 0) throw new Error(`${name} is gone`);
    return src.slice(at, src.indexOf('\n}\n', at) + 2).replace('export function', 'function');
}

const re = /const FIELD_NAME_RE = (\/.+\/);/.exec(parseJsonSrc)?.[1] as string;
const web = new Function(
    'suggestKeyFromPath',
    `const FIELD_NAME_RE = ${re};\n${cut(parseJsonSrc, 'suggestFieldName')}\n${cut(parseJsonSrc, 'parseSampleSource')}\nreturn { suggestFieldName, parseSampleSource };`,
)(bindingHelpers.suggestKeyFromPath);

describe('the table tools against setOperations.js', () => {
    it('offers the web’s six tools, in order, with its words and defaults', () => {
        const ours = SET_OP_DEFS.map((d) => [d.op, d.title[1], d.hint[1], d.makeDefault()]);
        const theirs = webOps.SET_OP_DEFS.map((d: { op: string; title: string; hint: string; makeDefault: () => unknown }) => [d.op, d.title, d.hint, d.makeDefault()]);
        expect(ours).toEqual(theirs);
    });

    it('offers each card the columns that exist at that point, and warns before overwriting one', () => {
        const ops = [
            { op: 'rename', from: 'a', to: 'x' },
            { op: 'rowId', target: 'n' },
            { op: 'keep', keys: ['x', 'n'] },
            { op: 'sort', key: 'n' },
        ];
        const base = baseColumnsOf({ a: 1, b: 2 }, { c: { kind: 'literal', value: '' } });
        expect(base).toEqual(['a', 'b', 'c']);
        for (let i = 0; i <= ops.length; i++) expect(columnsAt(base, ops, i)).toEqual(webOps.columnsAfterOps(base, ops, i));
        expect(baseColumnsOf(5, {})).toEqual(['value']);
        expect(collisionOf('b', base)?.[1]).toBe('Replaces the existing “{name}” values on every row.');
        expect(collisionOf('new', base)).toBeNull();
    });

    it('edits a key list as the web does: the row being typed in stays, other blanks go', () => {
        expect(keyRows([])).toEqual(['']);
        expect(setKeyAt([], 0, 'a')).toEqual(['a']);
        expect(setKeyAt(['a', '', 'c'], 2, '')).toEqual(['a', '']);
        expect(setKeyAt(['a', 'b'], 0, '')).toEqual(['', 'b']);
    });
});

describe('JSON text, against ParseJsonFields.jsx', () => {
    it.each([['body.id', []], ['items[0].name', ['name']], ['["content-type"]', []], ['2nd', []], ['a.b', ['b', 'b_2']]] as const)('suggestFieldName(%j, %j)', (p, taken) => {
        expect(suggestFieldName(p, taken)).toBe(web.suggestFieldName(p, taken));
    });

    it.each(['{"a":1}', '﻿ [1,2] ', 'not json', '', 5, null, { a: 1 }, [1]])('parseSampleSource(%j)', (v) => {
        expect(parseSampleSource(v)).toEqual(web.parseSampleSource(v));
    });

    it('finds JSON text — the row’s fields in list mode, the nearest step first otherwise — and adds a parseJson field', () => {
        const groups = [
            { id: 'a', label: 'First', kind: 'step', basePath: 'steps.a.output', sample: {}, fields: [{ key: 'raw', path: 'steps.a.output.raw', sample: '{"x":1}' }] },
            { id: 'b', label: 'Second', kind: 'step', basePath: 'steps.b.output', sample: {}, fields: [{ key: 'note', path: 'steps.b.output.note', sample: '[1]' }] },
        ];
        expect(jsonCandidates({ listMode: false, elementSample: null, groups, eachRow: 'each row' }).map((c) => c.path)).toEqual(['steps.a.output.raw', 'steps.b.output.note']);
        expect(jsonCandidates({ listMode: true, elementSample: { body: '{"a":1}', n: 1 }, groups, eachRow: 'each row' })).toEqual([{ path: 'item.body', label: 'each row · Body', preferred: true }]);
        expect(addJsonField({ id: 1 }, 'item.body', 'a["x"]')).toEqual({ id: 1, [web.suggestFieldName('a["x"]', ['id'])]: { kind: 'expr', value: `parseJson(item.body, 'a["x"]')` } });
        expect(addJsonField({ id: 1 }, 'item.body', 'user.id')).toEqual({ id: 1, id_2: { kind: 'expr', value: 'parseJson(item.body, "user.id")' } });
    });

    it('lists a payload as rows to pick from, a list by its first item or each', () => {
        const value = { user: { name: 'A', 'content-type': 'x' }, tags: ['a', 'b'] };
        const state = { toggled: new Set<string>(), each: new Set<string>() };
        const paths = pickRows(value, state).flatMap((r) => (r.kind === 'node' ? [r.path] : [r.kind]));
        expect(paths).toEqual(['user', 'user.name', 'user["content-type"]', 'tags', 'each', 'tags[0]']);
        const each = pickRows(value, { ...state, each: flip(state.each, 'tags') });
        expect(each.some((r) => r.kind === 'node' && r.path === 'tags[*]')).toBe(true);
        expect(pickRows(value, { ...state, toggled: flip(state.toggled, 'user') }).some((r) => r.kind === 'node' && r.path === 'user.name')).toBe(false);
    });
});

describe('what an edit saves', () => {
    const list = { id: 's1', type: 'set', fields: { a: { kind: 'literal', value: '1' } }, arrayRef: 'steps.x.output.rows', forEach: { overRef: 'old' } } as unknown as FlowNode;

    it('saves table tools in list mode and clears the legacy per-item setting', () => {
        const draft = extractFormState(list);
        const patch = buildPatch(list, { ...draft, operations: [{ op: 'rowId', target: 'n' }] });
        expect(patch).toMatchObject({ operations: [{ op: 'rowId', target: 'n' }], forEach: null });
    });

    it('switching to the whole run drops the list and the tools', () => {
        const withOps = { ...list, operations: [{ op: 'sort', key: 'a' }] } as unknown as FlowNode;
        const patch = buildPatch(withOps, { ...extractFormState(withOps), arrayRef: null });
        expect('arrayRef' in patch && patch.arrayRef === undefined).toBe(true);
        expect('operations' in patch && patch.operations === undefined).toBe(true);
    });
});
