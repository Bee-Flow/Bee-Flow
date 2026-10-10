/**
 * The upload ticket lifecycle: issue → PUT → burn → store, and every way it
 * must refuse. Fakes for the config store, object storage and the access policy.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createUploadTickets, TTL_MS } = require('./uploadTickets');
const { createUploadReceiver, receiveToFile } = require('./uploadReceiver');
const { createAccessCheck } = require('./accessCheck');
// The pure parts of the real access gate: the decision and the scope test.
const { evaluateAccessForOrgs } = require('../../auth/mcpAccess/gate');
const { scopeAllowsTool } = require('../../auth/mcpAccess/scopes');
const { isActiveAccount } = require('../../auth/accountStatusGate');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(996, 1)]); // 1000 bytes

function setup(over = {}) {
    let clock = 1_000_000;
    const kv = new Map();
    const tickets = createUploadTickets({
        now: () => clock,
        store: {
            get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
            set: async (k, v) => { kv.set(k, structuredClone(v)); },
            mutate: async (k, fn) => { const next = fn(kv.has(k) ? structuredClone(kv.get(k)) : null); kv.set(k, next); return next; },
            remove: async (k) => { kv.delete(k); },
            listKeys: async () => [...kv.keys()],
        },
    });
    const stored = [];
    const multipart = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-test-'));
    const policy = { enabled: true, ipAllowlist: [], allowedUsers: { mode: 'all' }, rejectLegacyTokens: false };
    const state = {
        token: { id: 't1', userId: 'u1', orgId: 'o1', name: 'laptop', scopes: { cms: { level: 'write' } }, ipAllowlist: [], expiresAt: null, revokedAt: null },
        user: { id: 'u1', role: 'admin', organizationId: 'o1', status: 'active' },
    };
    const checkAccess = createAccessCheck({
        getTokenById: async (id) => (state.token && state.token.id === id ? state.token : null),
        getUser: async () => state.user,
        resolveOrgs: async (user) => ({ primary: user.organizationId || null, all: user.organizationId ? [user.organizationId] : [] }),
        getOrgPolicy: async () => policy,
        evaluateAccessForOrgs,
        isActiveAccount,
        scopeAllowsTool,
        isAdmin: async (u) => u.role === 'admin',
    });
    const deps = {
        tickets,
        storage: { isAvailable: () => true, uploadFile: async (key, body, type, meta) => { stored.push({ key, body, type, meta }); } },
        streamIntoStorage: async (file, size, key, type) => { multipart.push({ key, type, size, bytes: fs.readFileSync(file).length }); },
        sanitizeSvg: (buf) => (buf.toString().includes('<script') ? null : Buffer.from(`CLEAN:${buf.toString()}`)),
        isValidVtt: (buf) => buf.toString().startsWith('WEBVTT'),
        looksLikeClip: (head) => head.toString('latin1', 4, 8) === 'ftyp',
        checkAccess,
        tmpRoot: () => tmp,
        ...over,
    };
    const receiver = createUploadReceiver(deps);
    const issue = (extra = {}) => tickets.issue({ userId: 'u1', orgId: 'o1', siteId: 'pj_aaaa', contentType: 'image/png', maxSize: 1000, filename: 'Hero Shot.png', tokenId: 't1', legacy: false, ...extra });
    const put = (ticket, body = PNG, extra = {}) => receiver.handle({
        ticket, contentType: 'image/png', contentLength: body.length, ip: '203.0.113.5', stream: Readable.from([body]), ...extra,
    });
    return { receiver, tickets, issue, put, stored, multipart, kv, policy, state, tmp, deps, advance: (ms) => { clock += ms; } };
}

const leftovers = (tmp) => fs.readdirSync(tmp);

test('success: stores the file as a CMS asset, answers with its url, burns the ticket', async () => {
    const s = setup();
    const { ticket, ticketId } = await s.issue();
    const out = await s.put(ticket);
    assert.equal(out.status, 200);
    assert.match(out.body.key, /^cms\/\d+-[a-f0-9]{12}-Hero_Shot\.png$/);
    assert.equal(out.body.url, `/api/cms/asset/${out.body.key}`);
    assert.equal(out.body.contentType, 'image/png');
    assert.equal(out.body.size, 1000);
    assert.equal(s.stored.length, 1);
    assert.deepEqual(s.stored[0].body, PNG);
    assert.equal(s.stored[0].type, 'image/png');
    const status = await s.tickets.status(ticketId, 'u1');
    assert.equal(status.state, 'done');
    assert.equal(status.used, true);
    assert.equal(status.asset.url, out.body.url);
    assert.deepEqual(leftovers(s.tmp), [], 'the temp directory is gone');
});

test('the ticket is stored hashed: the secret is not in the record', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    const secret = ticket.split('.')[1];
    assert.ok(!JSON.stringify([...s.kv.values()]).includes(secret));
});

test('reuse: a second PUT with the same ticket is refused and stores nothing more', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    assert.equal((await s.put(ticket)).status, 200);
    const again = await s.put(ticket);
    assert.equal(again.status, 403);
    assert.equal(s.stored.length, 1);
});

test('two PUTs racing for one ticket: exactly one stores a file', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    const results = await Promise.all([s.put(ticket), s.put(ticket)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
    assert.equal(s.stored.length, 1);
});

test('expired: refused, nothing stored', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    s.advance(TTL_MS + 1);
    assert.equal((await s.put(ticket)).status, 403);
    assert.equal(s.stored.length, 0);
});

test('malformed and unknown tickets are refused alike', async () => {
    const s = setup();
    assert.equal((await s.put('nonsense')).status, 403);
    assert.equal((await s.put(`${'a'.repeat(24)}.${'b'.repeat(43)}`)).status, 403);
    const { ticket } = await s.issue();
    const [id] = ticket.split('.');
    assert.equal((await s.put(`${id}.${'b'.repeat(43)}`)).status, 403, 'right id, wrong secret');
});

test('wrong Content-Type: 415, and the ticket is NOT spent (a retry with the right type works)', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    const bad = await s.put(ticket, PNG, { contentType: 'image/jpeg' });
    assert.equal(bad.status, 415);
    assert.match(bad.body.error, /image\/png/);
    const missing = await s.put(ticket, PNG, { contentType: undefined });
    assert.equal(missing.status, 415);
    assert.equal((await s.put(ticket)).status, 200);
});

test('Content-Type parameters are ignored (image/png; charset=binary)', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    assert.equal((await s.put(ticket, PNG, { contentType: 'IMAGE/PNG; x=y' })).status, 200);
});

test('oversize by Content-Length: 413 before anything is read, ticket not spent', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    const big = await s.put(ticket, Buffer.alloc(1001), { contentLength: 1001 });
    assert.equal(big.status, 413);
    assert.equal((await s.put(ticket)).status, 200);
});

test('oversize while streaming (no or lying Content-Length): 413, ticket spent, no file kept', async () => {
    const s = setup();
    const { ticket, ticketId } = await s.issue();
    const out = await s.put(ticket, Buffer.alloc(5000, 7), { contentLength: null });
    assert.equal(out.status, 413);
    assert.equal(out.closeConnection, true);
    assert.equal(s.stored.length, 0);
    assert.deepEqual(leftovers(s.tmp), []);
    assert.equal((await s.tickets.status(ticketId, 'u1')).state, 'failed');
    assert.equal((await s.put(ticket)).status, 403, 'spent');
});

test('a hard byte cap really stops reading: the source is paused, not drained', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-cap-'));
    let pulled = 0;
    const source = new Readable({ read() { pulled += 1; this.push(Buffer.alloc(16 * 1024)); if (pulled > 10_000) this.push(null); } });
    await assert.rejects(receiveToFile(source, path.join(tmp, 'f'), 64 * 1024), /too large/);
    const atStop = pulled;
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(atStop < 100, `stopped early (pulled ${atStop} chunks)`);
    assert.ok(pulled - atStop <= 2, 'no further reads after the cap');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('an upload that is cut off before the end fails cleanly', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    const broken = new Readable({ read() { this.push(Buffer.alloc(100)); this.destroy(new Error('socket hang up')); } });
    const out = await s.put(ticket, PNG, { stream: broken, contentLength: null });
    assert.equal(out.status, 400);
    assert.equal(s.stored.length, 0);
    assert.deepEqual(leftovers(s.tmp), []);
});

test('an empty upload is refused', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    assert.equal((await s.put(ticket, Buffer.alloc(0), { contentLength: null })).status, 400);
    assert.equal(s.stored.length, 0);
});

test('IP outside the org allow-list: refused, ticket not spent', async () => {
    const s = setup();
    s.policy.ipAllowlist = ['198.51.100.9/32'];
    const { ticket } = await s.issue();
    const out = await s.put(ticket, PNG, { ip: '203.0.113.5' });
    assert.equal(out.status, 403);
    assert.equal(s.stored.length, 0);
    assert.equal((await s.put(ticket, PNG, { ip: '198.51.100.9' })).status, 200);
});

test('the org turning MCP off after the ticket was issued blocks the upload', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    s.policy.enabled = false;
    assert.equal((await s.put(ticket)).status, 403);
});

test('a policy that cannot be read fails closed', async () => {
    const state0 = setup().state;
    const s = setup({ checkAccess: createAccessCheck({
        getTokenById: async (id) => ({ ...state0.token, id }), getUser: async () => ({ id: 'u1', role: 'admin', organizationId: 'o1' }),
        resolveOrgs: async () => ({ primary: 'o1', all: ['o1'] }), getOrgPolicy: async () => { throw new Error('db down'); },
        evaluateAccessForOrgs, isActiveAccount, scopeAllowsTool, isAdmin: async () => true,
    }) });
    const { ticket } = await s.issue();
    assert.equal((await s.put(ticket)).status, 403);
    assert.equal(s.stored.length, 0);
});

test('a user who lost admin rights since the ticket was issued is refused', async () => {
    const s = setup();
    const { ticket } = await s.issue();
    s.state.user.role = 'user';
    assert.equal((await s.put(ticket)).status, 403);
    s.state.user.role = 'admin';
    assert.equal((await s.put(ticket)).status, 200, 'refusal did not spend the ticket');
});

// The full access decision, asked again at PUT time. Each refusal is generic,
// and each leaves the ticket unused: restore the cause and the same URL works.
const REFUSALS = [
    ['the token was revoked', (s) => { s.state.token.revokedAt = '2026-10-10T10:00:00.000Z'; }, (s) => { s.state.token.revokedAt = null; }],
    ['the token was switched off', (s) => { s.state.token.disabledAt = '2026-10-10T10:00:00.000Z'; }, (s) => { s.state.token.disabledAt = null; }],
    ['the token expired', (s) => { s.state.token.expiresAt = '2000-01-01T00:00:00.000Z'; }, (s) => { s.state.token.expiresAt = null; }],
    ['the token is gone', (s) => { s.state.token = null; }, (s) => { s.state.token = { id: 't1', userId: 'u1', orgId: 'o1', name: 'laptop', scopes: { cms: { level: 'write' } }, ipAllowlist: [], expiresAt: null, revokedAt: null }; }],
    ['the IP is outside the token list', (s) => { s.state.token.ipAllowlist = ['198.51.100.0/24']; }, (s) => { s.state.token.ipAllowlist = []; }],
    ['the cms scope was removed', (s) => { s.state.token.scopes = { studio: { level: 'write' } }; }, (s) => { s.state.token.scopes = { cms: { level: 'write' } }; }],
    ['the token was downgraded to read', (s) => { s.state.token.scopes = { cms: { level: 'read' } }; }, (s) => { s.state.token.scopes = { cms: { level: 'write' } }; }],
    ['the tool list no longer includes uploads', (s) => { s.state.token.scopes = { cms: { level: 'write', tools: ['cms_list_site'] } }; }, (s) => { s.state.token.scopes = { cms: { level: 'write' } }; }],
    ['the account was suspended', (s) => { s.state.user.status = 'suspended'; }, (s) => { s.state.user.status = 'active'; }],
    ['the user is no longer allowed by the org', (s) => { s.policy.allowedUsers = { mode: 'users', userIds: ['someone-else'] }; }, (s) => { s.policy.allowedUsers = { mode: 'all' }; }],
    ['the user moved to another organisation', (s) => { s.state.user.organizationId = 'o2'; }, (s) => { s.state.user.organizationId = 'o1'; }],
    ['the token belongs to another user', (s) => { s.state.token.userId = 'u9'; }, (s) => { s.state.token.userId = 'u1'; }],
];
for (const [name, break_, fix] of REFUSALS) {
    test(`refused and the ticket stays unused when ${name}`, async () => {
        const s = setup();
        const { ticket, ticketId } = await s.issue();
        break_(s);
        const out = await s.put(ticket);
        assert.equal(out.status, 403);
        assert.match(out.body.error, /not valid/);
        assert.equal(s.stored.length, 0);
        assert.equal((await s.tickets.status(ticketId, 'u1')).used, false, 'not burned');
        fix(s);
        assert.equal((await s.put(ticket)).status, 200);
    });
}

test('a ticket without a named token behind it (legacy) is never honoured', async () => {
    const s = setup();
    const legacy = await s.issue({ tokenId: null, legacy: true });
    assert.equal((await s.put(legacy.ticket)).status, 403);
    const noToken = await s.issue({ tokenId: null, legacy: false });
    assert.equal((await s.put(noToken.ticket)).status, 403);
    assert.equal(s.stored.length, 0);
    assert.equal((await s.tickets.status(legacy.ticketId, 'u1')).used, false, 'not burned');
});

test('a group-only member (no home org) is held to the policy of the org their group belongs to', async () => {
    const s = setup();
    s.state.user.organizationId = '';
    const check = createAccessCheck({
        getTokenById: async () => s.state.token,
        getUser: async () => s.state.user,
        resolveOrgs: async () => ({ primary: 'o1', all: ['o1'] }),
        getOrgPolicy: async (orgId) => (orgId === 'o1' ? { ...s.policy, ipAllowlist: ['198.51.100.0/24'] } : s.policy),
        evaluateAccessForOrgs, isActiveAccount, scopeAllowsTool, isAdmin: async () => true,
    });
    const bound = { userId: 'u1', orgId: 'o1', tokenId: 't1', legacy: false };
    assert.deepEqual(await check(bound, '203.0.113.5'), { ok: false, reason: 'ip_outside_org_list' });
    assert.deepEqual(await check(bound, '198.51.100.7'), { ok: true });
});

test('with several orgs the strictest policy wins, and unresolvable orgs are refused', async () => {
    const s = setup();
    const base = {
        getTokenById: async () => s.state.token, getUser: async () => s.state.user,
        evaluateAccessForOrgs, isActiveAccount, scopeAllowsTool, isAdmin: async () => true,
    };
    const bound = { userId: 'u1', orgId: 'o1', tokenId: 't1', legacy: false };
    const two = createAccessCheck({
        ...base,
        resolveOrgs: async () => ({ primary: 'o1', all: ['o1', 'o2'] }),
        getOrgPolicy: async (orgId) => ({ ...s.policy, enabled: orgId !== 'o2' }),
    });
    assert.deepEqual(await two(bound, '203.0.113.5'), { ok: false, reason: 'mcp_disabled' });
    const broken = createAccessCheck({ ...base, resolveOrgs: async () => { throw new Error('groups unreadable'); }, getOrgPolicy: async () => s.policy });
    assert.match((await broken(bound, '203.0.113.5')).reason, /^check_failed/);
});

test('SVG is sanitised before storage and tagged; an unsafe SVG is rejected', async () => {
    const s = setup();
    const ok = await s.issue({ contentType: 'image/svg+xml', filename: 'logo.svg', maxSize: 100 });
    const res = await s.put(ok.ticket, Buffer.from('<svg/>'), { contentType: 'image/svg+xml' });
    assert.equal(res.status, 200);
    assert.equal(s.stored[0].body.toString(), 'CLEAN:<svg/>');
    assert.deepEqual(s.stored[0].meta, { sanitized: '1' });
    assert.match(res.body.key, /\.svg$/);

    const bad = await s.issue({ contentType: 'image/svg+xml', filename: 'x.svg', maxSize: 100 });
    const rej = await s.put(bad.ticket, Buffer.from('<svg><script>1</script></svg>'), { contentType: 'image/svg+xml' });
    assert.equal(rej.status, 400);
    assert.equal(s.stored.length, 1);
});

test('captions must be real WebVTT', async () => {
    const s = setup();
    const good = await s.issue({ contentType: 'text/vtt', filename: 'c.vtt', maxSize: 100 });
    assert.equal((await s.put(good.ticket, Buffer.from('WEBVTT\n\n'), { contentType: 'text/vtt' })).status, 200);
    const bad = await s.issue({ contentType: 'text/vtt', filename: 'c.vtt', maxSize: 100 });
    assert.equal((await s.put(bad.ticket, Buffer.from('hello'), { contentType: 'text/vtt' })).status, 400);
});

test('clips go through the multipart path after a container sniff; a renamed file is rejected', async () => {
    const s = setup();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
    const t1 = await s.issue({ contentType: 'video/mp4', filename: 'demo.mp4', maxSize: 100 });
    const ok = await s.put(t1.ticket, mp4, { contentType: 'video/mp4' });
    assert.equal(ok.status, 200);
    assert.equal(s.multipart.length, 1);
    assert.equal(s.multipart[0].bytes, mp4.length);
    assert.equal(s.stored.length, 0);

    const t2 = await s.issue({ contentType: 'video/mp4', filename: 'fake.mp4', maxSize: 100 });
    const bad = await s.put(t2.ticket, Buffer.alloc(40, 3), { contentType: 'video/mp4' });
    assert.equal(bad.status, 400);
    assert.equal(s.multipart.length, 1);
});

test('unavailable storage refuses without spending the ticket', async () => {
    let available = false;
    const s = setup({ storage: { isAvailable: () => available, uploadFile: async () => {} } });
    const { ticket } = await s.issue();
    assert.equal((await s.put(ticket)).status, 503);
    available = true;
    assert.equal((await s.put(ticket)).status, 200);
});

test('a storage failure is recorded on the ticket and the temp is cleaned', async () => {
    const s = setup({ storage: { isAvailable: () => true, uploadFile: async () => { throw new Error('s3 exploded'); } } });
    const { ticket, ticketId } = await s.issue();
    const out = await s.put(ticket);
    assert.equal(out.status, 500);
    assert.ok(!JSON.stringify(out.body).includes('s3'), 'internal detail is not leaked');
    assert.equal((await s.tickets.status(ticketId, 'u1')).state, 'failed');
    assert.deepEqual(leftovers(s.tmp), []);
});

test('status: pending, expired, and invisible to another user', async () => {
    const s = setup();
    const { ticketId } = await s.issue();
    assert.equal((await s.tickets.status(ticketId, 'u1')).state, 'pending');
    assert.equal(await s.tickets.status(ticketId, 'someone-else'), null);
    assert.equal(await s.tickets.status('zz', 'u1'), null);
    s.advance(TTL_MS + 1);
    assert.equal((await s.tickets.status(ticketId, 'u1')).state, 'expired');
});

test('prune removes records long past use and keeps recent ones', async () => {
    const s = setup();
    const old = await s.issue();
    s.advance(25 * 60 * 60 * 1000);
    const fresh = await s.issue();
    await s.tickets.prune();
    assert.equal(await s.tickets.status(old.ticketId, 'u1'), null);
    assert.ok(await s.tickets.status(fresh.ticketId, 'u1'));
});

test('open tickets are capped at 20 per user; a used or expired one frees a slot', async () => {
    const s = setup();
    const issued = [];
    for (let i = 0; i < 20; i++) issued.push(await s.issue());
    await assert.rejects(s.issue(), (e) => e.code === 'too_many_open_tickets');
    assert.equal((await s.issue({ userId: 'u2' })).ticketId.length, 24, 'another user has their own allowance');
    assert.equal((await s.put(issued[0].ticket)).status, 200, 'using one spends it');
    assert.ok(await s.issue(), 'the slot is free again');
    await assert.rejects(s.issue(), (e) => e.code === 'too_many_open_tickets');
    s.advance(TTL_MS + 1);
    assert.ok(await s.issue(), 'expired tickets do not count');
});
