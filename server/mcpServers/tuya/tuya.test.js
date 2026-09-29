const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const tuya = require('./tuya');

// Fixture credentials — never real. `npm run lint:secrets` keeps keys like this
// confined to test files.
const ACCESS_ID = 'testaccessid123456';
const ACCESS_SECRET = 'testaccesssecret0987654321abcdef';
const T = 1754140800000;
const NONCE = '00000000-0000-4000-8000-000000000000';

// ─── config ─────────────────────────────────────────────────────────

test('readConfig defaults to the EU data center', () => {
    const config = tuya.readConfig({ TUYA_ACCESS_ID: ACCESS_ID, TUYA_ACCESS_SECRET: ACCESS_SECRET });

    assert.strictEqual(config.accessId, ACCESS_ID);
    assert.strictEqual(config.region, 'eu');
    assert.strictEqual(config.baseUrl, 'https://openapi.tuyaeu.com');
    assert.strictEqual(config.uid, '');
    assert.strictEqual(config.readOnly, false);
    assert.strictEqual(config.allowLocks, false);
});

test('readConfig maps every region and lets TUYA_BASE_URL win', () => {
    assert.strictEqual(tuya.readConfig({ TUYA_REGION: 'us' }).baseUrl, 'https://openapi.tuyaus.com');
    assert.strictEqual(tuya.readConfig({ TUYA_REGION: 'WEU' }).baseUrl, 'https://openapi-weaz.tuyaeu.com');
    assert.strictEqual(tuya.readConfig({ TUYA_REGION: 'in' }).baseUrl, 'https://openapi.tuyain.com');
    // An unknown region must not produce an undefined host.
    assert.strictEqual(tuya.readConfig({ TUYA_REGION: 'mars' }).baseUrl, 'https://openapi.tuyaeu.com');
    assert.strictEqual(
        tuya.readConfig({ TUYA_REGION: 'us', TUYA_BASE_URL: 'https://openapi.example.test/' }).baseUrl,
        'https://openapi.example.test'
    );
});

test('readConfig never throws on missing credentials (install-time probe)', () => {
    const config = tuya.readConfig({});

    assert.strictEqual(config.accessId, '');
    assert.throws(() => tuya.requireCredentials(config), /credentials are not configured/i);
});

test('readConfig reads the operator flags', () => {
    assert.strictEqual(tuya.readConfig({ TUYA_READ_ONLY: 'true' }).readOnly, true);
    assert.strictEqual(tuya.readConfig({ TUYA_READ_ONLY: '0' }).readOnly, false);
    assert.strictEqual(tuya.readConfig({ TUYA_ALLOW_LOCKS: 'yes' }).allowLocks, true);
    assert.strictEqual(tuya.readConfig({}).allowLocks, false);
});

test('allowedTools drops the write tools in read-only mode', () => {
    const tools = [
        { name: 'list_devices' },
        { name: 'get_device_status' },
        { name: 'send_command' },
        { name: 'switch_device' },
        { name: 'set_light' },
        { name: 'trigger_scene' },
    ];

    assert.strictEqual(tuya.allowedTools(tools, { readOnly: false }).length, 6);
    assert.deepStrictEqual(
        tuya.allowedTools(tools, { readOnly: true }).map((t) => t.name),
        ['list_devices', 'get_device_status']
    );
});

// ─── signing ────────────────────────────────────────────────────────

test('canonicalUrl sorts query params and drops empties', () => {
    assert.strictEqual(tuya.canonicalUrl('/v1.0/devices'), '/v1.0/devices');
    assert.strictEqual(
        tuya.canonicalUrl('/v1.0/devices', { page_size: 20, page_no: 1, source_type: '' }),
        '/v1.0/devices?page_no=1&page_size=20'
    );
    assert.strictEqual(
        tuya.canonicalUrl('/v2.0/cloud/scene/rule', { type: 'scene', space_id: '123' }),
        '/v2.0/cloud/scene/rule?space_id=123&type=scene'
    );
    assert.strictEqual(
        tuya.canonicalUrl('/v1.0/x', { q: 'a b&c' }),
        '/v1.0/x?q=a%20b%26c'
    );
});

