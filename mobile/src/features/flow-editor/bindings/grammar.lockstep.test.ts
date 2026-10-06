/**
 * DIFFERENTIAL lockstep for the path grammar on the phone: every place a
 * binding editor reads or writes a path agrees with the web original AND with
 * the runtime (shared getPath), for the keys real payloads carry — quoted,
 * dashed, unicode, `}`/`]`, match segments, JSON text nested in JSON text.
 */

import * as display from '@/features/flow-editor/model/displayHelpers';
import { evaluate, getPath, getRelativePath } from '@/shared/expr';

import * as bh from './bindingHelpers';
import * as bp from './bindingPreview';
import * as bd from './boundPaths';
import * as cond from './conditionText';
import * as mm from './mismatch';
import * as rt from './refTokens';
import { BUILDER, requireWeb } from './testing/web';
import * as vp from './valueParts';
import { pathLabelParts } from './walkPath';

const web = requireWeb('utils/bindingHelpers.js');
const m = (name: string) => requireWeb(`${BUILDER}/mapping/${name}.js`);
const webPick = requireWeb(`${BUILDER}/mapping/proposePick.ts`);

const lvl3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
const lvl2 = JSON.stringify({ items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: lvl3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }] });
const base = 'steps.http.output.body.data.payload';

const ROOT = {
    trigger: { output: { headers: { 'content-type': 'application/json' }, 'Größe': 'XL' } },
    steps: {
        jira: { output: { fields: { 'Story Points': 5, 'x}y': 2, 'p]q': 3, 'a > b': 1 } } },
        graph: {
            output: {
                '@odata.nextLink': 'https://n',
                value: [
                    { id: 'm1', from: { emailAddress: { address: 'ada@x.nl' } }, toRecipients: [{ emailAddress: { address: 'c@x.nl' } }] },
                    { id: 'm2', from: { emailAddress: { address: 'bob@x.nl' } }, toRecipients: [] },
                ],
            },
        },
        mail: { output: { headers: [{ name: 'From', value: 'a@x.nl' }, { name: 'Subject', value: 'Hello' }] } },
        m: { output: { rows: [[1, 2], [3]], withNull: [1, null, 3] } },
        http: { output: { body: JSON.stringify({ data: { payload: lvl2 } }) } },
    },
};

const PATHS = [
    'steps.jira.output.fields["Story Points"]', "steps.jira.output.fields['Story Points']", 'steps.graph.output["@odata.nextLink"]',
    'steps.graph.output.value[0].from.emailAddress.address', 'steps.graph.output.value.0.id', 'steps.graph.output.value[-1].id',
    'steps.graph.output.value[*].from', 'steps.m.output.rows[*]', 'steps.m.output.withNull[*]', 'trigger.output.headers.content-type',
    'trigger.output.Größe', 'steps.jira.output.fields["x}y"]', 'steps.jira.output.fields["p]q"]', 'steps.mail.output.headers[name="Subject"].value',
    'steps.jira.output.fields.Story Points', 'steps.graph.output.value[0x1].id', 'steps.graph.output.value[0]id', 'steps.call/sub.output.x',
    `${base}.items[0].meta.ai.verdict["reason code"]`, `${base}.items[*].meta.tags`, `${base}.items[sku="B2"].meta.tags[0]`,
    'steps.a.output.total-1', 'steps.a.output.total-steps.b.output.tax', 'x + 1', '42', '',
];

describe('reading paths: phone = web = run', () => {
    it.each(PATHS)('%s', (p) => {
        const mine = bh.walkPath(p, ROOT);
        expect(mine).toStrictEqual(web.walkPath?.(p, ROOT));
        if (!p.includes('/')) expect(mine).toStrictEqual(p ? getPath(ROOT, p) : undefined);
        expect(bh.isCleanPath(p)).toBe(web.isCleanPath?.(p));
        expect(bh.detectTemplate(`{{${p}}}`)).toBe(web.detectTemplate?.(`{{${p}}}`));
        for (const mode of ['fixed', 'expression'] as const) {
            expect(bh.bindingFromInput(p, mode)).toStrictEqual(web.bindingFromInput?.(p, mode));
            expect(bh.formatPathForInsert(p, mode)).toBe(web.formatPathForInsert?.(p, mode));
        }
        expect(bh.suggestKeyFromPath(p)).toBe(web.suggestKeyFromPath?.(p));
        expect(bh.pathLeafKey(p)).toBe(web.pathLeafKey?.(p));
        expect(bh.canonicalRefPath(p)).toBe(web.canonicalRefPath?.(p));
        expect(pathLabelParts(p)).toStrictEqual(web.pathLabelParts?.(p) ?? null);
    });

    it('relative paths are the run\'s getRelativePath', () => {
        for (const p of ['', '$', '0', 'a-b', '["a-b"]', '[0].x', '[*].sku', '$.a', '[k="b"].n']) {
            for (const v of [{ a: 1, 'a-b': 2, 0: 'z' }, [{ x: 1, sku: 's', k: 'b', n: 2 }], '[{"k":"b","n":2}]', null]) {
                expect(bh.walkRelativePath(p, v)).toStrictEqual(getRelativePath(v, p));
                expect(bh.walkRelativePath(p, v)).toStrictEqual(web.walkRelativePath?.(p, v));
            }
        }
    });
});

