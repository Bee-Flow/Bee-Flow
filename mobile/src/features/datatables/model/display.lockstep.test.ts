/**
 * The column, access and filter ports held to the web's datatableDisplay.js
 * (agent-hub/src/components/admin/Studio/Datatables) — a differential test:
 * the web module is pure, so it runs here next to the port on the same
 * fixtures. When this fails, the web side changed: update the port.
 */

import { humanizeFieldKey } from '@/shared/lib/humanizeKey';
import { loadWebModule, webFileExists } from '@/shared/testing/webModule';

import { audienceOf, gradeAtLeast } from './access';
import {
    COLUMN_TYPES,
    columnLabel,
    columnProblem,
    columnTypeKind,
    destructiveChanges,
    isManagedColumn,
    isSchemaLocked,
    keyFromName,
    KEY_RE,
    MANAGED_COLUMNS,
    MAX_FIELDS_PER_TABLE,
    MAX_NAME_LEN,
    SYSTEM_COLUMNS,
    tableKindOf,
} from './columns';
import { FILTER_OPS, filterDescriptor, filterEntry, opsForColumn, opTakesList, opTakesNoValue, type FilterDraft } from './filters';
import type { ColumnDraft, Datatable, Grade } from './types';

const DIR = 'components/admin/Studio/Datatables';
const HELPERS = 'components/automation/Builder/flow/displayHelpers.js';
const describeIfWeb = webFileExists(`${DIR}/datatableDisplay.js`) ? describe : describe.skip;

/** The web module with its own three dependencies, each the web's implementation. */
function loadDisplay(): Web {
    const helpers = loadWebModule<{ humanizeFieldKey: unknown }>(HELPERS, { parseExprToRows: null, labelFor: null, isUnaryOp: null });
    const forms = loadWebModule<Record<string, unknown>>(`${DIR}/formAnswers.js`);
    const mirrors = loadWebModule<Record<string, unknown>>(`${DIR}/sourceMirrors.js`);
    return loadWebModule<Web>(`${DIR}/datatableDisplay.js`, {
        humanizeFieldKey: helpers.humanizeFieldKey,
        DEFINITION_MANAGED_KINDS: forms.DEFINITION_MANAGED_KINDS,
        isSourceMirror: mirrors.isSourceMirror,
        SOURCE_MANAGED_KINDS: mirrors.SOURCE_MANAGED_KINDS,
        sourceWritable: mirrors.sourceWritable,
    });
}

type Web = Record<string, unknown> & {
    COLUMN_TYPES: { type: string; label: string }[];
    MANAGED_COLUMNS: Record<string, { key: string }[]>;
};

const NAMES = ['Invoice date ', 'Crème brûlée', '2024 totals', '', '___', 'A'.repeat(90), 'Ümlaut — straße', 'x'];
const COLUMNS = [
    { key: 'contact_email' },
    { key: 'fromEmail', name: '' },
    { key: 'github_url', name: '  ' },
    { key: 'x', name: 'Named' },
    { key: 'pdf_ai_kb' },
    {},
];
const TYPES = ['text', 'richtext', 'number', 'bool', 'date', 'datetime', 'select', 'multiselect', 'file', 'relation', 'computed', undefined];
const LISTS: Partial<ColumnDraft>[][] = [
    [],
    [{ key: 'a', name: 'A', type: 'text' }],
    [{ key: 'Bad', type: 'text' }],
    [{ key: 'id', type: 'text' }],
    [{ key: 'a', type: 'text' }, { key: 'a', type: 'number' }],
    [{ key: 'a', name: 'A' }],
    [{ key: 's', type: 'select', options: [] }],
    [{ key: 's', type: 'multiselect', options: ['x'] }],
    [{ key: '', name: 'Nameless', type: 'text' }],
    [{ key: 'long', name: 'L'.repeat(121), type: 'text' }],
    Array.from({ length: 101 }, (_, i) => ({ key: `c${i}`, type: 'text' as const })),
];
const FILTERS: (FilterDraft | null)[] = [
    null,
    { field: '', op: 'eq', value: 'x' },
    { field: 'a', op: 'nope', value: 'x' },
    { field: 'a', op: 'isNull', value: 'ignored' },
    { field: 'a', op: 'in', value: 'x, y ,,' },
    { field: 'a', op: 'in', value: ' , ' },
    { field: 'a', op: 'between', value: '1,2' },
    { field: 'a', op: 'between', value: '1,2,3' },
    { field: 'a', op: 'eq', value: '' },
    { field: 'a', op: 'contains', value: 'abc' },
];

