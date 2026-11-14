/**
 * Unit tests for the Frappe CRM integration: tool set, credentials, the auth
 * header, query encoding, record-name checks, write bodies, error handling and
 * the site-address policy. No network: the real configStore reads a table the
 * test fills, and every request goes to a scripted fetch.
 *
 * Run: node --test integrations/frappeCrmTools.test.js
 */
const { useConfigRows } = require('../testUtils/configRows');
const config = useConfigRows();

const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('./frappeCrmTools.mts');
const { _setFetchForTests } = require('../utils/apiClient');
const host = require('./frappeCrmHost.mts');
const client = require('./frappeCrmClient.mts');
const defs = require('./frappeCrmToolDefs.mts');

const { executeFrappeCrmTool, isFrappeCrmTool, testFrappeCrmConnection, FRAPPE_CRM_TOOLS, NOT_CONFIGURED } = tools;

const USER = 'u1';
const KEY = 'a1b2c3d4e5f6g7h';
const SECRET = 'Zx9secretQ4471pp';

function setCreds(overrides = {}) {
    const values = { url: 'https://crm.example.com/', api_key: KEY, api_secret: SECRET, ...overrides };
    for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete config.rows[`frappe_crm_${k}_user_${USER}`];
        else config.rows[`frappe_crm_${k}_user_${USER}`] = v;
    }
}

let calls = [];
/** One answer per expected request: { status, body } (body JSON-encoded unless a string). */
function scriptFetch(answers) {
    calls = [];
    const queue = [...answers];
    _setFetchForTests(async (url, init) => {
        calls.push({ url, init });
        const next = queue.shift() || { status: 500, body: { exception: 'unexpected call' } };
        if (next.throw) throw next.throw;
        const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? null);
        const status = next.status || 200;
        return { ok: status >= 200 && status < 300, status, text: async () => text };
    });
}

