/**
 * Industrial-integration detector: signal extraction (schemes, ports, vendor
 * hosts, keywords), confidence levels, the automation step walker (nested
 * bodies/branches), every source with org-scoped SQL, graceful skipping of
 * unprovisioned tables, and evidence free of credentials/e-mail.
 *
 * Run: cd server && node --test --test-force-exit compliance/detectors/industrialIntegrations.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../testUtils/stubRequire');

const state = {
    rows: {},            // table → rows (or an Error to throw)
    queries: [],         // { sql, params }
};

function tableOf(sql) {
    const m = String(sql).match(/FROM\s+([a-z_]+)/i);
    return m ? m[1] : null;
}

const fakeDb = {
    async getAll(sql, params) {
        const flat = String(sql).replace(/\s+/g, ' ').trim();
        state.queries.push({ sql: flat, params: params || [] });
        const t = tableOf(flat);
        const v = state.rows[t];
        if (v instanceof Error) throw v;
        return Array.isArray(v) ? v : [];
    },
    async getOne() { return null; },
    async run() { return { rowCount: 0 }; },
    async exec() {},
};

const restore = installResolveStub({ '../../db': fakeDb });
const det = require('./industrialIntegrations');
test.after(() => restore());

test.beforeEach(() => { state.rows = {}; state.queries = []; });

function pgError(code) { const e = new Error(`pg ${code}`); e.code = code; return e; }
function kinds(signals) { return signals.map(s => s.kind).sort(); }

// ── scanText ────────────────────────────────────────────────────────────────

test('schemes: every industrial scheme is a signal; opc.tcp/modbus/s7/ads are high, mqtt is low', () => {
    for (const [scheme, expected] of [['opc.tcp', 'high'], ['modbus', 'high'], ['s7', 'high'], ['ads', 'high'], ['coap', 'high'], ['ethernet-ip', 'high'], ['bacnet', 'high'], ['dnp3', 'high'], ['mqtt', 'low'], ['mqtts', 'low']]) {
        const signals = det.scanText(`endpoint ${scheme}://device.plant.local/path`);
        assert.ok(signals.some(s => s.kind === 'scheme' && s.value.startsWith(`${scheme}://`)), `${scheme} detected`);
        assert.equal(det.confidenceOf(signals.filter(s => s.kind === 'scheme')), expected, `${scheme} confidence`);
    }
});

test('ports: exact match on the parsed port — 5020 is not 502, 443 is nothing, 4840 is OPC UA', () => {
    assert.deepEqual(det.scanText('https://api.example.com:5020/v1'), []);
    assert.deepEqual(det.scanText('https://api.stripe.com:443/v1'), []);
    const opc = det.scanText('https://gateway.plant.example:4840/');
    assert.deepEqual(opc, [{ kind: 'port', value: 'gateway.plant.example:4840' }]);
    assert.equal(det.confidenceOf(opc), 'high');
});

test('ports: bare host:port pairs count (IPv4 and dotted hostnames), numbers in prose and JSON do not', () => {
    assert.deepEqual(det.scanText('connect to 192.168.10.5:502 then read'), [{ kind: 'port', value: '192.168.10.5:502' }]);
    assert.deepEqual(det.scanText('host="plc1.factory.local:102"'), [{ kind: 'port', value: 'plc1.factory.local:102' }]);
    assert.deepEqual(det.scanText('{"port":502,"host":"api.example.com"}'), []);
    assert.deepEqual(det.scanText('order 502 arrived at 4840 units'), []);
    assert.deepEqual(det.scanText('localhost:4840'), [], 'a bare single-label name is not a host');
});

test('MQTT ports alone are low confidence; MQTT + a Modbus port is high', () => {
    assert.equal(det.confidenceOf(det.scanText('mqtt://broker.example.com:8883')), 'low');
    assert.equal(det.confidenceOf(det.scanText('mqtt://broker.example.com:8883 and modbus at 10.0.0.9:502')), 'high');
});

test('port 2222 is the SFTP alternative as often as EtherNet/IP: no signal in an SSH-family URL, low on its own', () => {
    assert.deepEqual(det.scanText('sftp://backup.example.com:2222/nightly'), []);
    assert.deepEqual(det.scanText('ssh://deploy@build.example.com:2222'), []);
    const bare = det.scanText('controller at 10.0.0.7:2222');
    assert.equal(bare.length, 1);
    assert.equal(det.confidenceOf(bare), 'low');
    // Together with the explicit EtherNet/IP port it is a PLC again.
    assert.equal(det.confidenceOf(det.scanText('10.0.0.7:2222 and 10.0.0.7:44818')), 'high');
});

test('vendor hosts are high confidence, with or without a scheme', () => {
    const a = det.scanText('https://acme.eu1.mindsphere.io/api/iottimeseries/v3');
    assert.ok(a.some(s => s.kind === 'host' && s.value === 'acme.eu1.mindsphere.io'));
    assert.equal(det.confidenceOf(a), 'high');
    const b = det.scanText('{"host":"plant.thingworx.example.com"}');
    assert.ok(b.some(s => s.kind === 'host'));
    const c = det.scanText('https://api.example.com/mindsphere-docs');
    assert.ok(!c.some(s => s.kind === 'host'), 'a path segment is not a vendor host');
});

test('keywords are low confidence and case-insensitive; unrelated text yields nothing', () => {
    const k = det.scanText('Beckhoff TwinCAT bridge for the SCADA dashboard');
    assert.deepEqual(kinds(k), ['keyword', 'keyword', 'keyword']);
    assert.equal(det.confidenceOf(k), 'low');
    assert.deepEqual(det.scanText('Sync HubSpot deals to a Google Sheet every morning'), []);
    assert.deepEqual(det.scanText('Summarise support e-mails from jan@example.org'), []);
    assert.equal(det.scanText('x', { keywords: false }).length, 0);
    assert.deepEqual(det.scanText('modbus bridge', { keywords: false }), []);
});

test('credentials in a URL never reach the signal value', () => {
    const s = det.scanText('opc.tcp://operator:S3cret@plc.plant.local:4840/UA');
    const blob = JSON.stringify(s);
    assert.ok(!/S3cret|operator/.test(blob), blob);
    assert.ok(s.some(x => x.value === 'opc.tcp://plc.plant.local:4840'));
});

test('signals are deduplicated and non-string input is tolerated', () => {
    const s = det.scanText('modbus://a.b modbus://a.b');
    assert.equal(s.filter(x => x.kind === 'scheme').length, 1);
    assert.deepEqual(det.scanText(null), []);
    assert.deepEqual(det.scanText(undefined), []);
    assert.ok(Array.isArray(det.scanText({ url: 'modbus://1.2.3.4' })));
});

// ── automation definitions ──────────────────────────────────────────────────

test('scanAutomationDefinition walks loop bodies and parallel branches (product grammar: branches are step arrays, condition arms are edges) and reads urls, tools and code', () => {
    const def = {
        name: 'Line 3 monitor',
        steps: [
            { id: 's1', type: 'http_request', url: 'https://erp.example.com/api/orders' },
            {
                id: 'loop', type: 'loop', itemVar: 'tag', body: [
                    { id: 's2', type: 'http_request', url: 'opc.tcp://plc-line3.plant.local:4840/UA/{{tag}}' },
                ],
            },
            {
                id: 'par', type: 'parallel', branches: [
                    [{ id: 's3', type: 'code', code: 'const client = new ModbusRTU(); await client.connectTCP("10.1.2.3", { port: 502 });' }],
                    [{ id: 's4', type: 'integration_action', tool: 'kepware.read_tag', inputs: { tag: 'Speed' } }],
                ],
            },
            // condition arms are edges in this grammar — the step after the
            // condition is a sibling, not a nested list
            { id: 'cond', type: 'condition', expression: '{{steps.s1.output.ok}}' },
            { id: 's5', type: 'ai_step', tools: ['siemens_diag'] },
        ],
    };
    const signals = det.scanAutomationDefinition(def);
    assert.ok(signals.some(s => s.kind === 'scheme' && s.value.startsWith('opc.tcp://plc-line3.plant.local')), 'loop body url');
    assert.ok(signals.some(s => s.kind === 'keyword' && s.value === 'modbus'), 'code in a parallel branch (array form)');
    assert.ok(signals.some(s => s.kind === 'keyword' && s.value === 'kepware'), 'tool name in the second parallel branch');
    assert.ok(signals.some(s => s.kind === 'keyword' && s.value === 'siemens'), 'ai_step tool list after a condition');
    assert.equal(det.confidenceOf(signals), 'high');
    // a string definition is parsed; garbage is tolerated
    assert.ok(det.scanAutomationDefinition(JSON.stringify(def)).length > 0);
    assert.deepEqual(det.scanAutomationDefinition('not json'), []);
    assert.deepEqual(det.scanAutomationDefinition(null), []);
});

test('an ordinary business automation produces no match', () => {
    const def = {
        steps: [
            { id: 'a', type: 'integration_action', tool: 'gmail.search', inputs: { q: 'invoices' } },
            { id: 'b', type: 'ai_step', prompt: 'Summarise the invoices for the finance team.' },
            { id: 'c', type: 'http_request', url: 'https://api.example.com:5020/v1/post' },
        ],
    };
    assert.deepEqual(det.scanAutomationDefinition(def), []);
});

// ── detect(orgId) ───────────────────────────────────────────────────────────

test('empty org: every source is scanned with an org-scoped WHERE, counts are zero, no matches', async () => {
    const r = await det.detect('org1');
    assert.deepEqual(r.scanned, { custom_integrations: 0, automations: 0, connections: 0, activity_hosts: 0, mcp_servers: 0 });
    assert.deepEqual(r.matches, []);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.heuristics_version, det.HEURISTICS_VERSION);
    const byTable = Object.fromEntries(state.queries.map(q => [tableOf(q.sql), q]));
    assert.match(byTable.org_custom_integrations.sql, /WHERE org_id = \$1/);
    assert.deepEqual(byTable.org_custom_integrations.params, ['org1']);
    assert.match(byTable.automations.sql, /a\.organization_id = \$1/);
    assert.match(byTable.automations.sql, /u\."organizationId" = \$1/);
    assert.match(byTable.integration_connections.sql, /WHERE org_id = \$1/);
    assert.match(byTable.integration_activity_log.sql, /WHERE organization_id = \$1/);
    assert.match(byTable.integration_activity_log.sql, /INTERVAL '90 days'/);
    assert.ok(byTable.mcp_servers, 'mcp_servers is scanned (platform table)');
});

test('matches from every source, with confidence, labels and the platform scope on mcp_servers', async () => {
    state.rows = {
        org_custom_integrations: [
            { id: 'ci1', name: 'Plant OPC gateway', description: '', kind: 'rest', status: 'active', definition: { baseUrl: 'opc.tcp://gw.plant.local:4840' }, activated_definition: null },
            { id: 'ci2', name: 'CRM sync', description: 'HubSpot to sheet', kind: 'rest', status: 'active', definition: { baseUrl: 'https://api.hubapi.com' }, activated_definition: null },
        ],
        automations: [
            { id: 'au1', title: 'Line monitor', description: null, definition_json: { steps: [{ type: 'http_request', url: 'https://10.0.0.2:502/' }] }, is_active: true },
            { id: 'au2', title: 'Robots newsletter', description: 'Weekly robotics news digest', definition_json: { steps: [] }, is_active: false },
        ],
        integration_connections: [
            { id: 'co1', provider: 'kepware', label: 'Default', kind: 'api_key', status: 'active' },
            { id: 'co2', provider: 'google', label: 'Default', kind: 'oauth', status: 'active' },
        ],
        integration_activity_log: [
            { host: 'acme.eu1.mindsphere.io', endpoint: 'https://acme.eu1.mindsphere.io/api', calls: 12 },
            { host: 'api.openai.com', endpoint: 'https://api.openai.com/v1', calls: 400 },
            { host: 'broker.example.com', endpoint: 'mqtt://broker.example.com:1883', calls: 3 },
        ],
        mcp_servers: [
            { id: 'm1', name: 'Modbus MCP', url: 'modbus://172.16.0.5', command: null, args: [], description: 'Reads PLC registers' },
            { id: 'm2', name: 'Filesystem', url: null, command: 'npx', args: ['@modelcontextprotocol/server-filesystem'], description: '' },
        ],
    };
    const r = await det.detect('org1');
    assert.deepEqual(r.scanned, { custom_integrations: 2, automations: 2, connections: 2, activity_hosts: 3, mcp_servers: 2 });
    const byId = Object.fromEntries(r.matches.map(m => [m.id, m]));
    assert.equal(byId.ci1.confidence, 'high');
    assert.equal(byId.ci1.source, 'custom_integration');
    assert.equal(byId.ci1.label, 'Plant OPC gateway');
    assert.equal(byId.ci2, undefined, 'plain REST integration is not a match');
    assert.equal(byId.au1.confidence, 'high');
    assert.equal(byId.au1.active, true);
    assert.equal(byId.au2.confidence, 'low', 'keyword-only ("robots") is low');
    assert.equal(byId.co1.confidence, 'low');
    assert.equal(byId.co1.provider, 'kepware');
    assert.equal(byId.co2, undefined);
    assert.equal(byId['acme.eu1.mindsphere.io'].confidence, 'high');
    assert.equal(byId['acme.eu1.mindsphere.io'].source, 'activity_host');
    assert.equal(byId['acme.eu1.mindsphere.io'].calls_90d, 12);
    assert.equal(byId['api.openai.com'], undefined);
    assert.equal(byId['broker.example.com'].confidence, 'low');
    assert.equal(byId.m1.scope, 'platform');
    assert.equal(byId.m1.confidence, 'high');
    assert.equal(byId.m2, undefined);
    // high before low
    assert.equal(r.matches[0].confidence, 'high');
    assert.equal(r.matches[r.matches.length - 1].confidence, 'low');
});

test('activity hosts are matched on scheme/port/host only — a keyword in a hostname is not a signal', async () => {
    state.rows = { integration_activity_log: [{ host: 'plc-docs.example.com', endpoint: 'https://plc-docs.example.com/', calls: 1 }] };
    const r = await det.detect('org1');
    assert.deepEqual(r.matches, []);
});

test('unprovisioned tables are skipped, never thrown; other sources still run', async () => {
    state.rows = {
        org_custom_integrations: pgError('42P01'),
        integration_activity_log: pgError('42703'),
        mcp_servers: [{ id: 'm1', name: 'S7 bridge', url: 's7://10.0.0.7', command: null, args: [], description: '' }],
    };
    const r = await det.detect('org1');
    assert.deepEqual(r.skipped.map(s => s.source).sort(), ['activity_log', 'custom_integrations']);
    assert.ok(r.skipped.every(s => s.reason === 'not provisioned'));
    assert.equal(r.scanned.mcp_servers, 1);
    assert.equal(r.matches.length, 1);
});

test('an unexpected query error is recorded as a skip with a truncated reason', async () => {
    state.rows = { automations: new Error('connection refused') };
    const r = await det.detect('org1');
    const s = r.skipped.find(x => x.source === 'automations');
    assert.match(s.reason, /^query failed: connection refused/);
});

test('detector output carries no e-mail addresses or credentials', async () => {
    state.rows = {
        org_custom_integrations: [{ id: 'ci1', name: 'Gateway', description: 'contact ops@example.org', kind: 'rest', status: 'active', definition: { url: 'opc.tcp://svc:pw@gw.local:4840', owner: 'jan@example.org' }, activated_definition: null }],
    };
    const r = await det.detect('org1');
    const blob = JSON.stringify(r);
    assert.ok(!/@/.test(blob), blob);
});
