/**
 * App Studio connectors — CHAINING (follow-up actions, one call per row).
 *
 * The case these tests encode is the one the feature exists for: `gmail_read`
 * needs a `messageId` that only `gmail_search` produces, and
 * `gmail_download_attachment` needs an `attachmentId` that only `gmail_read`
 * produces. A chain expresses that; these tests pin the properties that make it
 * safe to run with the OWNER's credentials on a viewer's request.
 *
 * Uses the same injectable `_deps` seam as connectors.test.js — no require-cache
 * tricks, no network.
 *
 * Run: cd server && node --test appStudio/connectors.chain.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const connectors = require('./connectors');
const dataModel = require('./dataModel');

const OWNER = 'owner-1';
const ORG = 'org-1';
const app = { id: 'app-1', userId: OWNER, organizationId: ORG };
const OWNER_SESSION = { user: { id: OWNER, organizationId: ORG }, isAdmin: false, automationProviders: {} };

// A recording executeTool built from a { toolName: handler } map.
function stubTools(handlers) {
    const calls = [];
    const executeTool = async (tool, args, ctx) => {
        calls.push({ tool, args, userId: ctx.userId, orgId: ctx.orgId });
        const handler = handlers[tool];
        if (!handler) throw new Error(`unexpected tool ${tool}`);
        return typeof handler === 'function' ? handler(args, calls.length) : handler;
    };
    return { executeTool, calls };
}

function deps(handlers, extra = {}) {
    const { executeTool, calls } = stubTools(handlers);
    return {
        calls,
        _deps: {
            executeTool,
            buildOwnerSession: async () => OWNER_SESSION,
            buildUserSession: async () => OWNER_SESSION,
            ...extra,
        },
    };
}

// ── the headline case ───────────────────────────────────────────────

test('chain: search → read binds messageId from each row and merges the result in', async () => {
    const { calls, _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }, { id: 'm2', subject: 'Yo' }] },
        gmail_read: (args) => ({ body: `body of ${args.messageId}`, format: args.format }),
    });

    const { rows } = await connectors.runConnector({
        id: 'conn_aaa111', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, fixedArgs: { format: 'full' } }],
    }, { app, viewerId: 'viewer-9', params: {}, _deps });

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].subject, 'Hi', 'the base row survives');
    assert.strictEqual(rows[0].body, 'body of m1', 'the follow-up result is merged in');
    assert.strictEqual(rows[1].body, 'body of m2');
    // One base call + one per row, each carrying the bound id AND the pinned arg.
    assert.deepStrictEqual(calls.map((c) => c.tool), ['gmail_search', 'gmail_read', 'gmail_read']);
    assert.deepStrictEqual(calls[1].args, { messageId: 'm1', format: 'full' });
});

test('chain: expand fans out one row per attachment (read → download)', async () => {
    const { calls, _deps } = deps({
        gmail_search: { results: [{ id: 'm1' }] },
        gmail_read: { attachments: [{ id: 'a1', name: 'x.pdf' }, { id: 'a2', name: 'y.pdf' }] },
        gmail_download_attachment: (args) => ({ bytes: 10, downloaded: args.attachmentId }),
    });

    const { rows } = await connectors.runConnector({
        id: 'conn_aaa222', kind: 'integration_tool', tool: 'gmail_search',
        chain: [
            { tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' },
            { tool: 'gmail_download_attachment', argsFrom: { messageId: 'parent_id', attachmentId: 'id' } },
        ],
    }, { app, viewerId: 'v', params: {}, _deps });

    assert.strictEqual(rows.length, 2, 'one row per attachment');
    assert.strictEqual(rows[0].name, 'x.pdf');
    assert.strictEqual(rows[0].downloaded, 'a1');
    assert.strictEqual(rows[1].downloaded, 'a2');
    // After an expand the row IS the attachment: `id` is the attachment's, and
    // the message it came from is still reachable as `parent_id`. That pair is
    // exactly what makes the download step bindable.
    assert.strictEqual(rows[0].id, 'a1');
    assert.strictEqual(rows[0].parent_id, 'm1');
    const dl = calls.filter((c) => c.tool === 'gmail_download_attachment');
    assert.deepStrictEqual(dl.map((c) => c.args.attachmentId), ['a1', 'a2']);
    assert.deepStrictEqual(dl.map((c) => c.args.messageId), ['m1', 'm1']);
});

// ── merge semantics ─────────────────────────────────────────────────

test('chain: a colliding field is prefixed, never silently overwritten', async () => {
    const { _deps } = deps({
        base_list: { rows: [{ id: 'r1', name: 'original' }] },
        other_get: { name: 'from the follow-up', extra: 1 },
    });
    const { rows } = await connectors.runConnector({
        id: 'conn_aaa333', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 'other_get', argsFrom: { key: 'id' } }],
    }, { app, viewerId: 'v', params: {}, _deps });

    // The identity/watermark a sync depends on must survive enrichment.
    assert.strictEqual(rows[0].name, 'original');
    assert.strictEqual(rows[0].get_name, 'from the follow-up');
    assert.strictEqual(rows[0].extra, 1);
});

test("chain: merge 'nest' puts the whole result under the alias", async () => {
    const { _deps } = deps({
        base_list: { rows: [{ id: 'r1' }] },
        other_get: { a: 1, b: 2 },
    });
    const { rows } = await connectors.runConnector({
        id: 'conn_aaa444', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 'other_get', argsFrom: { key: 'id' }, merge: 'nest', alias: 'detail' }],
    }, { app, viewerId: 'v', params: {}, _deps });
    assert.deepStrictEqual(rows[0].detail, { a: 1, b: 2 });
    assert.strictEqual(rows[0].a, undefined, 'nothing spread onto the row');
});

// ── safety properties ───────────────────────────────────────────────

test('chain: one row failing does not empty the table — it is flagged on that row', async () => {
    const { _deps } = deps({
        base_list: { rows: [{ id: 'ok1' }, { id: 'bad' }, { id: 'ok2' }] },
        other_get: (args) => {
            if (args.key === 'bad') return { error: 'that one is unreadable' };
            return { value: args.key };
        },
    });
    const { rows } = await connectors.runConnector({
        id: 'conn_aaa555', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 'other_get', argsFrom: { key: 'id' } }],
    }, { app, viewerId: 'v', params: {}, _deps });

    assert.strictEqual(rows.length, 3, 'the good rows are still there');
    assert.strictEqual(rows[0].value, 'ok1');
    assert.match(rows[1]._error, /unreadable/);
    assert.strictEqual(rows[2].value, 'ok2');
});

// ── "you never connected this app" ──────────────────────────────────
// The one upstream failure with an obvious fix. Executors disagree about how
// they report it — most return { error }, but the Google/Microsoft clients THROW
// a plain Error — and an unclassified throw used to collapse into a generic 500
// ("Connector failed to run") with nothing for the author to act on.

test('connection: a THROWN not-connected error becomes 409 connection_required, naming the app', async () => {
    const { _deps } = deps({
        gmail_search: () => { throw new Error('Not connected to Gmail — user must log in with Google'); },
    });
    await assert.rejects(
        () => connectors.runConnector(
            { id: 'conn_ab0001', kind: 'integration_tool', tool: 'gmail_search', integrationId: 'gmail' },
            { app, viewerId: 'v', params: {}, _deps },
        ),
        (err) => err.status === 409 && err.code === 'connection_required' && err.provider === 'gmail',
    );
});

test('connection: a soft { error } saying the same thing is classified identically', async () => {
    const { _deps } = deps({
        vplan_list_cards: { error: 'vPlan not configured. Add your API key and environment in Settings → Integrations.' },
    });
    await assert.rejects(
        () => connectors.runConnector(
            { id: 'conn_ab0002', kind: 'integration_tool', tool: 'vplan_list_cards', integrationId: 'vplan' },
            { app, viewerId: 'v', params: {}, _deps },
        ),
        (err) => err.status === 409 && err.code === 'connection_required' && err.provider === 'vplan',
    );
});

test('connection: the session builder is told WHICH integrations this run dispatches', async () => {
    // Without this the provider list can resolve to [], buildUserAuth takes its
    // "no OAuth needed" shortcut, and a connected account is reported as not
    // connected. `include` makes the run correct regardless of org config.
    const seen = [];
    const { _deps } = deps(
        { gmail_search: { rows: [{ id: 'm1' }] }, gmail_read: { body: 'x' } },
        { buildOwnerSession: async (_app, opts) => { seen.push(opts); return OWNER_SESSION; } },
    );
    await connectors.runConnector({
        id: 'conn_ab0005', kind: 'integration_tool', tool: 'gmail_search', integrationId: 'gmail',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' } }],
    }, { app, viewerId: 'v', params: {}, _deps });

    assert.strictEqual(seen.length, 1, 'resolved once, not per row');
    assert.ok(seen[0].include.includes('gmail'), 'the dispatched integration is forced into the list');
    assert.strictEqual(seen[0].providerHint, 'google', 'so a Microsoft token can never be handed to Gmail');
});

test('connection: a chain reaching a second app asks for that app’s tokens too', async () => {
    const seen = [];
    const { _deps } = deps(
        { gmail_search: { rows: [{ id: 'm1' }] }, drive_search: { results: [] } },
        { buildOwnerSession: async (_app, opts) => { seen.push(opts); return OWNER_SESSION; } },
    );
    await connectors.runConnector({
        id: 'conn_ab0006', kind: 'integration_tool', tool: 'gmail_search', integrationId: 'gmail',
        chain: [{ tool: 'drive_search', argsFrom: { query: 'id' } }],
    }, { app, viewerId: 'v', params: {}, _deps });

    assert.ok(seen[0].include.includes('gmail'));
    assert.ok(seen[0].include.some((id) => /drive/.test(id)), `expected a drive integration in ${JSON.stringify(seen[0].include)}`);
});

test('connection: an ordinary upstream failure stays a 502, not a connection prompt', async () => {
    const { _deps } = deps({ gmail_search: { error: 'Gmail returned 500' } });
    await assert.rejects(
        () => connectors.runConnector(
            { id: 'conn_ab0003', kind: 'integration_tool', tool: 'gmail_search', integrationId: 'gmail' },
            { app, viewerId: 'v', params: {}, _deps },
        ),
        (err) => err.status === 502 && err.code === 'connector_failed',
    );
});

test('connection: a not-connected chain step fails the run instead of flagging every row', async () => {
    // Stamping _error on 500 rows would bury the one thing the author can fix.
    const { _deps } = deps({
        base_list: { rows: [{ id: 'a' }, { id: 'b' }] },
        other_get: () => { throw new Error('Not connected to Gmail — user must log in with Google'); },
    });
    await assert.rejects(
        () => connectors.runConnector({
            id: 'conn_ab0004', kind: 'integration_tool', tool: 'base_list', integrationId: 'gmail',
            chain: [{ tool: 'other_get', argsFrom: { key: 'id' } }],
        }, { app, viewerId: 'v', params: {}, _deps }),
        (err) => err.status === 409 && err.code === 'connection_required',
    );
});

test('chain: the BASE step failing still fails the whole connector', async () => {
    const { calls, _deps } = deps({ base_list: { error: 'upstream returned 503' } });
    await assert.rejects(
        () => connectors.runConnector({
            id: 'conn_aaa666', kind: 'integration_tool', tool: 'base_list',
            chain: [{ tool: 'other_get' }],
        }, { app, viewerId: 'v', params: {}, _deps }),
        (err) => err.status === 502 && /503/.test(err.message),
    );
    assert.strictEqual(calls.length, 1, 'the chain never started');
});

test('chain: the call budget is a hard stop and the result says it was cut short', async () => {
    const budget = connectors._MAX_CHAIN_CALLS;
    const many = Array.from({ length: budget + 25 }, (_, i) => ({ id: `r${i}` }));
    const { calls, _deps } = deps({
        base_list: { rows: many },
        other_get: { ok: true },
    });
    const res = await connectors.runConnector({
        id: 'conn_aaa777', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 'other_get', argsFrom: { key: 'id' } }],
    }, { app, viewerId: 'v', params: {}, _deps });

    const followUps = calls.filter((c) => c.tool === 'other_get').length;
    assert.strictEqual(followUps, budget, 'never exceeds the budget');
    assert.strictEqual(res.rows.length, many.length, 'the un-enriched rows still come back');
    assert.strictEqual(res.partial, true, 'and the caller is told it was cut short');
    assert.strictEqual(res.rows[many.length - 1]._partial, true);
});

test('chain: steps beyond MAX_CHAIN_STEPS are not run, and the cap matches the model cap', async () => {
    assert.strictEqual(connectors._MAX_CHAIN_STEPS, dataModel.MAX_CHAIN_STEPS,
        'runtime and persisted-model chain caps must agree');
    const { calls, _deps } = deps({
        base_list: { rows: [{ id: 'r1' }] },
        s1: { a: 1 }, s2: { b: 2 }, s3: { c: 3 }, s4: { d: 4 },
    });
    await connectors.runConnector({
        id: 'conn_aaa888', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 's1' }, { tool: 's2' }, { tool: 's3' }, { tool: 's4' }],
    }, { app, viewerId: 'v', params: {}, _deps });
    assert.ok(!calls.some((c) => c.tool === 's4'), 's4 is beyond the cap');
});

test('chain: every call runs as the resolved identity, resolved exactly once', async () => {
    let sessionBuilds = 0;
    const { calls, _deps } = deps(
        { base_list: { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, other_get: { ok: 1 } },
        { buildOwnerSession: async () => { sessionBuilds += 1; return OWNER_SESSION; } },
    );
    await connectors.runConnector({
        id: 'conn_aaa999', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 'other_get', argsFrom: { key: 'id' } }],
    }, { app, viewerId: 'viewer-9', params: {}, _deps });

    assert.strictEqual(sessionBuilds, 1, 'identity negotiated once, not per row');
    assert.ok(calls.every((c) => c.userId === OWNER), 'every call acts as the owner');
    assert.ok(calls.every((c) => c.orgId === ORG));
});

test('chain: a viewer param can never reach a chain step it was not declared for', async () => {
    const { calls, _deps } = deps({
        base_list: { rows: [{ id: 'r1' }] },
        other_get: { ok: 1 },
    });
    await connectors.runConnector({
        id: 'conn_aab000', kind: 'integration_tool', tool: 'base_list',
        params: [{ key: 'q' }],
        chain: [{ tool: 'other_get', argsFrom: { key: 'id' } }],
    }, { app, viewerId: 'v', params: { q: 'hello', evil: 'x' }, _deps });

    assert.deepStrictEqual(calls[0].args, { q: 'hello' }, 'undeclared key dropped from the base call');
    assert.deepStrictEqual(calls[1].args, { key: 'r1' }, 'viewer params never leak into a chain step');
});

test('chain: an object-valued binding is skipped rather than passed as a malformed argument', async () => {
    const { calls, _deps } = deps({
        base_list: { rows: [{ id: 'r1', nested: { deep: 1 } }] },
        other_get: { ok: 1 },
    });
    await connectors.runConnector({
        id: 'conn_aab111', kind: 'integration_tool', tool: 'base_list',
        chain: [{ tool: 'other_get', argsFrom: { key: 'nested', good: 'id' } }],
    }, { app, viewerId: 'v', params: {}, _deps });
    assert.deepStrictEqual(calls[1].args, { good: 'r1' });
});

// ── grains: what a chain returns when it changes what "a row" means ──
//
// "Search mail, read each message, take each attachment" ends with one row per
// attachment — the messages are gone from the flat output. Storing that as ONE
// table would repeat every message field once per attachment. `trace` reports
// the rows at each grain so they can be stored as related tables instead.

test('grains: an expand opens a new grain; an enrich only widens the current one', async () => {
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }, { id: 'm2', subject: 'Yo' }] },
        gmail_read: (a) => ({
            body: `body-${a.messageId}`,
            attachments: a.messageId === 'm1' ? [{ id: 'a1', name: 'x.pdf' }, { id: 'a2', name: 'y.pdf' }] : [{ id: 'a3', name: 'z.pdf' }],
        }),
    });
    const res = await connectors.runConnector({
        id: 'conn_ac0001', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' }],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    assert.strictEqual(res.grains.length, 2);
    assert.strictEqual(res.grains[0].rows.length, 2, 'two messages');
    assert.strictEqual(res.grains[1].rows.length, 3, 'three attachments');
    assert.strictEqual(res.grains[1].expandFrom, 'attachments');
    assert.strictEqual(res.grains[1].parentLevel, 0);
});

test("grains: an expanding step's OWN fields land on the parent, not on every child", async () => {
    // gmail_read returns the body AND the attachments. The body describes the
    // message; copying it onto each attachment (or dropping it, which is what
    // used to happen) are both wrong.
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }] },
        gmail_read: { body: 'the body', attachments: [{ id: 'a1', name: 'x.pdf' }] },
    });
    const res = await connectors.runConnector({
        id: 'conn_ac0002', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' }],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    assert.deepStrictEqual(res.grains[0].rows, [{ id: 'm1', subject: 'Hi', body: 'the body' }]);
    // The child holds ONLY the attachment — no subject, no body.
    const child = res.grains[1].rows[0];
    assert.strictEqual(child.name, 'x.pdf');
    assert.strictEqual(child.subject, undefined);
    assert.strictEqual(child.body, undefined);
    assert.strictEqual(child._parentIndex, 0, 'linked to its message by position, not by a guessed column');
});

test('grains: a step after an expand enriches the CHILD grain, cleanly', async () => {
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }] },
        gmail_read: { body: 'b', attachments: [{ id: 'a1', name: 'x.pdf' }] },
        gmail_download_attachment: { bytes: 100, url: 'https://x' },
    });
    const res = await connectors.runConnector({
        id: 'conn_ac0003', kind: 'integration_tool', tool: 'gmail_search',
        chain: [
            { tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' },
            { tool: 'gmail_download_attachment', argsFrom: { messageId: 'parent_id', attachmentId: 'id' } },
        ],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    assert.strictEqual(res.grains.length, 2, 'an enriching step opens no new grain');
    assert.deepStrictEqual(res.grains[0].rows, [{ id: 'm1', subject: 'Hi', body: 'b' }]);
    const child = res.grains[1].rows[0];
    assert.strictEqual(child.bytes, 100);
    assert.strictEqual(child.url, 'https://x');
    assert.strictEqual(child.subject, undefined, 'the parent columns never leak back in');
});

test('grains: the FLAT rows stay merged, so a grid bound to the connector still works', async () => {
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }] },
        gmail_read: { body: 'b', attachments: [{ id: 'a1', name: 'x.pdf' }] },
    });
    const res = await connectors.runConnector({
        id: 'conn_ac0004', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' }],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].id, 'a1', 'the flat row is the attachment');
    assert.strictEqual(res.rows[0].parent_id, 'm1');
    assert.strictEqual(res.rows[0].subject, 'Hi', 'with its message alongside');
    assert.strictEqual(res.rows[0].body, 'b');
});

test('grains: a connector without trace behaves exactly as before', async () => {
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1' }] },
        gmail_read: { attachments: [{ id: 'a1' }] },
    });
    const res = await connectors.runConnector({
        id: 'conn_ac0005', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' }],
    }, { app, viewerId: 'v', params: {}, _deps });
    assert.strictEqual(res.grains, undefined);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0]._parentIndex, undefined, 'no bookkeeping leaks to a plain run');
});

// ── a step kept in its own table ────────────────────────────────────
// "gmail search → gmail read" returns two different things: messages, and the
// full content of each. Merging them gives one wide table; ownTable says keep
// them side by side, joined — which is what the author asked for.

test('ownTable: a 1:1 step opens its own grain and leaves the parent alone', async () => {
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }, { id: 'm2', subject: 'Yo' }] },
        gmail_read: (a) => ({ body: `body-${a.messageId}`, snippet: 's' }),
    });
    const res = await connectors.runConnector({
        id: 'conn_ot0001', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, ownTable: true }],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    assert.strictEqual(res.grains.length, 2, 'the step gets a grain of its own');
    // The parent is UNTOUCHED — no body, no snippet. Otherwise the same columns
    // would live in both tables.
    assert.deepStrictEqual(res.grains[0].rows, [{ id: 'm1', subject: 'Hi' }, { id: 'm2', subject: 'Yo' }]);
    assert.strictEqual(res.grains[1].rows.length, 2, 'one child row per parent row');
    assert.strictEqual(res.grains[1].expandFrom, null, 'not an expand — there is no list to fan out over');
    assert.strictEqual(res.grains[1].parentLevel, 0);
    assert.deepStrictEqual(res.grains[1].rows[1], { body: 'body-m2', snippet: 's', _parentIndex: 1 });
    // The flat view still merges, so `Test it` and a bound grid are unaffected.
    assert.strictEqual(res.rows[0].subject, 'Hi');
    assert.strictEqual(res.rows[0].body, 'body-m1');
});

test('ownTable: the proposal turns those grains into two joined tables', async () => {
    const connectorSchema = require('./connectorSchema');
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1', subject: 'Hi' }] },
        gmail_read: { body: 'b' },
    });
    const res = await connectors.runConnector({
        id: 'conn_ot0002', kind: 'integration_tool', tool: 'gmail_search',
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, ownTable: true }],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    const set = connectorSchema.proposeTableSet(res.grains, { name: 'Gmail' });
    assert.strictEqual(set.tables.length, 2);
    assert.strictEqual(set.children[0].table.name, 'Gmail — gmail read');
    const relation = set.children[0].table.fields[0];
    assert.strictEqual(relation.type, 'relation');
    assert.strictEqual(relation.relation.table, set.primary.table.id);
    assert.strictEqual(set.children[0].relationField, relation.key);
    // The child holds only its own columns.
    assert.deepStrictEqual(set.children[0].table.fields.slice(1).map((f) => f.key), ['body']);
});

test('ownTable: a later step still binds against the right parent when a row failed', async () => {
    // m1 fails the read. Before the grain index was tracked explicitly, every
    // later step shifted by one and enriched the WRONG row.
    const { calls, _deps } = deps({
        gmail_search: { results: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] },
        gmail_read: (a) => {
            if (a.messageId === 'm1') throw new Error('unreadable');
            return { body: `body-${a.messageId}` };
        },
        gmail_download_attachment: (a) => ({ bytes: a.body ? a.body.length : 0 }),
    });
    const res = await connectors.runConnector({
        id: 'conn_ot0003', kind: 'integration_tool', tool: 'gmail_search',
        chain: [
            { tool: 'gmail_read', argsFrom: { messageId: 'id' }, ownTable: true },
            { tool: 'gmail_download_attachment', argsFrom: { body: 'body' } },
        ],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    // The child grain holds only the two readable messages…
    const child = res.grains[1].rows;
    assert.deepStrictEqual(child.map((r) => r.body), ['body-m2', 'body-m3']);
    // …and the follow-up landed on those two, in the right order.
    assert.deepStrictEqual(child.map((r) => r.bytes), [7, 7]);
    assert.deepStrictEqual(child.map((r) => r._parentIndex), [1, 2], 'still pointing at m2 and m3');
    // The failed row keeps its reason on the parent grain rather than vanishing.
    assert.strictEqual(res.grains[0].rows[0]._error, 'unreadable');
    assert.strictEqual(calls.filter((c) => c.tool === 'gmail_download_attachment').length, 2);
});

test('ownTable: an expand over an empty list does not shift the rows after it', async () => {
    const { _deps } = deps({
        gmail_search: { results: [{ id: 'm1' }, { id: 'm2' }] },
        gmail_read: (a) => ({ attachments: a.messageId === 'm1' ? [] : [{ id: 'a1', name: 'x.pdf' }] }),
        gmail_download_attachment: (a) => ({ saved: a.attachmentId }),
    });
    const res = await connectors.runConnector({
        id: 'conn_ot0004', kind: 'integration_tool', tool: 'gmail_search',
        chain: [
            { tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' },
            { tool: 'gmail_download_attachment', argsFrom: { attachmentId: 'id' } },
        ],
    }, { app, viewerId: 'v', params: {}, trace: true, _deps });

    // m1 contributed a flat row but no attachment, so the one child row must
    // still be a1 — enriched, and not overwritten by m1's leftovers.
    assert.strictEqual(res.grains[1].rows.length, 1);
    assert.strictEqual(res.grains[1].rows[0].name, 'x.pdf');
    assert.strictEqual(res.grains[1].rows[0].saved, 'a1');
    assert.strictEqual(res.grains[1].rows[0]._parentIndex, 1, 'a1 belongs to m2');
});

test('ownTable: expanding AND asking for its own table is a contradiction', () => {
    const withChain = (step) => dataModel.validateDataModel({
        modelVersion: 1,
        tables: [],
        connectors: [{
            id: dataModel.newConnectorId(), name: 'Gmail', kind: 'integration_tool',
            integrationId: 'gmail', tool: 'gmail_search', chain: [step],
        }],
    }).errors;

    assert.ok(
        withChain({ tool: 'gmail_read', expand: 'attachments', ownTable: true })
            .some((e) => /cannot both expand and be its own table/.test(e)),
    );
    assert.ok(
        withChain({ tool: 'gmail_read', ownTable: 'yes' })
            .some((e) => /ownTable must be true or false/.test(e)),
    );
    assert.deepStrictEqual(withChain({ tool: 'gmail_read', ownTable: true }), [], 'on its own it is fine');
});

test('chain: a dotted binding reads a nested field', () => {
    const row = { sender: { email: 'a@b.nl' }, items: [{ id: 1 }] };
    assert.strictEqual(connectors._readRowPath(row, 'sender.email'), 'a@b.nl');
    assert.deepStrictEqual(connectors._readRowPath(row, 'items[]'), [{ id: 1 }]);
    assert.strictEqual(connectors._readRowPath(row, 'nope.deep'), undefined);
    assert.strictEqual(connectors._readRowPath(row, 'constructor'), undefined, 'no proto walk');
});

test('chain: a connector with no chain makes exactly one call', async () => {
    const { calls, _deps } = deps({ gmail_search: { results: [{ id: 'm1' }] } });
    const res = await connectors.runConnector(
        { id: 'conn_aab222', kind: 'integration_tool', tool: 'gmail_search' },
        { app, viewerId: 'v', params: {}, _deps },
    );
    assert.deepStrictEqual(res, { rows: [{ id: 'm1' }] });
    assert.strictEqual(calls.length, 1);
});

// ── envelope unwrapping ─────────────────────────────────────────────
// Nothing normalises tool output, so without this every Google/vPlan/Nextcloud
// connector would produce ONE row holding the whole response as a blob.

test('rows: the real envelope shapes each unwrap to their list', () => {
    const u = connectors._unwrapListEnvelope;
    assert.deepStrictEqual(u({ results: [{ id: 1 }], total: 1 }), [{ id: 1 }], 'Google');
    assert.deepStrictEqual(u({ data: [{ id: 1 }], count: 1, offset: 0, limit: 100, hasMore: false }), [{ id: 1 }], 'vPlan');
    assert.deepStrictEqual(u({ count: 1, activities: [{ id: 1 }] }), [{ id: 1 }], 'Nextcloud Activity');
    assert.deepStrictEqual(u({ calendar: 'work', count: 1, events: [{ id: 1 }] }), [{ id: 1 }], 'Nextcloud Calendar');
    assert.deepStrictEqual(u({ rows: [{ id: 1 }] }), [{ id: 1 }], 'the pre-existing contract still wins');
    assert.deepStrictEqual(u({ results: ['a', 'b'] }), ['a', 'b'], 'a known list key unwraps scalars too');
});

test('rows: an ambiguous or record-shaped payload is NOT unwrapped', () => {
    const u = connectors._unwrapListEnvelope;
    const oneRecord = { id: 'r1', name: 'x', tags: ['a', 'b'] };
    assert.deepStrictEqual(u(oneRecord), oneRecord, 'a scalar array on a record is not the row list');
    const twoLists = { messages: [{ id: 1 }], labels: [{ id: 2 }] };
    assert.deepStrictEqual(u(twoLists), twoLists, 'two candidates → guess nothing');
});

test('rows: an explicit rowsPath beats the heuristic', async () => {
    const { _deps } = deps({
        thing_list: { messages: [{ id: 'm1' }], labels: [{ id: 'l1' }] },
    });
    const { rows } = await connectors.runConnector(
        { id: 'conn_aab333', kind: 'integration_tool', tool: 'thing_list', rowsPath: 'labels' },
        { app, viewerId: 'v', params: {}, _deps },
    );
    assert.deepStrictEqual(rows, [{ id: 'l1' }]);
});