describe('pills, conditions and the value model: phone = web', () => {
    const TEXTS = [
        ...PATHS.map((p) => `Hi {{${p}}}!`), ...PATHS,
        'first(steps.graph.output["value"])', 'concat("steps.a.output.x", steps.b.output.y)',
        'steps.mail.output.headers[name="Subject"].value == "x"', '{{ steps.s1.output.odd["a}}b"] }}',
    ];
    const refTokens = m('refTokens');
    it.each(TEXTS)('%s', (text) => {
        for (const mode of ['fixed', 'expression']) {
            expect(rt.parseRefTokens(text, { mode })).toStrictEqual(refTokens.parseRefTokens?.(text, { mode }));
        }
        expect(rt.scanExprPaths(text, ['steps', 'trigger', 'item'])).toStrictEqual(refTokens.scanExprPaths?.(text, ['steps', 'trigger', 'item']));
        const ref = rt.classifyRef(text);
        expect(ref).toStrictEqual(refTokens.classifyRef?.(text));
        if (ref) expect(rt.fieldTailLabel(ref.fieldPath)).toBe(refTokens.fieldTailLabel?.(ref.fieldPath));
        for (const b of [{ kind: 'template', value: text }, { kind: 'expr', value: text }, { kind: 'ref', path: text }]) {
            expect(cond.renderBindingValue(b)).toBe(web.renderBindingValue?.(b));
            expect(vp.parseValue(b)).toStrictEqual(m('valueParts').parseValue?.(b));
            expect(bp.previewBinding(b, ROOT, { listAs: 'json' })).toBe(m('bindingPreview').default?.(b, ROOT, { listAs: 'json' }));
            expect(bp.previewBinding(b, ROOT)).toBe(m('bindingPreview').default?.(b, ROOT));
        }
        expect(cond.parseSimpleCondition(`${text} > 3`)).toStrictEqual(web.parseSimpleCondition?.(`${text} > 3`));
    });

    it('the value model writes formulas the engine reads', () => {
        for (const path of PATHS.filter((p) => bh.isCleanPath(p))) {
            for (const transform of [null, 'lower', 'join', 'yesNoText']) {
                const mine = vp.buildValue([{ type: 'data', path }], transform);
                expect(mine).toStrictEqual(m('valueParts').buildValue?.([{ type: 'data', path }], transform));
            }
            expect(vp.describeDataPath(path, new Map([['jira', 'Jira']]))).toEqual(
                expect.objectContaining({ suffix: (m('valueParts').describeDataPath?.(path, new Map([['jira', 'Jira']])) as { suffix?: string } | undefined)?.suffix }),
            );
        }
        const lowered = vp.buildValue([{ type: 'data', path: 'trigger.output.headers.content-type' }], 'lower') as { value: string };
        expect(evaluate(lowered.value, ROOT)).toBe('application/json');
    });

    it('"in use" and the auto-pick agree', () => {
        const step = { inputs: Object.fromEntries(PATHS.map((p, i) => [`i${i}`, { kind: i % 2 ? 'ref' : 'template', [i % 2 ? 'path' : 'value']: i % 2 ? p : `{{${p}}}` }])) };
        const used = bd.usedPathsIn(step);
        expect([...used].sort()).toStrictEqual([...(m('boundPaths').usedPathsIn?.(step) as Set<string>)].sort());
        for (const p of PATHS) expect(bd.pathInUse(p, used)).toBe(m('boundPaths').pathInUse?.(p, used));
        const mw = m('mismatch');
        for (const p of ['steps.graph.output.value[*].from', 'steps.graph.output.value[*].toRecipients', 'steps.graph.output.value', 'steps.jira.output.fields']) {
            expect(mm.columnPath(p, 'emailAddress', ROOT)).toBe(mw.columnPath?.(p, 'emailAddress', ROOT));
            for (const opts of [{ slot: 'Recipient address', expectedKind: 'email' }, { slot: 'id', expectedKind: 'text' }, { slot: 'Story Points', expectedKind: 'number' }]) {
                expect(mm.columnForSlot(p, ROOT, opts)).toBe(mw.columnForSlot?.(p, ROOT, opts));
                expect(mm.fieldForSlot(p, ROOT, opts)).toBe(mw.fieldForSlot?.(p, ROOT, opts));
            }
            for (const actualKind of ['list', 'table', 'group']) {
                const r = mm.remediesFor(p, ROOT, { actualKind, allowForEach: false });
                for (const expectedKind of ['text', 'email', 'number']) {
                    expect(mm.quietDefaultId(r, { path: p, actualKind, expectedKind })).toBe(mw.quietDefaultId?.(r, { path: p, actualKind, expectedKind }));
                }
            }
        }
    });
});

