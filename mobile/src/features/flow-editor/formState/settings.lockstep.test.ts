/**
 * DIFFERENTIAL lockstep for the settings helpers: columnMatch, tablesRowValues,
 * routeIntents, diffSummary, notificationDefaults and outputDrafts run beside
 * their agent-hub originals. When this fails the web side changed — update the
 * port, don't loosen the test.
 */

import * as cm from './columnMatch';
import * as ds from './diffSummary';
import * as nd from './notificationDefaults';
import * as od from './outputDrafts';
import * as ri from './routeIntents';
import * as tr from './tablesRowValues';
import { CATALOG, chainDefinition } from '../bindings/testing/fixture';
import { BUILDER, requireWeb, webValue, type WebModule } from '../bindings/testing/web';
import { computeUpstreamGroups } from '../bindings/upstream';

// tablesRowValues.js imports the web's fetch helpers (and through them `uuid`,
// which is not installed here); only its pure half is ported and compared.
jest.mock('../../../../../agent-hub/src/utils/helpers', () => ({ API_BASE: '', authFetch: jest.fn() }));

const settings = (name: string) => requireWeb(`${BUILDER}/flow/settings/${name}.js`);

describe('columnMatch', () => {
    const web = settings('columnMatch');
    const titles = ['Excl. btw', 'Prijs (€)', 'Datum — Überweisung', 'Btw', 'BTW.', '', null, 'Totaal'];
    it('normalises and matches like the web', () => {
        for (const s of [...titles, 'excl_btw', 'EXCL BTW', 5]) expect(cm.normaliseColumnKey(s)).toBe(web.normaliseColumnKey?.(s));
        for (const fields of [['excl_btw', 'prijs', 'btw', 'totaal', 'Totaal', null], ['Excl btw', 'excl_btw'], [], null]) {
            expect(cm.matchColumns(fields, titles)).toStrictEqual(web.matchColumns?.(fields, titles));
            expect(cm.matchColumns(fields, null)).toStrictEqual(web.matchColumns?.(fields, null));
        }
        const exactTie = cm.matchColumns(['Totaal', 'totaal'], ['Totaal']);
        expect(exactTie).toStrictEqual(web.matchColumns?.(['Totaal', 'totaal'], ['Totaal']));
        const columns = [{ id: 3, title: 'Excl. btw' }, { id: 4, title: 'Name' }, { id: null, title: 'Btw' }, { id: 5, title: 'BTW.' }];
        for (const key of ['excl_btw', 'name', '4', 'btw', '', '€', 'nope']) {
            expect(cm.resolveKeyToColumn(key, columns)).toStrictEqual(web.resolveKeyToColumn?.(key, columns));
        }
        expect(cm.resolveKeyToColumn('x', null)).toStrictEqual(web.resolveKeyToColumn?.('x', null));
    });
});

