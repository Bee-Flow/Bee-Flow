// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextcloudHttpError, extractReason, hasMaintenanceHeader, downloadFailureMessage } = require('./nextcloudHttpError');

const res = (/** @type {number} */ status, body = '') => ({ status, text: async () => body });
const AUTH = 'Bee Flow connector could not reach Nextcloud';

test('401 is the connector message, nothing else', async () => {
    assert.deepStrictEqual(await nextcloudHttpError(res(401), { authError: AUTH, what: 'x' }), { error: AUTH });
});

test('403 is a permission error with the OCS reason, not the connector message', async () => {
    const body = JSON.stringify({ ocs: { meta: { status: 'failure', message: 'Only the owner may do this' } } });
    const { error } = await nextcloudHttpError(res(403, body), { authError: AUTH, what: 'team update' });
    assert.match(error, /Permission denied/);
    assert.match(error, /Only the owner may do this/);
    assert.ok(!error.includes('could not reach'));
    assert.ok(!error.includes('{'), 'no raw JSON');
});

test('404 with a reason says not found; without one it hedges between id and app', async () => {
    const withReason = await nextcloudHttpError(res(404, '{"message":"Form not found"}'), { authError: AUTH, what: 'form lookup', app: 'Forms' });
    assert.match(withReason.error, /Not found for form lookup: Form not found/);
    assert.ok(!withReason.error.includes('not installed'));
    const bare = await nextcloudHttpError(res(404, '<html>x</html>'), { authError: AUTH, what: 'form lookup', app: 'Forms' });
    assert.match(bare.error, /id may be wrong/);
    assert.match(bare.error, /"Forms" app/);
});

test('5xx never echoes the body', async () => {
    const { error } = await nextcloudHttpError(res(500, 'SQLSTATE[42S22]: oc_tables_x column missing'), { authError: AUTH, what: 'row create' });
    assert.match(error, /\(500\)/);
    assert.ok(!/SQLSTATE|oc_tables/.test(error));
});

test('a Sabre XML message is read', () => {
    assert.strictEqual(extractReason('<d:error><s:message>Locked</s:message></d:error>'), 'Locked');
});

test('XML entities in a Sabre message are decoded', () => {
    assert.strictEqual(extractReason('<s:message>Can&apos;t &quot;lock&quot; &lt;a&gt; &amp; b</s:message>'), 'Can\'t "lock" <a> & b');
});

test('502/503/504 read as unreachable, 500 as an internal error, neither echoes the body', async () => {
    for (const status of [502, 503, 504]) {
        const { error } = await nextcloudHttpError(res(status, 'SQLSTATE secret'), { authError: AUTH, what: 'x' });
        assert.match(error, /could not be reached or is temporarily unavailable/);
        assert.ok(!error.includes('SQLSTATE'));
    }
    const { error } = await nextcloudHttpError(res(500, 'SQLSTATE secret'), { authError: AUTH, what: 'x' });
    assert.match(error, /internal error/);
});

test('a 403 that is the AppAPI signature failure is the connector message', async () => {
    const body = JSON.stringify({ message: 'AppAPI authentication failed' });
    assert.deepStrictEqual(await nextcloudHttpError(res(403, body), { authError: AUTH, what: 'x' }), { error: AUTH });
    const code = JSON.stringify({ ocs: { meta: { statuscode: 997, message: 'Unauthorised' } } });
    assert.deepStrictEqual(await nextcloudHttpError(res(403, code), { authError: AUTH, what: 'x' }), { error: AUTH });
});

// ── Maintenance mode ────────────────────────────────────────────────────────

const withHeaders = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers, body = '') => ({
    status,
    text: async () => body,
    headers: { get: (/** @type {string} */ name) => headers[name.toLowerCase()] ?? null },
});

test('a 503 with the maintenance header reads as maintenance mode', async () => {
    const { error } = await nextcloudHttpError(withHeaders(503, { 'x-nextcloud-maintenance-mode': '1' }), { authError: AUTH, what: 'board list' });
    assert.strictEqual(error, 'Nextcloud is in maintenance mode (503) during board list. Try again when the maintenance or upgrade is finished.');
});

test('a WebDAV 503 says maintenance in its Sabre body, without the header', async () => {
    const sabre = '<?xml version="1.0"?><d:error xmlns:s="http://sabredav.org/ns"><s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\ServerMaintenanceMode</s:exception><s:message>System is in maintenance mode.</s:message></d:error>';
    for (const body of [sabre, '<s:message>Upgrade needed</s:message>']) {
        const { error } = await nextcloudHttpError(res(503, body), { authError: AUTH, what: 'file read' });
        assert.match(error, /maintenance mode \(503\) during file read/);
        assert.ok(!error.includes('<'), 'the body is not echoed');
    }
});

