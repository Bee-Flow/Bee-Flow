/**
 * De TESTCHAT in een echte streaming-beurt (A4 deel A).
 *
 * Zelfde opzet als toolRoundExecutor.confirm.test.js (de opzet staat in
 * agentTurn.testkit.js) — de echte
 * chatWithAgentStream, aangedreven door een gescripte nep-adapter, met de
 * stores en zware collaborateurs vervangen. Wat hier bewezen wordt zijn de
 * eigenschappen die alleen in een hele beurt kunnen breken:
 *
 *   • hij laadt het CONCEPT (`useDraft`) en zegt op de lijn WELKE agent dat
 *     was (`test_chat`);
 *   • hij houdt alles vast wat niet leest, ook als de agentconfig `direct`
 *     zegt — een testchat is nooit de reden dat er echt iets de deur uit gaat;
 *   • één klik op "ja" draait ÉÉN actie: de sleutel is naam-plus-argumenten,
 *     hij wordt verbruikt, en een andere sleutel koopt niets;
 *   • zijn verbruik gaat onder een eigen bron het logboek in;
 *   • en een gewone beurt merkt van dit alles niets.
 *
 * Run: cd server && node --test core/agentRuntime/testChat.runtime.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    installAgentTurnHarness, turnState, resetTurnState, AGENT_BASE, GMAIL_TOOL_REGISTRY, GMAIL_TOOLS,
} = require('./agentTurn.testkit');

// ── Mutable per-test state, read by the stubs of the kit ──────────────
const S = {
    ...turnState(),
    runtimeLoads: [],
    loadedConfig: null,
    conversationWrites: 0,
    usage: [],
    draftConfig: null,
    publishedVersion: 0,
    publishedRev: 0,
    rev: 0,
};

function reset(cfg = {}) {
    resetTurnState(S, cfg, GMAIL_TOOLS);
    S.runtimeLoads = [];
    S.loadedConfig = null;
    S.conversationWrites = 0;
    S.usage = [];
    S.draftConfig = cfg.draftConfig || null;
    S.publishedVersion = cfg.publishedVersion || 0;
    S.publishedRev = cfg.publishedRev || 0;
    S.rev = cfg.rev || 0;
}

const kit = installAgentTurnHarness(S, {
    toolRegistry: GMAIL_TOOL_REGISTRY,
    stubs: {
        '../../stores/agentStore': {
            // De projectie die de runtime vroeg wordt vastgelegd EN nagespeeld:
            // `useDraft` levert het concept met `runtimeSource:'draft'`, precies
            // zoals agentCrud.projectDraft dat doet. Zonder die tweede helft zou
            // deze test groen blijven als chatStream de optie meestuurt maar er
            // niets mee gebeurt. (De kit versmalt de belt met `S.loadedConfig`:
            // de grants van de config die de runtime ZOJUIST laadde.)
            getForRuntime: async (_id, opts) => {
                S.runtimeLoads.push(opts || null);
                const draft = opts && opts.useDraft === true;
                S.loadedConfig = draft ? (S.draftConfig || S.agentConfig) : S.agentConfig;
                return {
                    ...AGENT_BASE,
                    config: S.loadedConfig,
                    runtimeSource: draft ? 'draft' : (S.publishedVersion > 0 ? 'published' : 'live'),
                    published_version: S.publishedVersion,
                    published_rev: S.publishedRev,
                    rev: S.rev,
                };
            },
            updateConversation: async () => { S.conversationWrites++; },
        },
        '../../stores/usageStore': { logUsage: async (row) => { S.usage.push(row); } },
    },
});
const { runTurn, eventsOfType } = kit;

test.after(() => kit.restore());

/** Call `name` on the first round, answer in prose on every later one. */
const callThenAnswer = (name) => (cb, options, round) => {
    if (round === 0) cb('tool_use', { id: 'call_1', name, input: { to: 'x@example.com' } });
    else cb('text', { text: 'All done.' });
    cb('done', {});
};