describe('tablesRowValues', () => {
    const web = settings('tablesRowValues');
    it('tools, schemas and table ids', () => {
        expect(tr.TABLES_ROW_TOOLS).toStrictEqual(webValue(web, 'TABLES_ROW_TOOLS'));
        for (const tool of ['nextcloud_tables_create_row', 'x']) expect(tr.isTablesRowTool(tool)).toBe(web.isTablesRowTool?.(tool));
        const schemas = [null, { properties: { a: {} } }, { properties: { values: {}, tableId: {} }, required: ['values', 'tableId'] }, { properties: { values: {} } }];
        for (const s of schemas) expect(tr.withoutValuesInput(s as never)).toStrictEqual(web.withoutValuesInput?.(s));
        for (const b of [7, 0, 2.5, ' 12 ', '0', 'Leads', ' ', null, { kind: 'literal', value: '9' }, { kind: 'ref', path: 'x' }, true]) {
            expect(tr.literalTableId(b)).toStrictEqual(web.literalTableId?.(b));
        }
        expect(tr.columnsPath('a b')).toBe(String(web.columnsEndpoint?.('a b')));
    });

    it('columns, kinds and the answer reader', () => {
        const cols = [{ id: 1, title: ' Name ', type: 'text', mandatory: 1 }, {}, null, { title: 'Pick', type: 'selection', subtype: 'multi' }];
        for (const c of cols) expect(tr.normaliseColumn(c)).toStrictEqual(web.normaliseColumn?.(c));
        for (const c of [{ type: 'text' }, { type: 'number' }, { type: 'datetime' }, { type: 'selection', subtype: 'check' }, { type: 'selection', subtype: 'multi' }, { type: 'selection' }, { type: 'usergroup' }, { type: 'x' }, null]) {
            expect(tr.columnKind(c)).toBe(web.columnKind?.(c));
        }
        expect(tr.TYPE_LABEL).toStrictEqual(webValue(web, 'TYPE_LABEL'));
        expect(tr.TYPE_LABEL_UNKNOWN).toStrictEqual(webValue(web, 'TYPE_LABEL_UNKNOWN'));
        expect(tr.readColumnsAnswer({ columns: cols })).toStrictEqual(cols.map((c) => web.normaliseColumn?.(c)).filter((c) => (c as { title: string }).title));
        expect(tr.readColumnsAnswer(cols)).toHaveLength(2);
        expect(() => tr.readColumnsAnswer({ nope: 1 })).toThrow('no columns');
    });

    it('the values map, key placement and auto-map sources', () => {
        for (const v of [null, '', '{"A": 1}', '[1]', 'text', 5, [1], { kind: 'ref', path: 'x' }, { kind: 'literal', value: '' },
            { kind: 'literal', value: { A: 1 } }, { kind: 'literal', value: '{"B":2}' }, { kind: 'literal', value: 'nope' }, { kind: 'literal', value: 3 }, { Title: { kind: 'literal', value: 1 } }]) {
            expect(tr.readValuesMap(v)).toStrictEqual(web.readValuesMap?.(v));
        }
        const columns = [{ id: 1, title: 'Excl. btw' }, { id: 2, title: 'Name' }];
        const map = { excl_btw: 1, 'Excl. btw': 2, name: 3, Stray: 4, 2: 5 };
        expect(tr.placeKeys(map, columns)).toStrictEqual(web.placeKeys?.(map, columns));
        expect(tr.placeKeys(null, columns)).toStrictEqual(web.placeKeys?.(null, columns));
        const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);
        for (const g of [...groups, null]) expect(tr.candidateFields(g)).toStrictEqual(web.candidateFields?.(g));
        expect(tr.mappableGroups(groups)).toStrictEqual(web.mappableGroups?.(groups));
        for (const step of [null, { forEach: { overRef: 'x', itemVar: 'result' } }, { forEach: { overRef: 'x' } }]) {
            expect(tr.feedingGroup(groups, step)).toStrictEqual(web.feedingGroup?.(groups, step));
        }
        for (const text of ['A, b;\nA ,c', '', null]) expect(tr.parseTitleList(text)).toStrictEqual(web.parseTitleList?.(text));
    });
});

