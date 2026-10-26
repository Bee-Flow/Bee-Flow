/**
 * The NMBRS page cache at the SOAP boundary: `global.fetch` is scripted, `configStore` is
 * the real store over PGlite, and the tools run through executeNmbrsTool exactly as the agent calls them.
 * The point: a full walk over a large company costs ONE SOAP call, not one per page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL configStore (encryption included) over an in-process PGlite behind db.js's pool.
process.env.MASTER_ENCRYPTION_KEY ||= require('node:crypto').randomBytes(32).toString('hex');
const { usePglitePool } = require('../testUtils/pglitePool');
const pglite = usePglitePool();
const configStore = require('../stores/configStore');

const { executeNmbrsTool, clearNmbrsPageCacheForUser } = require('./nmbrsTools');
const { resetPageCache, getPageCache } = require('./nmbrsPageCache.mts');
const log = require('../telemetry/log');

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2';
/**
 * Store one secret the way configStore.setSecret does (encrypted at rest, same table), minus its
 * fire-and-forget audit write, which would race this test's one-session PGlite.
 */
async function putSecret(key, value) {
    await configStore.initDB();
    await pglite.pg.query(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, configStore.encryptValue(value, null)],
    );
    configStore._applyInvalidation(key);
}
async function setCreds(userId, { token = TOKEN, subdomain = 'acme' } = {}) {
    await putSecret(`nmbrs_api_mode_user_${userId}`, 'soap');
    await putSecret(`nmbrs_subdomain_user_${userId}`, subdomain);
    await putSecret(`nmbrs_email_user_${userId}`, 'me@acme.nl');
    await putSecret(`nmbrs_token_user_${userId}`, token);
    await putSecret(`nmbrs_env_user_${userId}`, 'production');
}

let soapCalls = [];
let respond;
function installFetch(handler) {
    soapCalls = [];
    respond = handler;
    global.fetch = async (url, opts) => {
        soapCalls.push({ url, body: opts.body, action: opts.headers.SOAPAction });
        const out = await respond(soapCalls.length, opts.body);
        return { ok: out.ok !== false, status: out.status || 200, text: async () => out.text, json: async () => ({}) };
    };
}
function soapResponse(method, innerXml) {
    return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
        `<${method}Response><${method}Result>${innerXml}</${method}Result></${method}Response></soap:Body></soap:Envelope>`;
}
const contractsXml = (n) => Array.from({ length: n }, (_, i) =>
    `<EmployeeContractItemGlobal><EmployeeId>${i + 1}</EmployeeId><ContractId>${1000 + i}</ContractId></EmployeeContractItemGlobal>`).join('');
const CONTRACTS = (n) => ({ text: soapResponse('Contract_GetAll_AllEmployeesByCompany', contractsXml(n)) });

/** Walk a tool page by page the way an agent does; returns every page. */
async function walk(tool, args, userId, ctx = {}) {
    const pages = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard++) {
        const page = await executeNmbrsTool(tool, { ...args, offset, limit: 100 }, userId, ctx);
        assert.ok(!page.error, page.error);
        pages.push(page);
        if (!page.hasMore) return pages;
        offset = page.nextOffset;
    }
    throw new Error('walk did not end');
}

test.beforeEach(async () => {
    delete process.env.NMBRS_PAGE_CACHE_TTL_MS;
    delete process.env.NMBRS_PAGE_CACHE_MAX_ENTRIES;
    delete process.env.NMBRS_PAGE_CACHE_MAX_ITEMS;
    resetPageCache();
    await setCreds('u1');
});
test.after(() => pglite.close());
test.afterEach(() => {
    delete process.env.NMBRS_PAGE_CACHE_TTL_MS;
    resetPageCache();
});

const TOOL = 'nmbrs_list_company_contracts';

test('a walk over 10 pages makes ONE SOAP call with the cache, 10 without', async () => {
    installFetch(() => CONTRACTS(1000));
    const cached = await walk(TOOL, { companyId: '9' }, 'u1');
    assert.equal(cached.length, 10);
    assert.equal(soapCalls.length, 1, 'cache on: one SOAP call for the whole walk');
    assert.equal(cached.flatMap((p) => p.items).length, 1000);

    process.env.NMBRS_PAGE_CACHE_TTL_MS = '0';
    resetPageCache();
    installFetch(() => CONTRACTS(1000));
    const uncached = await walk(TOOL, { companyId: '9' }, 'u1');
    assert.equal(soapCalls.length, 10, 'cache off: one SOAP call per page (the old behaviour)');
    // Same shape and same content either way.
    assert.deepEqual(cached, uncached);
    console.log(`SOAP calls for a 10-page walk: ${soapCalls.length} without the cache, 1 with it`);
});