/**
 * The gmail names offered in a round. Filtered because the stack also carries
 * the set_reminder / set_ai_task builtins that toolStackAssembly always adds —
 * they are not what any assertion here is about, and counting them would make
 * these tests fail the day a third builtin arrives.
 */
const gmailOffered = (round = 0) => (S.toolsOfferedPerRound[round] || []).filter(n => n.startsWith('gmail_')).sort();


const { argsKeyFor } = require('./testChat');
const KEY = (name, args) => argsKeyFor(name, JSON.stringify(args));
/** De sleutel die de nep-adapter voor `call_1` produceert. */
const SEND_KEY = KEY('gmail_compose', { to: 'x@example.com' });

// ── Welke agent draaide er? ─────────────────────────────────────────

test('a test chat loads the CONCEPT and says so on the wire', async () => {
    reset({
        drive: (cb) => { cb('text', { text: 'Hi.' }); cb('done', {}); },
        publishedVersion: 3, publishedRev: 7, rev: 12,
    });

    await runTurn({ testChat: true });

    assert.deepStrictEqual(S.runtimeLoads, [{ useDraft: true }],
        'testing what you are making means loading the draft, not the published blob');
    const [info] = eventsOfType('test_chat');
    assert.ok(info, 'the difference with an automation (R2 runs PUBLISHED) has to be on screen');
    assert.strictEqual(info.active, true);
    assert.strictEqual(info.source, 'draft');
    assert.strictEqual(info.runsDraft, true);
    assert.strictEqual(info.publishedVersion, 3);
    assert.strictEqual(info.unpublishedChanges, 5);
});

test('an ordinary turn still loads the runtime projection and says nothing', async () => {
    reset({
        drive: (cb) => { cb('text', { text: 'Hi.' }); cb('done', {}); },
        publishedVersion: 3, publishedRev: 7, rev: 12,
    });

    await runTurn();

    assert.deepStrictEqual(S.runtimeLoads, [{ useDraft: false }]);
    assert.deepStrictEqual(eventsOfType('test_chat'), [],
        'no client should have to learn an event that never applies to it');
});

test('the draft config is what the turn actually runs on', async () => {
    // De harde helft van "het draait op het concept": niet de vlag, maar de
    // config waar de toolstack en het naamhek uit gebouwd worden. De
    // GEPUBLICEERDE map laat alleen gmail_compose toe; het concept heeft
    // helemaal geen map, dus daar is de hele belt beschikbaar.
    const cfg = {
        drive: callThenAnswer('gmail_search'),
        config: { disableExternalTools: true, tools: { gmail: { actions: ['gmail_compose'] } } },
        draftConfig: { disableExternalTools: true },
    };

    reset(cfg);
    await runTurn({ testChat: true });
    assert.deepStrictEqual(gmailOffered(), ['gmail_compose', 'gmail_search'],
        'the draft has no grants map — the whole belt is offered');
    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_search']);

    reset(cfg);
    await runTurn();
    assert.deepStrictEqual(gmailOffered(), ['gmail_compose'],
        'the published map is what an ordinary turn is held to');
    assert.deepStrictEqual(S.dispatched, [], 'gmail_search was never offered, so it is refused');
});

// ── Niets gaat de deur uit zonder een ja ────────────────────────────

test('a test chat holds a send the agent would otherwise just do', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });   // legacy agent: no grants map

    const { result, error } = await runTurn({ testChat: true });

    assert.strictEqual(error, null);
    assert.deepStrictEqual(S.dispatched, [],
        'trying out a concept may never be the thing that sends a real mail');
    const confirms = eventsOfType('tool_confirm');
    assert.strictEqual(confirms.length, 1);
    assert.strictEqual(confirms[0].toolName, 'gmail_compose');
    assert.strictEqual(confirms[0].status, 'pending');
    assert.strictEqual(confirms[0].argsKey, SEND_KEY, 'the card carries the key a decision quotes back');
    assert.match(result.message, /All done/);
});