describe('routeIntents', () => {
    const web = settings('routeIntents');

    const FIELDS = [
        { path: 'item.name', label: 'File name', sample: 'report.PDF' },
        { path: 'item.subject', sample: 'Hello' },
        { path: 'item.amount', sample: 1200 },
        { path: 'item.created_at', sample: '2026-01-02T10:00:00Z' },
        { path: 'item.from_email', label: 'From email', sample: 'a@b.nl' },
        { path: '' },
    ];
    const TEXTS = [
        '', 'split pdf, word and powerpoint', 'excel files', 'images or jpg', 'subject contains "urgent" and "asap"',
        'mentions invoice, quote or order.', 'with these', 'between 2026-01-01 and 2026-01-31', 'before 2026-02-01',
        'after 2026-01-15 and since 2026-03-01', 'on 2026-02-30', 'on 2026-01-05', 'amount over 1,000', 'no more than 100',
        'between 5 and 10', 'at least 3 at most 9', 'last week', '12-01-2026', 'nothing at all', 'from email contains x',
        'amount between 1.5 and 2.5', 'a b c d e f g h i contains "1","2","3","4","5","6","7","8","9"',
        'between 2026-01-01 and 2026-02-30', 'after 2026-02-30', 'on 2026-13-01', 'up to 2026-05-01', 'on or after 2026-01-01',
        'maximum of 5', 'under 3', 'minimum 2', 'no less than -4', 'smaller than 1,5', 'including invoice in the subject',
        '“quoted” thing', "'single' quotes", 'split pdf pdf', 'between 2026-01-01 and 2026-01-31 and before 2026-03-01',
    ];

    it.each(TEXTS)('suggestOutputs(%p)', (text) => {
        expect(ri.suggestOutputs(text, { fields: FIELDS })).toStrictEqual(web.suggestOutputs?.(text, { fields: FIELDS }));
        expect(ri.suggestOutputs(text, { fields: [{ path: 'item.x', sample: true }] })).toStrictEqual(
            web.suggestOutputs?.(text, { fields: [{ path: 'item.x', sample: true }] }),
        );
        expect(ri.suggestOutputs(text)).toStrictEqual(web.suggestOutputs?.(text));
    });

    it('slugs, file types and match counts', () => {
        for (const s of ['Hello World!', '', '__x__', null]) expect(ri.slugName(s)).toBe(web.slugName?.(s));
        expect(ri.FILE_TYPES).toStrictEqual(webValue(web, 'FILE_TYPES'));
        const rules = ri.suggestOutputs('split pdf and word', { fields: FIELDS }).rules.concat([{ name: 'bad', expr: 'bogus((' }]);
        const rows = [{ name: 'a.pdf' }, { name: 'b.DOCX' }, { name: 'c.txt' }, {}];
        for (const opts of [undefined, { root: { x: 1 } }, { itemVar: 'row' }, { root: [1] }]) {
            expect(ri.matchCounts(rules, rows, opts)).toStrictEqual(web.matchCounts?.(rules, rows, opts));
        }
        expect(ri.matchCounts([], rows)).toBe(web.matchCounts?.([], rows));
        expect(ri.matchCounts(rules, null)).toBe(web.matchCounts?.(rules, null));
    });
});

describe('diffSummary', () => {
    // The web's mirror (Builder/diffSummary.js) went with handoff 5; the server's is the original.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- server CommonJS, loaded as-is
    const web = require('../../../../../server/automation/diffSummary.js') as WebModule;
    it('summarises like the web', () => {
        const a = chainDefinition();
        const b = { ...a, description: 'changed', steps: [...(a.steps || []).slice(1).map((s, i) => (i === 0 ? { ...s, label: 'Renamed' } : s)), { id: 'new', type: 'code' }], edges: (a.edges || []).slice(2) };
        const c = { ...b, steps: [...(b.steps || []), { id: 'new2' }, null, { id: null }], edges: [...(b.edges || []), { from: 'x', to: 'y' }, { from: 'x' }, null], trigger: { id: 'z' }, layers: {} };
        for (const [p, n] of [[a, b], [b, a], [a, a], [a, c], [null, a], [a, 'x'], [{ steps: [{ id: 1, b: { y: 1, x: 2 } }] }, { steps: [{ id: 1, b: { x: 2, y: 1 } }] }]]) {
            expect(ds.summarizeDefinitionDiff(p, n)).toStrictEqual(web.summarizeDefinitionDiff?.(p, n));
            expect(ds.summarizeDefinitionDiffLine(p, n)).toBe(web.summarizeDefinitionDiffLine?.(p, n));
        }
        const one = { steps: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] };
        expect(ds.summarizeDefinitionDiff({}, one)).toStrictEqual(web.summarizeDefinitionDiff?.({}, one));
        expect(ds.summarizeDefinitionDiff(one, {})).toStrictEqual(web.summarizeDefinitionDiff?.(one, {}));
        expect(ds.summarizeDefinitionDiff(one, { steps: [{ id: 'a', x: 1 }], edges: [] })).toStrictEqual(web.summarizeDefinitionDiff?.(one, { steps: [{ id: 'a', x: 1 }], edges: [] }));
    });
});

