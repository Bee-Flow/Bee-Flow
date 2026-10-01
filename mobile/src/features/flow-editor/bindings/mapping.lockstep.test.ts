/**
 * DIFFERENTIAL lockstep for the smaller agent-hub `Builder/mapping/*` modules:
 * each port runs beside its original on the same inputs. When this fails the
 * web side changed — update the port, don't loosen the test.
 */

import * as bp from './bindingPreview';
import * as bd from './boundPaths';
import { describeField } from './fieldDescription';
import * as fk from './fieldKinds';
import * as ff from './filterFields';
import * as kp from './keyPath';
import * as ls from './listShape';
import * as mm from './mismatch';
import { isEmptyBinding, partitionInputs } from './partitionInputs';
import * as ro from './realOutputs';
import { CATALOG, chainDefinition } from './testing/fixture';
import { frozenWeb } from './testing/frozenWeb';
import { BUILDER, requireWeb, webValue } from './testing/web';
import type { VariableGroup } from './types';
import { computeUpstreamGroups } from './upstream';

// listShape and mismatch left agent-hub with M4 (the shared mapping core
// replaced them): their answers are the recorded ones (testing/frozenWeb.ts).
const FROZEN: Record<string, ReturnType<typeof frozenWeb>> = {
    listShape: frozenWeb('listShape', `${BUILDER}/mapping/listShape.js`),
    mismatch: frozenWeb('mismatch', `${BUILDER}/mapping/mismatch.js`),
};
const m = (name: string) => FROZEN[name] ?? requireWeb(`${BUILDER}/mapping/${name}.js`);

const ROOT = {
    trigger: { output: { subject: 'Hi', when: '2026-01-02', flag: true, n: 3, blob: 'x '.repeat(80), para: `${'a '.repeat(40)}\n\n${'b '.repeat(40)}` } },
    steps: {
        g: {
            output: {
                results: [
                    { subject: 'A', tags: ['x', 'y'], 'content-type': 'json', meta: { a: 1 } },
                    { subject: 'B', tags: ['z'] },
                    null,
                ],
                empty: [],
                nums: [1, 2, 3, 4],
                file: { fileId: 'f', name: 'r.pdf', size: 12345 },
                group: { 'first-name': 'Ada', last: 'L', 'a]b': 1, "q'\"": 2, city: 'X', zip: '1' },
                one: [{ only: 1 }],
                single: ['x'],
                twoCols: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
                nulls: [null, null],
                placeholder: '<string>',
                mixed: [1, { a: 1 }, { b: 2 }],
            },
        },
    },
};

const PATHS = [
    'steps.g.output.results', 'steps.g.output.results[*].subject', 'steps.g.output.results[*].tags', 'steps.g.output.empty',
    'steps.g.output.nums', 'steps.g.output.file', 'steps.g.output.group', 'steps.g.output.one', 'trigger.output.subject',
    'trigger.output.when', 'trigger.output.flag', 'trigger.output.n', 'trigger.output.blob', 'trigger.output.para',
    'steps.g.output.placeholder', 'steps.g.output.mixed', 'steps.g.output.nope', '', 'steps.g.output.results[*]["content-type"]',
    'steps.g.output.single', 'steps.g.output.twoCols', 'steps.g.output.nulls', 'steps.g.output.results[*].meta',
];

describe('partitionInputs', () => {
    const web = m('partitionInputs');
    it('partitions the fixture schemas like the web', () => {
        for (const app of CATALOG.apps || []) {
            for (const action of app.actions || []) {
                const schema = action?.inputSchema;
                const req = new Set(schema?.required || []);
                for (const inputs of [{}, { maxResults: { kind: 'literal', value: 5 } }, null]) {
                    expect(partitionInputs(schema?.properties, req, inputs)).toStrictEqual(
                        web.partitionInputs?.(schema?.properties, req, inputs),
                    );
                }
            }
        }
        expect(partitionInputs(null, null)).toStrictEqual(web.partitionInputs?.(null, null));
        expect(partitionInputs({ a: {}, b: { 'x-advanced': true } }, new Set())).toStrictEqual(
            web.partitionInputs?.({ a: {}, b: { 'x-advanced': true } }, new Set()),
        );
    });

    it.each([null, undefined, 'x', 0, { kind: 'literal', value: '' }, { kind: 'literal', value: 0 }, { kind: 'ref' },
        { kind: 'ref', path: 'a' }, { kind: 'expr' }, { kind: 'template', value: 'x' }, { kind: 'other' }])('isEmptyBinding(%p)', (b) => {
        expect(isEmptyBinding(b)).toBe(web.isEmptyBinding?.(b));
    });
});

