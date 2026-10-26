// @typecheck
const test = require('node:test');
const assert = require('node:assert');

const { TRIGGER_SOURCES } = require('./meeting-notes');
const { validateTriggerSource } = require('../validate');

/**
 * The Meeting-Notes declaration, and what it DOES and DOES NOT carry along by itself.
 *
 * The question this file answers is not "is the shape right" — registry.test.js
 * does that for EVERY declaration. It is: of the things a declaration should
 * carry along, which of them does this one actually carry? Assuming is how
 * `meeting_notes` looked registered for months when it was not.
 *
 * Run: node --test --test-force-exit automation/triggerSources/declared/meeting-notes.test.js
 */

function freshRegistry() {
    // De registry cachet zijn readdir-sweep; per test opnieuw laden houdt de
    // fixtures van andere suites erbuiten.
    delete require.cache[require.resolve('../index')];
    return require('../index');
}

const DECL = TRIGGER_SOURCES[0];
const EVENT = DECL.events[0];

test('de declaratie is geldig en volgt de vorm van de andere declaraties', () => {
    const errors = validateTriggerSource(DECL).filter(i => i.severity === 'error');
    assert.deepStrictEqual(errors, [], errors.map(e => `${e.code}@${e.path}`).join(', '));
    // The four things that the contract fixes and that must not shift:
    // the id is on every stored subscription.
    assert.strictEqual(DECL.id, 'meeting-notes', 'kebab-case; een underscore werd door PROVIDER_ID_RE geweigerd');
    assert.strictEqual(EVENT.id, 'meeting.processed');
    assert.strictEqual(EVENT.source.kind, 'push');
    assert.strictEqual(EVENT.scope, 'org');
});

test('`tags` is een gedeclareerd uitvoerveld MET voorbeeld — daar filtert een abonnement op', () => {
    assert.ok(EVENT.fields.includes('tags'), 'zonder dit veld is er niets om op te filteren');
    assert.ok(Array.isArray(EVENT.sample.tags) && EVENT.sample.tags.length > 0,
        'de variabelenkiezer toont dit voorbeeld vóór de eerste run');
});

test('de payload draagt GEEN inhoud van de notitie', () => {
    // A meeting note is a transcript of colleague\'s talking; the payload goes to
    // whatever a subscription hangs on it, possibly an outbound integration.
    // Whoever is entitled to the content fetches it with the id (BFSF-441).
    for (const forbidden of ['summary', 'title', 'attendees', 'transcript', 'actionItems', 'fullText']) {
        assert.ok(!EVENT.fields.includes(forbidden), `${forbidden} hoort niet in de payload`);
        assert.ok(!(forbidden in EVENT.sample), `${forbidden} hoort niet in het voorbeeld`);
    }
});

// ── wat de declaratie WEL meeneemt ───────────────────────────────────

test('de declaratie registreert zichzelf en declareert haar tenancy', () => {
    const reg = freshRegistry();
    assert.ok(reg.getTriggerSource('meeting-notes'), 'gevonden door de readdir-sweep bij boot');
    assert.strictEqual(reg.getProviderScope('meeting-notes'), 'org',
        'dispatchEvent scoopt de fan-out hierop; zonder scope wordt het event gedropt');
    assert.ok(reg.getEventDef('meeting-notes', 'meeting.processed'));
});

test('de variabelenkiezer krijgt de velden en de voorbeelden zonder extra code', () => {
    freshRegistry();
    const { buildTriggerOutputsCatalog } = require('../../builderTools/triggerCatalog');
    const entry = buildTriggerOutputsCatalog()['meeting-notes.meeting.processed'];
    assert.ok(entry, 'trigger.output.* is bindbaar in de builder');
    assert.deepStrictEqual(entry.fields.map((/** @type {{ key: string }} */ f) => f.key), EVENT.fields);
    assert.deepStrictEqual(entry.sample.tags, EVENT.sample.tags);
});

test('de bouw-agent — en daarmee de MCP-toolset — krijgt de provider vanzelf', () => {
    // describe.js feeds builderTools/schemas.js, and automation/mcpBuilder.js
    // sends exactly the same TOOL_SCHEMAS to an external client. One source,
    // so the two cannot drift apart.
    freshRegistry();
    const { describeSourcesForPrompt } = require('../describe');
    const { providerList, eventList } = describeSourcesForPrompt();
    assert.ok(providerList.split(' | ').includes('meeting-notes'));
    assert.ok(eventList.includes('meeting-notes.{meeting.processed'));
});

// ── wat de declaratie NIET meeneemt (en dus ergens anders geregeld is) ──

test('de provider-dropdown vraagt om de check `meeting_notes` — die is GEEN gratis gevolg', () => {
    // providerIsAvailable requires `ctx.checks['meeting_notes'] === true`, and that
    // key comes from routes/automation/catalog.js. When it was missing there, the
    // dispatch, the variable picker and the build agent already knew the provider,
    // but a human could not choose it. This test pins both sides.
    freshRegistry();
    const { buildAppEventProviders } = require('../../builderTools/triggerProviders');
    const ctx = { availableAppIds: new Set(), availableMcpServerIds: new Set(), publicBaseUrl: true, orgId: null };

    const zonder = buildAppEventProviders({ ...ctx, checks: { approvals: true } });
    assert.ok(!zonder.some(p => p.id === 'meeting-notes'), 'faalt dicht zonder de check');

    const met = buildAppEventProviders({ ...ctx, checks: { approvals: true, meeting_notes: true } });
    const entry = met.find(p => p.id === 'meeting-notes');
    assert.ok(entry, 'met de check staat de provider in het dropdown');
    assert.strictEqual(entry.label, 'Meeting Notes');
    assert.strictEqual(entry.defaultEvent, 'meeting.processed');
    assert.deepStrictEqual(entry.events.map((/** @type {{ id: string }} */ e) => e.id), ['meeting.processed']);
    // push events have no generic ingest route, but this event is dispatched
    // in-process — so it is simply deliverable and must not show a "does not work
    // yet" warning.
    assert.strictEqual(entry.events[0].deliverability, 'ok');
});

test('de suggestie-engine leest geen enkele trigger-declaratie', () => {
    // Honestly recorded rather than assumed: automation/suggestions.js
    // knows only the coarse triggerKind enum. So a suggestion does not name
    // this trigger because the declaration exists, but at most because the
    // model came across it in the builder prompt. Whoever ever wants to offer
    // providers here must build that explicitly.
    // Deliberately kept textual: this pins an architecture promise (no
    // coupling to the declaration registry), not behaviour on an input. A spy
    // on the three functions would only prove that TODAY nobody calls them,
    // not that the file — or the registry itself — never reads them;
    // and without an existing call there is also no require string to trip
    // over.
    const src = require('fs').readFileSync(require.resolve('../../suggestions'), 'utf8');
    assert.ok(!/triggerSources|buildAppEventProviders|describeSourcesForPrompt/.test(src),
        'als dit rood wordt, leest de suggestie-engine de declaraties inmiddels wél — pas de belofte aan');
    const { VALID_TRIGGER_KINDS } = require('../../suggestions');
    if (VALID_TRIGGER_KINDS) assert.ok(VALID_TRIGGER_KINDS.includes('app_event'));
});