test('a page keeps exactly the same shape and fields as before', async () => {
    installFetch(() => CONTRACTS(250));
    const [p1, p2, p3] = await walk(TOOL, { companyId: '9' }, 'u1');
    assert.deepEqual(Object.keys(p2).sort(), Object.keys(p1).sort());
    assert.deepEqual([p1.total, p1.offset, p1.count, p1.hasMore, p1.nextOffset], [250, 0, 100, true, 100]);
    assert.deepEqual([p2.total, p2.offset, p2.count, p2.hasMore, p2.nextOffset], [250, 100, 100, true, 200]);
    assert.deepEqual([p3.total, p3.offset, p3.count, p3.hasMore, p3.nextOffset], [250, 200, 50, false, null]);
    assert.deepEqual(p3.items[0], { EmployeeId: '201', ContractId: '1200' });
});

test('offset 0 always refetches, so a new run never sees an old list', async () => {
    let version = 0;
    installFetch(() => CONTRACTS(version === 0 ? 150 : 120));
    const first = await executeNmbrsTool(TOOL, { companyId: '9' }, 'u1');
    assert.equal(first.total, 150);
    version = 1;
    const second = await executeNmbrsTool(TOOL, { companyId: '9' }, 'u1');
    assert.equal(second.total, 120, 'the new first page shows the new list');
    assert.equal(soapCalls.length, 2);
    const next = await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    assert.equal(next.total, 120, 'and later pages follow that list');
    assert.equal(soapCalls.length, 2);
});

test('a later page with no cached entry fetches and then fills the cache', async () => {
    installFetch(() => CONTRACTS(300));
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 200 }, 'u1');
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    assert.equal(soapCalls.length, 1);
});

test('another company, user, organisation, credentials or argument is a separate entry', async () => {
    await setCreds('u2');
    installFetch(() => CONTRACTS(300));
    const read = (args, user = 'u1', ctx = {}) => executeNmbrsTool(TOOL, { companyId: '9', offset: 100, ...args }, user, ctx);
    await read({});
    await read({ companyId: '10' });
    await read({}, 'u2');
    await read({}, 'u1', { orgId: 'orgA' });
    await read({}, 'u1', { orgId: 'orgB' });
    assert.equal(soapCalls.length, 5);
    await read({});
    await read({ companyId: '10' });
    await read({}, 'u2');
    await read({}, 'u1', { orgId: 'orgA' });
    assert.equal(soapCalls.length, 5, 'each is served from its own entry');

    // Arguments that change the list: year / period.
    installFetch(() => ({ text: soapResponse('LeaseCar_GetAll_EmployeesByCompany', '<Car><Id>1</Id></Car>') }));
    const lease = (a) => executeNmbrsTool('nmbrs_list_company_lease_cars', { companyId: '9', offset: 1, ...a }, 'u1');
    await lease({ year: 2026, period: 3 });
    await lease({ year: 2026, period: 4 });
    await lease({ year: 2025, period: 3 });
    assert.equal(soapCalls.length, 3);
    await lease({ year: 2026, period: 3 });
    assert.equal(soapCalls.length, 3);
    // Another tool on the same company: its own entry too.
    installFetch(() => CONTRACTS(10));
    await executeNmbrsTool('nmbrs_list_company_employments', { companyId: '9', offset: 1 }, 'u1');
    assert.equal(soapCalls.length, 1);
});

test('changed credentials do not read the lists fetched under the old ones', async () => {
    installFetch(() => CONTRACTS(300));
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    await setCreds('u1', { subdomain: 'other-tenant', token: 'z9y8x7w6v5u4t3s2r1q0p9o8' });
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    assert.equal(soapCalls.length, 2);
    assert.match(soapCalls[1].body, /<tns:Domain>other-tenant<\/tns:Domain>/);
});

test('clearNmbrsPageCacheForUser drops that user\'s lists', async () => {
    await setCreds('u2');
    installFetch(() => CONTRACTS(300));
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u2');
    clearNmbrsPageCacheForUser('u1');
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u2');
    assert.equal(soapCalls.length, 3, 'u1 refetched, u2 still cached');
});

test('the TTL expiry refetches', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    process.env.NMBRS_PAGE_CACHE_TTL_MS = '60000';
    resetPageCache();
    installFetch(() => CONTRACTS(300));
    await executeNmbrsTool(TOOL, { companyId: '9' }, 'u1');
    t.mock.timers.tick(59_000);
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    assert.equal(soapCalls.length, 1);
    t.mock.timers.tick(2_000);
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 200 }, 'u1');
    assert.equal(soapCalls.length, 2, 'expired: fetched again');
});