test('the same agent outside a test chat is untouched', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });

    await runTurn();

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_compose'],
        'the hold is a testchat extra — it must not leak into every legacy agent');
    assert.deepStrictEqual(eventsOfType('tool_confirm'), []);
});

test('a read is not held, not even in a test chat', async () => {
    reset({ drive: callThenAnswer('gmail_search') });

    await runTurn({ testChat: true });

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_search']);
    assert.deepStrictEqual(eventsOfType('tool_confirm'), []);
});

// ── Wat één klik koopt ──────────────────────────────────────────────

test('an approval for exactly this action runs it — once', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });

    await runTurn({
        testChat: true,
        toolDecisions: [{ toolName: 'gmail_compose', argsKey: SEND_KEY, decision: 'approve' }],
    });

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_compose']);
    const confirms = eventsOfType('tool_confirm');
    assert.strictEqual(confirms.length, 1);
    assert.strictEqual(confirms[0].status, 'approved', 'the card has to stop saying "waiting"');
});

test('one yes runs one action — a model that repeats the call is held again', async () => {
    // Twee rondes, dezelfde actie. Zou de toestemming per RONDE worden
    // ingelezen, dan verstuurt één klik twee mails.
    reset({
        drive: (cb, options, round) => {
            if (round < 2) cb('tool_use', { id: `call_${round}`, name: 'gmail_compose', input: { to: 'x@example.com' } });
            else cb('text', { text: 'All done.' });
            cb('done', {});
        },
    });

    await runTurn({
        testChat: true,
        toolDecisions: [{ toolName: 'gmail_compose', argsKey: SEND_KEY, decision: 'approve' }],
    });

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_compose'],
        'the second attempt at the same action is not covered by the first yes');
    const statuses = eventsOfType('tool_confirm').map(c => c.status);
    assert.deepStrictEqual(statuses, ['approved', 'pending']);
});

test('an approval for a DIFFERENT action buys nothing', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });

    await runTurn({
        testChat: true,
        toolDecisions: [{
            toolName: 'gmail_compose',
            argsKey: KEY('gmail_compose', { to: 'somebody-else@example.com' }),
            decision: 'approve',
        }],
    });

    assert.deepStrictEqual(S.dispatched, [], 'a yes is about an action, never about a tool');
    assert.strictEqual(eventsOfType('tool_confirm')[0].status, 'pending');
});

test('a decline stops the call and tells the model it did not happen', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });

    const { result } = await runTurn({
        testChat: true,
        toolDecisions: [{ toolName: 'gmail_compose', argsKey: SEND_KEY, decision: 'decline' }],
    });

    assert.deepStrictEqual(S.dispatched, []);
    assert.strictEqual(eventsOfType('tool_confirm')[0].status, 'declined');
    const call = result.toolCalls.find(c => c.name === 'gmail_compose');
    assert.match(call.result, /declined/i);
    assert.match(call.result, /has not run/i);
});

test('an approval sent WITHOUT test:true is not consulted', async () => {
    // De poort staat op de route (alleen een testchat draagt beslissingen mee);
    // dit pint dat de runtime er zelf ook niet naar kijkt.
    reset({
        drive: callThenAnswer('gmail_compose'),
        config: { disableExternalTools: true, tools: { gmail: { actions: '*', confirm: 'ask' } } },
    });

    await runTurn({
        toolDecisions: [{ toolName: 'gmail_compose', argsKey: SEND_KEY, decision: 'approve' }],
    });

    assert.deepStrictEqual(S.dispatched, [],
        'an ordinary turn may not be talked past its own confirmation regime');
    assert.strictEqual(eventsOfType('tool_confirm')[0].status, 'pending');
});

