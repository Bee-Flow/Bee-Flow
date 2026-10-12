/**
 * The ONE personal-data FLOW analyser: what leaves, where it goes, and
 * whether anything stood in front of it.
 *
 * What these tests hold in place is mostly the difference between claims that
 * look alike and are not: "no personal data leaves here", "nobody established
 * what this automation handles", and "a Privacy Shield exists somewhere in this
 * automation" — which is not at all the same as "a Privacy Shield stands in front
 * of the thing it is supposed to protect".
 *
 * Run: node --test --test-force-exit core/privacy/dataFlow.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./dataFlow');
const { CANONICAL_IDS } = require('./piiCategories');

/** The projection both callers really send: a type, and a tool only on an integration_action. */
const step = (type, tool = null) => ({ type, tool });
const PERSONAL = [{ key: 'email', name: 'E-mail', kind: 'email', kinds: ['email'] }, { key: 'naam', name: 'Naam', kind: 'name', kinds: ['name'] }];

test('an exit is decided per STEP, against the product\'s own classifier', () => {
    // gmail_search and gmail_compose are both integration_action and only one
    // of them leaves the building, which is the whole reason the question is
    // asked per step rather than per type.
    assert.equal(F.isExit(step('integration_action', 'gmail_compose')), true);
    assert.equal(F.isExit(step('integration_action', 'gmail_search')), false);
    assert.equal(F.isExit(step('code')), true, 'the sandbox is handed an HTTPS fetch');
    assert.equal(F.isExit(step('http_request')), true);
    assert.equal(F.isExit(step('datatable')), false);
    // Fail closed: a step whose tool we cannot read is not evidence that
    // nothing leaves.
    assert.equal(F.isExit(step('integration_action', null)), true);
});

test('the destination is the recipient, not the step type', () => {
    // Art. 30(1)(d) asks for the categories of RECIPIENTS, and
    // 'integration_action' names none: gmail_compose and
    // nextcloud_talk_send_message are the same type and two different places.
    assert.equal(F.destinationOf(step('integration_action', 'gmail_compose')), 'gmail');
    assert.equal(F.destinationOf(step('integration_action', 'nextcloud_talk_send_message')), 'nextcloud');
    assert.equal(F.destinationOf(step('integration_action', 'signrequest_send_document')), 'signrequest');
    // 'ms' and 'outlook' are the same company and neither word says so.
    assert.equal(F.destinationOf(step('integration_action', 'ms_calendar_create_event')), 'microsoft');
    assert.equal(F.destinationOf(step('integration_action', 'outlook_compose')), 'microsoft');
    // For the types that are outbound whatever they run, the destination IS
    // the type — claiming to know the host would be an invention.
    assert.equal(F.destinationOf(step('http_request')), 'http');
    assert.equal(F.destinationOf(step('code')), 'code');
    assert.equal(F.destinationOf(step('datatable')), null);
});

test('a shield counts only in front of what it precedes', () => {
    // THE BUG THIS MODULE EXISTS FOR. The review's finding is titled "a model
    // reads the data with no privacy check IN FRONT OF IT", and it was
    // suppressed by "is there a privacy step anywhere in this automation" — so a
    // shield dropped at the end of the automation, where it protects nothing that
    // already ran, silenced it.
    const late = F.analyseFlow({ steps: [step('ai_step'), step('integration_action', 'gmail_compose'), step('guard')], personal: PERSONAL });
    assert.equal(late.shields.length, 1, 'the shield is still seen');
    assert.equal(late.models[0].shielded, false, 'the model read the raw rows before it');
    assert.equal(late.exits[0].shielded, false);
    assert.equal(late.verdict, 'unguarded');

    const early = F.analyseFlow({ steps: [step('guard'), step('ai_step'), step('integration_action', 'gmail_compose')], personal: PERSONAL });
    assert.equal(early.models[0].shielded, true);
    assert.equal(early.exits[0].shielded, true);
    assert.equal(early.verdict, 'guarded');

    // And the case one boolean could never express: the model saw the raw
    // rows, the mail did not.
    const between = F.analyseFlow({ steps: [step('ai_step'), step('guard'), step('integration_action', 'gmail_compose')], personal: PERSONAL });
    assert.equal(between.modelsUnshielded, 1);
    assert.deepEqual(between.unguardedExits, []);
    assert.equal(between.verdict, 'guarded');
});

test('the hiding shapes guard what follows; a reveal does not', () => {
    for (const shape of ['guard', 'tokenize']) {
        const flow = F.analyseFlow({ steps: [step(shape), step('integration_action', 'gmail_compose')], personal: PERSONAL });
        assert.equal(flow.exits[0].shielded, true, shape);
    }
    // An untokenize is still a shield STEP (it is seen and counted), but it puts
    // the real values back: a send behind it sends them.
    const reveal = F.analyseFlow({ steps: [step('untokenize'), step('integration_action', 'gmail_compose')], personal: PERSONAL });
    assert.equal(reveal.shields.length, 1);
    assert.equal(reveal.exits[0].shielded, false);
    assert.equal(reveal.verdict, 'unguarded');
});

