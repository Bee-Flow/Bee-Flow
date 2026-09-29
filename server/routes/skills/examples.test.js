'use strict';

/**
 * routes/skills/examples — "make an example out of that answer" (S2).
 *
 * What is pinned here is the part that can go wrong QUIETLY:
 *   - the conversation must be the CALLER'S OWN. `getConversationById` has
 *     no owner filter, so a missing `user_id` check is a read of somebody
 *     else's chat. Both the preview and the write refuse, and both refuse
 *     with 404 — a 403 would confirm the id exists in another account;
 *   - the conversation is read with `{ restore: false }`, so Privacy Shield
 *     tokens stay tokens instead of being restored into an example other
 *     people will read;
 *   - `detectPii` + `tokenizeText` run on the way out ANYWAY, on the
 *     preview as well as on the stored example — the artboard promises
 *     "personal data is removed automatically" before the person clicks,
 *     not after;
 *   - a skill that is visible but not editable is 403 `not_editable`, never
 *     a silent write;
 *   - the stored example carries `sourceConversationId` as provenance and
 *     the question is taken from the user turn above the answer.
 *
 * DB-free: every dependency is stubbed through a `Module._resolveFilename`
 * hook keyed on this feature's own file, the pattern of routes/skills.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/skills/examples.test.js
 */

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures the stubs close over ───────────────────────────────────
const fx = {
    userId: 'owner',
    orgId: 'org1',
    canManage: true,
    skill: null,
    conversation: null,
    conversations: [],
    updated: true,
    detect: null,        // what detectPii resolves
    calls: [],
};
const rec = (name, args) => { fx.calls.push({ name, args }); };
const lastCall = (name) => [...fx.calls].reverse().find(c => c.name === name);

const MOCKS = {
    '../../stores/skillStore': {
        getSkill: async (id, orgId, userId, viewer) => { rec('getSkill', { id, orgId, userId, viewer }); return fx.skill; },
        updateSkill: async (id, userId, updates, opts) => { rec('updateSkill', { id, userId, updates, opts }); return fx.updated; },
    },
    '../../stores/agentStore': {
        getConversationById: async (id, key, options) => {
            rec('getConversationById', { id, key, options });
            // The real store DECRYPTS before anyone compares user_id, and on a
            // zero-knowledge org that decryption is done with the CALLER'S key
            // — so somebody else's conversation does not open, it THROWS
            // (FIELD_DECRYPT_FAILED, deliberately). A stub that only ever
            // returns an object cannot see the difference between a refusal
            // and a 404, which is exactly the difference this file is about.
            if (fx.conversationThrows) throw fx.conversationThrows;
            return fx.conversation;
        },
        listAllConversations: async (userId) => { rec('listAllConversations', { userId }); return fx.conversations; },
    },
    '../../stores/userStore': { getUser: async () => ({ id: fx.userId, organizationId: fx.orgId }) },
    '../../auth/permissions': { hasPermission: async () => fx.canManage },
    '../../core/privacy/piiDetection': {
        detectPii: async (text, categories, threshold, opts) => { rec('detectPii', { text, opts }); return fx.detect; },
        // A deliberately crude stand-in: it replaces each entity's literal
        // text with its token, which is all this file's contract needs.
        tokenizeText: (text, entities) => ({
            tokenizedText: (entities || []).reduce((acc, e) => acc.split(e.text).join(e.token), text),
            tokenMap: {},
        }),
        // NOT stubbed. This one is the point: a token is a key in ONE
        // conversation's map, and an example leaves that conversation. A stub
        // here would test the stub. It is pure and DB-free, so it runs for
        // real.
        neutraliseTokens: require('../../core/privacy/piiDetection/tokenNeutralise').neutraliseTokens,
    },
    '../../core/agentRuntime/phaseEvents': {
        messageText: (m) => (typeof m?.content === 'string'
            ? m.content
            : (Array.isArray(m?.content) ? (m.content.find(p => p.type === 'text')?.text || '') : '')),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:skill-examples:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]skills[\\/]examples\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const examples = require('./examples');
test.after(() => { Module._resolveFilename = originalResolve; });

// ── Minimal req/res ─────────────────────────────────────────────────
function makeReq({ params = {}, body = {}, userId = fx.userId } = {}) {
    return { params, body, session: { user: { id: userId }, encryptionKey: 'k' } };
}
function makeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
}

