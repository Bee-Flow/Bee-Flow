'use strict';

/**
 * What a testchat IS — per property.
 *
 * Every test below belongs to one sentence from the header of testChat.js. They stand apart because they can
 * break separately: the gate can open without the source changing, the source can shift without the gate moving,
 * and the version rule can start lying while everything else is right.
 *
 * Run: cd server && node --test core/agentRuntime/testChat.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const tc = require('./testChat');

// ── De poort ─────────────────────────────────────────────────────────

test('a test chat is an editor right, and it refuses rather than degrades', () => {
    assert.deepStrictEqual(tc.gateTestChatRequest({ test: true, canEdit: true }),
        { ok: true, testChat: true });

    const refused = tc.gateTestChatRequest({ test: true, canEdit: false });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.code, 'test_chat_not_allowed');
    // The temptation that this test closes: "it may not test, so just run an
    // ordinary turn". That serves the PUBLISHED agent under the name of a test, and that is precisely
    // the answer that must never come.
    assert.strictEqual(refused.testChat, undefined);
});

test('nothing asked for is not a test chat, and does not need the right', () => {
    for (const test_ of [undefined, null, false, 'true', 1, {}]) {
        assert.deepStrictEqual(tc.gateTestChatRequest({ test: test_, canEdit: false }),
            { ok: true, testChat: false }, `test: ${JSON.stringify(test_)}`);
    }
});

test('only a literal true asks for a test chat', () => {
    assert.strictEqual(tc.wantsTestChat({ test: true }), true);
    for (const v of ['true', 'false', 1, 0, '', null, undefined, {}, []]) {
        assert.strictEqual(tc.wantsTestChat({ test: v }), false, `test: ${JSON.stringify(v)}`);
    }
    assert.strictEqual(tc.wantsTestChat(null), false);
    assert.strictEqual(tc.wantsTestChat(undefined), false);
});

test('isTestChat reads the metadata the route wrote, not a truthy value', () => {
    assert.strictEqual(tc.isTestChat({ testChat: true }), true);
    assert.strictEqual(tc.isTestChat({ testChat: 'yes' }), false);
    assert.strictEqual(tc.isTestChat({}), false);
    assert.strictEqual(tc.isTestChat(null), false);
});

// ── De bron in het verbruikslogboek ──────────────────────────────────

test('a test turn writes its usage under its OWN source', () => {
    // This is the only place where a test conversation still counted as an ordinary conversation.
    assert.strictEqual(tc.usageSourceFor({ testChat: true }, 'agent_stream'), 'agent_test_chat');
    assert.strictEqual(tc.usageSourceFor({ testChat: true }, 'agent_chat'), 'agent_test_chat');
    assert.strictEqual(tc.TEST_CHAT_USAGE_SOURCE, 'agent_test_chat');
});

test('an ordinary turn keeps the source its call site always wrote', () => {
    assert.strictEqual(tc.usageSourceFor({}, 'agent_stream'), 'agent_stream');
    assert.strictEqual(tc.usageSourceFor(null, 'agent_chat'), 'agent_chat');
    assert.strictEqual(tc.usageSourceFor({ testChat: false }, 'agent_stream'), 'agent_stream');
});

// ── Welke agent draaide er? ──────────────────────────────────────────

test('the draft projection is reported as the draft, with what is live beside it', () => {
    const info = tc.testChatConfigInfo({
        runtimeSource: 'draft', published_version: 3, published_rev: 7, rev: 12,
    });
    assert.strictEqual(info.source, 'draft');
    assert.strictEqual(info.runsDraft, true);
    assert.strictEqual(info.publishedVersion, 3);
    assert.strictEqual(info.unpublishedChanges, 5);
});

test('a never-published agent has nothing to differ from', () => {
    const info = tc.testChatConfigInfo({ runtimeSource: 'live', published_version: 0, rev: 4 });
    assert.strictEqual(info.source, 'live');
    assert.strictEqual(info.runsDraft, true, 'live IS the concept when nothing is published');
    assert.strictEqual(info.publishedVersion, 0);
    assert.strictEqual(info.unpublishedChanges, 0);
});

test('a projection that ran the PUBLISHED blob never claims to be the concept', () => {
    const info = tc.testChatConfigInfo({
        runtimeSource: 'published', published_version: 3, published_rev: 7, rev: 12,
    });
    assert.strictEqual(info.source, 'published');
    assert.strictEqual(info.runsDraft, false);
});

test('an unreadable projection is unknown, and unknown is not "your concept"', () => {
    for (const src of [undefined, null, '', 'something-else']) {
        const info = tc.testChatConfigInfo({ runtimeSource: src, published_version: 2, rev: 5 });
        assert.strictEqual(info.source, 'unknown', `runtimeSource: ${String(src)}`);
        assert.strictEqual(info.runsDraft, false,
            'a screen may not reassure someone about a turn nobody could describe');
    }
    assert.strictEqual(tc.testChatConfigInfo(null).source, 'unknown');
    assert.strictEqual(tc.testChatConfigInfo(null).runsDraft, false);
});

test('unpublishedChanges never goes negative', () => {
    // A row in which published_rev lies ahead of rev (restored snapshot, half a write) must not put
    // "-3 changes" on the screen.
    const info = tc.testChatConfigInfo({
        runtimeSource: 'draft', published_version: 2, published_rev: 9, rev: 4,
    });
    assert.strictEqual(info.unpublishedChanges, 0);
});

// ── De sleutel van één vastgehouden actie ────────────────────────────

test('the args key names ONE action — same tool, other arguments, other key', () => {
    const a = tc.argsKeyFor('gmail_send', '{"to":"a@b.c"}');
    const b = tc.argsKeyFor('gmail_send', '{"to":"x@y.z"}');
    const c = tc.argsKeyFor('gmail_draft', '{"to":"a@b.c"}');
    assert.notStrictEqual(a, b, 'other arguments are another action');
    assert.notStrictEqual(a, c, 'other tool is another action');
    assert.strictEqual(a, tc.argsKeyFor('gmail_send', '{"to":"a@b.c"}'), 'stable');
    assert.match(a, /^[0-9a-f]{32}$/);
    // Irreversible: the raw arguments may not be readable from the key.
    assert.ok(!a.includes('a@b'), 'the key must not carry the arguments');
});

// ── Wat de client terug mag sturen ───────────────────────────────────

test('only a well-formed approve/decline survives normalisation', () => {
    const key = 'ab12'.repeat(8);
    const out = tc.normaliseToolDecisions([
        { toolName: 't', argsKey: key, decision: 'approve' },
        { toolName: 't', argsKey: 'NOTHEX!!', decision: 'approve' },
        { toolName: 't', argsKey: key.slice(0, 4), decision: 'approve' },  // te kort
        { toolName: 't', argsKey: key, decision: 'approve ' },             // spatie
        { toolName: 't', argsKey: key, decision: true },
        null, 'approve', 42,
    ]);
    assert.strictEqual(out.size, 1);
    assert.strictEqual(out.get(key), 'approve');
});

test('the first decision about an action wins — a second one is not new consent', () => {
    const key = 'cd34'.repeat(8);
    const out = tc.normaliseToolDecisions([
        { argsKey: key, decision: 'decline' },
        { argsKey: key, decision: 'approve' },
    ]);
    assert.strictEqual(out.get(key), 'decline');
});

test('the number of decisions one request may carry is bounded', () => {
    const many = Array.from({ length: tc.MAX_TOOL_DECISIONS + 25 }, (_, i) => ({
        argsKey: String(i).padStart(32, '0'), decision: 'approve',
    }));
    assert.strictEqual(tc.normaliseToolDecisions(many).size, tc.MAX_TOOL_DECISIONS);
});

test('anything that is not a list is no decisions at all', () => {
    for (const v of [undefined, null, {}, 'approve', 7]) {
        assert.strictEqual(tc.normaliseToolDecisions(v).size, 0);
    }
});

// ── Wat een testchat vasthoudt ───────────────────────────────────────

test('a test chat holds everything that is not demonstrably a read', () => {
    assert.strictEqual(tc.holdsEffect('anything', 'writes'), true);
    assert.strictEqual(tc.holdsEffect('anything', 'sends'), true);
    assert.strictEqual(tc.holdsEffect('anything', 'reads'), false);
});

test('an effect nobody could classify is held, not run', () => {
    assert.strictEqual(tc.holdsEffect('a_tool_nobody_registered_2026', null), true);
    assert.strictEqual(tc.holdsEffect('a_tool_nobody_registered_2026', undefined), true);
});

test('a known read is still a read when the caller passes no effect', () => {
    const { effectOf } = require('../automationModel/sideEffectMap');
    // A name of which the card itself says that it reads, so that this test does not lean on a hard-coded tool name
    // that might be called something else tomorrow.
    const reader = ['gmail_list_messages', 'kb_search', 'web_search']
        .find(n => effectOf(n) === 'reads');
    if (!reader) return; // niets te bewijzen als de kaart geen lezer kent
    assert.strictEqual(tc.holdsEffect(reader, null), false);
});

// ── De id van een efemere conversatie ────────────────────────────────
//
// `usageStore.getTestChatCounts` telt testgesprekken met `COUNT(DISTINCT
// conversation_id)`. Met een id per REQUEST — de oude `ephemeral-<Date.now()>`
// — telde dat BEURTEN: een testgesprek van zes berichten rapporteerde er zes.

test('dezelfde sessiesleutel geeft dezelfde efemere conversatie', () => {
    const a = tc.ephemeralConversationId({ sessionKey: 'tc-abcdefgh', userId: 'u1', agentId: 'a1' });
    const b = tc.ephemeralConversationId({ sessionKey: 'tc-abcdefgh', userId: 'u1', agentId: 'a1' });
    assert.strictEqual(a, b, 'twee beurten van één testgesprek zijn één gesprek');
    assert.ok(a.startsWith(tc.EPHEMERAL_PREFIX));
});

test('de sessiesleutel is geen adres: gebruiker en agent zitten in de hash', () => {
    const base = { sessionKey: 'tc-abcdefgh', userId: 'u1', agentId: 'a1' };
    const mine = tc.ephemeralConversationId(base);
    assert.notStrictEqual(mine, tc.ephemeralConversationId({ ...base, userId: 'u2' }));
    assert.notStrictEqual(mine, tc.ephemeralConversationId({ ...base, agentId: 'a2' }));
});

test('zonder bruikbare sleutel is elke beurt zijn eigen gesprek — te hoog, nooit te laag', () => {
    const ids = new Set();
    for (const key of [undefined, null, '', '  ', 'kort', 'x'.repeat(201), 42, {}]) {
        for (let i = 0; i < 2; i++) ids.add(tc.ephemeralConversationId({ sessionKey: key, userId: 'u', agentId: 'a' }));
    }
    assert.strictEqual(ids.size, 16, 'elke aanroep zonder sleutel is een nieuwe id');
    for (const id of ids) assert.ok(id.startsWith(tc.EPHEMERAL_PREFIX));
});

test('een efemere id kan nooit een echte rij aanwijzen', () => {
    // The prefix is what makes it safe to derive an id from CLIENT input: it travels along in
    // guardrail_events.conversation_id, in the egress log and in the PII token-map memo.
    const forged = tc.ephemeralConversationId({
        sessionKey: '8ab1e9c4-0f52-4c4a-9a1f-2f3b4c5d6e7f', userId: 'u', agentId: 'a',
    });
    assert.ok(forged.startsWith('ephemeral-'));
    assert.ok(!forged.includes('8ab1e9c4'), 'de sleutel van de client wordt gehasht, niet doorgegeven');
});

test('de sessiesleutel wordt smal ingelezen', () => {
    assert.strictEqual(tc.normaliseSessionKey('tc-abcdefgh'), 'tc-abcdefgh');
    assert.strictEqual(tc.normaliseSessionKey('  tc-abcdefgh  '), 'tc-abcdefgh');
    for (const bad of [undefined, null, 42, {}, '', 'kort', 'x'.repeat(201), 'met spatie', 'sleutel;drop']) {
        assert.strictEqual(tc.normaliseSessionKey(bad), null, String(bad));
    }
});

// ── Wat een testbeurt in de AUDIT-rijen achterlaat ───────────────────

test('een testbeurt is voor elke audit-lezer een droogloop', () => {
    assert.strictEqual(tc.isDryRunTurn({ testChat: true }), true);
    for (const meta of [undefined, null, {}, { testChat: false }, { testChat: 'true' }, { testChat: 1 }]) {
        assert.strictEqual(tc.isDryRunTurn(meta), false, JSON.stringify(meta));
    }
});
