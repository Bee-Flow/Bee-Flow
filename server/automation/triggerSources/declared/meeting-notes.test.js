const test = require('node:test');
const assert = require('node:assert');

const { TRIGGER_SOURCES } = require('./meeting-notes');
const { validateTriggerSource } = require('../validate');

/**
 * De Meeting-Notes-declaratie, en wat zij WEL en NIET vanzelf meeneemt.
 *
 * De vraag die dit bestand beantwoordt is niet "klopt de vorm" — dat doet
 * registry.test.js voor élke declaratie. Het is: welke van de dingen die een
 * declaratie zou moeten meeliften, doet dat hier ook echt? Aannemen is hoe
 * `meeting_notes` ooit maandenlang geregistreerd léék en het niet was.
 *
 * Draai: node --test --test-force-exit automation/triggerSources/declared/meeting-notes.test.js
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
    // De vier dingen die het contract vastleggen en die niet mogen schuiven:
    // het id staat op elke opgeslagen subscription.
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
    // Een vergadernotitie is een transcript van collega\'s; de payload gaat naar
    // wat een abonnement er ook aan hangt, mogelijk een uitgaande integratie.
    // Wie recht heeft op de inhoud haalt hem op met het id (BFSF-441).
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
    assert.deepStrictEqual(entry.fields.map(f => f.key), EVENT.fields);
    assert.deepStrictEqual(entry.sample.tags, EVENT.sample.tags);
});

test('de bouw-agent — en daarmee de MCP-toolset — krijgt de provider vanzelf', () => {
    // describe.js voedt builderTools/schemas.js, en automation/mcpBuilder.js
    // stuurt exact diezelfde TOOL_SCHEMAS naar een externe client. Eén bron,
    // dus de twee kunnen niet uit elkaar lopen.
    freshRegistry();
    const { describeSourcesForPrompt } = require('../describe');
    const { providerList, eventList } = describeSourcesForPrompt();
    assert.ok(providerList.split(' | ').includes('meeting-notes'));
    assert.ok(eventList.includes('meeting-notes.{meeting.processed'));
});

// ── wat de declaratie NIET meeneemt (en dus ergens anders geregeld is) ──

test('de provider-dropdown vraagt om de check `meeting_notes` — die is GEEN gratis gevolg', () => {
    // providerIsAvailable eist `ctx.checks['meeting_notes'] === true`, en die
    // sleutel komt uit routes/automation/catalog.js. Toen die daar ontbrak
    // kende de dispatch, de variabelenkiezer én de bouw-agent de provider al,
    // maar kon een mens hem niet kiezen. Deze test pint beide kanten vast.
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
    assert.deepStrictEqual(entry.events.map(e => e.id), ['meeting.processed']);
    // push-events hebben geen generieke ingest-route, maar dit event wordt
    // in-process gedispatcht — het is dus gewoon leverbaar en mag geen
    // "werkt nog niet"-waarschuwing tonen.
    assert.strictEqual(entry.events[0].deliverability, 'ok');
});

test('de suggestie-engine leest geen enkele trigger-declaratie', () => {
    // Eerlijk vastgelegd in plaats van aangenomen: automation/suggestions.js
    // kent alleen de grove triggerKind-enum. Een suggestie noemt deze trigger
    // dus niet omdat de declaratie bestaat, maar hooguit omdat het model haar
    // in de builder-prompt is tegengekomen. Wie hier ooit wél providers wil
    // aanbieden, moet dat expliciet gaan bouwen.
    // Bewust tekstueel gehouden: dit pint een architectuur-belofte (geen
    // koppeling naar de declaratie-registry), niet gedrag op een input. Een
    // spy op de drie functies zou alleen bewijzen dat VANDAAG niemand ze
    // aanroept, niet dat het bestand ze — of de registry zelf — nooit inleest;
    // en zonder bestaande aanroep is er ook geen require-string om op te
    // stuiten.
    const src = require('fs').readFileSync(require.resolve('../../suggestions'), 'utf8');
    assert.ok(!/triggerSources|buildAppEventProviders|describeSourcesForPrompt/.test(src),
        'als dit rood wordt, leest de suggestie-engine de declaraties inmiddels wél — pas de belofte aan');
    const { VALID_TRIGGER_KINDS } = require('../../suggestions');
    if (VALID_TRIGGER_KINDS) assert.ok(VALID_TRIGGER_KINDS.includes('app_event'));
});