test('a 503 without maintenance evidence stays "temporarily unavailable"; 502 and 504 never read as maintenance', async () => {
    const bare = await nextcloudHttpError(withHeaders(503, {}, 'Connector busy'), { authError: AUTH, what: 'x' });
    assert.match(bare.error, /temporarily unavailable \(503\)/);
    assert.doesNotMatch(bare.error, /maintenance/);
    for (const status of [502, 504]) {
        const { error } = await nextcloudHttpError(res(status, 'System is in maintenance mode.'), { authError: AUTH, what: 'x' });
        assert.doesNotMatch(error, /maintenance/);
    }
});

test('hasMaintenanceHeader reads a Response and a bare object', () => {
    assert.strictEqual(hasMaintenanceHeader(new Response('', { status: 503, headers: { 'X-Nextcloud-Maintenance-Mode': '1' } })), true);
    assert.strictEqual(hasMaintenanceHeader(new Response('', { status: 503 })), false);
    assert.strictEqual(hasMaintenanceHeader({}), false);
});

// ── An answer from a proxy or CDN in front of Nextcloud ─────────────────────

const CHALLENGE = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

test('a 403 HTML page with the proxy marker is worded as the proxy, not as a permission error', async () => {
    const byHeader = await nextcloudHttpError(withHeaders(403, { 'cf-ray': '8a1b2c3d4e5f-AMS', 'content-type': 'text/html; charset=UTF-8' }, '<html><body>blocked</body></html>'), { authError: AUTH, what: 'team list' });
    const byBody = await nextcloudHttpError(res(403, CHALLENGE), { authError: AUTH, what: 'team list' });
    for (const { error } of [byHeader, byBody]) {
        assert.match(error, /^A proxy in front of Nextcloud answered instead of Nextcloud \(403\) during team list: it blocked the request/);
        assert.doesNotMatch(error, /Permission denied|Sorry|<html/);
    }
});

test('the AppAPI signature failure keeps the connector message, also behind a proxy', async () => {
    const body = JSON.stringify({ message: 'AppAPI authentication failed' });
    const out = await nextcloudHttpError(withHeaders(403, { 'cf-ray': '8a1b2c3d4e5f-AMS', server: 'cloudflare' }, body), { authError: AUTH, what: 'x' });
    assert.deepStrictEqual(out, { error: AUTH });
});

test('a 403 from Nextcloud itself stays a permission error behind a proxy: JSON, Sabre XML and its own HTML page', async () => {
    const headers = { 'cf-ray': '8a1b2c3d4e5f-AMS', server: 'cloudflare' };
    const json = JSON.stringify({ ocs: { meta: { message: 'Only the owner may do this' } } });
    const xml = '<d:error><s:message>Forbidden</s:message></d:error>';
    const ownPage = '<!DOCTYPE html><html><head><title>Nextcloud</title></head><body>Access forbidden</body></html>';
    for (const body of [json, xml, ownPage]) {
        const { error } = await nextcloudHttpError(withHeaders(403, headers, body), { authError: AUTH, what: 'x' });
        assert.match(error, /^Permission denied for x/, body.slice(0, 20));
    }
    const noMarker = await nextcloudHttpError(res(403, '<html><body>403 Forbidden</body></html>'), { authError: AUTH, what: 'x' });
    assert.match(noMarker.error, /^Permission denied for x/);
});

test('520 to 527 and a proxy 413 page are worded as the proxy; a JSON 413 keeps its status line', async () => {
    for (const status of [520, 522, 524, 527]) {
        const { error } = await nextcloudHttpError(res(status, 'error code: 522'), { authError: AUTH, what: 'x' });
        assert.match(error, new RegExp(`answered instead of Nextcloud \\(${status}\\) during x: the proxy got no answer`));
    }
    const tooLarge = await nextcloudHttpError(res(413, '<html><head><title>413 Request Entity Too Large</title></head><body>cloudflare</body></html>'), { authError: AUTH, what: 'upload' });
    assert.match(tooLarge.error, /\(413\) during upload: the upload is larger than the proxy accepts/);
    const own = await nextcloudHttpError(res(413, '{"message":"Body too large"}'), { authError: AUTH, what: 'upload' });
    assert.strictEqual(own.error, 'Nextcloud upload failed (413): Body too large');
    const internal = await nextcloudHttpError(res(500, ''), { authError: AUTH, what: 'x' });
    assert.match(internal.error, /internal error/);
});

test('downloadFailureMessage: maintenance header, proxy status, and the plain status line', () => {
    assert.match(downloadFailureMessage(withHeaders(503, { 'x-nextcloud-maintenance-mode': '1' })), /maintenance mode \(503\) during download/);
    assert.match(downloadFailureMessage({ status: 521 }), /proxy in front of Nextcloud answered instead of Nextcloud \(521\)/);
    assert.match(downloadFailureMessage(withHeaders(403, { 'cf-ray': 'x', 'content-type': 'text/html' })), /\(403\) during download: it blocked the request/);
    assert.strictEqual(downloadFailureMessage(withHeaders(403, { 'cf-ray': 'x', 'content-type': 'application/xml' })), 'Nextcloud download failed (403)');
    assert.strictEqual(downloadFailureMessage({ status: 503 }), 'Nextcloud download failed (503)');
});