const ENV_KEYS = ['FRAPPE_CRM_MAX_PAGE_SIZE', 'FRAPPE_CRM_MAX_OUTPUT_CHARS', 'FRAPPE_CRM_ALLOW_PRIVATE_HOSTS', 'FRAPPE_CRM_ALLOWED_HOSTS', 'DEPLOYMENT_MODE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
test.beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    setCreds();
});
test.after(() => {
    _setFetchForTests(null);
    host._setHostLookupForTests(null);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const query = (call) => new URL(call.url).searchParams;

// ─── Tool set ──────────────────────────────────────────────────

test('tool set: every name has the prefix, is unique and is recognised', () => {
    const names = FRAPPE_CRM_TOOLS.map((t) => t.function.name);
    assert.equal(new Set(names).size, names.length);
    for (const n of names) {
        assert.ok(n.startsWith('frappe_crm_'), n);
        assert.ok(isFrappeCrmTool(n), n);
    }
    assert.equal(isFrappeCrmTool('firebird_query'), false);
});

test('tool set: no delete, and no tool takes a DocType from the model', () => {
    for (const t of FRAPPE_CRM_TOOLS) {
        assert.ok(!/delete|remove/i.test(t.function.name), t.function.name);
        const props = Object.keys(t.function.parameters.properties || {});
        assert.ok(!props.includes('doctype'), t.function.name);
        assert.ok(!props.includes('filters'), t.function.name);
    }
    assert.deepEqual(Object.values(defs.DOCTYPES).sort(),
        ['CRM Deal', 'CRM Deal Status', 'CRM Lead', 'CRM Lead Status', 'CRM Organization', 'CRM Task', 'Contact', 'FCRM Note']);
});

test('tool set: the write tools are exactly the six named', () => {
    assert.deepEqual([...defs.FRAPPE_CRM_WRITE_TOOLS].sort(), [
        'frappe_crm_add_note', 'frappe_crm_create_deal', 'frappe_crm_create_lead', 'frappe_crm_create_task',
        'frappe_crm_update_deal', 'frappe_crm_update_lead',
    ]);
});

// ─── Credentials and auth ──────────────────────────────────────

test('not configured: a missing part answers the settings sentence without a request', async () => {
    setCreds({ api_secret: undefined });
    scriptFetch([]);
    const out = await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
    assert.equal(out.error, NOT_CONFIGURED);
    assert.equal(calls.length, 0);
});

test('auth header is "token key:secret" and the trailing slash of the site is dropped', async () => {
    scriptFetch([{ body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, `token ${KEY}:${SECRET}`);
    assert.ok(calls[0].url.startsWith('https://crm.example.com/api/resource/CRM%20Lead?'), calls[0].url);
    assert.equal(calls[0].init.method, 'GET');
});

test('credential shape: a key with a colon, whitespace or a newline is refused before any request', async () => {
    for (const bad of ['ab:cd', 'ab cd', 'ab\ncd']) {
        setCreds({ api_key: bad });
        scriptFetch([]);
        const out = await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
        assert.match(out.error, /API key has an invalid format/);
        assert.equal(calls.length, 0);
    }
    assert.equal(client.isValidCredential('k:v'), true);
    assert.equal(client.isValidCredential('k:v', { allowColon: false }), false);
});

// ─── Query encoding ────────────────────────────────────────────

test('list leads: fields, filters, search, order, page and the extra row are JSON-encoded query params', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ name: `CRM-LEAD-2025-0000${i}`, lead_name: `L${i}` }));
    scriptFetch([{ body: { data: rows } }]);
    const out = await executeFrappeCrmTool('frappe_crm_list_leads', { status: 'New', search: 'acme', limit: 5, offset: 10, order_by: 'creation asc' }, USER);
    const q = query(calls[0]);
    assert.deepEqual(JSON.parse(q.get('filters')), [['status', '=', 'New']]);
    assert.deepEqual(JSON.parse(q.get('or_filters')).map((f) => f[0]), ['lead_name', 'email', 'organization', 'mobile_no']);
    assert.deepEqual(JSON.parse(q.get('or_filters'))[0], ['lead_name', 'like', '%acme%']);
    assert.ok(JSON.parse(q.get('fields')).includes('lead_name'));
    assert.equal(q.get('limit_page_length'), '6');
    assert.equal(q.get('limit_start'), '10');
    assert.equal(q.get('order_by'), 'creation asc');
    assert.equal(out.count, 5);
    assert.equal(out.has_more, true);
    assert.match(out.message, /offset 15/);
});

