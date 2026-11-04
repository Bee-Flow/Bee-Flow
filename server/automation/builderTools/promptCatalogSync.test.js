// @typecheck strict
/**
 * The builder prompt must describe the catalog that actually exists.
 *
 * `triggerRegistry.golden.test.js` proves the catalog the FRONTEND sees is
 * stable. Nothing proved that the prose the MODEL sees agrees with it — and it
 * didn't. The prompt documented `file.tagged` as taking a `tagName` filter
 * (Nextcloud's tag event carries numeric ids and no name at all), advertised
 * Deck, Talk and share.created as deliverable long after it was established
 * that Nextcloud exposes no webhook for them, and never mentioned
 * forms.submitted or tables.row.* once they existed.
 *
 * Every one of those produces the same failure: the model emits a trigger that
 * validates, activates, reports healthy, and never fires. So this file checks
 * the prompt against the trigger source in both directions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const { TOOL_SCHEMAS } = require('./schemas');
const { TRIGGER_SOURCES } = require('../triggerSources/declared/nextcloud');
const { PUSH_PENDING } = require('../deliverableEvents');
const { buildAppEventProviders } = require('./triggerProviders');
const { renderAppEventProviderLines } = require('../builderPrompt/triggerBlock');

const NC_EVENTS = new Set(TRIGGER_SOURCES[0].events.map(e => e.id));

/**
 * Where the app_event prose lives now. It used to be the template literal of
 * builder_propose_trigger's description (schemasPart1.js), ~16k characters of
 * every provider sent to every user; that description is one paragraph since
 * the prompt diet, and the per-provider knowledge renders in the per-user
 * "App events you may use" block (builderPrompt/triggerBlock.js,
 * renderAppEventProviderLines). The full band and the MCP guide read exactly
 * these lines, so they are what this file checks, for a user who has every
 * provider.
 */
const ALL_PROVIDERS = buildAppEventProviders({
    availableAppIds: new Set(['gmail', 'google-calendar', 'google-drive', 'nextcloud', 'outlook']),
    checks: { support: true, approvals: true, meeting_notes: true },
    publicBaseUrl: true,
});
const PROSE = renderAppEventProviderLines(ALL_PROVIDERS, { band: 'full' });

