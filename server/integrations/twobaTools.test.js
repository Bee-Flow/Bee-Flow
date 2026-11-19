/**
 * The 2BA tools (twobaTools.mts, twobaLookup.mts) against a scripted 2BA: which
 * calls go out and with what, how answers become priced lines, the caps, the
 * errors, the upload and the connection test. No network, no database.
 *
 * Run: node --test integrations/twobaTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { twobaTransport } = require('./twobaTransport.mts');
const auth = require('./twobaAuth.mts');
const tools = require('./twobaTools.mts');
const lookup = require('./twobaLookup.mts');
const sourceFile = require('../core/automationRunner/tables/sourceFile.js');

const GLN = '8711389000001';
let secrets = {};
auth.authDeps.configStore = () => ({ getSecret: async (k) => secrets[k] ?? null });
twobaTransport.sleep = async () => {};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

let calls = [];
let inFlight = 0;
let maxInFlight = 0;
/** Routes by path: `routes[path](url, init)` answers; the token endpoint always succeeds. */
function script(routes) {
    calls = [];
    inFlight = 0;
    maxInFlight = 0;
    twobaTransport.fetch = async (url, init) => {
        const u = new URL(url);
        if (u.pathname === '/connect/token') return json(200, { access_token: 'tok', expires_in: 120 });
        calls.push({ url: u, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        const handler = routes[u.pathname.replace('/1/json', '').replace('/1/streaming', '')];
        return handler ? handler(u, init) : json(404, {});
    };
}

const cable = (over = {}) => ({
    Id: 11, TradeItemId: 'K-100', GTIN: '08712345678906', SupplierGLN: GLN, Description: 'Cable 3x2.5',
    UseUnitMeasureUnitCode: 'MTR', UseUnitMeasureUnitDescription: 'meter', PriceUnitMeasureUnitCode: 'MTR', OrderUnitMeasureUnitCode: 'RO',
    NumberOfUnitsInPriceBasis: 100, QuantityOfUseUnits: 100, PackageTypeCode: 'RO', StatusCode: '126', CurrencyCode: 'EUR',
    StartDatePriceInformation: '/Date(1767225600000)/', VatPercentage: 21, ...over,
});
const socket = (over = {}) => ({
    Id: 22, TradeItemId: 'S-7', GTIN: '04048357465826', SupplierGLN: GLN, Description: 'Socket', UseUnitMeasureUnitCode: 'PCE',
    PriceUnitMeasureUnitCode: 'PCE', OrderUnitMeasureUnitCode: 'PCE', NumberOfUnitsInPriceBasis: 1, QuantityOfUseUnits: 1, CurrencyCode: 'EUR', ...over,
});
const PRICES = {
    'K-100': { ConditionId: 501, Scenario: 3, TermsType: 'BC', GrossPriceInPriceUnit: 200, NetPriceInPriceUnit: 125.5, NetPricePerUseUnit: 1.255, DiscountPercentage: 37.25 },
    'S-7': { ConditionId: 502, Scenario: 1, TermsType: 'PC', NetPriceInPriceUnit: 4.1, NetPricePerUseUnit: 4.1 },
};
const ROUTES = {
    '/TradeItem/forGLNAndTradeItemIds': (_u, init) => {
        const ids = JSON.parse(init.body).tradeitemids;
        return json(200, { TradeItems: [cable(), socket()].filter((t) => ids.includes(t.TradeItemId.toUpperCase())), MoreAvailable: false });
    },
    '/TradeItem/DetailsForTradeItem': (u) => json(200, [cable(), socket()].filter((t) => t.GTIN.endsWith(u.searchParams.get('gtinArticle').replace(/^0+/, '')))),
    '/TradeItem/netpriceByGLNAndTradeItemIdA': (u) => (PRICES[u.searchParams.get('tradeitemid')] ? json(200, PRICES[u.searchParams.get('tradeitemid')]) : json(404, {})),
};

const SAVED_ENV = ['TWOBA_MAX_ITEMS', 'TWOBA_MAX_UPLOAD_BYTES', 'TWOBA_MAX_RETRIES'];
test.beforeEach(() => {
    for (const k of SAVED_ENV) delete process.env[k];
    auth.forgetToken('u1');
    secrets = {
        twoba_client_id_user_u1: 'client-1', twoba_client_secret_user_u1: 'secret-1', twoba_auth_mode_user_u1: 'password',
        twoba_username_user_u1: 'buyer', twoba_password_user_u1: 'pw',
    };
});

test('the tool set: four twoba_ tools, one write', () => {
    assert.deepEqual(tools.TWOBA_TOOLS.map((t) => t.function.name), ['twoba_find_trade_items', 'twoba_net_price', 'twoba_list_condition_databases', 'twoba_upload_conditions']);
    assert.equal(tools.isTwobaTool('twoba_net_price'), true);
    assert.equal(tools.isTwobaTool('frappe_crm_list_leads'), false);
});

test('find: one batch call for the article numbers, one per GTIN, one price per article; lines priced and flagged', async () => {
    script(ROUTES);
    const out = await tools.executeTwobaTool('twoba_find_trade_items', {
        supplierGln: GLN, projectNumber: 'P-42',
        items: [
            { ref: 'r1', tradeItemId: 'k-100', quantity: '30', unit: 'm' },
            { ref: 'r2', gtin: '4048357465826', quantity: 12, unit: 'stuks' },
            { ref: 'r3', tradeItemId: 'NOPE', quantity: 1 },
            { ref: 'r4', tradeItemId: 'K-100', gtin: '4048357465826', quantity: 2, unit: 'rol' },
            { ref: 'r5', gtin: '1234567890128', quantity: 1 },
        ],
    }, 'u1');
    assert.equal(out.error, undefined, out.error);
    const [r1, r2, r3, r4, r5] = out.items;
    assert.equal(r1.status, 'matched');
    assert.equal(r1.unitNetPrice, 1.255);
    assert.equal(r1.lineTotalExVat, 37.65);
    assert.deepEqual(r1.flags, []);
    assert.equal(r1.price.scenario, 3);
    assert.equal(r1.price.scenarioName, 'DiscountGroupPercentage');
    assert.equal(r1.price.conditionId, 501);
    assert.equal(r1.tradeItem.useUnit.code, 'MTR');
    assert.equal(r1.tradeItem.startDatePriceInformation, '2026-01-01T00:00:00.000Z');
    assert.match(r1.priceDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r2.status, 'matched');
    assert.equal(r2.lineTotalExVat, 49.2);
    assert.equal(r3.status, 'not_found');
    assert.equal(r3.lineTotalExVat, null);
    assert.equal(r4.status, 'code_mismatch');
    assert.ok(r4.flags.includes('codes_disagree'));
    assert.ok(r4.flags.includes('unit_mismatch'));
    assert.equal(r4.candidates[0].tradeItemId, 'S-7');
    assert.equal(r5.status, 'not_found');
    assert.deepEqual(out.summary.byStatus, { matched: 2, not_found: 2, multiple: 0, code_mismatch: 1 });
    assert.equal(out.summary.totalExVat, 86.85);
    assert.equal(out.summary.currency, 'EUR');

    const paths = calls.map((c) => c.url.pathname);
    assert.equal(paths.filter((p) => p.endsWith('/forGLNAndTradeItemIds')).length, 1);
    assert.equal(paths.filter((p) => p.endsWith('/DetailsForTradeItem')).length, 2);
    // K-100 with no order quantity (counted in metres, ordered per roll) and S-7 with 12: two prices.
    const priced = calls.filter((c) => c.url.pathname.endsWith('/netpriceByGLNAndTradeItemIdA'));
    assert.equal(priced.length, 2);
    for (const c of priced) {
        assert.deepEqual([...c.url.searchParams.keys()].sort(), c.url.searchParams.has('orderQuantity') ? ['gln', 'orderQuantity', 'projectnumber', 'tradeitemid'] : ['gln', 'projectnumber', 'tradeitemid']);
        assert.equal(c.url.searchParams.get('projectnumber'), 'P-42');
    }
    assert.equal(priced.find((c) => c.url.searchParams.get('tradeitemid') === 'S-7').url.searchParams.get('orderQuantity'), '12');
});

test('find: only article data goes to 2BA, with the bearer token in the header', async () => {
    script(ROUTES);
    await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ tradeItemId: 'K-100', quantity: 1 }] }, 'u1');
    const batch = calls.find((c) => c.url.pathname.endsWith('/forGLNAndTradeItemIds'));
    assert.deepEqual(Object.keys(batch.body).sort(), ['gln', 'resultLimit', 'tradeitemids']);
    assert.deepEqual(batch.body.tradeitemids, ['K-100']);
    for (const c of calls) {
        assert.equal(c.init.headers.Authorization, 'Bearer tok');
        const sent = `${c.url}${JSON.stringify(c.body ?? '')}`;
        for (const personal of ['buyer', 'pw', 'secret-1', 'u1']) assert.ok(!sent.includes(personal), `${personal} in ${sent}`);
    }
});