test('list: a filter value with quotes or brackets stays a JSON string, never a filter of its own', async () => {
    scriptFetch([{ body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_deals', { organization: 'A"],["owner","like","%' }, USER);
    const filters = JSON.parse(query(calls[0]).get('filters'));
    assert.equal(filters.length, 1);
    assert.deepEqual(filters[0], ['organization', '=', 'A"],["owner","like","%']);
});

test('list: fields must be field names; "name" is always added', async () => {
    scriptFetch([{ body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_contacts', { fields: ['email_id', 'custom_region'] }, USER);
    assert.deepEqual(JSON.parse(query(calls[0]).get('fields')), ['name', 'email_id', 'custom_region']);
    for (const bad of [['*'], ['name; drop'], ['Email'], 'email_id', ['count(name)']]) {
        scriptFetch([]);
        const out = await executeFrappeCrmTool('frappe_crm_list_contacts', { fields: bad }, USER);
        assert.match(out.error, /fields/);
        assert.equal(calls.length, 0);
    }
});

test('list: order_by outside the four choices is refused', async () => {
    scriptFetch([]);
    const out = await executeFrappeCrmTool('frappe_crm_list_leads', { order_by: 'name; select 1' }, USER);
    assert.match(out.error, /order_by/);
    assert.equal(calls.length, 0);
});

test('page size: capped by FRAPPE_CRM_MAX_PAGE_SIZE, 0 means unlimited', async () => {
    process.env.FRAPPE_CRM_MAX_PAGE_SIZE = '3';
    scriptFetch([{ body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_leads', { limit: 100 }, USER);
    assert.equal(query(calls[0]).get('limit_page_length'), '4');
    process.env.FRAPPE_CRM_MAX_PAGE_SIZE = '0';
    assert.equal(tools.clampLimit(100000), 100000);
    scriptFetch([{ body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_statuses', { record_type: 'deal' }, USER);
    assert.equal(query(calls[0]).get('limit_page_length'), '0');
    assert.ok(calls[0].url.includes('/api/resource/CRM%20Deal%20Status?'));
});

test('output budget: rows past FRAPPE_CRM_MAX_OUTPUT_CHARS are left out with a message', async () => {
    process.env.FRAPPE_CRM_MAX_OUTPUT_CHARS = '200';
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, title: 'x'.repeat(40) }));
    scriptFetch([{ body: { data: rows } }]);
    const out = await executeFrappeCrmTool('frappe_crm_list_tasks', {}, USER);
    assert.ok(out.count < 10 && out.count > 0);
    assert.equal(out.has_more, true);
    assert.match(out.message, /too large/);
});

test('list tasks and notes filter on the reference of a lead or deal', async () => {
    scriptFetch([{ body: { data: [] } }, { body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_tasks', { record_type: 'deal', record_name: 'CRM-DEAL-2025-00001', status: 'Todo' }, USER);
    await executeFrappeCrmTool('frappe_crm_list_notes', { record_type: 'lead', record_name: 'CRM-LEAD-2025-00002' }, USER);
    assert.deepEqual(JSON.parse(query(calls[0]).get('filters')), [
        ['reference_doctype', '=', 'CRM Deal'], ['reference_docname', '=', 'CRM-DEAL-2025-00001'], ['status', '=', 'Todo'],
    ]);
    assert.ok(calls[1].url.includes('/api/resource/FCRM%20Note?'));
    assert.deepEqual(JSON.parse(query(calls[1]).get('filters')), [
        ['reference_doctype', '=', 'CRM Lead'], ['reference_docname', '=', 'CRM-LEAD-2025-00002'],
    ]);
    scriptFetch([]);
    const bad = await executeFrappeCrmTool('frappe_crm_list_notes', { record_type: 'Contact', record_name: 'x' }, USER);
    assert.match(bad.error, /record_type/);
    assert.equal(calls.length, 0);
});

// ─── Record names ──────────────────────────────────────────────

test('get: the record name is URL-encoded into the path and the answer is shaped', async () => {
    scriptFetch([{ body: { data: { name: 'Acme & Co/NL', doctype: 'CRM Organization', idx: 0, _user_tags: 'x', website: 'acme.example', contacts: [{ name: 'r1', parent: 'p', doctype: 'x', contact: 'C1' }] } } }]);
    const out = await executeFrappeCrmTool('frappe_crm_get_organization', { name: 'Acme & Co/NL' }, USER);
    assert.equal(new URL(calls[0].url).pathname, '/api/resource/CRM%20Organization/Acme%20%26%20Co%2FNL');
    assert.deepEqual(out.data, { name: 'Acme & Co/NL', website: 'acme.example', contacts: [{ name: 'r1', contact: 'C1' }] });
});

test('get: empty, dot-only, control-character and over-long names are refused without a request', async () => {
    for (const bad of ['', '   ', '.', '..', 'a\nb', 'a\u0000b', 'x'.repeat(141), { a: 1 }, undefined]) {
        scriptFetch([]);
        const out = await executeFrappeCrmTool('frappe_crm_get_lead', { name: bad }, USER);
        assert.ok(out.error, JSON.stringify(bad));
        assert.equal(calls.length, 0, JSON.stringify(bad));
    }
    assert.equal(tools.recordPath('lead', '../x'), '/api/resource/CRM%20Lead/..%2Fx');
});

// ─── Writes ────────────────────────────────────────────────────

test('create lead: POST with only the allow-listed fields', async () => {
    scriptFetch([{ body: { data: { name: 'CRM-LEAD-2025-00009', first_name: 'Ann', status: 'New', owner: 'x@y' } } }]);
    const out = await executeFrappeCrmTool('frappe_crm_create_lead', { first_name: ' Ann ', email: 'ann@example.com', annual_revenue: '1200', doctype: 'User', owner: 'admin', naming_series: 'X' }, USER);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/resource/CRM%20Lead');
    assert.deepEqual(JSON.parse(calls[0].init.body), { first_name: 'Ann', email: 'ann@example.com', annual_revenue: 1200 });
    assert.equal(out.ok, true);
    assert.equal(out.name, 'CRM-LEAD-2025-00009');
});

test('create lead: first_name is required', async () => {
    scriptFetch([]);
    const out = await executeFrappeCrmTool('frappe_crm_create_lead', { email: 'a@b.c' }, USER);
    assert.match(out.error, /first_name/);
    assert.equal(calls.length, 0);
});

test('update deal: PUT to the encoded record with the changed fields; nothing to change is refused', async () => {
    scriptFetch([{ body: { data: { name: 'CRM-DEAL-2025-00001', status: 'Won' } } }]);
    const out = await executeFrappeCrmTool('frappe_crm_update_deal', { name: 'CRM-DEAL-2025-00001', status: 'Won', deal_value: 5000 }, USER);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(new URL(calls[0].url).pathname, '/api/resource/CRM%20Deal/CRM-DEAL-2025-00001');
    assert.deepEqual(JSON.parse(calls[0].init.body), { status: 'Won', deal_value: 5000 });
    assert.deepEqual(out.updated_fields, ['status', 'deal_value']);
    scriptFetch([]);
    const none = await executeFrappeCrmTool('frappe_crm_update_deal', { name: 'CRM-DEAL-2025-00001' }, USER);
    assert.match(none.error, /at least one field/);
    assert.equal(calls.length, 0);
});

test('write values: objects and non-numbers are refused', async () => {
    scriptFetch([]);
    assert.match((await executeFrappeCrmTool('frappe_crm_update_lead', { name: 'L1', email: { $ne: 1 } }, USER)).error, /email must be text/);
    assert.match((await executeFrappeCrmTool('frappe_crm_update_deal', { name: 'D1', probability: 'high' }, USER)).error, /probability must be a number/);
    assert.equal(calls.length, 0);
});

test('add note: FCRM Note with the reference of the lead or deal', async () => {
    scriptFetch([{ body: { data: { name: 'abc123', title: 'Call' } } }]);
    await executeFrappeCrmTool('frappe_crm_add_note', { record_type: 'deal', record_name: 'CRM-DEAL-2025-00001', title: 'Call', content: '<p>Spoke</p>', reference_doctype: 'User' }, USER);
    assert.equal(new URL(calls[0].url).pathname, '/api/resource/FCRM%20Note');
    assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Call', content: '<p>Spoke</p>', reference_doctype: 'CRM Deal', reference_docname: 'CRM-DEAL-2025-00001' });
});

test('create task: default status Todo, optional reference', async () => {
    scriptFetch([{ body: { data: { name: 7, title: 'Follow up' } } }, { body: { data: { name: 8 } } }]);
    const out = await executeFrappeCrmTool('frappe_crm_create_task', { title: 'Follow up', priority: 'High', record_type: 'lead', record_name: 'CRM-LEAD-2025-00001' }, USER);
    assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Follow up', priority: 'High', status: 'Todo', reference_doctype: 'CRM Lead', reference_docname: 'CRM-LEAD-2025-00001' });
    assert.equal(out.name, 7);
    await executeFrappeCrmTool('frappe_crm_create_task', { title: 'Solo', status: 'Backlog' }, USER);
    assert.deepEqual(JSON.parse(calls[1].init.body), { title: 'Solo', status: 'Backlog' });
});

// ─── Errors ────────────────────────────────────────────────────

test('errors: a validation error shows Frappe\'s message, truncated and scrubbed', async () => {
    const message = `Lead status <b>Bogus</b> not found ${SECRET} ${'x'.repeat(600)}`;
    scriptFetch([{ status: 417, body: { exception: 'frappe.exceptions.LinkValidationError: ignored', _server_messages: JSON.stringify([JSON.stringify({ message })]) } }]);
    const out = await executeFrappeCrmTool('frappe_crm_update_lead', { name: 'CRM-LEAD-2025-00001', status: 'Bogus' }, USER);
    assert.match(out.error, /^Frappe CRM: HTTP 417: Lead status Bogus not found \*\*\*/);
    assert.ok(!out.error.includes(SECRET));
    assert.ok(out.error.length < 400, String(out.error.length));
});

test('errors: the last line of an exception when there are no server messages', async () => {
    scriptFetch([{ status: 500, body: { exception: 'Traceback...\nfrappe.exceptions.ValidationError: Title is required' } }]);
    const out = await executeFrappeCrmTool('frappe_crm_create_task', { title: 'x' }, USER);
    assert.equal(out.error, 'Frappe CRM: HTTP 500: Title is required');
});

test('errors: 401, 403 and 404 answer a fixed sentence; nothing of the body is shown', async () => {
    for (const [status, re] of [[401, /refused/], [403, /not permitted/], [404, /not found/]]) {
        scriptFetch([{ status, body: { exception: `secret detail ${SECRET}` } }]);
        const out = await executeFrappeCrmTool('frappe_crm_get_deal', { name: 'D1' }, USER);
        assert.match(out.error, re);
        assert.ok(!out.error.includes('secret detail'));
    }
});

test('errors: a network failure and a timeout never show the URL or the key', async () => {
    scriptFetch([{ throw: new Error(`connect ECONNREFUSED https://crm.example.com ${KEY}`) }]);
    const out = await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
    assert.equal(out.error, 'Frappe CRM: the site could not be reached. Check the address.');
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    scriptFetch([{ throw: timeout }]);
    assert.match((await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER)).error, /did not answer in time/);
});

test('frappeServerMessage reads both documented error shapes and ignores the rest', () => {
    assert.equal(client.frappeServerMessage(JSON.stringify({ _server_messages: JSON.stringify([JSON.stringify({ message: 'A' }), JSON.stringify({ message: 'B' })]) })), 'A B');
    assert.equal(client.frappeServerMessage('not json'), '');
    assert.equal(client.frappeServerMessage(JSON.stringify({ message: 'plain' })), 'plain');
});

// ─── Site address policy ───────────────────────────────────────

test('site URL: scheme, credentials, query and metadata hosts are refused', () => {
    assert.throws(() => host.checkSiteUrl('ftp://crm.example.com'), /https:\/\//);
    assert.throws(() => host.checkSiteUrl('https://u:p@crm.example.com'), /user name or password/);
    assert.throws(() => host.checkSiteUrl('https://crm.example.com/?x=1'), /without \? or #/);
    assert.throws(() => host.checkSiteUrl('http://169.254.169.254'), /not allowed/);
    assert.throws(() => host.checkSiteUrl('http://metadata.google.internal'), /not allowed/);
    assert.deepEqual(host.checkSiteUrl('https://crm.example.com/sub//'), { baseUrl: 'https://crm.example.com/sub', allowPrivate: false });
});

test('site URL: a private address is refused in cloud mode, allowed self-hosted or by the operator', () => {
    assert.throws(() => host.checkSiteUrl('http://10.0.0.5:8000'), /FRAPPE_CRM_ALLOW_PRIVATE_HOSTS/);
    assert.throws(() => host.checkSiteUrl('http://localhost:8000'), /private network/);
    process.env.DEPLOYMENT_MODE = 'selfhosted';
    assert.equal(host.checkSiteUrl('http://10.0.0.5:8000').allowPrivate, true);
    delete process.env.DEPLOYMENT_MODE;
    process.env.FRAPPE_CRM_ALLOW_PRIVATE_HOSTS = '1';
    assert.equal(host.checkSiteUrl('http://10.0.0.5:8000').allowPrivate, true);
    assert.throws(() => host.checkSiteUrl('http://169.254.169.254'), /not allowed/);
    delete process.env.FRAPPE_CRM_ALLOW_PRIVATE_HOSTS;
    process.env.FRAPPE_CRM_ALLOWED_HOSTS = 'crm.lan';
    assert.equal(host.checkSiteUrl('http://crm.lan').allowPrivate, true);
    assert.throws(() => host.checkSiteUrl('https://crm.example.com'), /not in the list of allowed hosts/);
});

test('private mode: link-local answers are refused before the request, redirects are not followed', async () => {
    process.env.FRAPPE_CRM_ALLOW_PRIVATE_HOSTS = '1';
    setCreds({ url: 'http://crm.lan:8000' });
    host._setHostLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    scriptFetch([]);
    const refused = await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
    assert.match(refused.error, /not allowed/);
    assert.equal(calls.length, 0);
    host._setHostLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
    scriptFetch([{ body: { data: [] } }]);
    await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
    assert.equal(calls[0].init.redirect, 'manual');
    scriptFetch([{ status: 302, body: '' }]);
    assert.match((await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER)).error, /redirect \(HTTP 302\)/);
    host._setHostLookupForTests(null);
});

test('cloud mode: a private site stored earlier is refused at use time without a request', async () => {
    setCreds({ url: 'http://192.168.1.10' });
    scriptFetch([]);
    const out = await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER);
    assert.match(out.error, /private network/);
    assert.equal(calls.length, 0);
});

// ─── Connection test ───────────────────────────────────────────

test('connection test: get_logged_user, and the error of a refused key', async () => {
    scriptFetch([{ body: { message: 'api@example.com' } }]);
    const ok = await testFrappeCrmConnection({ url: 'https://crm.example.com', apiKey: KEY, apiSecret: SECRET });
    assert.deepEqual(ok, { ok: true, user: 'api@example.com' });
    assert.equal(new URL(calls[0].url).pathname, '/api/method/frappe.auth.get_logged_user');
    scriptFetch([{ status: 401, body: {} }]);
    const bad = await testFrappeCrmConnection({ url: 'https://crm.example.com', apiKey: KEY, apiSecret: SECRET });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /refused/);
    const shape = await testFrappeCrmConnection({ url: 'nope', apiKey: KEY, apiSecret: SECRET });
    assert.match(shape.error, /address of your Frappe CRM site/);
});

test('connection test: a site\'s own error text is never shown, only the kind of answer', async () => {
    scriptFetch([{ status: 500, body: { exception: 'Internal service at 10.1.2.3 says: db password expired' } }]);
    const out = await testFrappeCrmConnection({ url: 'https://crm.example.com', apiKey: KEY, apiSecret: SECRET });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'Frappe CRM: the site answered HTTP 500.');
    // A tool call still hands the site's message to the model, which needs it to correct a request.
    setCreds();
    scriptFetch([{ status: 417, body: { exception: 'Field status: unknown value' } }]);
    assert.match((await executeFrappeCrmTool('frappe_crm_list_leads', {}, USER)).error, /unknown value/);
});

test('site URL: plain http only for a private address where private addresses are allowed', async () => {
    assert.throws(() => host.checkSiteUrl('http://crm.example.com'), /must start with https:\/\//);
    process.env.DEPLOYMENT_MODE = 'selfhosted';
    try {
        assert.throws(() => host.checkSiteUrl('http://8.8.8.8'), /must start with https:\/\//);
        assert.equal(host.checkSiteUrl('http://10.0.0.5:8000').allowPrivate, true);
        assert.equal(host.checkSiteUrl('https://crm.example.com').baseUrl, 'https://crm.example.com');
        const named = host.checkSiteUrl('http://crm.example.com');
        host._setHostLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
        await assert.rejects(() => host.assertNotLinkLocal(named), /must start with https:\/\//);
        host._setHostLookupForTests(async () => [{ address: '10.0.0.7', family: 4 }]);
        await host.assertNotLinkLocal(named);
        const tls = host.checkSiteUrl('https://crm.example.com');
        host._setHostLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
        await host.assertNotLinkLocal(tls);
    } finally {
        host._setHostLookupForTests(null);
        delete process.env.DEPLOYMENT_MODE;
    }
});