test('sha256Hex of an empty body is the well-known empty digest', () => {
    assert.strictEqual(
        tuya.sha256Hex(''),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
});

test('signRequest builds the token-request form (no access_token)', () => {
    const url = '/v1.0/token?grant_type=1';
    const headers = tuya.signRequest({
        method: 'GET',
        url,
        accessId: ACCESS_ID,
        accessSecret: ACCESS_SECRET,
        t: T,
        nonce: NONCE,
    });

    const stringToSign = ['GET', tuya.sha256Hex(''), '', url].join('\n');
    const expected = crypto
        .createHmac('sha256', ACCESS_SECRET)
        .update(`${ACCESS_ID}${T}${NONCE}${stringToSign}`, 'utf8')
        .digest('hex')
        .toUpperCase();

    assert.strictEqual(headers.sign, expected);
    assert.strictEqual(headers.client_id, ACCESS_ID);
    assert.strictEqual(headers.t, String(T));
    assert.strictEqual(headers.sign_method, 'HMAC-SHA256');
    assert.strictEqual(headers.nonce, NONCE);
    assert.ok(!('access_token' in headers), 'token requests must not carry an access_token');
    assert.match(headers.sign, /^[0-9A-F]{64}$/, 'sign is uppercase hex');
});

test('signRequest splices the access_token in for business requests', () => {
    const url = '/v1.0/users/u1/devices';
    const token = 'tok_abcdef123456';
    const headers = tuya.signRequest({
        method: 'GET',
        url,
        accessId: ACCESS_ID,
        accessSecret: ACCESS_SECRET,
        accessToken: token,
        t: T,
        nonce: NONCE,
    });

    const stringToSign = ['GET', tuya.sha256Hex(''), '', url].join('\n');
    const expected = crypto
        .createHmac('sha256', ACCESS_SECRET)
        .update(`${ACCESS_ID}${token}${T}${NONCE}${stringToSign}`, 'utf8')
        .digest('hex')
        .toUpperCase();

    assert.strictEqual(headers.sign, expected);
    assert.strictEqual(headers.access_token, token);
    // The token is part of the signature, so the two forms must differ.
    const withoutToken = tuya.signRequest({
        method: 'GET', url, accessId: ACCESS_ID, accessSecret: ACCESS_SECRET, t: T, nonce: NONCE,
    });
    assert.notStrictEqual(headers.sign, withoutToken.sign);
});

test('signRequest hashes the POST body into the signature', () => {
    const url = '/v1.0/iot-03/devices/dev1/commands';
    const body = JSON.stringify({ commands: [{ code: 'switch_1', value: true }] });
    const signed = tuya.signRequest({
        method: 'POST', url, body, accessId: ACCESS_ID, accessSecret: ACCESS_SECRET,
        accessToken: 'tok', t: T, nonce: NONCE,
    });
    const empty = tuya.signRequest({
        method: 'POST', url, accessId: ACCESS_ID, accessSecret: ACCESS_SECRET,
        accessToken: 'tok', t: T, nonce: NONCE,
    });

    assert.notStrictEqual(signed.sign, empty.sign);

    const stringToSign = ['POST', tuya.sha256Hex(body), '', url].join('\n');
    const expected = crypto
        .createHmac('sha256', ACCESS_SECRET)
        .update(`${ACCESS_ID}tok${T}${NONCE}${stringToSign}`, 'utf8')
        .digest('hex')
        .toUpperCase();
    assert.strictEqual(signed.sign, expected);
});

test('signRequest generates a nonce when none is supplied', () => {
    const a = tuya.signRequest({ method: 'GET', url: '/x', accessId: ACCESS_ID, accessSecret: ACCESS_SECRET, t: T });
    const b = tuya.signRequest({ method: 'GET', url: '/x', accessId: ACCESS_ID, accessSecret: ACCESS_SECRET, t: T });

    assert.notStrictEqual(a.nonce, b.nonce);
    assert.notStrictEqual(a.sign, b.sign);
});

test('scrubSecrets removes the access secret and token from error text', () => {
    const config = { accessSecret: ACCESS_SECRET };
    const message = `sign invalid for secret=${ACCESS_SECRET} token=tok_abcdef123456`;

    const scrubbed = tuya.scrubSecrets(message, config, 'tok_abcdef123456');
    assert.ok(!scrubbed.includes(ACCESS_SECRET));
    assert.ok(!scrubbed.includes('tok_abcdef123456'));
    assert.ok(scrubbed.includes('***'));
});

// ─── devices ────────────────────────────────────────────────────────

test('isLockDevice covers lock categories and name hints', () => {
    assert.strictEqual(tuya.isLockDevice({ category: 'ms' }), true);
    assert.strictEqual(tuya.isLockDevice({ category: 'ckmkzq' }), true);
    assert.strictEqual(tuya.isLockDevice({ category: 'MS' }), true);
    assert.strictEqual(tuya.isLockDevice({ category: 'dj', name: 'Voordeur slot' }), true);
    assert.strictEqual(tuya.isLockDevice({ category: 'kg', product_name: 'Garage Door Opener' }), true);
    assert.strictEqual(tuya.isLockDevice({ category: 'dj', name: 'Woonkamer lamp' }), false);
    assert.strictEqual(tuya.isLockDevice({}), false);
});

test('summarizeDevice never leaks local_key or the household IP', () => {
    const summary = tuya.summarizeDevice({
        id: 'dev1',
        name: 'Bureaulamp',
        category: 'dj',
        product_name: 'Smart Bulb',
        online: true,
        local_key: 'aaaaaaaaaaaaaaaa',
        ip: '84.12.9.7',
        uid: 'eu1234567890',
    });

    assert.strictEqual(summary.id, 'dev1');
    assert.strictEqual(summary.online, true);
    assert.strictEqual(summary.is_lock, false);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes('aaaaaaaaaaaaaaaa'), 'local_key must not survive');
    assert.ok(!serialized.includes('84.12.9.7'), 'ip must not survive');
});

