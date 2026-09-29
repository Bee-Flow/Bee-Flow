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

const NC_EVENTS = new Set(TRIGGER_SOURCES[0].events.map(e => e.id));

/**
 * The prompt prose lives in a template literal inside schemas.js, so the source
 * text IS the prompt — reading the file avoids fighting JSON escaping and keeps
 * the assertions readable.
 */
function promptSource() {
    assert.ok(TOOL_SCHEMAS, 'schemas module still exports TOOL_SCHEMAS');
    return fs.readFileSync(path.join(__dirname, 'schemas.js'), 'utf8');
}

/**
 * The top-level provider headings in the app_event catalogue, in order.
 *
 * Kept BY HAND and checked below, because indentation cannot tell a provider
 * heading from a sub-heading — `── Files (webhook…) ──` and `── Nextcloud ──`
 * are both two spaces in. Nextcloud used to be assumed the LAST section and
 * was bounded on the trailing GENERAL note alone; that stopped being true when
 * Meeting Notes was added below it, and the Nextcloud slice silently swallowed
 * another provider's prose. The event-id regex would then read, say,
 * `calendar.event.upcoming` out of a Meeting-Notes sentence and fail the
 * Nextcloud drift test with a message pointing at the wrong file.
 */
const PROVIDER_HEADINGS = ['Gmail', 'Google Calendar', 'Google Drive', 'Nextcloud', 'Meeting Notes'];

test('the provider headings this file slices on are the ones the prompt has', () => {
    const raw = promptSource();
    const start = raw.indexOf('── Gmail ──');
    const end = raw.indexOf('GENERAL: bind the trigger payload', start);
    const catalogue = raw.slice(start, end === -1 ? undefined : end);
    const found = (catalogue.match(/── ([^─\n]+?) ──/g) || []).map(h => h.replace(/── | ──/g, ''));
    for (const heading of PROVIDER_HEADINGS) {
        assert.ok(found.includes(heading), `the prompt lost the ${heading} section`);
    }
    // A NEW top-level provider that is not in the list would make every slice
    // below run past its own section again. Sub-headings are allowed, so this
    // only checks that the ones we do slice on are still there and in order.
    const order = PROVIDER_HEADINGS.map(h => catalogue.indexOf(`── ${h} ──`));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections moved around');
});

/** The prose of ONE provider: its heading up to the next provider or GENERAL. */
function providerSection(heading) {
    const raw = promptSource();
    const start = raw.indexOf(`── ${heading} ──`);
    assert.ok(start !== -1, `the prompt has a ${heading} section`);
    const bounds = PROVIDER_HEADINGS
        .filter(h => h !== heading)
        .map(h => raw.indexOf(`── ${h} ──`, start + 1))
        .concat([raw.indexOf('GENERAL: bind the trigger payload', start)])
        .filter(i => i !== -1);
    const end = bounds.length ? Math.min(...bounds) : -1;
    return raw.slice(start, end === -1 ? undefined : end);
}

function nextcloudSection() {
    return providerSection('Nextcloud');
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
    // Share, Deck and Talk cannot be delivered: their event classes are not
    // IWebhookCompatibleEvent and there is no poller. The model must be told,
    // or it will keep proposing them.
    assert.match(section, /NEVER FIRE|NO PRODUCER/,
        'the prompt states plainly that some events cannot fire');
    for (const family of ['deck.card', 'talk.message', 'share.created']) {
        assert.ok(section.includes(family), `${family} is addressed rather than silently omitted`);
    }
});

test('the prompt does not teach filters the matcher cannot honour', () => {
    const section = nextcloudSection();
    // `tagName` was the specific regression: Nextcloud's TagAssignedEvent has
    // ids only, so a tagName filter silently matches nothing.
    const tagBlock = section.slice(section.indexOf('file.tagged'), section.indexOf('── Forms'));
    assert.ok(!/Filters:[^\n]*tagName/.test(tagBlock), 'file.tagged must not advertise a tagName filter');
    assert.match(tagBlock, /tagId/, 'file.tagged documents the numeric tagId filter instead');

    // Calendar push carries no VEVENT body, so summaryContains never matches.
    const calBlock = section.slice(section.indexOf('calendar.event.created'), section.indexOf('── Generic'));
    assert.ok(!/Filters:[^\n]*summaryContains/.test(calBlock),
        'calendar.event.created/changed must not advertise summaryContains — the payload has no summary');
});

// ── Meeting Notes ───────────────────────────────────────────────────
//
// Same drift risk as Nextcloud, and it went uncovered when the section was
// written: the whole block could be cut out of schemas.js and every test in
// this directory stayed green. The prompt IS the MCP tool description
// (mcpBuilder.js ships TOOL_SCHEMAS verbatim), so a prompt that has drifted
// from the declaration teaches an external client a contract that is not real.

const MEETING_SOURCE = require('../triggerSources/declared/meeting-notes').TRIGGER_SOURCES[0];

test('the Meeting Notes section describes the declaration that exists', () => {
    const section = providerSection('Meeting Notes');
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
    const section = providerSection('Meeting Notes');
    assert.match(section, /EVERY FINISHED MEETING|every finished meeting/,
        'without this the model reads an empty filter as "match nothing"');
});

test('the prompt does not promise a step that reads a note by id', () => {
    // There is no action anywhere that takes a transcriptionId — transcribe_audio
    // processes an UPLOADED file. A prompt that told the model to "follow the
    // trigger with a Meeting Notes action" made it add a tool that does not
    // exist, which applyAddAction then rejects.
    const section = providerSection('Meeting Notes');
    assert.ok(!/Meeting Notes action/.test(section),
        'the prompt names an action the catalogue does not have');
    assert.match(section, /NO STEP THAT READS\s+A NOTE BY ID|no action takes a transcriptionId/,
        'the prompt must say plainly that the content cannot be fetched in a step');
});

test('the generic filter description does not claim a shallow match', () => {
    // Several events (gmail, nextcloud, meeting-notes) have their own matcher,
    // so "must shallowly match the event payload" was untrue for all of them.
    const raw = promptSource();
    assert.ok(!/shallowly match the event payload/.test(raw));
    assert.match(raw, /An omitted or empty filter means "every event of this kind", never "no events"\./);
});
