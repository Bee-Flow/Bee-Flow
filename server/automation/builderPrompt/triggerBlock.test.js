/**
 * The `## Triggers` block must describe the trigger sources that exist —
 * every one of them, with filter keys the runtime really reads.
 *
 * Same drift risk promptCatalogSync.test.js guards for the FULL schema's
 * prose: a trigger the model is told about that cannot fire, or a filter key
 * that silently matches nothing, produces an automation that activates, reports
 * healthy and never runs. The lean band reads THIS block instead of that
 * prose, so it gets the same checks, in both directions.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt/triggerBlock.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    renderTriggerBlockLean, TRIGGER_PROMPT_NOTES, GENERIC_FILTER_TEXT, _declaredEvents, _usesGenericMatcher,
} = require('./triggerBlock');
const { listTriggerSources } = require('../triggerSources');

const block = renderTriggerBlockLean();
const lines = block.split('\n').filter(l => l.startsWith('- '));

/** The block's line for one provider that names this event. */
function lineFor(provider, event) {
    return lines.find(l => l.startsWith(`- ${provider}: `) && l.slice(`- ${provider}: `.length).split(' [')[0].split(' → ')[0].split(' / ').includes(event)) || null;
}

test('every non-hidden declared event of every non-hidden provider appears on a line of its provider', () => {
    const declared = _declaredEvents();
    assert.ok(declared.length > 30, 'sanity: the registry has its events');
    const missing = declared
        .filter(d => !(d.provider === 'nextcloud' && d.event === 'share.created'))
        .filter(d => !lineFor(d.provider, d.event))
        .map(d => `${d.provider}.${d.event}`);
    assert.deepEqual(missing, [], 'these events exist and the model cannot propose them');
});

test('hidden providers and hidden events are not listed', () => {
    for (const src of listTriggerSources({ includeHidden: true })) {
        for (const ev of (src.events || [])) {
            if (!src.hidden && !ev.hidden) continue;
            assert.equal(lineFor(src.id, ev.id), null, `${src.id}.${ev.id} is hidden and must not be taught`);
        }
    }
    assert.ok(!block.includes('github'), 'the label-resolution-only github declaration stays out');
});

test('share.created is named ONLY as the event never to propose', () => {
    assert.equal(lineFor('nextcloud', 'share.created'), null, 'not a proposable line');
    assert.match(block, /NEVER propose nextcloud share\.created \(nothing produces it\)\./);
});

test('two renders are the same bytes (memoised, global registry, no per-user input)', () => {
    assert.equal(renderTriggerBlockLean(), block);
    assert.equal(renderTriggerBlockLean(), renderTriggerBlockLean());
    assert.ok(block.startsWith('## Triggers (builder_propose_trigger'));
    assert.ok(block.length < 6000, `the block is the diet, not the catalogue: ${block.length} chars`);
});

// ── The sidecar promises only what the runtime reads ────────────────────────