describe('filterFields / keyPath / boundPaths', () => {
    const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);

    it.each(['', 'subj', 'RESULTS', 'steps.search', 'gmail', 'zzz', ' trigger '])('filter %p', (q) => {
        expect(ff.filterGroups(groups, q)).toStrictEqual(m('filterFields').filterGroups?.(groups, q));
        const fields = (groups[3] as VariableGroup).fields;
        expect(ff.filterFields(fields, q)).toStrictEqual(m('filterFields').filterFields?.(fields, q));
    });

    it('filters nothing out of nothing', () => {
        expect(ff.filterGroups(null, 'x')).toStrictEqual(m('filterFields').filterGroups?.(null, 'x'));
        expect(ff.filterFields(null, '')).toStrictEqual(m('filterFields').filterFields?.(null, ''));
    });

    it.each(['name', 'content-type', 'Order date', 'has"quote', "both'\"", 'a]b', '', '2024', 5])('keyPath %p', (key) => {
        const web = m('keyPath');
        expect(kp.joinKeyPath('', key)).toBe(web.joinKeyPath?.('', key));
        expect(kp.joinKeyPath('steps.a.output', key)).toBe(web.joinKeyPath?.('steps.a.output', key));
        expect(kp.keyPickable(key)).toBe(web.keyPickable?.(key));
    });

    it('bound paths and empty slots', () => {
        const web = m('boundPaths');
        const step = {
            id: 'x', label: 'steps.fake.output', position: { x: 1 },
            inputs: { a: { kind: 'ref', path: 'steps.s1.output.results[*].subject' }, b: { kind: 'template', value: 'Hi {{trigger.output.name}}' }, c: { kind: 'literal', value: ' ' }, d: '' },
            fields: { e: { kind: 'expr', value: 'loop.item.x + 1' }, f: { kind: 'ref' }, g: 3, h: { kind: 'other' } },
        };
        const used = bd.usedPathsIn(step);
        expect(used).toStrictEqual(web.usedPathsIn?.(step));
        expect(bd.usedPathsIn(null)).toStrictEqual(web.usedPathsIn?.(null));
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(bd.usedPathsIn(cyclic)).toStrictEqual(web.usedPathsIn?.(cyclic));
        for (const p of ['steps.s1.output.results', 'steps.s1.output', 'trigger.output.name', 'nope', '']) {
            expect(bd.pathInUse(p, used)).toBe(web.pathInUse?.(p, used));
        }
        const fields = (groups[3] as VariableGroup).fields;
        expect(bd.countInUse(fields, new Set(['steps.search.output.results[*].x']))).toBe(
            web.countInUse?.(fields, new Set(['steps.search.output.results[*].x'])),
        );
        expect(bd.countInUse(fields, null)).toBe(web.countInUse?.(fields, null));
        for (const opts of [undefined, { inputSchema: { required: ['a', 'z'] } }, { schemaKnown: false }]) {
            expect(bd.emptySlotsIn(step as never, opts)).toStrictEqual(web.emptySlotsIn?.(step, opts));
        }
        expect(bd.emptySlotsIn({ inputs: [] } as never)).toStrictEqual(web.emptySlotsIn?.({ inputs: [] }));
    });
});