const CONVO = () => ({
    id: 'c1',
    user_id: 'owner',
    messages: [
        { role: 'user', content: 'What does line 4 mean?' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] },
        { role: 'tool', content: 'irrelevant' },
        { role: 'assistant', content: 'It is the meter cupboard, 4 hours of work.' },
    ],
});

beforeEach(() => {
    fx.calls = [];
    fx.userId = 'owner';
    fx.orgId = 'org1';
    fx.canManage = true;
    fx.updated = true;
    // The ordinary case: the guard is installed, it ran, it found nothing.
    // `null` is the guard being ABSENT, which this route now treats as a
    // refusal — so it has to be asked for by name, not inherited by default.
    fx.detect = { hasPii: false, entities: [] };
    fx.conversations = [];
    fx.conversation = CONVO();
    fx.conversationThrows = null;
    fx.skill = { id: 's1', orgId: 'org1', userId: 'owner', canEdit: true, examplesV2: [] };
});

// ── Ownership ───────────────────────────────────────────────────────
test('the message preview refuses a conversation that is not the caller\'s', async () => {
    fx.conversation = { ...CONVO(), user_id: 'someone-else' };
    const res = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), res);
    assert.equal(res.statusCode, 404, 'not-yours must read as not-found, never 403');
    assert.equal(res.body.messages, undefined);
});

test('from-message refuses a conversation that is not the caller\'s, and writes nothing', async () => {
    fx.conversation = { ...CONVO(), user_id: 'someone-else' };
    const res = makeRes();
    await examples.fromMessage(makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(lastCall('updateSkill'), undefined, 'no write may reach the store');
});

test('the conversation is read with restore:false so shield tokens stay tokens', async () => {
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), makeRes());
    assert.deepEqual(lastCall('getConversationById').args.options, { restore: false });
});

/**
 * The refusal must be the SAME answer, not merely the same status code: a 403,
 * or a 404 whose message differs ("not yours" vs "not found"), turns this route
 * into an oracle for whether a conversation id exists in somebody else's
 * account. Both read paths are compared, because either one alone would do.
 */
test('“not yours” and “not there” are one answer, on the preview and on the write', async () => {
    const answersFor = async (conversation) => {
        fx.conversation = conversation;
        const preview = makeRes();
        await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), preview);
        const write = makeRes();
        await examples.fromMessage(
            makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }),
            write,
        );
        return {
            preview: { status: preview.statusCode, body: preview.body },
            write: { status: write.statusCode, body: write.body },
        };
    };
    const notThere = await answersFor(null);
    const notYours = await answersFor({ ...CONVO(), user_id: 'someone-else' });
    assert.deepEqual(notYours, notThere, 'a different answer would confirm the id exists elsewhere');
    assert.equal(notThere.preview.status, 404);
    assert.equal(notThere.write.status, 404);
});

/**
 * ── AND THE THIRD ANSWER, WHICH IS THE ONE THAT ACTUALLY FIRED ──────
 * The pair above only compares two shapes the STORE can return. On a
 * zero-knowledge org it returns neither: `getConversationById` decrypts the
 * messages BEFORE anyone compares `user_id`, with the CALLER'S key, so a
 * conversation belonging to somebody else does not open — it throws
 * FIELD_DECRYPT_FAILED, on purpose. Uncaught, that became a 500 while a
 * made-up id got a 404, and the difference is an existence oracle: the 500s
 * are exactly the ids that exist in other accounts. `managed` tier hides it,
 * because there the row owner's escrow key opens the row and the `user_id`
 * check is what refuses — so the tier that leaks is the private one.
 */
test('a conversation that will not DECRYPT answers the same as one that is not there', async () => {
    const answersFor = async () => {
        const preview = makeRes();
        await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), preview);
        const write = makeRes();
        await examples.fromMessage(
            makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }),
            write,
        );
        return {
            preview: { status: preview.statusCode, body: preview.body },
            write: { status: write.statusCode, body: write.body },
        };
    };
    fx.conversation = null;
    fx.conversationThrows = null;
    const notThere = await answersFor();

    fx.conversation = null;
    fx.conversationThrows = Object.assign(new Error('Field decryption failed'), { code: 'FIELD_DECRYPT_FAILED' });
    const refused = await answersFor();

    assert.deepEqual(refused, notThere, 'a 500 here is an oracle for "this id exists in another account"');
    assert.equal(refused.preview.status, 404);
    assert.equal(refused.write.status, 404);
    assert.equal(lastCall('updateSkill'), undefined, 'and nothing was written');
});