// ── Wat het kost, en onder welke naam ───────────────────────────────

test('a test turn logs its usage under its own source', async () => {
    reset({ drive: callThenAnswer('gmail_search') });

    await runTurn({ testChat: true });

    assert.ok(S.usage.length > 0, 'a test turn really costs money — it is logged');
    for (const row of S.usage) {
        assert.strictEqual(row.source, 'agent_test_chat',
            'the one place a test conversation still counted as an ordinary one');
    }
});

test('an ordinary turn keeps the sources every dashboard already groups on', async () => {
    reset({ drive: callThenAnswer('gmail_search') });

    await runTurn();

    assert.ok(S.usage.length > 0);
    for (const row of S.usage) {
        assert.ok(['agent_stream', 'agent_chat'].includes(row.source), `unexpected source ${row.source}`);
    }
});

test('a test turn writes no conversation row at all', async () => {
    // De hele "een testgesprek betekent overal hetzelfde"-belofte hangt hier
    // aan: geen rij ⇒ niet in de historie, niet in `getAgentChatStats` (de
    // kaartvoet van A5 en de Chat-rij van de Used-by-tab), en niets om in een
    // compliance-export tegen te komen. Er valt dus ook nergens een filter te
    // vergeten. De route is wat `ephemeral` afdwingt (chat.testChat.test.js);
    // dit pint de andere helft: efemeer betekent hier écht niet schrijven.
    reset({ drive: (cb) => { cb('text', { text: 'Hi.' }); cb('done', {}); } });

    await runTurn({ testChat: true });

    assert.strictEqual(S.conversationWrites, 0);
});

// ── Eén testgesprek is één conversatie, over meerdere beurten ────────

test('twee beurten van hetzelfde testgesprek delen één conversatie-id', async () => {
    // Hier hangt de hele telling aan: `usageStore.getTestChatCounts` doet
    // `COUNT(DISTINCT conversation_id)` over `source = 'agent_test_chat'`. Kreeg
    // elke beurt zijn eigen `ephemeral-<Date.now()>`, dan telde dat BEURTEN en
    // rapporteerde een testgesprek van zes berichten er zes.
    reset({ drive: (cb) => { cb('text', { text: 'Hi.' }); cb('done', {}); } });
    const first = await runTurn({ testChat: true, ephemeralKey: 'tc-sessie-een' });
    const second = await runTurn({ testChat: true, ephemeralKey: 'tc-sessie-een' });

    assert.ok(first.result.conversationId, 'een beurt heeft een conversatie-id');
    assert.strictEqual(second.result.conversationId, first.result.conversationId);
    assert.ok(first.result.conversationId.startsWith('ephemeral-'),
        'nog steeds efemeer: de id kan geen echte rij aanwijzen');
    assert.strictEqual(S.conversationWrites, 0, 'en er wordt nog steeds niets geschreven');

    const seen = new Set(S.usage.filter(r => r.source === 'agent_test_chat').map(r => r.conversation_id));
    assert.strictEqual(seen.size, 1, 'twee beurten, één testgesprek');
});

test('een ander testgesprek is een ander gesprek', async () => {
    reset({ drive: (cb) => { cb('text', { text: 'Hi.' }); cb('done', {}); } });
    const a = await runTurn({ testChat: true, ephemeralKey: 'tc-sessie-een' });
    const b = await runTurn({ testChat: true, ephemeralKey: 'tc-sessie-twee' });
    assert.notStrictEqual(a.result.conversationId, b.result.conversationId);
});

test('zonder sessiesleutel telt elke beurt als een eigen gesprek — te hoog, nooit te laag', async () => {
    reset({ drive: (cb) => { cb('text', { text: 'Hi.' }); cb('done', {}); } });
    const a = await runTurn({ testChat: true });
    const b = await runTurn({ testChat: true });
    assert.notStrictEqual(a.result.conversationId, b.result.conversationId);
});
