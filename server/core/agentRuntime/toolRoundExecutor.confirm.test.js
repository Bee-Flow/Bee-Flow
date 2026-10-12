/**
 * The two agent-policy gates in a real streaming turn: the name whitelist and
 * the confirmation hold.
 *
 * THE POINT OF THIS FILE is the invisibility claim. The confirm layer ships
 * dark: an agent that exists today has no `config.tools`, and every assertion
 * below that runs without one must show the pre-A1 behaviour unchanged — the
 * tool dispatches, the draft card still comes from the tool itself, and a
 * headless run keeps the mail tool `autoSend` exists to use. The moment a
 * `tools` map is stored, the same call is held back instead.
 *
 * HOW THIS RUNS WITHOUT POSTGRES: the harness lives in agentTurn.testkit.js —
 * the real chatWithAgentStream driven by a scripted fake provider adapter,
 * `ephemeral: true`, and the stores/heavy collaborators swapped through
 * testUtils/stubRequire (keys are the require strings exactly as the modules
 * write them). The tool REGISTRY is stubbed
 * too, so `gmail_compose` resolves to the gmail app without loading every
 * integration module; the effect classes come from the real sideEffectMap, so
 * "compose sends, search reads" is the product's own answer, not the test's.
 *
 * Run: node --test --test-force-exit core/agentRuntime/toolRoundExecutor.confirm.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
    installAgentTurnHarness, turnState, resetTurnState, LEND, fn, GMAIL_TOOL_REGISTRY, GMAIL_TOOLS,
} = require('./agentTurn.testkit');

// ── Mutable per-test state, read by the stubs of the kit ──────────────
const S = turnState();
const TOOLS = GMAIL_TOOLS;

function reset(cfg = {}) {
    resetTurnState(S, cfg, TOOLS);
}

const kit = installAgentTurnHarness(S, { toolRegistry: GMAIL_TOOL_REGISTRY });
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

// ── Invisible without a stored map ──────────────────────────────────

test('a legacy agent (no config.tools) sends exactly as it does today — no hold, no card', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });

    const { result, error } = await runTurn();

    assert.strictEqual(error, null);
    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_compose'],
        'the tool must still run: today it answers with an email_draft of its own, and holding it ' +
        'back here would take that draft card away from every agent that exists');
    assert.deepStrictEqual(eventsOfType('tool_confirm'), [], 'nothing to confirm without a stored map');
    assert.match(result.message, /All done/);
    assert.deepStrictEqual(gmailOffered(), ['gmail_compose', 'gmail_search'],
        'the whole toolbelt is offered');
});

test('a legacy agent keeps its mail tool in a headless run — autoSend still means send', async () => {
    reset({ drive: callThenAnswer('gmail_compose') });

    await runTurn({ autoSend: true });

    assert.deepStrictEqual(gmailOffered(), ['gmail_compose', 'gmail_search'],
        'dropping confirm-tools from an unattended run must not touch an agent with no grants — ' +
        'that is every mailing automation in the product');
    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_compose']);
});

// ── The map is the opt-in ───────────────────────────────────────────

test('with a stored map a send is held back: SSE tool_confirm, no dispatch, turn still finishes', async () => {
    reset({
        drive: callThenAnswer('gmail_compose'),
        config: { tools: { gmail: { actions: '*', confirm: 'ask' } } },
    });

    const { result, error } = await runTurn();

    assert.strictEqual(error, null, 'a held call is not an error — the turn runs on to done');
    assert.deepStrictEqual(S.dispatched, [], 'nothing may reach the dispatcher');

    const confirms = eventsOfType('tool_confirm');
    assert.strictEqual(confirms.length, 1);
    assert.strictEqual(confirms[0].toolName, 'gmail_compose');
    assert.strictEqual(confirms[0].effect, 'sends', 'the effect comes from sideEffectMap, not from a name check');
    assert.strictEqual(confirms[0].callId, 'call_1', 'the card needs the id the resume route will quote');
    assert.deepStrictEqual(confirms[0].preview, { to: 'x@example.com' });

    assert.match(result.message, /All done/, 'the model finishes its turn around the pending call');
    const held = result.toolCalls.find(c => c.name === 'gmail_compose');
    assert.match(held.result, /has not run/, 'the model is told the call is parked, not that it failed');
});

test('a read is never held, whatever the app entry says', async () => {
    reset({
        drive: callThenAnswer('gmail_search'),
        // `confirm: 'ask'` on the whole app — a read still has nothing to approve.
        config: { tools: { gmail: { actions: '*', confirm: 'ask' } } },
    });

    await runTurn();

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_search']);
    assert.deepStrictEqual(eventsOfType('tool_confirm'), []);
});

test('a stored "direct" cannot buy a send past the gate', async () => {
    reset({
        drive: callThenAnswer('gmail_compose'),
        // The clamp on write/read would have turned this into 'ask'; the
        // runtime must reach the same verdict on its own for a row that
        // somehow arrived unclamped.
        config: { tools: { gmail: { actions: '*', confirm: 'direct' } } },
    });

    await runTurn();

    assert.deepStrictEqual(S.dispatched, [], 'sends is the one thing no stored config talks its way out of');
    assert.strictEqual(eventsOfType('tool_confirm').length, 1);
});

test('a granted agent loses the tool entirely when nobody is watching', async () => {
    reset({
        drive: callThenAnswer('gmail_compose'),
        config: { tools: { gmail: { actions: '*', confirm: 'ask' } } },
    });

    await runTurn({ autoSend: true });

    assert.deepStrictEqual(gmailOffered(), ['gmail_search'],
        'with no one to answer, a tool that would ask is withheld rather than run unapproved');
    assert.deepStrictEqual(S.dispatched, []);
    assert.deepStrictEqual(eventsOfType('tool_confirm'), [],
        'and no card either — there is nobody to draw it for');
});

// ── A hold may not become a loop ────────────────────────────────────
// The placeholder result asks the model to stop; nothing makes it. A model
// that re-emits the same call every round gets a FRESH call id each time, so
// an id-keyed dedupe never fires: before this was keyed on the action, one
// held send produced a card per round until the iteration budget ran out and
// the turn ended by THROWING — which skips finalizeTurn, so the user got an
// error instead of a reply and the cards they had just seen were never
// persisted (they vanish on reload).

/** Re-call `name` for as long as tools are offered; answer once they are not. */
const keepCalling = (name, input) => (cb, options, round) => {
    if (options?.tools?.length) {
        cb('tool_use', { id: `call_${round}`, name, input });
    } else {
        cb('text', { text: 'Waiting on you before I send that.' });
    }
    cb('done', {});
};