// ── Redaction ───────────────────────────────────────────────────────
test('the PREVIEW is redacted, not just the stored example', async () => {
    fx.conversation = {
        id: 'c1', user_id: 'owner',
        messages: [{ role: 'assistant', content: 'Call Jan Bakker about it.' }],
    };
    fx.detect = { hasPii: true, entities: [{ text: 'Jan Bakker', token: '[person_1]', category: 'person' }] };
    const res = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), res);
    // The value is gone AND so is the token: see the stored-example test below
    // for why a `[person_1]` on this path is worse than a name.
    assert.equal(res.body.messages[0].text, 'Call someone about it.');
});

/**
 * ── A TOKEN IS NOT A PLACEHOLDER ────────────────────────────────────
 * `[person_1]` is a KEY in the token map of ONE conversation. This example
 * goes verbatim into the system prompt of everybody who uses the skill
 * (skillStructure renders question/good into the text, skillInjection injects
 * it), the model quotes it — that is what examples are for — and the READER's
 * own restore pass then runs over the model's reply with the READER's map. A
 * stored `[person_1]` therefore comes back as the reader's own customer, under
 * a card that says "personal data removed".
 *
 * Two sources, both covered here: tokens the SOURCE text already carried
 * (it is read with `restore:false`, so they are still in it) and tokens this
 * route mints itself — which restart at 1, because there is no map for text
 * that is leaving its conversation to extend.
 */
test('no live token survives into the stored example — not a minted one, not an inherited one', async () => {
    fx.conversation = {
        id: 'c1',
        user_id: 'owner',
        messages: [
            { role: 'user', content: 'Did [person_1] send the IBAN?' },
            { role: 'assistant', content: 'Yes — [person_1] confirmed [iban_2], and Jan Bakker signed.' },
        ],
    };
    // The guard only finds the value the shield missed; the two tokens are
    // already in the text.
    fx.detect = { hasPii: true, entities: [{ text: 'Jan Bakker', token: '[person_1]', category: 'person' }] };
    const res = makeRes();
    await examples.fromMessage(
        makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 1 } }),
        res,
    );
    assert.equal(res.statusCode, 201);
    const stored = lastCall('updateSkill').args.updates.examplesV2.at(-1);
    for (const half of [stored.question, stored.good]) {
        assert.ok(!/\[[a-z0-9_ ]{1,60}\]/i.test(half), `a restorable token survived: ${half}`);
    }
    assert.ok(!stored.good.includes('Jan Bakker'));
    assert.equal(stored.good, 'Yes — someone confirmed a bank account, and someone signed.');
    assert.equal(stored.question, 'Did someone send the IBAN?');
});

/** The drift shapes the MODEL writes, which restoreTokens also substitutes. */
test('the drifted spellings of a token go too — restoreTokens accepts those as well', async () => {
    fx.conversation = {
        id: 'c1', user_id: 'owner',
        messages: [{ role: 'assistant', content: 'Mail [email]2 or [person3]; see [the quote] for the rest.' }],
    };
    fx.detect = { hasPii: false, entities: [] };
    const res = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), res);
    assert.equal(
        res.body.messages[0].text,
        'Mail an email address or someone; see [the quote] for the rest.',
        'a bracketed span that is NOT token-shaped is ordinary prose and stays',
    );
});

/**
 * The screen promises that personal data is removed automatically, and this is
 * the half of that promise that OUTLIVES the click: an example is read later,
 * by colleagues, out of the conversation it came from.
 *
 * Both halves are checked, and both are checked on the payload that reaches
 * the STORE rather than only on the 201 body — the answer could be redacted
 * while the write is not. The question matters as much as the answer: it is
 * lifted out of the same conversation, so it is exactly as likely to name
 * somebody. Until this test existed, deleting `redact` from either one left
 * the whole file green.
 */