test('find: pages through MoreAvailable with NextOffset', async () => {
    script({
        ...ROUTES,
        '/TradeItem/forGLNAndTradeItemIds': (_u, init) => {
            const body = JSON.parse(init.body);
            return body.resultOffset === undefined
                ? json(200, { TradeItems: [cable()], MoreAvailable: true, NextOffset: 987654 })
                : json(200, { TradeItems: [socket()], MoreAvailable: false });
        },
    });
    const out = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ tradeItemId: 'K-100' }, { tradeItemId: 'S-7' }] }, 'u1');
    assert.deepEqual(out.items.map((i) => i.status), ['matched', 'matched']);
    const batches = calls.filter((c) => c.url.pathname.endsWith('/forGLNAndTradeItemIds'));
    assert.equal(batches[1].body.resultOffset, 987654);
});

test('find: per-line calls run at most four at a time; one article is priced once', async () => {
    // 12 distinct articles, each line twice: 12 price calls, never more than four at once.
    const ids = Array.from({ length: 12 }, (_, i) => `A-${i}`);
    script({
        '/TradeItem/forGLNAndTradeItemIds': () => json(200, { TradeItems: ids.map((id, i) => socket({ Id: 100 + i, TradeItemId: id })), MoreAvailable: false }),
        '/TradeItem/netpriceByGLNAndTradeItemIdA': () => json(200, PRICES['S-7']),
    });
    const items = [...ids, ...ids].map((tradeItemId) => ({ tradeItemId, quantity: 1 }));
    const out = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items }, 'u1');
    assert.equal(out.items.length, 24);
    assert.equal(out.summary.totalExVat, 98.4);
    assert.equal(calls.filter((c) => c.url.pathname.endsWith('/netpriceByGLNAndTradeItemIdA')).length, 12);
    assert.ok(maxInFlight > 1 && maxInFlight <= lookup.CONCURRENCY, `max in flight ${maxInFlight}`);
});