describeIfWeb('datatableDisplay ports match the web', () => {
    // Loaded inside the tests: a skipped describe still runs its body.
    const web = () => loadDisplay();
    const fn = <A extends unknown[], R>(name: string) => web()[name] as (...args: A) => R;

    it('offers the same column types in the same order, and the same limits', () => {
        expect(COLUMN_TYPES.map((c) => c.type)).toEqual(web().COLUMN_TYPES.map((c) => c.type));
        expect(COLUMN_TYPES.map((c) => c.fallback)).toEqual(web().COLUMN_TYPES.map((c) => c.label));
        expect(String(KEY_RE)).toEqual(String(web().KEY_RE));
        expect(SYSTEM_COLUMNS).toEqual(web().SYSTEM_COLUMNS);
        expect([MAX_FIELDS_PER_TABLE, MAX_NAME_LEN]).toEqual([web().MAX_FIELDS_PER_TABLE, web().MAX_NAME_LEN]);
        expect(FILTER_OPS).toEqual(web().FILTER_OPS);
    });

    it('humanises a key the way the builder does', () => {
        const theirs = loadWebModule<{ humanizeFieldKey: (k: unknown) => string }>(HELPERS, { parseExprToRows: null, labelFor: null, isUnaryOp: null });
        for (const key of ['from_email', 'messageId', 'htmlUrl', 'pdf_ai_kb', 'github-url', '', '  x  ', 'a.b.c', 42]) {
            expect({ key, label: humanizeFieldKey(key) }).toEqual({ key, label: theirs.humanizeFieldKey(key) });
        }
    });

    it('derives keys and labels the same way', () => {
        for (const name of NAMES) expect({ name, key: keyFromName(name) }).toEqual({ name, key: fn('keyFromName')(name) });
        for (const c of COLUMNS) expect({ c, label: columnLabel(c) }).toEqual({ c, label: fn('columnLabel')(c) });
        for (const type of TYPES) {
            expect({ type, kind: columnTypeKind(type) }).toEqual({ type, kind: fn('columnTypeKind')(type) });
            expect({ type, ops: opsForColumn({ type }) }).toEqual({ type, ops: fn('opsForColumn')({ type }) });
        }
    });

    it('accepts and refuses the same column lists', () => {
        for (const list of LISTS) {
            const ours = columnProblem(list) === null;
            const theirs = (fn<[unknown], string[]>('validateColumns')(list)).length === 0;
            expect({ list: list.slice(0, 2), ok: ours }).toEqual({ list: list.slice(0, 2), ok: theirs });
        }
    });

    it('sees the same destructive changes', () => {
        const prev = [{ key: 'a', type: 'text' as const }, { key: 'b', type: 'number' as const }, { key: 'c', type: 'date' as const }];
        const nexts = [prev, [prev[0]!, { key: 'b', type: 'text' as const }], [{ key: 'd', type: 'bool' as const }], []];
        for (const next of nexts) expect(destructiveChanges(prev, next)).toEqual(fn('destructiveChanges')(prev, next));
    });

    it('locks the same managed columns', () => {
        expect(Object.keys(MANAGED_COLUMNS).sort()).toEqual(Object.keys(web().MANAGED_COLUMNS).sort());
        for (const [kind, cols] of Object.entries(web().MANAGED_COLUMNS)) {
            expect({ kind, keys: MANAGED_COLUMNS[kind] }).toEqual({ kind, keys: cols.map((c) => c.key) });
        }
        for (const kind of [null, 'http_cache', 'nextcloud_table', 'spreadsheet_file', 'form_answers', 'other']) {
            expect({ kind, locked: isSchemaLocked(kind) }).toEqual({ kind, locked: fn('isSchemaLocked')(kind) });
            for (const key of ['cache_key', 'run_id', 'mine']) {
                expect({ kind, key, managed: isManagedColumn(kind, key) }).toEqual({ kind, key, managed: fn('isManagedColumn')(kind, key) });
            }
            expect({ kind, tile: tableKindOf({ managedKind: kind }) }).toEqual({ kind, tile: fn('tableKindOf')({ managedKind: kind }) });
        }
    });

    it('reads audiences and grades the same way', () => {
        const tables = [
            { isPublished: false, sharedGroups: ['g'] },
            { isPublished: true, sharedGroups: [] },
            { isPublished: true, sharedGroups: ['g1', 'g2'] },
        ] as Pick<Datatable, 'isPublished' | 'sharedGroups'>[];
        const words: Record<string, string> = { private: web().PRIVATE as string, org: web().ORG as string, groups: web().GROUPS as string };
        for (const table of tables) expect(words[audienceOf(table)]).toEqual(fn('audienceOf')(table));
        const grades: (Grade | null)[] = ['owner', 'editor', 'viewer', null];
        for (const g of grades) {
            for (const min of ['owner', 'editor', 'viewer'] as Grade[]) {
                expect({ g, min, ok: gradeAtLeast(g, min) }).toEqual({ g, min, ok: fn('gradeAtLeast')(g, min) });
            }
        }
    });

    it('builds the same filter descriptor', () => {
        for (const row of FILTERS) expect({ row, entry: filterEntry(row) }).toEqual({ row, entry: fn('filterEntry')(row) });
        const drafts = FILTERS.filter((f): f is FilterDraft => f !== null);
        expect(filterDescriptor(drafts)).toEqual(fn('filterDescriptor')(drafts));
        for (const op of FILTER_OPS) {
            expect([opTakesNoValue(op), opTakesList(op)]).toEqual([fn('opTakesNoValue')(op), fn('opTakesList')(op)]);
        }
    });
});