test('a model that keeps re-holding one action gets ONE card and a real answer', async () => {
    reset({
        drive: keepCalling('gmail_compose', { to: 'x@example.com' }),
        config: { tools: { gmail: { actions: '*', confirm: 'ask' } } },
    });

    const { result, error } = await runTurn();

    assert.strictEqual(error, null,
        'the turn must not end on the max-iterations throw: that never reaches finalizeTurn, so the ' +
        'user gets an error banner and the pending call is never persisted');
    assert.strictEqual(eventsOfType('tool_confirm').length, 1,
        'one action is one thing to approve, however often the model asks for it');
    assert.deepStrictEqual(S.dispatched, [], 'and it still never runs');
    assert.match(result.message, /Waiting on you/, 'the turn ends with a saved reply');

    const broken = eventsOfType('tool_loop_broken');
    assert.deepStrictEqual(broken, [{ reason: 'pending_confirmation' }],
        'the reason must not borrow the repeated-failure wording — nothing failed here');
    assert.ok(S.toolsOfferedPerRound.length <= 4,
        `the hold costs the same budget as a repeated failure (3 rounds + the wrap-up), not the whole ` +
        `iteration cap — drove ${S.toolsOfferedPerRound.length} rounds`);

    const held = result.toolCalls.filter(c => c.name === 'gmail_compose');
    assert.ok(held.length > 1, 'the model did re-ask — otherwise this test proves nothing');
    assert.match(held[0].result, /has not run/);
    assert.match(held[held.length - 1].result, /Still waiting/,
        'a repeat is told plainly that asking again changes nothing');
});

test('two different pending actions each get their own card', async () => {
    reset({
        drive: (cb, options, round) => {
            if (round === 0) {
                cb('tool_use', { id: 'c1', name: 'gmail_compose', input: { to: 'a@example.com' } });
                cb('tool_use', { id: 'c2', name: 'gmail_compose', input: { to: 'b@example.com' } });
            } else {
                cb('text', { text: 'Two mails are waiting for you.' });
            }
            cb('done', {});
        },
        config: { tools: { gmail: { actions: '*', confirm: 'ask' } } },
    });

    const { error } = await runTurn();

    assert.strictEqual(error, null);
    assert.deepStrictEqual(eventsOfType('tool_confirm').map(c => c.preview.to),
        ['a@example.com', 'b@example.com'],
        'the dedupe is per ACTION — two different mails are two decisions, not a repeat');
});