test('the STORED example is redacted — the answer AND the question lifted above it', async () => {
    fx.conversation = {
        id: 'c1',
        user_id: 'owner',
        messages: [
            { role: 'user', content: 'Can Jan Bakker still cancel?' },
            { role: 'assistant', content: 'No — tell Jan Bakker the term ran out on the 3rd.' },
        ],
    };
    fx.detect = { hasPii: true, entities: [{ text: 'Jan Bakker', token: '[person_1]', category: 'person' }] };
    const res = makeRes();
    await examples.fromMessage(
        makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 1 } }),
        res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.example.good, 'No — tell someone the term ran out on the 3rd.');
    assert.equal(res.body.example.question, 'Can someone still cancel?');

    const stored = lastCall('updateSkill').args.updates.examplesV2.at(-1);
    assert.equal(stored.good, 'No — tell someone the term ran out on the 3rd.');
    assert.equal(stored.question, 'Can someone still cancel?');
    assert.ok(
        !JSON.stringify(stored).includes('Jan Bakker'),
        'no recognisable person may reach the store, in any field',
    );
    // The same read the preview makes: shield tokens stay tokens on the path
    // that PERSISTS, not just on the one that displays.
    assert.deepEqual(lastCall('getConversationById').args.options, { restore: false });
});

test('a stored example carries the redacted answer, the question above it and its provenance', async () => {
    const res = makeRes();
    await examples.fromMessage(
        makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }),
        res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.example.good, 'It is the meter cupboard, 4 hours of work.');
    assert.equal(res.body.example.question, 'What does line 4 mean?', 'the question is the user turn above the answer');
    assert.equal(res.body.example.sourceConversationId, 'c1');
    const write = lastCall('updateSkill');
    assert.equal(write.args.updates.examplesV2.length, 1);
    assert.deepEqual(Object.keys(write.args.updates), ['examplesV2'], 'nothing else on the skill is touched');
});

test('an explicit question wins over the turn above, and is redacted too', async () => {
    fx.detect = { hasPii: true, entities: [{ text: 'Bakker', token: '[person_1]', category: 'person' }] };
    const res = makeRes();
    await examples.fromMessage(
        makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3, question: 'What did Bakker mean?' } }),
        res,
    );
    assert.equal(res.body.example.question, 'What did someone mean?');
});

// ── Authorisation on the skill itself ───────────────────────────────
test('a visible but not editable skill is 403 not_editable', async () => {
    fx.skill = { id: 's1', orgId: 'org1', userId: 'someone-else', canEdit: false, examplesV2: [] };
    const res = makeRes();
    await examples.fromMessage(makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'not_editable');
    assert.equal(lastCall('updateSkill'), undefined);
});

test('an invisible skill is 404 and never reads the conversation', async () => {
    fx.skill = null;
    const res = makeRes();
    await examples.fromMessage(makeReq({ params: { id: 'nope' }, body: { conversationId: 'c1', messageIndex: 3 } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(lastCall('getConversationById'), undefined);
});

test('the manager widening only ever names the caller\'s OWN org', async () => {
    fx.skill = { id: 's1', orgId: 'other-org', userId: 'someone-else', canEdit: true, examplesV2: [] };
    await examples.fromMessage(makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }), makeRes());
    assert.equal(lastCall('updateSkill').args.opts.managerOrgId, null);
});

// ── Message selection ───────────────────────────────────────────────
test('tool traffic and empty turns are not offered as examples', async () => {
    // The helper the WRITE addresses through: user turns stay, because the
    // question is lifted from the turn above the answer.
    assert.deepEqual(examples.readableMessages(CONVO()).map(m => m.index), [0, 3]);
    // The PREVIEW offers only what the picker draws — assistant turns — so a
    // user turn is not a guard scan paid for a row nobody can click.
    const res = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), res);
    assert.deepEqual(res.body.messages.map(m => m.index), [3]);
});

test('an index that is not a readable message is a 400, not a write', async () => {
    const res = makeRes();
    await examples.fromMessage(makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 2 } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'no_message');
    assert.equal(lastCall('updateSkill'), undefined);
});