test('filterDevices narrows by query, online state and category', () => {
    const devices = [
        { id: '1', name: 'Woonkamer lamp', category: 'dj', online: true },
        { id: '2', name: 'Keuken plug', category: 'cz', online: false },
        { id: '3', name: 'Slaapkamer lamp', category: 'dj', online: true },
    ];

    assert.deepStrictEqual(tuya.filterDevices(devices, { query: 'lamp' }).map((d) => d.id), ['1', '3']);
    assert.deepStrictEqual(tuya.filterDevices(devices, { online: false }).map((d) => d.id), ['2']);
    assert.deepStrictEqual(tuya.filterDevices(devices, { category: 'DJ' }).map((d) => d.id), ['1', '3']);
    assert.strictEqual(tuya.filterDevices(devices, {}).length, 3);
    assert.strictEqual(tuya.filterDevices(null, {}).length, 0);
});

test('matchDevice resolves ids, exact names and unique substrings', () => {
    const devices = [
        { id: 'bf1234', name: 'Woonkamer lamp' },
        { id: 'bf5678', name: 'Keuken lamp' },
        { id: 'bf9999', name: 'Ventilator' },
    ];

    assert.strictEqual(tuya.matchDevice(devices, 'bf5678').device.id, 'bf5678');
    assert.strictEqual(tuya.matchDevice(devices, 'woonkamer lamp').device.id, 'bf1234');
    assert.strictEqual(tuya.matchDevice(devices, 'Ventil').device.id, 'bf9999');
});

test('matchDevice refuses to guess when a name is ambiguous', () => {
    const devices = [
        { id: 'bf1234', name: 'Woonkamer lamp' },
        { id: 'bf5678', name: 'Keuken lamp' },
    ];

    const ambiguous = tuya.matchDevice(devices, 'lamp');
    assert.strictEqual(ambiguous.device, null);
    assert.deepStrictEqual(ambiguous.candidates.map((d) => d.id), ['bf1234', 'bf5678']);

    const missing = tuya.matchDevice(devices, 'tuinverlichting');
    assert.strictEqual(missing.device, null);
    assert.strictEqual(missing.candidates.length, 0);

    assert.strictEqual(tuya.matchDevice(devices, '').device, null);
});

// ─── specs & commands ───────────────────────────────────────────────

test('parseSpecValues survives strings, objects and junk', () => {
    assert.deepStrictEqual(tuya.parseSpecValues('{"min":10,"max":1000}'), { min: 10, max: 1000 });
    assert.deepStrictEqual(tuya.parseSpecValues({ min: 1 }), { min: 1 });
    assert.deepStrictEqual(tuya.parseSpecValues('not json'), {});
    assert.deepStrictEqual(tuya.parseSpecValues(undefined), {});
});