// ── The name whitelist ──────────────────────────────────────────────

test('a name that was never offered is refused before anything is dispatched', async () => {
    reset({
        // The shape of a prompt injection: an automation name the asker owns, which
        // the dispatcher's dynamic-name fallback would happily have run.
        drive: callThenAnswer('automation_pay_invoice'),
        // Curated: this gate is opt-in, like everything else here.
        config: { tools: { gmail: { actions: '*' } } },
    });

    const { error } = await runTurn();

    assert.strictEqual(error, null);
    assert.deepStrictEqual(S.dispatched, [],
        'an unoffered name must never reach toolDispatcher — its dynamic-name fallback runs the ' +
        "asker's own agent_call automations outside every agent policy");
    assert.deepStrictEqual(eventsOfType('tool_confirm'), [], 'a refusal is not a confirmation');
});

test('an UNcurated agent keeps the dispatcher path it has always had for an unoffered name', async () => {
    // The gate shipped global for one stage, which changed what every agent in
    // the product does with a name outside its stack — with no field anyone
    // could set to ask for it. The dispatcher has its own answer for such a
    // name (the caller's automations and Steps, a progressive-disclosure hint, a
    // component tool), and that answer is what a legacy agent gets back.
    reset({ drive: callThenAnswer('automation_pay_invoice') });

    const { error } = await runTurn();

    assert.strictEqual(error, null);
    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['automation_pay_invoice'],
        'unchanged from before the grants layer — curating the agent is what closes its stack');
    assert.deepStrictEqual(eventsOfType('tool_confirm'), []);
});

// ── actAs: the stored answer to "may this run on my connection?" ─────
// A lend grant is the OWNER's permission for the agent; `actAs` is their
// per-app answer for the tools. Nothing read it: with lending on, one grant
// borrowed the connection for every tool of that provider, including apps the
// owner had deliberately left on "as the person asking".

test('a curated app left on "as the person asking" does not borrow the lent connection', async () => {
    reset({
        drive: callThenAnswer('gmail_search'),
        config: { tools: { gmail: { actions: '*', actAs: 'viewer' } } },
    });
    LEND.on = true;

    await runTurn();

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['gmail_search']);
    assert.strictEqual(S.dispatched[0].userId, 'u1',
        'the call runs as the person asking — the stored choice decides, not the mere existence of a grant');
    assert.strictEqual(S.dispatched[0].lent, false);
});

test('...and an app the owner DID put on "as the owner" still borrows it', async () => {
    reset({
        drive: callThenAnswer('gmail_search'),
        config: { tools: { gmail: { actions: '*', actAs: 'owner' } } },
    });
    LEND.on = true;

    await runTurn();

    assert.strictEqual(S.dispatched[0].userId, 'owner-2',
        'or the fix would just be lending switched off in a costume');
    assert.strictEqual(S.dispatched[0].lent, true);
});

test('an agent with no grants map lends exactly as it did before', async () => {
    reset({ drive: callThenAnswer('gmail_search') });
    LEND.on = true;

    await runTurn();

    assert.strictEqual(S.dispatched[0].userId, 'owner-2',
        'there is no stored answer to honour here, and reading the default as one would switch ' +
        'lending off for every agent that predates the picker');
});

// ── A granted automation's own confirm ─────────────────────────────────
// `automations[].confirm` is keyed on the automation id while the tool is
// named per user at assembly time, so nothing married the two and the stored
// value did nothing at all.

const AUTOMATION = {
    type: 'function',
    function: { name: 'automation_send_invoice', description: 'Send the invoice', parameters: { type: 'object', properties: {} } },
    __automation: { id: 'auto-1', userId: 'u1' },
};

test('an automation its owner put on "ask" is held back instead of run', async () => {
    reset({
        drive: callThenAnswer('automation_send_invoice'),
        tools: [...TOOLS, AUTOMATION],
        config: { tools: { automations: { 'auto-1': { confirm: 'ask' } } } },
    });

    const { error } = await runTurn();

    assert.strictEqual(error, null);
    assert.deepStrictEqual(S.dispatched, [], 'the automation must not run — that is what "ask" was for');
    const confirms = eventsOfType('tool_confirm');
    assert.strictEqual(confirms.length, 1);
    assert.strictEqual(confirms[0].toolName, 'automation_send_invoice');
});