const MATCHER_SOURCES = [
    fs.readFileSync(path.join(__dirname, '..', 'triggerBus', 'filters.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'triggerBus.js'), 'utf8'),
].join('\n');

/** The bare keys in a sidecar filter entry ("columnId + valueEquals" → two). */
function bareKeys(entry) {
    return String(entry).split('+').map(s => (/^\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(s) || [])[1]).filter(Boolean);
}

test('every sidecar note names a declared event, and every filter key is one the runtime reads', () => {
    const declared = new Map(_declaredEvents().map(d => [`${d.provider}.${d.event}`, d]));
    for (const [key, note] of Object.entries(TRIGGER_PROMPT_NOTES)) {
        const d = declared.get(key);
        assert.ok(d, `${key} is in the sidecar but not declared`);
        if (!Array.isArray(note.filters)) continue;
        const generic = _usesGenericMatcher(d.provider, d.event);
        for (const entry of note.filters) {
            for (const k of bareKeys(entry)) {
                if (generic) {
                    // The shallow matcher compares payload keys by equality, so
                    // a filter key must be a payload field to ever match.
                    assert.ok(d.fields.includes(k), `${key}: generic matcher — "${k}" is not a payload field`);
                } else {
                    assert.ok(new RegExp(`\\b(?:filter|f)\\.${k}\\b`).test(MATCHER_SOURCES), `${key}: nothing reads filter.${k}`);
                }
            }
        }
    }
});

test('every payload field the sidecar names is declared, or an enriched key it accounts for', () => {
    const declared = new Map(_declaredEvents().map(d => [`${d.provider}.${d.event}`, d]));
    for (const [key, note] of Object.entries(TRIGGER_PROMPT_NOTES)) {
        if (!Array.isArray(note.fields)) continue;
        const extra = new Set(note.extraFields || []);
        for (const f of note.fields) {
            const bare = (/^[a-zA-Z.]+/.exec(f) || [''])[0].split('.')[0];
            assert.ok(declared.get(key).fields.includes(bare) || extra.has(f), `${key}: payload has no "${f}"`);
        }
    }
});

test('an event with no verified notes gets the generic wording or no filter bracket, never a guess', () => {
    for (const d of _declaredEvents()) {
        if (TRIGGER_PROMPT_NOTES[`${d.provider}.${d.event}`]) continue;
        const line = lineFor(d.provider, d.event);
        if (!line) continue;
        if (_usesGenericMatcher(d.provider, d.event)) assert.ok(line.includes(`[${GENERIC_FILTER_TEXT}]`), line);
        else assert.ok(!/\[/.test(line.split(' → ')[0]), `${d.provider}.${d.event}: an unverified filter bracket`);
    }
});

test('the corrections the full prose got wrong stay corrected', () => {
    // nextcloud_read_file takes a path; file.tagged carries ids only.
    const tagged = lineFor('nextcloud', 'file.tagged');
    assert.ok(tagged && !/nextcloud_read_file/.test(tagged), 'file.tagged must not point at a tool that cannot read by id');
    assert.match(tagged, /tagId/);
    assert.ok(!/tagName/.test(tagged), 'no tagName filter — the event has no tag name');
    // Calendar push carries no VEVENT body.
    const cal = lineFor('nextcloud', 'calendar.event.created');
    assert.ok(cal && !/summaryContains/.test(cal.split(' → ')[0]));
    assert.match(cal, /calendarUri/);
    // Deck moved: the matcher compares fromStackId/toStackId with the payload's
    // previousStackId/stackId (it used to read keys the payload never has, so
    // the filter never matched). Taught only now that it works — and only as
    // long as filters.js keeps reading the real payload keys.
    const deck = lineFor('nextcloud', 'deck.card.moved');
    assert.ok(deck && /fromStackId \/ toStackId/.test(deck) && /previousStackId/.test(deck), deck);
    // Behavioural, not textual: call the real matcher instead of reading its
    // source. Until 2026-09-17 it read the filter's own key names off the
    // PAYLOAD, which never carries them — see filters.js — so a filter with
    // either key never matched a single move.
    const { matchNextcloudDeckCardMovedFilter } = require('../triggerBus/filters');
    const moved = { boardId: 'b1', stackId: 'to', previousStackId: 'from' };
    assert.equal(matchNextcloudDeckCardMovedFilter(moved, { fromStackId: 'from' }), true,
        'fromStackId must compare against the payload\'s previousStackId');
    assert.equal(matchNextcloudDeckCardMovedFilter(moved, { fromStackId: 'elsewhere' }), false);
    assert.equal(matchNextcloudDeckCardMovedFilter(moved, { toStackId: 'to' }), true,
        'toStackId must compare against the payload\'s stackId');
    assert.equal(matchNextcloudDeckCardMovedFilter(moved, { toStackId: 'elsewhere' }), false);
});
