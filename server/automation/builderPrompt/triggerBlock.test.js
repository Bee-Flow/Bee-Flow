// @typecheck
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
    renderTriggerBlockLean, renderAppEventProviderLines, TRIGGER_PROMPT_NOTES, PROVIDER_PROMPT_NOTES, GENERIC_FILTER_TEXT,
    _declaredEvents, _usesGenericMatcher,
} = require('./triggerBlock');
const { listTriggerSources } = require('../triggerSources');
const { buildAppEventProviders } = require('../builderTools/triggerProviders');
const { PUSH_PENDING } = require('../deliverableEvents');

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

test('agent_call and app_trigger are proposable from the lean band, with the binding path and the linking step', () => {
    assert.match(block, /agent_call \{toolName, description, params:\[\{name,type,required,description\}\]\}/);
    assert.match(block, /app_trigger \{params:/);
    assert.match(block, /arrives as trigger\.output\.<name> \(there is no trigger\.payload\)/);
    assert.match(block, /link it to an agent under "Who can call this" in the trigger panel/);
});

// ── The sidecar promises only what the runtime reads ────────────────────────

// The matchers, plus the pollers that read filter keys themselves
// (event.upcoming's leadMinutes / calendarId / includeAllDay, ...).
const MATCHER_SOURCES = [
    path.join('triggerBus', 'filters.js'),
    path.join('triggerBus', 'filtersTables.js'),
    path.join('triggerBus', 'filtersNcTags.js'),
    path.join('triggerBus', 'filtersMsGraph.js'),
    // includeColleagues is a delivery switch read where the fan-out happens.
    path.join('triggerBus', 'dispatch.js'),
    'triggerBus.js',
    path.join('triggerBus', 'pollers', 'googleCalendar.js'),
    path.join('triggerBus', 'pollers', 'nextcloud.js'),
].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');

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
        // `more` = the keys only the full band's per-user lines name: same check.
        for (const entry of [...note.filters, ...(note.more || [])]) {
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

// ── The per-user "App events you may use" lines (renderAppEventProviderLines) ──
//
// builder_propose_trigger's description no longer carries the global catalogue,
// so on the full band (and in the MCP guide) these lines are the ONLY place the
// model learns an event's filter keys, payload and cautions. The lean band
// keeps the global block above in its system prompt and gets the header lines.

// Every provider a fully connected user can have.
const ALL_PROVIDERS = buildAppEventProviders({
    availableAppIds: new Set(['gmail', 'google-calendar', 'google-drive', 'google-sheets', 'google-slides', 'google-contacts', 'google-keep', 'nextcloud', 'outlook', 'msgraph', 'tuya']),
    checks: { support: true, approvals: true, meeting_notes: true },
    publicBaseUrl: true,
});

/** The lines of one provider: its header and the indented lines under it. */
function providerLines(out, id) {
    const all = out.split('\n');
    const start = all.findIndex(l => l.startsWith(`- ${id} (`));
    if (start === -1) return [];
    const end = all.findIndex((l, i) => i > start && l.startsWith('- '));
    return all.slice(start, end === -1 ? undefined : end);
}

/** The full band's detail line that names this event. */
function detailFor(out, provider, event) {
    return providerLines(out, provider).slice(1)
        .find(l => l.startsWith('  - ') && l.slice(4).split(' [')[0].split(' → ')[0].split(' / ').includes(event)) || null;
}

const FULL = renderAppEventProviderLines(ALL_PROVIDERS);
const LEAN = renderAppEventProviderLines(ALL_PROVIDERS, { band: 'lean' });

test('per-user lines: sanity — the fixture has the providers the notes are about', () => {
    for (const id of ['gmail', 'google-calendar', 'google-drive', 'nextcloud', 'msgraph', 'meeting-notes', 'approvals', 'support']) {
        assert.ok(ALL_PROVIDERS.some(p => p.id === id), `${id} in the fixture`);
    }
    assert.equal(renderAppEventProviderLines([]), '');
    assert.equal(renderAppEventProviderLines(null), '');
    assert.equal(renderAppEventProviderLines([], { band: 'lean' }), '');
});

test('per-user lines, both bands: one header line per provider, every listed event, connector events marked', () => {
    for (const out of [FULL, LEAN]) {
        for (const p of ALL_PROVIDERS) {
            const head = providerLines(out, p.id)[0];
            assert.ok(head, `${p.id} has a header line`);
            for (const e of p.events) assert.ok(head.includes(e.id), `${p.id}: ${e.id} on the header line`);
        }
    }
    assert.match(LEAN, /- nextcloud \(Nextcloud\): file\.new, .*share\.created \[needs the connector\]/);
    // Lean: header lines only — the system prompt carries the details.
    assert.ok(LEAN.split('\n').every(l => l.startsWith('- ')), 'the lean band gets the header lines only');
    assert.ok(LEAN.length < FULL.length / 4, `lean ${LEAN.length} vs full ${FULL.length}`);
});

test('per-user lines, full band: every deliverable event has a detail line with its verified filter keys, payload and cautions', () => {
    for (const p of ALL_PROVIDERS) {
        for (const e of p.events) {
            if (PUSH_PENDING[p.id] && PUSH_PENDING[p.id].has(e.id)) continue;
            const line = detailFor(FULL, p.id, e.id);
            assert.ok(line, `${p.id}.${e.id} has no detail line`);
            const decl = _declaredEvents().find(d => d.provider === p.id && d.event === e.id);
            const fieldPart = line.split(' → ')[1] || '';
            for (const f of decl.fields) assert.ok(fieldPart.includes(f), `${p.id}.${e.id}: payload field ${f} not named`);
        }
    }
    for (const [key, note] of Object.entries(TRIGGER_PROMPT_NOTES)) {
        const provider = key.split('.')[0];
        const event = key.slice(provider.length + 1);
        if (!ALL_PROVIDERS.some(p => p.id === provider && p.events.some(e => e.id === event))) continue;
        const line = detailFor(FULL, provider, event);
        if (note.group && !note.filters) continue; // a group member: the lead's line carries the notes
        const bracket = line.split(' → ')[0];
        for (const k of [...(note.filters || []), ...(note.more || [])]) assert.ok(bracket.includes(k), `${key}: filter "${k}" missing`);
        if (note.note) assert.ok(line.includes(note.note), `${key}: note missing`);
        if (note.fullNote) assert.ok(line.includes(note.fullNote), `${key}: fullNote missing`);
    }
});

test('per-user lines, full band: provider notes and the events nothing produces', () => {
    for (const [id, text] of Object.entries(PROVIDER_PROMPT_NOTES)) {
        assert.ok(providerLines(FULL, id).includes(`  ${text}`), `${id}: provider note missing`);
    }
    const nc = providerLines(FULL, 'nextcloud').join('\n');
    assert.equal(detailFor(FULL, 'nextcloud', 'share.created'), null, 'share.created is not a proposable line');
    assert.match(nc, /\n {2}NEVER propose share\.created \(nothing produces it/);
    assert.match(nc, /includeColleagues:true/);
    assert.match(nc, /Talk events come from the Bee Flow bot/);
});

test('per-user lines, full band: the corrections stay corrected', () => {
    const tagged = detailFor(FULL, 'nextcloud', 'file.tagged');
    assert.ok(!/nextcloud_read_file/.test(tagged), 'file.tagged must not point at a tool that cannot read by id');
    assert.ok(!/tagName/.test(tagged.split(' → ')[0]), 'no tagName filter');
    const cal = detailFor(FULL, 'nextcloud', 'calendar.event.created');
    assert.ok(!/summaryContains/.test(cal.split(' → ')[0]), 'calendar push carries no summary to filter on');
    assert.match(detailFor(FULL, 'meeting-notes', 'meeting.processed'), /EVERY FINISHED MEETING/);
    assert.match(detailFor(FULL, 'gmail', 'mail.new'), /replyToMessageId: trigger\.output\.messageId/);
});

test('per-user lines: only THIS user\'s providers, the per-provider cap, and no guessing for an unknown event', () => {
    const gmailOnly = ALL_PROVIDERS.filter(p => p.id === 'gmail');
    const out = renderAppEventProviderLines(gmailOnly);
    assert.ok(!out.includes('nextcloud') && !out.includes('msgraph'), 'no provider the user does not have');
    assert.ok(detailFor(out, 'gmail', 'label.added'));

    const many = [{ id: 'nextcloud', label: 'Nextcloud', events: Array.from({ length: 45 }, (_, i) => ({ id: `ev.${i}` })) }];
    for (const band of /** @type {const} */ (['full', 'lean'])) {
        const capped = renderAppEventProviderLines(many, { band });
        assert.ok(capped.includes('ev.39') && !capped.includes('ev.40'), band);
        assert.match(capped, /…and 5 more events/);
        // An event with no declaration and no notes says nothing beyond its id.
        assert.ok(!capped.includes('  - '), `${band}: no detail line for an undeclared event`);
    }
    // An org-scoped or derived provider the global registry does not know.
    const own = renderAppEventProviderLines([{ id: 'acme-crm', label: 'Acme CRM', events: [{ id: 'deal.won', deliverability: 'ok' }] }]);
    assert.ok(own.includes('- acme-crm (Acme CRM): deal.won'));
});

test('per-user lines: same input, same bytes', () => {
    assert.equal(renderAppEventProviderLines(structuredClone(ALL_PROVIDERS)), FULL);
});
