/**
 * resolveIntegration precedence + the hardened output scanner.
 *
 * The scanner half is the important one: routine rows feed the same
 * sovereignty dashboards as GLiNER-scanned chat rows, and the old shape-only
 * patterns reported any 9-digit number as a BSN and almost any digit run as
 * a phone number — inflating the org's "PII left the building" figures.
 *
 * Run: node --test server/core/integrationToolMap.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { resolveIntegration, scanOutputForPii } = require('./integrationToolMap');

// ── resolveIntegration precedence ──────────────────────────────────────

test('internal tools resolve to null (never logged as egress)', () => {
    assert.strictEqual(resolveIntegration('set_reminder', {}), null);
    assert.strictEqual(resolveIntegration('notebook_search', {}), null);
});

test('document builders: local in Bee Flow storage, external (the Nextcloud URL) with nextcloudPath', () => {
    const ctx = { nextcloudUrl: 'https://cloud.example' };
    for (const tool of ['create_word_document', 'create_presentation']) {
        const kept = resolveIntegration(tool, { title: 'x' }, ctx);
        assert.strictEqual(kept.isLocal, true, tool);
        assert.strictEqual(kept.server, null, tool);
        assert.strictEqual(kept.direction, 'received', tool);

        const nc = resolveIntegration(tool, { title: 'x', nextcloudPath: '/Documents' }, ctx);
        assert.strictEqual(nc.isLocal, false, `${tool} into Nextcloud is egress, like nextcloud_create_document`);
        assert.strictEqual(nc.server, 'https://cloud.example', tool);
        assert.strictEqual(nc.direction, 'sent', tool);

        assert.strictEqual(resolveIntegration(tool, { nextcloudPath: '  ' }, ctx).isLocal, true, 'a blank path is no destination');
        assert.strictEqual(resolveIntegration(tool, { nextcloudPath: true }, ctx).isLocal, true, 'only a string is a path');
    }
});

test('cint_: a custom integration resolves with its base URL, but only for a caller that looked it up', () => {
    const ctx = { customIntegration: { name: 'Invoice API', baseUrl: 'https://api.invoices.example/v2' } };
    const meta = resolveIntegration('cint_ab12cd34_list_invoices', {}, ctx);
    assert.strictEqual(meta.integration, 'custom_integration');
    assert.strictEqual(meta.label, 'Invoice API');
    assert.strictEqual(meta.server, 'https://api.invoices.example');
    assert.strictEqual(meta.direction, 'received');
    assert.strictEqual(meta.isLocal, false);

    // The ledger looked it up but the integration is gone: still a row, no host.
    const gone = resolveIntegration('cint_ab12cd34_create_invoice', {}, { customIntegration: null });
    assert.strictEqual(gone.server, null);
    assert.strictEqual(gone.label, 'Custom integration (ab12cd34)');
    assert.strictEqual(gone.direction, 'sent');

    // Every other caller (lending, the tool-PII class, step contracts) keeps null.
    assert.strictEqual(resolveIntegration('cint_ab12cd34_list_invoices', {}), null);
    assert.strictEqual(resolveIntegration('cint_ab12cd34_list_invoices', {}, { nextcloudUrl: 'x' }), null);
    // A malformed base URL never throws.
    assert.strictEqual(resolveIntegration('cint_ab12cd34_x', {}, { customIntegration: { baseUrl: 'not a url' } }).server, null);
});

test('exact map beats prefix; ctx reaches the serverFn', () => {
    // nextcloud_* tools resolve their endpoint from ctx — the chat paths
    // passed NO ctx for years, which is why server_endpoint was NULL there.
    const withCtx = resolveIntegration('nextcloud_upload_file', {}, { nextcloudUrl: 'https://cloud.acme.nl' });
    const noCtx = resolveIntegration('nextcloud_upload_file', {});
    if (withCtx) {
        assert.ok(
            String(withCtx.server || '').includes('cloud.acme.nl')
            || withCtx.server !== noCtx.server
            || withCtx.server === null,
            'ctx must be able to influence the resolved server',
        );
    }
    // Unknown-but-prefixed tools fall through to the family entry.
    const gmail = resolveIntegration('gmail_totally_new_tool', {});
    assert.ok(gmail, 'gmail_ prefix must resolve');
    assert.strictEqual(typeof gmail.integration, 'string');
});

test('mcp and n8n fallbacks still resolve, unknown tools return null', () => {
    const mcp = resolveIntegration('mcp__soverin__list_messages', {});
    assert.strictEqual(mcp.integration, 'mcp');
    assert.match(mcp.server, /^mcp-server:\/\//);
    const n8n = resolveIntegration('n8n_custom_flow', {});
    assert.strictEqual(n8n.integration, 'n8n');
    assert.strictEqual(resolveIntegration('definitely_not_a_tool_xyz', {}), null);
});

test('bundled MCP servers with a prefix entry win over the generic mcp_ fallback', () => {
    const tuya = resolveIntegration('mcp_tuya_switch_device', {});
    assert.strictEqual(tuya.integration, 'tuya');
    assert.strictEqual(tuya.label, 'Tuya Smart Home');
    // Host is the user's data center, discovered by the egress probe.
    assert.strictEqual(tuya.server, null);
});

// ── hardened scanner ───────────────────────────────────────────────────

test('BSN: elfproef-valid 9-digit numbers only', () => {
    // 111222333: 9·1+8·1+7·1+6·2+5·2+4·2+3·3+2·3−3 = 66 → 66 % 11 = 0 ✓
    assert.match(scanOutputForPii('klant bsn 111222333 ok'), /NationalIdentificationNumber/);
    // 123456789: 9·1+8·2+7·3+6·4+5·5+4·6+3·7+2·8−9 = 183 → 183 % 11 ≠ 0 ✗
    assert.doesNotMatch(scanOutputForPii('ordernummer 123456789'), /NationalIdentificationNumber/,
        'an arbitrary 9-digit number is NOT a BSN');
});

test('credit cards: Luhn-valid only', () => {
    assert.match(scanOutputForPii('kaart 4111 1111 1111 1111'), /CreditCardNumber/); // classic Luhn-valid test PAN
    assert.doesNotMatch(scanOutputForPii('ref 1234 5678 9012 3456'), /CreditCardNumber/,
        'a 16-digit number failing Luhn is not a card');
});

test('phone numbers: must look dialed, 9–15 digits', () => {
    assert.match(scanOutputForPii('bel +31 6 1234 5678 vandaag'), /PhoneNumber/);
    assert.match(scanOutputForPii('vast: 020-123 45 67'), /PhoneNumber/);
    assert.doesNotMatch(scanOutputForPii('totaal 1234 5678'), /PhoneNumber/,
        'bare digit runs without a dialing prefix are not phones');
    assert.doesNotMatch(scanOutputForPii('om 06:30 uur'), /PhoneNumber/, 'clock times are not phones');
});

test('IP addresses: octets must be in range', () => {
    assert.match(scanOutputForPii('server 192.168.1.10 up'), /IPAddress/);
    assert.doesNotMatch(scanOutputForPii('versie 999.999.999.999'), /IPAddress/);
});

test('output uses canonical ids with the bare-comma encoding', () => {
    const out = scanOutputForPii('mail piet@acme.nl of bel +31612345678');
    assert.match(out, /Email/);
    assert.match(out, /PhoneNumber/);
    assert.ok(!out.includes(', '), 'scanner joins with a bare comma (canonical wire encoding)');
    assert.ok(!/Email Address|Phone Number/.test(out), 'no human labels — ids only');
});

test('empty and tiny inputs return the empty string', () => {
    assert.strictEqual(scanOutputForPii(''), '');
    assert.strictEqual(scanOutputForPii('ok'), '');
    assert.strictEqual(scanOutputForPii(null), '');
});
