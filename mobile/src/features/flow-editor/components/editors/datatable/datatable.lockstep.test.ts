/**
 * The datatable editor held to the web's (datatableEditors.jsx): the operator
 * list is its OPS, and `opsForType` is cut out and run beside the port for
 * every column type; "no value" is the Studio's opTakesNoValue. Then what an
 * edit saves — including the two keys the web's form shows but never saves
 * (`match`, `sort`), which the phone's form carries.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CatalogDatatable } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';

import { DATATABLE_FORM, OPS, opChoices, opNeeds, opsForType, opTakesNoValue, setSort, sortEntry, tableOption } from './datatableModel';

const AGENT_HUB = path.resolve(__dirname, '../../../../../../../agent-hub/src');
const src = fs.readFileSync(path.join(AGENT_HUB, 'components/automation/Builder/flow/settings/datatableEditors.jsx'), 'utf8');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const display = require(path.join(AGENT_HUB, 'components/admin/Studio/Datatables/datatableDisplay.js'));

const between = (start: string, end: string) => {
    const at = src.indexOf(start);
    if (at < 0) throw new Error(`${start} is gone`);
    return src.slice(at, src.indexOf(end, at) + end.length);
};
const web = new Function(
    `${between('const OPS = [', '];')}\n${between('const TEXTUAL', ';')}\n${between('const ORDERED', ';')}\n${between('const TEXT_ONLY', ';')}\n${between('function opsForType(', '\n}\n')}\nreturn { OPS, opsForType };`,
)();

describe('the datatable editor against datatableEditors.jsx', () => {
    it('offers the web’s operators, in its words', () => {
        expect(OPS.map((o) => [o.op, o.label[1]])).toEqual(web.OPS.map((o: { op: string; label: string }) => [o.op, o.label]));
    });

    it.each([null, 'text', 'select', 'number', 'date', 'datetime', 'bool', 'json'])('narrows the operators for a %s column', (type) => {
        expect(opsForType(type).map((o) => o.op)).toEqual(web.opsForType(type).map((o: { op: string }) => o.op));
    });

    it.each(['eq', 'isNull', 'isNotNull', 'in', undefined])('asks for a value after %s as the Studio does', (op) => {
        expect(opTakesNoValue(op)).toBe(display.opTakesNoValue(op));
    });

    it('knows what each operation needs', () => {
        expect(opNeeds('find_rows')).toEqual({ writes: false, values: false, match: false, where: false });
        expect(opNeeds('count_rows').writes).toBe(false);
        expect(opNeeds('save_row')).toEqual({ writes: true, values: true, match: true, where: false });
        expect(opNeeds('delete_rows')).toEqual({ writes: true, values: false, match: false, where: true });
        expect(opChoices([]).map((o) => o.op)).toEqual(['find_rows']);
    });

    it('names a table’s origin and sharing, and refuses a read-only one for a write', () => {
        const table = { id: 't', name: 'Leads', canWrite: false, managedKind: 'nextcloud_table', scope: 'org', columns: [] } as CatalogDatatable;
        const o = tableOption(table, true);
        expect(o.notes.map((n) => n[1])).toEqual(['from Nextcloud', 'shared', 'you can only read this one']);
        expect(o.disabled).toBe(true);
        expect(tableOption({ ...table, scope: 'personal', canWrite: true, managedKind: undefined }, true).notes).toEqual([]);
    });
});

describe('what a datatable edit saves', () => {
    const step = {
        id: 'd1',
        type: 'datatable',
        label: 'Leads',
        icon: 'Table',
        datatableId: 't1',
        op: 'find_rows',
        where: [{ field: 'a', op: 'eq', value: '1' }],
        values: {},
        matchColumn: '',
        limit: 50,
    } as unknown as FlowNode;
    const edit = (change: Record<string, unknown>, from: FlowNode = step) => DATATABLE_FORM.patch(from, { ...DATATABLE_FORM.extract(from), ...change });

    it('leaves an untouched step alone', () => {
        expect(edit({})).toEqual({});
    });

    it('saves “any” and one sort column; the defaults are stored as absence', () => {
        expect(edit({ match: 'any', sort: setSort('created', 'asc') })).toEqual({ match: 'any', sort: [{ field: 'created', dir: 'asc' }] });
        const saved = { ...step, match: 'any', sort: [{ field: 'created', dir: 'asc' }, { field: 'ignored' }] } as unknown as FlowNode;
        const back = edit({ match: 'all', sort: [] }, saved);
        expect('match' in back && back.match === undefined).toBe(true);
        expect('sort' in back && back.sort === undefined).toBe(true);
        expect(sortEntry([{ field: 'x' }])).toEqual({ field: 'x', dir: 'desc' });
    });

    it('drops a half-written condition and an empty value', () => {
        expect(edit({ where: [{ field: 'a', op: 'eq', value: '1' }, { field: '', op: 'eq', value: '' }], values: { a: '', b: 'x' }, op: 'update_rows' })).toEqual({ op: 'update_rows', values: { b: 'x' } });
    });
});