test('TTL 0 disables the cache', async () => {
    process.env.NMBRS_PAGE_CACHE_TTL_MS = '0';
    resetPageCache();
    installFetch(() => CONTRACTS(300));
    for (const offset of [0, 100, 200, 100]) await executeNmbrsTool(TOOL, { companyId: '9', offset }, 'u1');
    assert.equal(soapCalls.length, 4);
    assert.deepEqual(getPageCache().size, { entries: 0, items: 0 });
});

test('concurrent pages of one read make one SOAP call', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    installFetch(async () => { await gate; return CONTRACTS(500); });
    const reads = [100, 200, 300, 400].map((offset) => executeNmbrsTool(TOOL, { companyId: '9', offset }, 'u1'));
    await new Promise((r) => setImmediate(r));
    release();
    const pages = await Promise.all(reads);
    assert.equal(soapCalls.length, 1);
    assert.deepEqual(pages.map((p) => p.offset), [100, 200, 300, 400]);
});

test('a failed fetch is not cached', async () => {
    installFetch((n) => (n === 1
        ? { ok: false, status: 500, text: '<soap:Fault><faultstring>Index onbekend</faultstring></soap:Fault>' }
        : CONTRACTS(300)));
    const failed = await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    assert.match(failed.error, /server error/);
    const retry = await executeNmbrsTool(TOOL, { companyId: '9', offset: 100 }, 'u1');
    assert.equal(retry.total, 300);
    assert.equal(soapCalls.length, 2);
    await executeNmbrsTool(TOOL, { companyId: '9', offset: 200 }, 'u1');
    assert.equal(soapCalls.length, 2, 'the success is cached');
});

test('nmbrs_list_employees pages from the cache too, keyed on activeOnly', async () => {
    const xml = Array.from({ length: 250 }, (_, i) => `<Employee><Id>${i + 1}</Id></Employee>`).join('');
    installFetch(() => ({ text: soapResponse('List_GetByCompany', xml) }));
    const pages = await walk('nmbrs_list_employees', { companyId: '9' }, 'u1');
    assert.equal(pages.length, 3);
    assert.equal(soapCalls.length, 1);
    // activeOnly:false is another list (two SOAP calls: payroll and former payroll).
    await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', activeOnly: false, offset: 100 }, 'u1');
    assert.equal(soapCalls.length, 3);
    await executeNmbrsTool('nmbrs_list_employees', { companyId: '9', activeOnly: false, offset: 200 }, 'u1');
    assert.equal(soapCalls.length, 3);
});

test('privacy: only allow-listed fields are cached, and no row content is logged', async () => {
    const row = '<PersonalInfoContractSalaryAddress><EmployeeID>1</EmployeeID><FirstName>Alice</FirstName><BSN>123456782</BSN><Street>Dorpsstraat</Street><SalaryValue>3000</SalaryValue></PersonalInfoContractSalaryAddress>';
    installFetch(() => ({ text: soapResponse('PersonalInfoContractSalaryAddress_GetAll_AllEmployeesByCompany', row.repeat(150)) }));
    const logged = [];
    const saved = {};
    for (const k of ['info', 'warn', 'error', 'debug']) { saved[k] = log[k]; log[k] = (...a) => logged.push(a.join(' ')); }
    let page2;
    try {
        await executeNmbrsTool('nmbrs_list_company_personal_info', { companyId: '9' }, 'u1');
        page2 = await executeNmbrsTool('nmbrs_list_company_personal_info', { companyId: '9', offset: 100 }, 'u1');
    } finally {
        for (const k of Object.keys(saved)) log[k] = saved[k];
    }
    assert.equal(soapCalls.length, 1);
    const out = JSON.stringify(page2);
    for (const leak of ['123456782', 'Dorpsstraat']) assert.ok(!out.includes(leak), `${leak} must not leak from the cache`);
    const text = logged.join('\n');
    for (const leak of ['Alice', '123456782', 'Dorpsstraat', '3000', 'me@acme.nl', TOKEN]) assert.ok(!text.includes(leak), `${leak} must not be logged`);
    assert.match(text, /page cache hit: nmbrs_list_company_personal_info/);
    const stats = getPageCache().stats()['nmbrs_list_company_personal_info'];
    assert.deepEqual([stats.refresh, stats.hit], [1, 1]);
});
