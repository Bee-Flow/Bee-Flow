'use strict';

/**
 * The chat signals recorder: what is counted, what never is, and that nothing
 * but closed-vocabulary counters reaches the store.
 *
 * The store, the objection store and the resolver are doubles keyed by the
 * require strings chatSignals.js uses; everything else is real.
 *
 * Run: cd server && node --test core/privacy/chatSignals.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../testUtils/stubRequire');

const VERSION = '2026-10-14T09:00:00.000Z';
const fx = {
    mon: null,
    objecting: new Set(),
    objectionCalls: [],
    writes: [],
    failWrites: 0,
};
const ON = { state: 'on', version: VERSION, from: '2026-10-14', surfaces: ['direct', 'agent', 'agent_public'], paused: [], signals: ['outcomes', 'kinds'] };

const restore = installResolveStub({
    '../../stores/chatSignalStore': {
        addCounts: async (rows) => {
            if (fx.failWrites > 0) { fx.failWrites--; throw new Error('connection lost'); }
            fx.writes.push(rows.map(r => ({ ...r })));
            return rows.length;
        },
    },
    '../../stores/chatSignalObjectionStore': {
        isObjecting: async (userId) => { fx.objectionCalls.push(userId); return fx.objecting.has(userId); },
    },
    '../entitlements/chatMonitoringFlag': {
        resolveChatMonitoring: async () => fx.mon,
    },
});
const cs = require('./chatSignals');
after(restore);

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const rows = () => fx.writes.flat();

beforeEach(() => {
    cs._resetForTests();
    cs._setNowForTests(() => new Date('2026-10-21T10:00:00.000Z'));   // a Wednesday
    fx.mon = ON;
    fx.objecting = new Set();
    fx.objectionCalls = [];
    fx.writes = [];
    fx.failWrites = 0;
});

function turn(over = {}) {
    return {
        orgKey: 'org1', surface: 'direct', userId: 'u1', optOut: false, notice: `direct@${VERSION}`,
        outcome: 'protected', categories: ['EmailAddress', 'Person'],
        providerConfig: { providerType: 'openai', url: 'https://api.openai.com/v1' }, allowlistedHosts: [], dryRun: false,
        ...over,
    };
}

async function count(t) {
    assert.equal(cs.countTurn(t), undefined, 'countTurn returns nothing');
    await settle();
    await cs.flush();
    return rows();
}

test('a counted turn: one outcome row, one row per distinct kind, closed vocabulary only', async () => {
    const out = await count(turn({ categories: ['EmailAddress', 'Email', 'Person', 'Organization'] }));
    assert.deepEqual(out.map(r => [r.signal, r.value, r.protection, r.provider_type]).sort(), [
        ['kind', 'email', 'protected', ''],
        ['kind', 'name', 'protected', ''],
        ['outcome', 'protected', '', 'openai'],
    ]);
    for (const r of out) {
        assert.deepEqual(Object.keys(r).sort(), ['destination', 'granularity', 'organization_id', 'period_start', 'protection', 'provider_type', 'signal', 'surface', 'turns', 'value']);
        assert.equal(r.period_start, '2026-10-19', 'employee rows sit on the ISO-week Monday');
        assert.equal(r.granularity, 'week');
        assert.equal(r.destination, 'external');
        assert.equal(r.turns, 1);
    }
});

test('off or scheduled: nothing is counted', async () => {
    fx.mon = { ...ON, state: 'off', surfaces: [] };
    assert.deepEqual(await count(turn()), []);
    fx.mon = { ...ON, state: 'scheduled' };
    assert.deepEqual(await count(turn()), []);
    fx.mon = { ...ON, surfaces: ['agent_public'] };
    assert.deepEqual(await count(turn()), [], 'a paused or unselected surface is not counted');
});

test('a dry run (test chat, "test as") is never counted', async () => {
    assert.deepEqual(await count(turn({ dryRun: true })), []);
});

test('announced equals counted: no marker, a stale version or another surface\'s marker counts nothing', async () => {
    for (const notice of [null, undefined, '', 'direct@2026-10-07T09:00:00.000Z', `agent@${VERSION}`, `agent_public@${VERSION}`, 'yes']) {
        assert.deepEqual(await count(turn({ notice })), [], String(notice));
    }
    assert.equal((await count(turn())).length > 0, true, 'the exact marker counts');
});

test('the request opt-out and a recorded objection count nothing; a guest never reaches the objection store', async () => {
    assert.deepEqual(await count(turn({ optOut: true })), []);
    fx.objecting.add('u1');
    assert.deepEqual(await count(turn()), []);
    assert.deepEqual(fx.objectionCalls, ['u1']);
    fx.objectionCalls = [];
    const visitor = await count(turn({ surface: 'agent_public', userId: 'guest_abc', notice: `agent_public@${VERSION}` }));
    assert.ok(visitor.length > 0);
    assert.deepEqual(fx.objectionCalls, [], 'no lookup for a guest id');
    assert.ok(visitor.every(r => r.granularity === 'day' && r.period_start === '2026-10-21'), 'website visitors are counted per day');
});

test('extra keys never reach the store: no user, conversation, text, agent id or name (amendment 24)', async () => {
    const out = await count({
        ...turn(),
        conversationId: 'conv-secret-1', text: 'Jan Jansen, jan@example.org', agentId: 'agent-secret-9', agentName: 'Bob the HR bot',
        projectId: 'proj-7', model: 'gpt-x', ip: '10.1.2.3',
    });
    const json = JSON.stringify(out);
    for (const needle of ['u1', 'conv-secret-1', 'Jan Jansen', 'jan@example.org', 'agent-secret-9', 'Bob the HR bot', 'proj-7', 'gpt-x', '10.1.2.3', 'api.openai.com']) {
        assert.ok(!json.includes(needle), `${needle} reached addCounts`);
    }
    assert.ok(out.length > 0);
});

test('kindOf: custom labels are "other", secrets are "credential", health is DROPPED, never "other" (amendment 3)', () => {
    assert.equal(cs.kindOf('cdt_contract_number'), 'other');
    assert.equal(cs.kindOf('UserMarked'), 'other');
    assert.equal(cs.kindOf('Projectcode X'), 'other');
    assert.equal(cs.kindOf('ApiKeyOrSecret'), 'credential');
    assert.equal(cs.kindOf('API key / secret'), 'credential');
    for (const health of ['MedicalCondition', 'Medication', 'HealthInsuranceNumber', 'medical', 'health', 'medicalcondition', 'Medical condition', 'Health data', 'patient_number']) {
        assert.equal(cs.kindOf(health), null, health);
    }
    assert.equal(cs.kindOf('Organization'), null);
    assert.equal(cs.kindOf('URL'), null);
    assert.equal(cs.kindOf(''), null);
    assert.equal(cs.kindOf('NationalIdentificationNumber'), 'id_number');
    assert.equal(cs.kindOf('IBAN'), 'financial');
});

test('kindOf: an org data type named after another special category or criminal data is dropped too, and so are scan markers', () => {
    for (const special of ['Religion', 'Geloofsovertuiging', 'Ethnic origin', 'Etnische afkomst', 'Sexual orientation', 'Political opinion',
        'Politieke voorkeur', 'Trade union membership', 'Vakbondslidmaatschap', 'Biometric template', 'Genetic data',
        'Criminal record', 'Strafblad', 'Conviction', 'Veroordelingen']) {
        assert.equal(cs.kindOf(special), null, special);
    }
    for (const marker of ['scan_timeout', 'scan_failed']) assert.equal(cs.kindOf(marker), null, marker);
    // The built-in kinds are untouched by the extra drop list.
    for (const [label, kind] of [['Person', 'name'], ['Email', 'email'], ['PhoneNumber', 'phone'], ['Address', 'address'],
        ['DateOfBirth', 'birth'], ['InternationalBankingAccountNumber', 'financial'], ['NationalIdentificationNumber', 'id_number'],
        ['TaxIdentificationNumber', 'id_number'], ['LicensePlateNumber', 'id_number'], ['IPAddress', 'online_id'],
        ['EU National ID / BSN', 'id_number'], ['Tax ID (BTW / RSIN / VAT)', 'id_number']]) {
        assert.equal(cs.kindOf(label), kind, label);
    }
});

test('a turn with only health findings counts its outcome and no kind', async () => {
    const out = await count(turn({ categories: ['MedicalCondition', 'Medication', 'HealthInsuranceNumber', 'medical'] }));
    assert.deepEqual(out.map(r => r.signal), ['outcome']);
    assert.ok(!JSON.stringify(out).includes('health'));
    assert.ok(!out.some(r => r.value === 'other'));
});

test('kinds only while "kinds" is on, and only for outcomes that found something', async () => {
    fx.mon = { ...ON, signals: ['outcomes'] };
    assert.deepEqual((await count(turn())).map(r => r.signal), ['outcome']);
    fx.writes = [];
    fx.mon = ON;
    assert.deepEqual((await count(turn({ outcome: 'clean' }))).map(r => r.signal), ['outcome']);
    fx.writes = [];
    const exposed = await count(turn({ outcome: 'sent_unprotected', categories: ['PhoneNumber'] }));
    assert.deepEqual(exposed.filter(r => r.signal === 'kind').map(r => [r.value, r.protection, r.provider_type]), [['phone', 'exposed', '']]);
});

test('destination and provider: internal, external, unknown without a provider config', async () => {
    const internal = await count(turn({ providerConfig: { providerType: 'ollama', url: 'http://localhost:11434' }, outcome: 'clean' }));
    assert.deepEqual([internal[0].destination, internal[0].provider_type], ['internal', 'local']);
    fx.writes = [];
    const allowlisted = await count(turn({ providerConfig: { providerType: 'acme', url: 'https://models.corp.example/v1' }, allowlistedHosts: ['corp.example'], outcome: 'clean' }));
    assert.deepEqual([allowlisted[0].destination, allowlisted[0].provider_type], ['internal', 'other']);
    fx.writes = [];
    const swarm = await count(turn({ providerConfig: null, outcome: 'unscanned' }));
    assert.deepEqual([swarm[0].destination, swarm[0].provider_type], ['unknown', '']);
});

test('normaliseProviderType maps every factory type into PROVIDER_TYPES', () => {
    const V = require('../../stores/lib/chatMonitoringVocab');
    const providers = require('../providers');
    for (const t of ['openai', 'mistral', 'claude', 'google', 'google-vertex', 'azure', 'scaleway', 'eugpt', 'local', ...providers.LOCAL_PROVIDER_TYPES]) {
        assert.ok(V.PROVIDER_TYPES.includes(cs.normaliseProviderType(t)), t);
    }
    assert.equal(cs.normaliseProviderType('google-vertex'), 'google_vertex');
    assert.equal(cs.normaliseProviderType('vllm'), 'local');
    assert.equal(cs.normaliseProviderType('something-new'), 'other');
});

test('the PII outcome table is complete', () => {
    const cases = {
        disabled: 'unscanned', allowed_by_policy: 'unscanned', too_short: 'clean', clean: 'clean',
        guard_absent: 'scan_failed_open', failed_open: 'scan_failed_open', failed_closed: 'scan_failed_closed',
    };
    for (const [status, outcome] of Object.entries(cases)) assert.equal(cs.outcomeFromPiiReport({ status }), outcome, status);
    assert.equal(cs.outcomeFromPiiReport({ status: 'found', decision: 'tokenised' }), 'protected');
    assert.equal(cs.outcomeFromPiiReport({ status: 'found', decision: 'blocked' }), 'blocked');
    assert.equal(cs.outcomeFromPiiReport({ status: 'deferred_to_dlp' }), null);
    assert.equal(cs.outcomeFromPiiReport({}), 'unscanned');
    assert.equal(cs.outcomeFromPiiReport(null), 'unscanned');
    assert.equal(cs.outcomeFromPiiReport({ status: 'what' }), 'unscanned');
});

test('the DLP outcome table is complete', () => {
    const t = (dlp) => cs.outcomeFromDlp(dlp);
    assert.equal(t({ outcome: 'blocked', scanStatus: 'failed' }), 'scan_failed_closed');
    assert.equal(t({ outcome: 'blocked', scanStatus: 'ok', categories: ['Email'] }), 'blocked');
    assert.equal(t({ outcome: 'redacted', scanStatus: 'ok', categories: ['Email'] }), 'protected');
    assert.equal(t({ outcome: 'scan_failed', scanStatus: 'failed' }), 'scan_failed_open');
    assert.equal(t({ outcome: 'allow', scanStatus: 'failed' }), 'scan_failed_open');
    assert.equal(t({ outcome: 'allow', scanStatus: 'ok', categories: ['Email'], override: true }), 'sent_unprotected');
    assert.equal(t({ outcome: 'allow', scanStatus: 'skipped', tooShort: true, categories: [] }), 'clean');
    assert.equal(t({ outcome: 'allow', scanStatus: 'skipped', categories: [] }), 'unscanned');
    assert.equal(t({ outcome: 'allow', scanStatus: 'ok', categories: [] }), 'clean');
    assert.equal(t(null), 'unscanned');
    assert.equal(t({ outcome: 'later' }), 'unscanned');
});

test('never throws, synchronously or asynchronously', async () => {
    fx.mon = null;
    assert.doesNotThrow(() => cs.countTurn(undefined));
    assert.doesNotThrow(() => cs.countTurn(null));
    assert.doesNotThrow(() => cs.countTurn({ surface: 'direct', get notice() { throw new Error('getter'); } }));
    fx.mon = ON;
    assert.doesNotThrow(() => cs.countTurn(turn({ orgKey: 'bad org|id', categories: 'not-a-list' })));
    assert.doesNotThrow(() => cs.countTurn(turn({ outcome: 'made_up' })));
    await settle();
    assert.equal(await cs.flush(), 0, 'an invalid org key or outcome is dropped before the store');
    assert.equal(cs.recordChatTurn({}), false);
});

test('a failed flush is retried once with the next, then dropped', async () => {
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
        cs.recordChatTurn({ orgKey: 'org1', surface: 'direct', outcome: 'clean', signals: ['outcomes'] });
        fx.failWrites = 1;
        assert.equal(await cs.flush(), 0);
        assert.equal(cs._pendingKeys(), 1, 'kept for one retry');
        cs.recordChatTurn({ orgKey: 'org1', surface: 'direct', outcome: 'blocked', signals: ['outcomes'] });
        fx.failWrites = 1;
        assert.equal(await cs.flush(), 0);
        assert.ok(warns.some(w => /dropped 1 keys after a failed flush/.test(w)), 'the first batch is dropped, by count only');
        assert.equal(cs._pendingKeys(), 1, 'the second batch now waits for its one retry');
        assert.equal(await cs.flush(), 1);
        assert.deepEqual(rows().map(r => r.value), ['blocked']);
        assert.ok(!warns.some(w => /org1|clean|blocked/.test(w)), 'no key content is logged');
    } finally {
        console.warn = warn;
    }
});

test('the map caps at 5 000 keys and flushes early', async () => {
    const base = { surface: 'agent_public', outcome: 'clean', signals: ['outcomes'] };
    for (let i = 0; i < cs.MAX_KEYS; i++) cs.recordChatTurn({ ...base, orgKey: `org${i}` });
    assert.ok(cs._pendingKeys() <= cs.MAX_KEYS);
    await settle();
    await cs.flush();
    assert.equal(rows().length, cs.MAX_KEYS, 'every key written, in one early flush');
    assert.equal(fx.writes.length, 1);
    assert.equal(cs._pendingKeys(), 0);
});

test('the same turn counted twice adds up in one key', async () => {
    cs.recordChatTurn({ orgKey: 'org1', surface: 'agent', outcome: 'blocked', signals: ['outcomes'] });
    cs.recordChatTurn({ orgKey: 'org1', surface: 'agent', outcome: 'blocked', signals: ['outcomes'] });
    await cs.flush();
    assert.deepEqual(rows().map(r => [r.surface, r.value, r.turns]), [['agent', 'blocked', 2]]);
});

test('"Delete collected counts": discardOrg drops that org\'s pending keys (and its retry), and only that org\'s', async () => {
    cs.recordChatTurn({ orgKey: 'org1', surface: 'direct', outcome: 'clean', signals: ['outcomes'] });
    cs.recordChatTurn({ orgKey: 'org10', surface: 'direct', outcome: 'clean', signals: ['outcomes'] });
    cs.recordChatTurn({ orgKey: 'org2', surface: 'agent', outcome: 'blocked', signals: ['outcomes'] });
    fx.failWrites = 1;
    assert.equal(await cs.flush(), 0, 'the first flush fails, so its keys wait as a retry');
    cs.recordChatTurn({ orgKey: 'org1', surface: 'agent', outcome: 'protected', signals: ['outcomes'] });
    assert.equal(cs.discardOrg('org1'), 2, 'one pending key and one retry key');
    assert.equal(cs.discardOrg(''), 0);
    await cs.flush();
    assert.deepEqual(rows().map(r => r.organization_id).sort(), ['org10', 'org2'], 'org1 is not written back; org10 shares a prefix but is another org');
});

test('the org key: direct chat under the effective org or "default"; agent turns only for guests and same-org members', () => {
    assert.equal(cs.directOrgKey('org9'), 'org9');
    assert.equal(cs.directOrgKey(null), 'default');
    assert.equal(cs.directOrgKey(''), 'default');

    assert.deepEqual(cs.agentTurnTarget({ userId: 'guest_x1', callerOrgId: null, agentOrgId: 'org1' }), { surface: 'agent_public', orgKey: 'org1' });
    assert.deepEqual(cs.agentTurnTarget({ userId: 'u1', callerOrgId: 'org1', agentOrgId: 'org1' }), { surface: 'agent', orgKey: 'org1' });
    assert.equal(cs.agentTurnTarget({ userId: 'u1', callerOrgId: 'org2', agentOrgId: 'org1' }), null, 'another org could not tell them');
    assert.equal(cs.agentTurnTarget({ userId: 'admin', callerOrgId: null, agentOrgId: 'org1' }), null, 'a super admin (no caller org) is never counted');
    assert.equal(cs.agentTurnTarget({ userId: 'guest_x1', callerOrgId: null, agentOrgId: null }), null, 'an agent without an org is never recorded');
});