test('the example cap is enforced before the write', async () => {
    fx.skill = {
        id: 's1', orgId: 'org1', userId: 'owner', canEdit: true,
        examplesV2: Array.from({ length: examples.MAX_EXAMPLES }, (_, i) => ({ id: `e${i}` })),
    };
    const res = makeRes();
    await examples.fromMessage(makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'too_many_examples');
    assert.equal(lastCall('updateSkill'), undefined);
});

test('existing examples are kept — the new one is appended', async () => {
    fx.skill = { id: 's1', orgId: 'org1', userId: 'owner', canEdit: true, examplesV2: [{ id: 'old', question: 'q', good: 'g' }] };
    const res = makeRes();
    await examples.fromMessage(makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }), res);
    assert.equal(res.body.examplesV2.length, 2);
    assert.equal(res.body.examplesV2[0].id, 'old');
});

// ── The conversation list ───────────────────────────────────────────
test('the conversation list is the caller\'s own and carries no message text', async () => {
    fx.conversations = [{
        id: 'c1', user_id: 'owner', title: 'Quote 2026-0412', agent_id: 'a1', agent_name: 'Quote assistant',
        updated_at: '2026-09-01T10:00:00.000Z', messages_json: 'secret',
    }];
    const res = makeRes();
    await examples.listConversations(makeReq(), res);
    assert.equal(lastCall('listAllConversations').args.userId, 'owner');
    assert.deepEqual(res.body.conversations, [{
        id: 'c1', title: 'Quote 2026-0412', agentId: 'a1', agentName: 'Quote assistant',
        updatedAt: '2026-09-01T10:00:00.000Z',
    }]);
});

// ── Pure helpers ────────────────────────────────────────────────────
test('questionBefore takes the nearest user turn above, not the first one', () => {
    const messages = [
        { index: 0, role: 'user', text: 'first' },
        { index: 1, role: 'assistant', text: 'a' },
        { index: 2, role: 'user', text: 'second' },
        { index: 3, role: 'assistant', text: 'b' },
    ];
    assert.equal(examples.questionBefore(messages, 3), 'second');
    assert.equal(examples.questionBefore(messages, 1), 'first');
    assert.equal(examples.questionBefore(messages, 0), '');
});

test('redact clips a runaway message instead of storing a document', async () => {
    fx.detect = { hasPii: false, entities: [] };
    const long = 'x'.repeat(examples.MAX_EXAMPLE_CHARS + 500);
    assert.equal((await examples.redact(long)).text.length, examples.MAX_EXAMPLE_CHARS);
});

test('redact survives a guard that throws, and reports that nothing was checked', async () => {
    const piiMock = require.cache[MOCK_IDS['../../core/privacy/piiDetection']].exports;
    const original = piiMock.detectPii;
    piiMock.detectPii = async () => { throw new Error('guard down'); };
    try {
        assert.deepEqual(await examples.redact('hello'), { text: 'hello', checked: false });
    } finally {
        piiMock.detectPii = original;
    }
});

/**
 * `detectPii` fails open in two shapes and only one of them LOOKS like a
 * failure. detect.js answers `{ hasPii:false, entities:[], degraded:true }`
 * when the guard is installed but unreachable, and says in its own comment
 * that this "is NOT the same as 'no PII'" — it is the shape of a clean scan
 * with nothing behind it. Reading it as clean is the whole bug this pins.
 */
test('a degraded scan is not a clean scan — no guard and a broken guard read alike', async () => {
    fx.detect = null;
    assert.deepEqual(await examples.redact('Call Jan Bakker.'), { text: 'Call Jan Bakker.', checked: false });

    fx.detect = { hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable: ECONNREFUSED' };
    assert.deepEqual(await examples.redact('Call Jan Bakker.'), { text: 'Call Jan Bakker.', checked: false });

    fx.detect = { hasPii: false, entities: [] };
    assert.deepEqual(await examples.redact('Nothing personal here.'), { text: 'Nothing personal here.', checked: true });
});

test('an unchecked answer is refused, not stored with the promise still on screen', async () => {
    fx.detect = { hasPii: false, entities: [], degraded: true, degradedReason: 'guard_circuit_open' };
    const res = makeRes();
    await examples.fromMessage(
        makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }),
        res,
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'pii_unchecked');
    assert.equal(lastCall('updateSkill'), undefined, 'nothing unchecked may reach the store');
});