test('a reveal after the hide re-exposes every later step, until the next hide', () => {
    const steps = [
        step('tokenize'),
        step('ai_step'),
        step('untokenize'),
        step('integration_action', 'gmail_compose'),
        step('tokenize'),
        step('http_request'),
    ];
    const flow = F.analyseFlow({ steps, personal: PERSONAL });
    assert.equal(flow.models[0].shielded, true, 'the model read tokens');
    assert.equal(flow.exits[0].shielded, false, 'the mail went out after the reveal');
    assert.equal(flow.exits[1].shielded, true, 'the HTTP call follows a fresh hide');
    assert.equal(flow.verdict, 'unguarded');
});

test('"nothing personal leaves" and "nobody looked" stay different answers', () => {
    const steps = [step('datatable'), step('integration_action', 'gmail_compose')];
    // null in, null out — a caller that never established what the automation
    // handles has not established that it handles nothing. A flow that reports
    // "no personal data goes out" precisely when it could not look is the one
    // thing this module must never do.
    const unknown = F.analyseFlow({ steps, personal: null });
    assert.equal(unknown.carries, null);
    assert.equal(unknown.verdict, 'unknown');
    const clean = F.analyseFlow({ steps, personal: [] });
    assert.deepEqual(clean.carries, []);
    assert.equal(clean.verdict, 'no_personal_data');
    // And an automation with no exit at all is neither: nothing leaves it.
    assert.equal(F.analyseFlow({ steps: [step('datatable')], personal: PERSONAL }).verdict, 'contained');
    // Steps that could not be read are not a clean automation either.
    assert.equal(F.analyseFlow({ steps: null, personal: PERSONAL }).verdict, 'unknown');
    assert.equal(F.analyseFlow({ steps: [], personal: PERSONAL }).verdict, 'unknown');
});

test('the kinds it reports are the columns\' own, in the reviewer\'s order', () => {
    const flow = F.analyseFlow({ steps: [step('code')], personal: PERSONAL });
    assert.deepEqual(flow.carries, ['name', 'email']);
    assert.deepEqual(F.carriedKinds(null), null);
    assert.deepEqual(F.carriedKinds([]), []);
});

test('a guard category is never re-spelled here — every canonical id survives the trip', () => {
    // THE WORST BUG THIS SIDE OF THE PRODUCT HAS HAD (handoff §7b): a private
    // snake_case squash of the category id meant eighteen of the twenty-one
    // canonical ids matched nothing, so a column of nothing but telephone
    // numbers, IBANs, BSNs or medical data came back "no personal data here".
    // Every id that stands for personal data has to arrive as a kind, whatever
    // spelling it is written in.
    const { KIND_OF_CATEGORY, NOT_PERSONAL_CATEGORIES } = require('./personalColumns');
    for (const id of CANONICAL_IDS) {
        const kinds = F.kindsCarried([id]);
        if (NOT_PERSONAL_CATEGORIES.includes(id)) {
            assert.deepEqual(kinds, [], `${id} is not personal data on its own`);
        } else {
            assert.deepEqual(kinds, [KIND_OF_CATEGORY[id]], `${id} must arrive as a kind`);
        }
    }
    // The wire encoding of the ledger, in every era's spelling.
    assert.deepEqual(F.kindsCarried('PhoneNumber,InternationalBankingAccountNumber'), ['phone', 'financial']);
    assert.deepEqual(F.kindsCarried('Phone Number, EU National ID / BSN'), ['phone', 'id_number']);
    // Null is not empty here either: a ledger column that was never read is
    // not a ledger column that said nothing.
    assert.equal(F.kindsCarried(null), null);
    assert.deepEqual(F.kindsCarried(''), []);
});

test('the ledger turns a hypothesis into a fact, and silence never turns it back', () => {
    const steps = [step('datatable'), step('integration_action', 'gmail_compose')];
    const flow = F.analyseFlow({ steps, personal: PERSONAL });
    assert.equal(flow.verdict, 'unguarded');
    assert.equal(flow.observed, null, 'a ledger that was not read is not a ledger that is empty');

    const seen = F.observedEgress([{ tool_name: 'gmail_compose', pii_categories_detected: 'Email,Person', calls: 4 }]);
    assert.deepEqual(seen.kinds, ['name', 'email']);
    assert.deepEqual(seen.destinations, ['gmail']);
    const confirmed = F.mergeObserved(flow, seen);
    assert.equal(confirmed.verdict, 'confirmed', 'personal data really went out with no shield in front of it');
    assert.equal(confirmed.exits[0].observedCalls, 4);

    // An empty ledger is not an acquittal: nothing has run yet, or the scan
    // was off. "It can send personal data unshielded" stays true.
    const empty = F.mergeObserved(flow, F.observedEgress([]));
    assert.equal(empty.verdict, 'unguarded');
    // And a shielded exit that really sent something is not upgraded either.
    const guarded = F.analyseFlow({ steps: [step('guard'), ...steps], personal: PERSONAL });
    assert.equal(F.mergeObserved(guarded, seen).verdict, 'guarded');
    assert.equal(F.observedEgress(null), null);
});