test('find: caller mistakes are a 400 before any call', async () => {
    script(ROUTES);
    const badGln = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: '8711389000002', items: [{ tradeItemId: 'A' }] }, 'u1');
    assert.equal(badGln.status, 400);
    assert.equal(badGln.code, 'invalid_arguments');
    assert.match(badGln.error, /check digit/);
    const noCode = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ quantity: 2 }] }, 'u1');
    assert.match(noCode.error, /tradeItemId or a gtin/);
    const badQty = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ tradeItemId: 'A', quantity: 'lots' }] }, 'u1');
    assert.match(badQty.error, /quantity must be a number/);
    process.env.TWOBA_MAX_ITEMS = '2';
    const tooMany = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ tradeItemId: 'A' }, { tradeItemId: 'B' }, { tradeItemId: 'C' }] }, 'u1');
    assert.equal(tooMany.code, 'twoba_too_many_items');
    process.env.TWOBA_MAX_ITEMS = '0';
    const unlimited = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ tradeItemId: 'A' }, { tradeItemId: 'B' }, { tradeItemId: 'C' }] }, 'u1');
    assert.equal(unlimited.error, undefined);
    const invalidGtin = await tools.executeTwobaTool('twoba_find_trade_items', { supplierGln: GLN, items: [{ gtin: '4048357465827' }] }, 'u1');
    assert.deepEqual(invalidGtin.items[0].flags, ['invalid_gtin']);
    assert.equal(invalidGtin.items[0].status, 'not_found');
});

test('not configured, or 2BA down: a clear error with its status, never a throw', async () => {
    secrets = {};
    const none = await tools.executeTwobaTool('twoba_list_condition_databases', {}, 'u1');
    assert.equal(none.code, 'twoba_not_configured');
    assert.equal(none.status, 400);
    secrets = { twoba_client_id_user_u1: 'c', twoba_client_secret_user_u1: 's', twoba_auth_mode_user_u1: 'password', twoba_username_user_u1: 'b', twoba_password_user_u1: 'p' };
    script({ '/CompanyConditions/databases': () => json(503, {}), '/CompanyConditions/currentUserStatus': () => json(503, {}) });
    const down = await tools.executeTwobaTool('twoba_list_condition_databases', {}, 'u1');
    assert.equal(down.status, 503);
    assert.match(down.error, /^2BA: /);
});

test('net price: by GTIN, the trade item is found first; flags from the scenario', async () => {
    script({ ...ROUTES, '/TradeItem/netpriceByGLNAndTradeItemIdA': () => json(200, { ...PRICES['S-7'], Scenario: 5 }) });
    const out = await tools.executeTwobaTool('twoba_net_price', { supplierGln: GLN, gtin: '04048357465826', orderQuantity: 10 }, 'u1');
    assert.equal(out.status, 'matched');
    assert.equal(out.tradeItemId, 'S-7');
    assert.equal(out.unitNetPrice, 4.1);
    assert.ok(out.flags.includes('gross_only_no_condition'));
    const call = calls.find((c) => c.url.pathname.endsWith('/netpriceByGLNAndTradeItemIdA'));
    assert.equal(call.url.searchParams.get('orderQuantity'), '10');
    script(ROUTES);
    const missing = await tools.executeTwobaTool('twoba_net_price', { supplierGln: GLN, tradeItemId: 'NOPE' }, 'u1');
    assert.equal(missing.status, 'not_found');
    assert.ok(missing.flags.includes('no_price'));
});