describe('every label names a path the way its pill does: phone = web', () => {
    const webDisplay = requireWeb(`${BUILDER}/flow/displayHelpers.js`);
    it.each([
        'from.emailAddress.address', 'value[*].toRecipients[*].emailAddress.address', 'items[0]', 'items[-1]', 'items[2]',
        'fields["Story Points"]', 'headers[name="Subject"].value', 'customer.id', 'results[*].from_email', 'subject',
        '[0]', 'a.', '', 'items[0].id', `${base}.items[0].meta.tags[1]`,
    ])('%s', (path) => {
        const label = display.humanizeFieldTail(path);
        expect(label).toBe(webDisplay.humanizeFieldTail!(path));
        expect(rt.fieldTailLabel(path)).toBe(label);
        expect(m('refTokens').fieldTailLabel!(path)).toBe(label);
    });
});

describe('the pick decision for a one-value slot (proposePickBinding)', () => {
    const PICKS = [
        'steps.graph.output.value[*].from.emailAddress', 'steps.graph.output.value', 'steps.graph.output.value[*].toRecipients',
        'steps.graph.output.value[*].id', 'steps.jira.output.fields', 'steps.m.output.withNull', 'steps.mail.output.headers',
        'steps.jira.output.fields["Story Points"]', 'trigger.output.headers.content-type',
    ];
    const SLOTS = [
        { slot: 'Recipient address', expectKind: 'email', expectShape: 'scalar' },
        { slot: 'Story Points', expectKind: 'number', expectShape: 'scalar' },
        { slot: 'Body', expectKind: 'text', expectShape: 'scalar' },
        { slot: 'id', expectKind: null, expectShape: 'scalar' },
        { slot: 'Items', expectKind: null, expectShape: 'list' },
    ];
    it.each(PICKS)('%s', (path) => {
        for (const opts of SLOTS) {
            for (const allowForEach of [false, true]) {
                const mine = mm.proposePickBinding(path, ROOT, { ...opts, allowForEach });
                const theirs = webPick.proposePickBinding!(path, ROOT, { ...opts, allowForEach }) as typeof mine;
                expect({ path: mine.path, remedy: mine.remedy?.binding ?? null, id: mine.remedy?.id ?? null })
                    .toStrictEqual({ path: theirs.path, remedy: theirs.remedy?.binding ?? null, id: theirs.remedy?.id ?? null });
            }
        }
    });
});

describe('JSON nested in JSON text, several levels deep', () => {
    it.each([
        [`${base}.items[0].sku`, 'A1', 'Sku'],
        [`${base}.items[0].meta.ai.verdict["reason code"]`, 'R-7', 'Reason code'],
        [`${base}.items[*].meta.tags`, ['x', 'y', 'z'], 'Tags'],
        [`${base}.items[sku="B2"].meta.tags[0]`, 'z', 'Tags ▸ 1st'],
    ] as const)('%s', (path, want, label) => {
        expect(bh.walkPath(path, ROOT)).toStrictEqual(want);
        const ref = rt.classifyRef(path);
        expect(rt.fieldTailLabel(ref?.fieldPath)).toBe(label);
        expect(bh.bindingFromInput(path, 'expression')).toStrictEqual({ kind: 'ref', path });
        const asText = bh.formatPathForInsert(path, 'fixed');
        expect(asText).toBe(`{{${path}}}`);
        expect(cond.renderBindingValue({ kind: 'template', value: asText })).toBe(path);
        expect(cond.parseSimpleCondition(`${path} != ""`)).toMatchObject({ leftPath: path });
        expect(evaluate(path, ROOT)).toStrictEqual(want);
        expect(vp.parseValue({ kind: 'template', value: asText }).parts).toStrictEqual([{ type: 'data', path }]);
    });
});