/** The schema SOURCE (what the MCP surface ships verbatim), for the filter wording. */
function schemaSource() {
    assert.ok(TOOL_SCHEMAS, 'schemas module still exports TOOL_SCHEMAS');
    return ['schemas.js', ...fs.readdirSync(__dirname).filter(f => /^schemasPart\d+\.js$/.test(f)).sort()]
        .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

/** The provider ids this file slices on. */
const PROVIDER_IDS = ['gmail', 'google-calendar', 'google-drive', 'nextcloud', 'meeting-notes'];

test('the providers this file slices on each have a section in the per-user lines', () => {
    for (const id of PROVIDER_IDS) {
        assert.ok(PROSE.split('\n').some(l => l.startsWith(`- ${id} (`)), `the per-user lines lost the ${id} section`);
    }
});

/** The lines of ONE provider: its header line up to the next provider's. */
function providerSection(/** @type {string} */ id) {
    const lines = PROSE.split('\n');
    const start = lines.findIndex(l => l.startsWith(`- ${id} (`));
    assert.ok(start !== -1, `the per-user lines have a ${id} section`);
    const end = lines.findIndex((l, i) => i > start && l.startsWith('- '));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

test('builder_propose_trigger no longer ships the global catalogue: one paragraph that points at the block', () => {
    const propose = TOOL_SCHEMAS.find(t => t.function.name === 'builder_propose_trigger');
    assert.ok(propose, 'the tool exists');
    const desc = propose.function.description;
    assert.ok(desc.length < 2500, `the description is the diet, not the catalogue: ${desc.length} chars`);
    assert.ok(!desc.includes('\n'), 'one paragraph');
    assert.ok(!/── [A-Z]/.test(desc), 'no per-provider headings');
    for (const ev of ['mail.new', 'file.tagged', 'meeting.processed', 'tables.row.updated']) {
        assert.ok(!desc.includes(ev), `${ev}: a provider's event in the global schema`);
    }
    assert.match(desc, /"App events you may use" block/);
    const props = /** @type {{ properties: Record<string, { description: string }> }} */ (propose.function.parameters).properties;
    assert.ok(!/gmail|nextcloud/.test(props.appProvider.description + props.appEvent.description), 'no global provider or event list in the parameters');
});

function nextcloudSection() {
    return providerSection('nextcloud');
}

test('every Nextcloud event named in the prompt exists in the trigger source', () => {
    const section = nextcloudSection();
    // Event ids are dotted lowercase tokens; pull them out of the prose.
    const mentioned = new Set(
        (section.match(/\b(?:file|share|calendar|deck|talk|forms|tables|activity|notification|task|user)\.[a-z.]*[a-z]\b/g) || [])
            // `trigger.output.x` and tool names are not event ids.
            .filter(t => !t.startsWith('trigger.') && !t.startsWith('steps.'))
    );
    assert.ok(mentioned.size > 5, 'sanity: found event ids in the prompt');

    const unknown = [...mentioned].filter(id => !NC_EVENTS.has(id));
    assert.deepEqual(
        unknown, [],
        'the prompt names Nextcloud events that are not in triggerSources/declared/nextcloud.js — '
        + 'the model will emit triggers that can never fire',
    );
});

test('every deliverable Nextcloud event is described in the prompt', () => {
    const section = nextcloudSection();
    const missing = [...NC_EVENTS]
        .filter(id => !PUSH_PENDING.nextcloud.has(id))
        .filter(id => !section.includes(id));
    assert.deepEqual(
        missing, [],
        'these events work but the prompt never mentions them, so the model cannot propose them',
    );
});

test('the prompt warns the model off the events that have no producer', () => {
    const section = nextcloudSection();
    // Share cannot be delivered: its event class is not IWebhookCompatibleEvent
    // and there is no poller. Deck is pushed by the connector and Talk by the
    // bot, which the model must say needs adding to the conversation.
    assert.match(section, /NEVER propose share\.created \(nothing produces it/,
        'the prompt states plainly that some events cannot fire');
    for (const family of ['deck.card', 'talk.message', 'share.created']) {
        assert.ok(section.includes(family), `${family} is addressed rather than silently omitted`);
    }
    assert.match(section, /bot must be in the room/, 'Talk: the bot must be added');
});

test('the prompt does not teach filters the matcher cannot honour', () => {
    const section = nextcloudSection();
    // `tagName` was the specific regression: Nextcloud's TagAssignedEvent has
    // ids only, so a tagName filter silently matches nothing.
    const lineOf = (/** @type {string} */ ev) => section.split('\n').find(l => l.startsWith('  - ') && l.slice(4).split(' [')[0].split(' / ').includes(ev)) || '';
    const filtersOf = (/** @type {string} */ ev) => lineOf(ev).split(' → ')[0];
    assert.ok(!/tagName/.test(filtersOf('file.tagged')), 'file.tagged must not advertise a tagName filter');
    assert.match(filtersOf('file.tagged'), /tagId/, 'file.tagged documents the numeric tagId filter instead');

    // Calendar push carries no VEVENT body, so summaryContains never matches.
    for (const ev of ['calendar.event.created', 'calendar.event.changed']) {
        assert.ok(lineOf(ev), `${ev} has a line`);
        assert.ok(!/summaryContains/.test(filtersOf(ev)),
            `${ev} must not advertise summaryContains — the payload has no summary`);
    }
});

// ── Meeting Notes ───────────────────────────────────────────────────
//
// Same drift risk as Nextcloud, and it went uncovered when the section was
// written: the whole block could be cut out and every test in this directory
// stayed green. These lines are also the MCP guide's (automations_get_guide
// appends the per-user block), so prose that has drifted from the declaration
// teaches an external client a contract that is not real.

const MEETING_SOURCE = require('../triggerSources/declared/meeting-notes').TRIGGER_SOURCES[0];

test('the Meeting Notes section describes the declaration that exists', () => {
    const section = providerSection('meeting-notes');
    for (const ev of MEETING_SOURCE.events) {
        assert.ok(section.includes(ev.id), `the prompt never mentions ${ev.id}`);
        for (const field of ev.fields) {
            assert.ok(section.includes(field), `the payload field ${field} is missing from the prompt`);
        }
    }
    assert.ok(section.includes(MEETING_SOURCE.id),
        'the prompt must spell the provider id the way it is registered (kebab-case)');
    // `meeting_notes` is the CAPABILITY name, not the provider id. A prompt
    // that used the underscore form would have the model emit a provider that
    // PROVIDER_ID_RE rejects — the exact way this trigger stayed invisible once.
    assert.ok(!section.includes('appProvider:"meeting_notes"'));
    assert.ok(!section.includes('appProvider: "meeting_notes"'));
});

test('the Meeting Notes section states that an empty tag list means EVERY meeting', () => {
    // The one sentence that keeps the model from writing a tag it invented, and
    // the one the matcher's own header calls the choice that must not be hidden.
    const section = providerSection('meeting-notes');
    assert.match(section, /EVERY FINISHED MEETING|every finished meeting/,
        'without this the model reads an empty filter as "match nothing"');
});

test('the prompt does not promise a step that reads a note by id', () => {
    // There is no action anywhere that takes a transcriptionId — transcribe_audio
    // processes an UPLOADED file. A prompt that told the model to "follow the
    // trigger with a Meeting Notes action" made it add a tool that does not
    // exist, which applyAddAction then rejects.
    const section = providerSection('meeting-notes');
    assert.ok(!/Meeting Notes action/.test(section),
        'the prompt names an action the catalogue does not have');
    assert.match(section, /NO STEP THAT READS\s+A NOTE BY ID|no action takes a transcriptionId/,
        'the prompt must say plainly that the content cannot be fetched in a step');
});

test('the generic filter description does not claim a shallow match', () => {
    // Several events (gmail, nextcloud, meeting-notes) have their own matcher,
    // so "must shallowly match the event payload" was untrue for all of them.
    const raw = schemaSource();
    assert.ok(!/shallowly match the event payload/.test(raw));
    assert.match(raw, /An omitted or empty filter means "every event of this kind", never "no events"\./);
});