test('condition databases: the list and the database in use, no user names', async () => {
    script({
        '/CompanyConditions/databases': () => json(200, [{ Id: 3, Name: 'Main', CreateDate: '/Date(1767225600000)/' }]),
        '/CompanyConditions/currentUserStatus': () => json(200, { Username: 'buyer', UserFullname: 'A Person', Companyname: 'Example Company BV', Databasename: 'Main' }),
    });
    const out = await tools.executeTwobaTool('twoba_list_condition_databases', {}, 'u1');
    assert.deepEqual(out, { databases: [{ id: 3, name: 'Main', createDate: '2026-01-01T00:00:00.000Z' }], current: { companyName: 'Example Company BV', databaseName: 'Main' } });
});

test('upload: only inside a run; the file of the run goes to the streaming endpoint with process; sha256 of what was sent', async () => {
    const outside = await tools.executeTwobaTool('twoba_upload_conditions', { databaseId: 3, sourceHandle: { kind: 'form_upload', fileId: 'f1' } }, 'u1');
    assert.equal(outside.code, 'twoba_needs_run');
    const bytes = Buffer.from('ICC;1.1;conditions\n');
    let asked;
    sourceFile.readSourceFile = async (handle, ctx, deps) => { asked = { handle, ctx, cap: deps.limits().maxFileBytes }; return { buffer: bytes, filename: 'supplier.icc', size: bytes.length, mimeType: 'text/plain' }; };
    script({ '/CompanyConditionsUpload/UploadFileToDatabase': () => json(200, { Files: [{ ImportId: 77, Name: 'supplier.icc', Size: bytes.length, Error: null }] }) });
    const ctx = { automationId: 'a1', runScope: { runId: 'run-1', rootRunId: 'run-0' } };
    const out = await tools.executeTwobaTool('twoba_upload_conditions', { databaseId: '3', sourceHandle: { kind: 'form_upload', fileId: 'f1' }, process: 'ProcessIfAllOk' }, 'u1', ctx);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.sha256, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(out.files, [{ importId: 77, name: 'supplier.icc', size: bytes.length, error: null }]);
    assert.deepEqual(asked.ctx, { automationId: 'a1', runId: 'run-1', rootRunId: 'run-0' });
    assert.equal(asked.cap, tools.DEFAULT_MAX_UPLOAD_BYTES);
    const call = calls[0];
    assert.equal(call.url.origin + call.url.pathname, 'https://api.2ba.nl/1/streaming/CompanyConditionsUpload/UploadFileToDatabase');
    assert.equal(call.url.searchParams.get('databaseId'), '3');
    assert.ok(call.init.body instanceof FormData);
    assert.equal(call.init.body.get('process'), 'ProcessIfAllOk');
    assert.equal(call.init.body.get('file').name, 'supplier.icc');

    sourceFile.readSourceFile = async () => ({ buffer: bytes, filename: 'list.pdf', size: 3 });
    const wrongType = await tools.executeTwobaTool('twoba_upload_conditions', { databaseId: 3, sourceHandle: { kind: 'form_upload', fileId: 'f1' } }, 'u1', ctx);
    assert.equal(wrongType.code, 'twoba_file_type');
    sourceFile.readSourceFile = async () => { throw Object.assign(new Error('x'), { errorClass: 'table_source_too_large' }); };
    const big = await tools.executeTwobaTool('twoba_upload_conditions', { databaseId: 3, sourceHandle: { kind: 'form_upload', fileId: 'f1' } }, 'u1', ctx);
    assert.equal(big.status, 413);
    const badProcess = await tools.executeTwobaTool('twoba_upload_conditions', { databaseId: 3, sourceHandle: {}, process: 'Now' }, 'u1', ctx);
    assert.equal(badProcess.code, 'invalid_arguments');
});

test('connection test: company and OCS database; a refused password says so', async () => {
    script({ '/CompanyConditions/currentUserStatus': () => json(200, { Companyname: 'Example Company BV', Databasename: 'Main', Username: 'buyer' }) });
    const cfg = await auth.configFor('u1');
    assert.deepEqual(await tools.testTwobaConnection('u1', cfg), { ok: true, companyName: 'Example Company BV', databaseName: 'Main' });
    twobaTransport.fetch = async () => json(400, { error: 'invalid_grant' });
    const refused = await tools.testTwobaConnection('u1', cfg);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'twoba_credentials_refused');
});