describe('notificationDefaults', () => {
    const web = requireWeb(`${BUILDER}/notificationDefaults.js`);
    it('tables and channel rules match', () => {
        expect(nd.NOTIFICATION_DEFAULTS).toStrictEqual(webValue(web, 'NOTIFICATION_DEFAULTS'));
        // Handoff 5 replaced the policy's bell levels with urgencies (the old
        // levels live on as LEGACY_LEVEL_TO_URGENCY) and its channels with bell/email/talk.
        for (const name of ['NOTIFICATION_EVENTS', 'NOTIFICATION_CHANNELS', 'NOTIFICATION_URGENCIES', 'RECIPIENT_TYPES', 'DELIVERY_MODES',
            'MAX_RECIPIENTS', 'MAX_PER_HOUR_LIMIT', 'DEFAULT_DIGEST_TIME', 'LEGACY_CHANNEL_MAP', 'LEGACY_LEVEL_TO_URGENCY']) {
            expect((nd as Record<string, unknown>)[name]).toStrictEqual(webValue(web, name));
        }
        expect(nd.VALID_CHANNELS).toStrictEqual(webValue(web, 'VALID_CHANNELS'));
        expect(nd.CHANNEL_LABELS).toStrictEqual(webValue(web, 'CHANNEL_LABELS'));
        type WebOption = { key: string; label: string; hint?: string };
        const asWeb = (list: readonly nd.ChannelOption[]) => list.map(({ labelEn, hintEn, ...rest }) => ({ ...rest, label: labelEn, ...(hintEn ? { hint: hintEn } : {}) }));
        expect(asWeb(nd.CHANNEL_OPTIONS)).toStrictEqual(webValue<WebOption[]>(web, 'CHANNEL_OPTIONS'));
        for (const scope of ['policy', 'step', undefined]) expect(asWeb(nd.channelOptionsFor(scope))).toStrictEqual(web.channelOptionsFor?.(scope));
        for (const opt of nd.CHANNEL_OPTIONS) {
            expect(nd.channelLabel(opt)).toBe(opt.labelEn);
            expect(nd.channelHint(opt)).toBe(opt.hintEn || '');
        }
        for (const c of [null, [], ['email', 'bogus', 'inapp', 'email'], ['notification'], 'x']) {
            expect(nd.normalizeChannels(c)).toStrictEqual(web.normalizeChannels?.(c));
            expect(nd.stepChannelsToUi(c)).toStrictEqual(web.stepChannelsToUi?.(c));
        }
    });
});

describe('outputDrafts', () => {
    const web = requireWeb(`${BUILDER}/outputDrafts.ts`);
    const withoutIds = (v: unknown) => JSON.parse(JSON.stringify(v, (k, val) => (k === 'id' ? undefined : val)));
    it('drafts and values round-trip like the web', () => {
        for (const text of ['{"a":1,"b":"x\\ny","c":true,"d":null,"e":{"f":1}}', '[{"a":1},{"b":2},3]', '"single"', '42', 'not json', '[]']) {
            const mine = od.draftRecords(text);
            expect(withoutIds(mine)).toStrictEqual(withoutIds(web.draftRecords?.(text)));
            const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
            const shape = od.outputShape(parsed);
            expect(shape).toBe(web.outputShape?.(parsed));
            expect(od.draftValue(shape, mine)).toStrictEqual(web.draftValue?.(shape, mine));
        }
        expect(od.draftValue(null, [])).toStrictEqual(web.draftValue?.(null, []));
        expect(od.MAX_PINNED_BYTES).toBe(webValue(web, 'MAX_PINNED_BYTES'));
        for (const v of [{ a: 'é' }, 1n, undefined, 'x']) {
            expect(od.jsonByteLength(v)).toBe(web.jsonByteLength?.(v));
            expect(od.safeJsonText(v)).toBe(web.safeJsonText?.(v));
        }
        for (const kind of ['text', 'number', 'yesno', 'nested'] as const) {
            for (const v of ['1.', '', ' 12 ', 'ja', 0, 3, true, null]) {
                expect(od.typedValue(kind, String(v ?? ''))).toStrictEqual(web.typedValue?.(kind, String(v ?? '')));
                expect(od.coerceToKind(kind, v)).toStrictEqual(web.coerceToKind?.(kind, v));
            }
        }
        for (const k of ['text', 'x']) expect(od.isOutFieldKind(k)).toBe(web.isOutFieldKind?.(k));
        expect(od.rowText(null)).toBe(web.rowText?.(null));
        expect(od.isMultilineText('a\nb')).toBe(true);
        expect(od.nextRowId()).toMatch(/^of\d+$/);
    });
});