describe('fieldKinds / fieldDescription', () => {
    const web = m('fieldKinds');
    it('tables', () => {
        expect(fk.KINDS).toStrictEqual(webValue(web, 'KINDS'));
        expect(fk.KIND_WORD).toStrictEqual(webValue(web, 'KIND_WORD'));
        expect(fk.KIND_TECHNICAL).toStrictEqual(webValue(web, 'KIND_TECHNICAL'));
        expect(String(fk.ISO_DATE_RE)).toBe(String(webValue(web, 'ISO_DATE_RE')));
    });

    it.each(PATHS)('describeField(%p)', (path) => {
        const field = { key: 'k', path, sample: path ? undefined : [1, 2] };
        for (const sample of [[{ a: 1 }], [{}], [], [null], ['x']]) {
            expect(describeField({ key: 'k', path: 'nope.x', sample }, ROOT)).toStrictEqual(web.describeField?.({ key: 'k', path: 'nope.x', sample }, ROOT));
        }
        expect(describeField(field, ROOT)).toStrictEqual(web.describeField?.(field, ROOT));
        expect(describeField(field, null)).toStrictEqual(web.describeField?.(field, null));
        const t = (key: string, en: string) => `${key}|${en}`;
        expect(describeField(field, ROOT, t)).toStrictEqual(web.describeField?.(field, ROOT, t));
    });

    it('values, bytes and schema kinds', () => {
        for (const v of [null, 1, 2n, true, 'x', '<string>', '2026-01-01', '2026-01-01T10:00', [], [{}], [1], { fileId: 'a', filename: 'b', mime: 'c' }, {}, () => 1]) {
            expect(fk.kindOfValue(v)).toBe(web.kindOfValue?.(v));
            expect(fk.isPlaceholder(v)).toBe(web.isPlaceholder?.(v));
            expect(fk.looksLikeFile(v)).toBe(web.looksLikeFile?.(v));
        }
        for (const n of [-1, 0, 900, 5000, 20000, 3e6, 'x', null]) expect(fk.formatBytes(n)).toBe(web.formatBytes?.(n));
        const props = [null, {}, { type: 'string' }, { type: 'string', format: 'date-time' }, { type: 'string', enum: ['a'] },
            { enum: ['a'] }, { type: 'string', enum: ['a'], format: 'date' }, { type: ['null', 'integer'] }, { type: 'boolean' },
            { type: 'array', items: { type: 'object' } }, { type: 'array' }, { type: 'object' }, { type: 'weird' }, { type: ['null'] }];
        for (const p of props) {
            expect(fk.expectedKindFor(p as never)).toBe(web.expectedKindFor?.(p));
            expect(ls.expectedShapeFor(p as never)).toBe(m('listShape').expectedShapeFor?.(p));
        }
        for (const a of fk.KINDS) {
            expect(fk.isScalarKind(a)).toBe(web.isScalarKind?.(a));
            for (const e of [...fk.KINDS, null]) expect(fk.kindFits(a, e)).toBe(web.kindFits?.(a, e));
        }
    });
});

describe('listShape', () => {
    const web = m('listShape');
    it.each(PATHS)('%p', (path) => {
        expect(ls.pathListShape(path, ROOT)).toStrictEqual(web.pathListShape?.(path, ROOT));
        expect(ls.fieldListShape({ key: 'k', path, sample: [{ a: 1 }] }, ROOT)).toStrictEqual(
            web.fieldListShape?.({ key: 'k', path, sample: [{ a: 1 }] }, ROOT),
        );
        expect(ls.fieldListShape({ key: 'k', path, sample: 'x' }, {})).toStrictEqual(web.fieldListShape?.({ key: 'k', path, sample: 'x' }, {}));
        expect(ls.forEachPickFor(path, ROOT)).toStrictEqual(web.forEachPickFor?.(path, ROOT));
        expect(ls.forEachPickFor(path, ROOT, { itemVar: 'my-row' })).toStrictEqual(web.forEachPickFor?.(path, ROOT, { itemVar: 'my-row' }));
        expect(ls.bindingsForList(path, { separator: '\n' })).toStrictEqual(web.bindingsForList?.(path, { separator: '\n' }));
        expect(ls.previewForEachPick(path, ROOT)).toStrictEqual(web.previewForEachPick?.(path, ROOT));
        const labels = new Map([['g', 'Gmail']]);
        expect(ls.describeListPath(path, labels)).toBe(web.describeListPath?.(path, labels));
        const t = (key: string, en: string) => `${key}:${en}`;
        expect(ls.describeListPath(path, labels, t)).toBe(web.describeListPath?.(path, labels, t));
        expect(ls.splitColumnPath(path)).toStrictEqual(web.splitColumnPath?.(path));
    });

    it('odd inputs', () => {
        expect(ls.pathListShape('a', null)).toBe(web.pathListShape?.('a', null));
        expect(ls.fieldListShape(null, ROOT)).toBe(web.fieldListShape?.(null, ROOT));
        expect(ls.bindingsForList(null)).toStrictEqual(web.bindingsForList?.(null));
        expect(ls.previewForEachPick('steps.g.output.results', { steps: { g: { output: { results: [null] } } } })).toBe(
            web.previewForEachPick?.('steps.g.output.results', { steps: { g: { output: { results: [null] } } } }),
        );
    });
});