test('percentToRaw / rawToPercent round-trip the 10-1000 brightness range', () => {
    const spec = { values: '{"min":10,"max":1000,"scale":0,"step":1}' };

    assert.strictEqual(tuya.percentToRaw(0, spec), 10);
    assert.strictEqual(tuya.percentToRaw(100, spec), 1000);
    assert.strictEqual(tuya.percentToRaw(50, spec), 505);
    // Out-of-range input clamps rather than producing an invalid command.
    assert.strictEqual(tuya.percentToRaw(150, spec), 1000);
    assert.strictEqual(tuya.percentToRaw(-20, spec), 10);

    assert.strictEqual(tuya.rawToPercent(10, spec), 0);
    assert.strictEqual(tuya.rawToPercent(1000, spec), 100);
    assert.strictEqual(tuya.rawToPercent(505, spec), 50);
});

test('percentToRaw honours a coarse step', () => {
    const spec = { values: '{"min":0,"max":100,"step":10}' };

    assert.strictEqual(tuya.percentToRaw(44, spec), 40);
    assert.strictEqual(tuya.percentToRaw(46, spec), 50);
});

test('summarizeStatus applies scale, unit and percentage from the spec', () => {
    const specification = {
        status: [
            { code: 'temp_current', type: 'Integer', values: '{"unit":"°C","min":-200,"max":600,"scale":1,"step":1}' },
            { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000,"scale":0,"step":1}' },
        ],
        functions: [{ code: 'switch_led', type: 'Boolean', values: '{}' }],
    };
    const status = [
        { code: 'temp_current', value: 235 },
        { code: 'bright_value_v2', value: 505 },
        { code: 'switch_led', value: true },
        { code: 'unknown_dp', value: 'x' },
    ];

    const [temp, bright, sw, unknown] = tuya.summarizeStatus(status, specification);

    assert.strictEqual(temp.display, 23.5);
    assert.strictEqual(temp.unit, '°C');
    assert.strictEqual(bright.percent, 50);
    assert.strictEqual(sw.type, 'Boolean');
    // Unknown data points still come back, just undecorated.
    assert.deepStrictEqual(unknown, { code: 'unknown_dp', value: 'x' });
});

test('findSwitchCode prefers the canonical codes and falls back to any switch*', () => {
    assert.strictEqual(
        tuya.findSwitchCode({ functions: [{ code: 'switch_led', type: 'Boolean' }, { code: 'bright_value', type: 'Integer' }] }),
        'switch_led'
    );
    assert.strictEqual(
        tuya.findSwitchCode({ functions: [{ code: 'switch_2', type: 'Boolean' }] }),
        'switch_2'
    );
    assert.strictEqual(tuya.findSwitchCode({ functions: [{ code: 'mode', type: 'Enum' }] }), null);
    assert.strictEqual(tuya.findSwitchCode({}), null);
});

test('validateCommands rejects codes the device does not accept', () => {
    const specification = { functions: [{ code: 'switch_1', type: 'Boolean' }] };

    assert.deepStrictEqual(
        tuya.validateCommands([{ code: 'switch_1', value: true }], specification),
        [{ code: 'switch_1', value: true }]
    );
    assert.throws(
        () => tuya.validateCommands([{ code: 'unlock_door', value: true }], specification),
        /does not accept unlock_door/
    );
    assert.throws(() => tuya.validateCommands([], specification), /At least one command/);
    assert.throws(() => tuya.validateCommands([{ value: true }], specification), /needs a "code"/);
    assert.throws(() => tuya.validateCommands([{ code: 'switch_1' }], specification), /needs a "value"/);
    // No published spec is not a reason to refuse.
    assert.strictEqual(tuya.validateCommands([{ code: 'anything', value: 1 }], {}).length, 1);
});

test('clampLimit keeps result counts sane', () => {
    assert.strictEqual(tuya.clampLimit(undefined), 50);
    assert.strictEqual(tuya.clampLimit('10'), 10);
    assert.strictEqual(tuya.clampLimit(9999), 200);
    assert.strictEqual(tuya.clampLimit('lots'), 50);
});