test('the stored record is built from an allow-list, so a ledger row cannot leak into evidence', () => {
    // BFSF-441. A row of integration_activity_log also carries user_id,
    // acting_user_id, agent_name, data_summary, server_ip and peer_ip. A
    // projection written as "the row minus what I do not want" starts leaking
    // each of those the day a column is added — into a compliance evidence
    // record, which is the one artifact in this product designed to be handed
    // to an outsider.
    const seen = F.observedEgress([{
        tool_name: 'gmail_compose', pii_categories_detected: 'Email', calls: 2,
        user_id: 'usr_7', acting_user_id: 'usr_9', agent_name: 'Klantenservice',
        data_summary: 'mail to jan.jansen@example.com', server_ip: '13.37.0.1', peer_ip: '13.37.0.1',
    }]);
    const blob = JSON.stringify(seen);
    for (const secret of ['usr_7', 'usr_9', 'Klantenservice', 'jan.jansen@example.com', '13.37.0.1']) {
        assert.ok(!blob.includes(secret), `${secret} travelled out of the ledger row`);
    }
    assert.deepEqual(Object.keys(seen.tools[0]).sort(), [...F.EGRESS_FIELDS].sort());

    const record = F.flowRecord(F.mergeObserved(F.analyseFlow({
        steps: [step('datatable'), step('integration_action', 'gmail_compose')], personal: PERSONAL,
    }), seen));
    // The flow carries whole step objects and a step object is the automation's
    // own configuration — sooner or later one holds a recipient address or a
    // bound value. None of them is in the record.
    assert.deepEqual(Object.keys(record).sort(), [...F.FLOW_FIELDS].sort());
    assert.ok(!JSON.stringify(record).includes('gmail_compose'), 'a tool name is a destination here, not a step dump');
    assert.equal(record.exits, 1);
    assert.equal(record.exits_unshielded, 1);
    assert.deepEqual(record.destinations, ['gmail']);
    assert.deepEqual(record.observed_kinds, ['email']);
    // null survives the projection: it is the difference between "no personal
    // data is in play" and "nobody established what is".
    assert.equal(F.flowRecord(F.analyseFlow({ steps: [step('code')], personal: null })).carries, null);
    assert.equal(F.flowRecord(F.analyseFlow({ steps: [step('code')], personal: null })).observed_kinds, null);
    assert.equal(F.flowRecord(null), null);
});

test('every step gets exactly one role, and the roles are the ones this module names', () => {
    const flow = F.analyseFlow({
        steps: [step('datatable'), step('ai_step'), step('guard'), step('integration_action', 'gmail_compose'), step('condition')],
        personal: PERSONAL,
    });
    assert.deepEqual(flow.steps.map((s) => s.role), ['store', 'model', 'shield', 'exit', 'step']);
    for (const s of flow.steps) assert.ok(F.ROLES.includes(s.role), s.role);
    // The step TYPES that send are still reported under their own name — the
    // playbook review has always said those, and a destination is a different
    // sentence, not a replacement for them.
    assert.deepEqual(flow.outboundTypes, ['integration_action']);
    assert.deepEqual(flow.destinations, ['gmail']);
});

test('"a model reads this" is automationGraph\'s list, not a fourth copy of it', () => {
    // The copy this replaces said ['ai_step','data_extraction','summarize','fill_document'],
    // carried forward from the playbook review, and was wrong both ways:
    // `summarize` is a sum over a collection (execSummarize.js) and calls no
    // model at all, while `ai_tool` — which does — was missing, so an automation
    // whose only model call was an ai_tool read as having no model in it.
    const { AI_STEP_TYPES } = require('../../automation/automationGraph');
    assert.deepStrictEqual([...F.MODEL_TYPES].sort(), [...AI_STEP_TYPES].sort());
    assert.ok(!F.MODEL_TYPES.has('summarize'), 'counting rows is not handing data to a model');
    assert.ok(!F.MODEL_TYPES.has('fill_document'), 'filling a template reads nothing to a model');
    assert.ok(F.MODEL_TYPES.has('ai_tool'));

    const flow = F.analyseFlow({
        steps: [
            { type: 'summarize', op: 'count' },
            { type: 'ai_tool' },
        ],
    });
    const roles = flow.steps.map((s) => s.role);
    assert.strictEqual(roles[0], 'step', 'a summarize is not a model step');
    assert.strictEqual(roles[1], 'model');
});