describe('mismatch', () => {
    const web = m('mismatch');
    it.each(PATHS)('remediesFor(%p)', (path) => {
        for (const opts of [undefined, { allowForEach: true }, { allowForEach: true, itemVar: 'row' }, { actualKind: 'group' }, { actualKind: 'table', allowForEach: true }]) {
            expect(mm.remediesFor(path, ROOT, opts)).toStrictEqual(web.remediesFor?.(path, ROOT, opts));
        }
        expect(mm.kindAtPath(path, ROOT)).toBe(web.kindAtPath?.(path, ROOT));
    });

    it('detects and words the mismatch', () => {
        const kinds = [...fk.KINDS, undefined, 'bogus'];
        for (const actualKind of kinds) {
            for (const expectedKind of kinds) {
                expect(mm.detectMismatch({ actualKind, expectedKind })).toStrictEqual(web.detectMismatch?.({ actualKind, expectedKind }));
                for (const count of [null, 3]) {
                    expect(mm.mismatchSentence({ actualKind, expectedKind, count })).toBe(web.mismatchSentence?.({ actualKind, expectedKind, count }));
                }
            }
        }
        const t = (key: string, en: string) => `${key}/${en}`;
        expect(mm.mismatchSentence({ actualKind: 'list', expectedKind: 'text' }, t)).toBe(
            web.mismatchSentence?.({ actualKind: 'list', expectedKind: 'text' }, t),
        );
        expect(mm.kindAtPath('', ROOT)).toBe(web.kindAtPath?.('', ROOT));
        expect(mm.NEWLINE).toBe(webValue(web, 'NEWLINE'));
    });
});

describe('bindingPreview', () => {
    const web = m('bindingPreview');

    it.each([
        null, 'bare', { kind: 'literal', value: '' }, { kind: 'literal', value: 'x' }, { kind: 'literal', value: { a: 1 } },
        { kind: 'ref' }, { kind: 'ref', path: 'trigger.output.subject' }, { kind: 'ref', path: 'steps.g.output.nums' },
        { kind: 'ref', path: 'nope.x' }, { kind: 'template' }, { kind: 'template', value: 'Hi {{trigger.output.subject}} {{ nope }}' },
        { kind: 'template', value: '{{nope}}' }, { kind: 'expr' }, { kind: 'expr', value: 'upper(trigger.output.subject)' },
        { kind: 'expr', value: 'count(steps.g.output.nums)' }, { kind: 'expr', value: 'steps.g.output.nums' },
        { kind: 'expr', value: 'bogus((' }, { kind: 'expr', value: 'trigger.output.none' }, { kind: 'other' },
    ])('%j', (b) => {
        for (const root of [ROOT, null]) {
            expect(bp.previewBinding(b as never, root)).toBe(web.default?.(b, root));
            expect(bp.previewBinding(b as never, root, { raw: false })).toBe(web.default?.(b, root, { raw: false }));
            expect(bp.previewBindingShape(b as never, root)).toStrictEqual(web.previewBindingShape?.(b, root));
        }
    });
});

describe('realOutputs', () => {
    const web = m('realOutputs');
    it('overlay, maps and sample roots', () => {
        const pairs: [unknown, unknown][] = [[{ a: 1, b: { c: 1 } }, { b: { d: 2 }, e: [1] }], [null, { a: 1 }], [{ a: 1 }, 'x'], [[1], { a: 1 }], [{ a: 1 }, null]];
        for (const [base, real] of pairs) expect(ro.deepOverlay(base, real)).toStrictEqual(web.deepOverlay?.(base, real));
        for (const v of [null, {}, { __truncated__: true }, { __truncated__: 1 }]) expect(ro.isTruncatedOutput(v)).toBe(web.isTruncatedOutput?.(v));
        expect(ro.buildRealOutputMap(null, [])).toStrictEqual(web.buildRealOutputMap?.(null, []));
        const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);
        const extra = [{ id: 'l', label: 'L', kind: 'loop', basePath: 'loop.row', sample: { a: 1 }, fields: [] },
            { id: 'l2', label: 'L', kind: 'loop', basePath: 'loop.', sample: null, fields: [] },
            { id: 't9', label: 'T', kind: 'trigger', basePath: 'trigger.output', sample: null, fields: [], hasRealData: true },
            { id: 't10', label: 'T', kind: 'trigger', basePath: 'trigger.output', sample: { late: 1 }, fields: [] }];
        expect(ro.buildSampleRoot([...groups, ...extra])).toStrictEqual(web.buildSampleRoot?.([...groups, ...extra]));
        expect(ro.buildSampleRoot(null)).toStrictEqual(web.buildSampleRoot?.(null));
    });
});