test('the preview withdraws the promise instead of quietly showing unchecked text', async () => {
    fx.detect = { hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable: timeout' };
    const res = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), res);
    assert.equal(res.statusCode, 200, 'the person may still read their own chat');
    assert.equal(res.body.piiChecked, false, 'the screen has to be told the check did not run');

    fx.detect = { hasPii: false, entities: [] };
    const ok = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), ok);
    assert.equal(ok.body.piiChecked, true);
});

// ── The cap, and the answer when the store refuses ──────────────────
/**
 * There used to be a SECOND copy of this limit here (`const MAX_EXAMPLES = 50`,
 * "mirrors skillStructure.MAX_EXAMPLES"), and the thing it mirrored was 40. A
 * skill with 40-49 examples therefore passed this gate, built a 41st, and the
 * validator threw inside the store — which this handler's catch turned into a
 * bare 500. Both halves are pinned: the number is the validator's, and a
 * structure refusal from the store keeps its 400 and its code.
 */
test('the cap is the validator\'s own number, not a second copy of it', () => {
    const { MAX_EXAMPLES: real } = require('../../core/skills/skillStructure');
    assert.equal(examples.MAX_EXAMPLES, real);
});

test('a structure refusal from the store is a 400 with its code, not a bare 500', async () => {
    const { SkillStructureError } = require('../../core/skills/skillStructure');
    const store = require.cache[MOCK_IDS['../../stores/skillStore']].exports;
    const original = store.updateSkill;
    store.updateSkill = async () => { throw new SkillStructureError('examplesV2: at most 40 examples', 'examplesV2'); };
    try {
        const res = makeRes();
        await examples.fromMessage(
            makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 3 } }),
            res,
        );
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'invalid_structure');
        assert.equal(res.body.field, 'examplesV2');
    } finally {
        store.updateSkill = original;
    }
});

// ── What one click costs ────────────────────────────────────────────
/**
 * One click on a conversation used to fire one `detectPii` per readable
 * message of the WHOLE conversation — user turns included, which the picker
 * never renders — on the INTERACTIVE lane, in front of everybody else's chat
 * on that pod. The two-lane admission control exists precisely so background
 * work cannot do that (BFSF-322), and three timeouts open the breaker.
 */
test('the preview scans only what it offers, most recent first, on the bulk lane', async () => {
    const messages = [];
    for (let i = 0; i < 300; i += 1) {
        messages.push({ role: 'user', content: `q${i}` });
        messages.push({ role: 'assistant', content: `a${i}` });
    }
    fx.conversation = { id: 'c1', user_id: 'owner', messages };
    const res = makeRes();
    await examples.listMessages(makeReq({ params: { conversationId: 'c1' } }), res);

    const scans = fx.calls.filter(c => c.name === 'detectPii');
    assert.equal(scans.length, examples.PREVIEW_LIMIT, 'one scan per offered row, and no more');
    assert.ok(scans.every(c => c.args.opts?.priority === 'bulk'), 'never in front of live chat');
    assert.equal(res.body.messages.length, examples.PREVIEW_LIMIT);
    assert.ok(res.body.messages.every(m => m.role === 'assistant'), 'the picker only renders answers');
    assert.equal(res.body.messages.at(-1).text, 'a299', 'the newest answer is the one you came for');
});

/**
 * The same window, on the WRITE path. `readableMessages` used to take the
 * FIRST 200, so in a long chat the answer somebody had just received was
 * unreachable — 400 `no_message` for the exact case the feature exists for.
 */
test('the readable window is the LAST messages, so a fresh answer can still be used', async () => {
    const messages = [];
    for (let i = 0; i < 300; i += 1) messages.push({ role: 'assistant', content: `a${i}` });
    fx.conversation = { id: 'c1', user_id: 'owner', messages };
    const rows = examples.readableMessages(fx.conversation);
    assert.equal(rows.length, examples.MESSAGE_LIMIT);
    assert.equal(rows.at(-1).index, 299);
    assert.equal(rows[0].index, 300 - examples.MESSAGE_LIMIT);

    const res = makeRes();
    await examples.fromMessage(
        makeReq({ params: { id: 's1' }, body: { conversationId: 'c1', messageIndex: 299 } }),
        res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.example.good, 'a299');
});