test('an automation granted without a confirm runs exactly as before', async () => {
    reset({
        drive: callThenAnswer('automation_send_invoice'),
        tools: [...TOOLS, AUTOMATION],
        config: { tools: { automations: { 'auto-1': {} } } },
    });

    await runTurn();

    assert.deepStrictEqual(S.dispatched.map(d => d.name), ['automation_send_invoice'],
        'a grant is permission to call it, not an instruction to ask first');
    assert.deepStrictEqual(eventsOfType('tool_confirm'), []);
    // The dispatcher refuses a grant on "ask" unless the caller vouches that this
    // confirm layer stood in front of the call: this path is the one that does.
    assert.strictEqual(S.dispatched[0].confirmLayer, true, 'the streaming round vouches for its confirm layer');
});

test('nobody watching: the automation set to "ask" is withheld, and naming it anyway is refused', async () => {
    reset({
        drive: callThenAnswer('automation_send_invoice'),
        tools: [...TOOLS, AUTOMATION],
        config: { tools: { automations: { 'auto-1': { confirm: 'ask' } } } },
    });

    await runTurn({ autoSend: true });

    assert.ok(!(S.toolsOfferedPerRound[0] || []).includes('automation_send_invoice'),
        'with no one to answer, an automation that would ask is left out of the stack');
    assert.deepStrictEqual(S.dispatched, [],
        'and the name gate holds: the withheld automation may not slip through the dispatcher\'s own lookup');
});

test('an unticked action of a granted app is refused, not merely un-offered', async () => {
    reset({
        drive: callThenAnswer('gmail_compose'),
        // Only search is ticked. The tool is not in the stack, so a model that
        // names it anyway is drift.
        config: { tools: { gmail: { actions: ['gmail_search'] } } },
    });

    const { error } = await runTurn();

    assert.strictEqual(error, null);
    assert.deepStrictEqual(gmailOffered(), ['gmail_search'],
        'the unticked send never reaches the model — assert this first, or the rest of the test ' +
        'passes on gate 2 holding a tool that was still offered and proves nothing about gate 1');
    assert.deepStrictEqual(S.dispatched, [], 'and naming it anyway does not run it');
    assert.deepStrictEqual(eventsOfType('tool_confirm'), [],
        'REFUSED, not held: a name outside the round\'s stack is drift, not a decision to put in ' +
        'front of a person — there is nothing here anyone could sensibly approve');
});

// ── The carrier ─────────────────────────────────────────────────────
// The pending call rides out on the assistant message like an email draft. The
// end-to-end harness is ephemeral (nothing is persisted), so pin the carrier
// structurally: cheap, and it catches the regression that matters — someone
// dropping the field while the SSE event keeps firing, which would leave a
// card that vanishes on reload.

test('finalizeTurn carries pending confirmations on the assistant message', () => {
    // Genuinely textual, given this harness: `ephemeral: true` above means the
    // normal conversation-persistence path never runs, and finalizeTurn's
    // return value (see finalizeTurn.js's final `return`) only carries
    // `message`/`toolCalls`/…, never the durable `assistantMsg` object itself
    // — so there is no stub call or return value here that this property
    // could be observed through. The regression this pins is real and cheap
    // to lose: someone drops the field while the SSE `tool_confirm` event (the
    // one every test above already asserts on behaviourally) keeps firing,
    // leaving a card that reads fine live and vanishes on reload.
    const src = fs.readFileSync(path.join(__dirname, 'finalizeTurn.js'), 'utf8');
    assert.match(src, /assistantMsg\.pendingToolCalls\s*=\s*_pendingToolCalls/,
        'the held call must survive a reload the way emailDrafts does');
});

// ── Studio document writes reach the open editors ───────────────────

test('create_presentation that kept the deck in the library sends document_update', async () => {
    reset({
        tools: [fn('create_presentation')],
        toolResults: { create_presentation: { success: true, documentId: 'doc-9', documentUrl: '/documents/doc-9', file: { name: 'deck.pptx' } } },
        drive: callThenAnswer('create_presentation'),
    });
    const { error } = await runTurn();
    assert.strictEqual(error, null);
    assert.deepStrictEqual(eventsOfType('document_update'), [{ documentId: 'doc-9', name: 'deck.pptx', url: '/documents/doc-9' }]);
});

test('no document_update without a document id, or for a tool that writes no Studio document', async () => {
    reset({
        tools: [fn('create_presentation')],
        toolResults: { create_presentation: { success: true } },
        drive: callThenAnswer('create_presentation'),
    });
    await runTurn();
    assert.deepStrictEqual(eventsOfType('document_update'), []);
    reset({ drive: callThenAnswer('gmail_search'), toolResults: { gmail_search: { documentId: 'x' } } });
    await runTurn();
    assert.deepStrictEqual(eventsOfType('document_update'), []);
});
