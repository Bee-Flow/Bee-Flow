/**
 * A bill of materials priced end to end, with the real steps: an uploaded
 * .xlsx → read_table → table (map the columns) → a Loop over the table in
 * batches with twoba_find_trade_items as its body → table (join the priced
 * lines back onto the rows, take fields out of the nested results) →
 * write_table (.xlsx, the lines to check highlighted).
 *
 * What is faked: the uploaded file's bytes, the table store's database and
 * object storage (testUtils/memoryTableStore.testkit.js, the real writer and
 * reader over memory), the generated-file ledger, and 2BA itself (a scripted
 * fetch). The action step in the loop body is the tool call with its inputs
 * resolved the way execIntegrationAction resolves them; the action step's own
 * safety and permission wrapper has its own tests.
 *
 * Run: node --test core/automationRunner/bomPricingFlow.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildXlsxWorkbook } = require('../documents/office/xlsxWorkbook');
const { readWorkbookTables } = require('./tables/workbook');
const { execReadTable, defaultDeps: readDeps } = require('./execReadTable');
const { execTable } = require('./execTable');
const { execLoop } = require('./execFlow');
const { execWriteTable } = require('./execWriteTable.mts');
const { handleRowsDeps } = require('./tables/handleRows.mts');
const { resolveInputs } = require('../automationModel/bind');
const { memoryTableStore } = require('../../testUtils/memoryTableStore.testkit');
const { twobaTransport } = require('../../integrations/twobaTransport.mts');
const auth = require('../../integrations/twobaAuth.mts');
const { executeTwobaTool } = require('../../integrations/twobaTools.mts');

const SUPPLIER = '8712345000004';
const ctx = { userId: 'u1', automationId: 'a1', runId: 'r1', rootRunId: 'r1' };

// ─── The scripted 2BA ───────────────────────────────────────────

const item = (id, tradeItemId, gtin, description, unit, basis = 1) => ({
    Id: id, TradeItemId: tradeItemId, GTIN: gtin, SupplierGLN: SUPPLIER, Description: description,
    UseUnitMeasureUnitCode: unit, PriceUnitMeasureUnitCode: unit, OrderUnitMeasureUnitCode: unit,
    NumberOfUnitsInPriceBasis: basis, QuantityOfUseUnits: 1, CurrencyCode: 'EUR', StatusCode: '126',
});
const CATALOGUE = [
    item(1, 'KAB-3X25', '8712345678937', 'Installation cable 3x2.5 mm2', 'MTR', 100),
    item(2, 'WCD-1', '8712345678913', 'Wall socket, single', 'PCE'),
    item(3, 'SCH-2', '8712345678920', 'Two-way switch', 'PCE'),
];
const NET = {
    'KAB-3X25': { ConditionId: 9001, Scenario: 3, TermsType: 'BC', GrossPriceInPriceUnit: 160, NetPriceInPriceUnit: 98, NetPricePerUseUnit: 0.98 },
    'WCD-1': { ConditionId: 9002, Scenario: 2, TermsType: 'AC', NetPriceInPriceUnit: 3.25, NetPricePerUseUnit: 3.25 },
    'SCH-2': { ConditionId: 9003, Scenario: 1, TermsType: 'PC', NetPriceInPriceUnit: 6.4, NetPricePerUseUnit: 6.4 },
};
const answer = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const calls = [];
function scripted2ba(url, init) {
    const u = new URL(url);
    const path = u.pathname.replace('/1/json', '');
    if (path === '/connect/token') return answer(200, { access_token: 'token', expires_in: 120 });
    calls.push(path);
    if (path === '/TradeItem/forGLNAndTradeItemIds') {
        const wanted = JSON.parse(init.body).tradeitemids;
        return answer(200, { TradeItems: CATALOGUE.filter((c) => wanted.includes(c.TradeItemId)), MoreAvailable: false });
    }
    if (path === '/TradeItem/DetailsForTradeItem') return answer(200, CATALOGUE.filter((c) => c.GTIN === u.searchParams.get('gtinArticle')));
    if (path === '/TradeItem/netpriceByGLNAndTradeItemIdA') {
        const net = NET[u.searchParams.get('tradeitemid')];
        return net ? answer(200, net) : answer(404, {});
    }
    return answer(404, {});
}

// ─── The bill of materials, as one is sent ────────────

const BOM = [
    ['Pos', 'Qty', 'Unit', 'Article no.', 'EAN', 'Description'],
    [1, 12, 'st', 'WCD-1', '', 'socket, article number only'],
    [2, 4, 'stuks', '', '8712345678920', 'switch, GTIN only'],
    [3, 2, 'st', 'WCD-1', '8712345678913', 'socket, both codes'],
    [4, 30, 'm', 'KAB-3X25', '', 'cable priced per 100 m'],
    [5, 5, 'bak', 'SCH-2', '', 'a unit nobody knows'],
    [6, 1, 'st', 'NOPE-9', '', 'not in the catalogue'],
];

test('an .xlsx bill of materials comes back priced, flagged and highlighted, through the real steps', async () => {
    const mem = memoryTableStore();
    const savedOpen = handleRowsDeps.openTable;
    handleRowsDeps.openTable = (h, scope) => mem.store.openTable(h, scope);
    twobaTransport.fetch = async (url, init) => scripted2ba(url, init);
    twobaTransport.sleep = async () => {};
    const secrets = { twoba_client_id_user_u1: 'id', twoba_client_secret_user_u1: 'secret', twoba_auth_mode_user_u1: 'password', twoba_username_user_u1: 'buyer', twoba_password_user_u1: 'pw' };
    auth.authDeps.configStore = () => ({ getSecret: async (k) => secrets[k] ?? null });
    auth.forgetToken('u1');
    try {
        const upload = await buildXlsxWorkbook([{ name: 'BOM', matrix: BOM }]);
        const state = { trigger: { output: { bom: { kind: 'form_upload', fileId: 'up1' }, project: 'P-2026-17' } }, steps: {}, vars: {}, loop: {} };
        const tableDeps = { openTable: mem.store.openTable, writeTable: mem.store.writeTable, minGroupFloorFor: async () => 0, isCancelRequested: async () => false };
        const run = async (step, exec) => { state.steps[step.id] = { status: 'success', output: (await exec(step)).output }; return state.steps[step.id].output; };

        // 1. The upload as a table.
        const read = await run({ id: 'read', type: 'read_table', source: { kind: 'ref', path: 'trigger.output.bom' } },
            (s) => execReadTable(s, ctx, state, 'live', { ...readDeps, writeTable: mem.store.writeTable, readSourceFile: async () => ({ buffer: upload, filename: 'bom.xlsx', size: upload.length }) }));
        assert.equal(read.table.rowCount, 6);

        // 2. The columns 2BA reads, under the names the tool takes.
        const mapped = await run({
            id: 'map', type: 'table', source: { kind: 'ref', path: 'steps.read.output.table' },
            ops: [{ op: 'select', rename: [{ from: 'Pos', to: 'ref' }, { from: 'Qty', to: 'quantity' }, { from: 'Unit', to: 'unit' }, { from: 'Article no.', to: 'tradeItemId' }, { from: 'EAN', to: 'gtin' }] }],
        }, (s) => execTable(s, ctx, state, 'live', tableDeps));
        assert.deepEqual(mapped.columns.map((c) => c.key), ['ref', 'quantity', 'unit', 'tradeItemId', 'gtin', 'Description']);

        // 3. A Loop over the TABLE (not its inline rows), four lines per 2BA call.
        const body = [{ id: 'price', type: 'integration_action', tool: 'twoba_find_trade_items', inputs: {
            supplierGln: { kind: 'literal', value: SUPPLIER },
            items: { kind: 'ref', path: 'loop.batch' },
            projectNumber: { kind: 'ref', path: 'trigger.output.project' },
        } }];
        const priceStep = async (step, _ctx, subState) => {
            const inputs = resolveInputs(step.inputs, subState, { allowSecrets: true, listAs: 'json' });
            return { output: await executeTwobaTool(step.tool, inputs, ctx.userId, { automationId: ctx.automationId, runScope: { runId: ctx.runId } }) };
        };
        const loopOut = (await execLoop({ id: 'batches', type: 'loop', overRef: 'steps.map.output.table', itemVar: 'batch', batchSize: 4, body }, ctx, state, 'live', priceStep)).output;
        state.steps.batches = { status: 'success', output: loopOut };
        assert.equal(loopOut.iterations, 2, 'six lines in batches of four');
        for (const r of loopOut.results) assert.equal(r.output.error, undefined, r.output.error);
        assert.equal(calls.filter((c) => c === '/TradeItem/forGLNAndTradeItemIds').length, 2, 'one batch lookup per pass');

        // 4. The priced lines back onto the rows, the nested fields taken out.
        const priced = await run({
            id: 'priced', type: 'table', source: { kind: 'ref', path: 'steps.map.output.table' },
            ops: [
                { op: 'join', with: { kind: 'ref', path: 'steps.batches.output.results[*].output.items' }, on: [{ left: 'ref', right: 'ref' }],
                    columns: ['status', 'description', 'unitNetPrice', 'lineTotalExVat', 'priceDate', 'conditionId', 'scenarioName', 'review', 'tradeItem'] },
                // A nested field is a cell of JSON in a table; parseJson reads one out of it.
                { op: 'derive', columns: [{ name: 'useUnit', value: { kind: 'expr', value: 'parseJson(row.tradeItem, "useUnit.code")' } }] },
                { op: 'select', drop: ['tradeItem'] },
            ],
        }, (s) => execTable(s, ctx, state, 'live', tableDeps));
        assert.equal(priced.rowCount, 6);

        // 5. The file that goes back.
        const written = await run({
            id: 'out', type: 'write_table', source: { kind: 'ref', path: 'steps.priced.output.table' }, format: 'xlsx',
            fileName: 'Priced {{trigger.output.project}}', highlightColumn: 'review',
            columns: [
                { column: 'ref', header: 'Pos' }, { column: 'tradeItemId', header: 'Article no.' }, { column: 'gtin', header: 'EAN' },
                { column: 'description', header: 'Description' }, { column: 'quantity', header: 'Qty' }, { column: 'unit', header: 'Unit' },
                { column: 'unitNetPrice', header: 'Net unit price' }, { column: 'lineTotalExVat', header: 'Line total excl. VAT' },
                { column: 'priceDate', header: 'Price date' }, { column: 'conditionId', header: 'Condition' }, { column: 'scenarioName', header: 'Price basis' }, { column: 'useUnit', header: '2BA unit' },
                { column: 'status', header: 'Status' }, { column: 'review', header: 'Check' },
            ],
        }, (s) => execWriteTable(s, ctx, state, 'live', { openTable: mem.store.openTable, storageAvailable: () => true, keepGeneratedFile: mem.keepGeneratedFile, noteRunWarning: () => {} }));
        assert.equal(written.filename, 'Priced P-2026-17.xlsx');
        assert.equal(written.rowCount, 6);
        assert.equal(written.highlightedRows, 2, 'the unknown unit and the article that was not found');
        assert.deepEqual(written.sourceHandle, { kind: 'generated_file', fileId: 'gf_1' });

        const back = await readWorkbookTables(mem.files.get('gf_1').buffer, { filename: 'out.xlsx', format: 'auto', sheets: 'all', headerRow: 1, limits: require('./tables/limits').tableLimits({}) });
        const byPos = Object.fromEntries(back.sheets[0].rows.map((r) => [String(r.Pos), r]));
        assert.equal(byPos['1']['Line total excl. VAT'], 39);
        assert.equal(byPos['1'].Condition, 9002);
        assert.equal(byPos['2'].Description, 'Two-way switch');
        assert.equal(byPos['2']['Line total excl. VAT'], 25.6);
        assert.equal(byPos['3'].Status, 'matched');
        assert.equal(byPos['3']['Line total excl. VAT'], 6.5);
        assert.equal(byPos['4']['Net unit price'], 0.98, 'per metre, from a price per 100 m');
        assert.equal(byPos['4']['Line total excl. VAT'], 29.4);
        assert.equal(byPos['4']['Price basis'], 'DiscountGroupPercentage');
        assert.equal(byPos['4']['2BA unit'], 'MTR');
        assert.equal(byPos['5'].Check, 'unit_unknown');
        assert.equal(byPos['5']['Line total excl. VAT'], null);
        assert.equal(byPos['6'].Status, 'not_found');
        assert.equal(byPos['6'].Check, 'not_found');
        for (const pos of ['1', '2', '3', '4']) assert.equal(byPos[pos].Check, null, `line ${pos} needs no look`);
        assert.match(String(byPos['1']['Price date']), /^\d{4}-\d{2}-\d{2}/);
    } finally {
        handleRowsDeps.openTable = savedOpen;
    }
});
