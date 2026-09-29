'use strict';

/**
 * The write contract for meeting artifacts (M3) — core/meetingNotes/actionItems.js.
 *
 * THE TEST THAT MATTERS is the regenerate one: a person adds an action, presses
 * "Opnieuw", and must still have it afterwards. There is no undo behind that
 * button, so the rule is pinned from both sides — user items survive, AI items
 * do not accumulate.
 *
 * The rest pins the shape the whole downstream reads (list aggregates, export,
 * meeting knowledge source, report) and the two client realities the validator
 * must not break: the Android client PATCHes the whole array with no `id` on
 * the items, and the web client re-sends every item on a single checkbox
 * toggle.
 *
 * Pure — no DB, no HTTP, no clock beyond `at`.
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/actionItems.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    DESTINATION_KINDS,
    MAX_ITEMS,
    actionItemSource,
    validateActionItems,
    validateDecisions,
    validateQuestions,
    normalizeActionItems,
    normalizeNotes,
    noteSource,
    mergeRegeneratedActionItems,
    mergeRegeneratedNotes,
} = require('./actionItems');

const ok = (result) => {
    assert.strictEqual(result.ok, true, `expected ok, got: ${result.error}`);
    return result.items;
};

// ── The regenerate rule ─────────────────────────────────────────────

test('a user item survives a regenerate; the AI items are replaced', () => {
    const existing = [
        { id: 'ai-0', text: 'Rapport opsturen', assignee: 'Tom', done: false },
        { id: 'u-1', source: 'user', text: 'Bel de klant', done: true, assignee: 'Sandra' },
    ];
    const fresh = [
        { id: 'ai-0', source: 'ai', text: 'Rapport opsturen (herzien)', assignee: 'Tom', done: false },
        { id: 'ai-1', source: 'ai', text: 'Offerte nakijken', assignee: 'Ewald', done: false },
    ];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    const mine = merged.find((i) => i.id === 'u-1');
    assert.ok(mine, 'the item the user typed is still there');
    assert.strictEqual(mine.text, 'Bel de klant');
    assert.strictEqual(mine.done, true, 'and it kept its done state');
    assert.strictEqual(mine.assignee, 'Sandra');
    // The AI's old item is gone, its replacement is there, and nothing doubled.
    assert.deepStrictEqual(
        merged.map((i) => i.text),
        ['Bel de klant', 'Rapport opsturen (herzien)', 'Offerte nakijken'],
    );
});

test('a legacy AI item (no `source` at all) is still replaced, not duplicated', () => {
    // Every row written before M3 looks like this. Defaulting them to 'user'
    // would make the list grow by the whole extraction on every regenerate.
    const existing = [{ id: 'ai-0', text: 'Oud AI-punt', done: false }];
    const fresh = [{ id: 'ai-0', source: 'ai', text: 'Nieuw AI-punt', done: false }];
    const merged = mergeRegeneratedActionItems(existing, fresh);
    assert.deepStrictEqual(merged.map((i) => i.text), ['Nieuw AI-punt']);
});

test('a user item keeps its destination and due date across a regenerate', () => {
    const existing = [{
        id: 'u-9',
        source: 'user',
        text: 'Weging draaien',
        due: '2026-09-30',
        destination: { kind: 'automation', ref: 'aut-7', label: 'Weging', at: '2026-09-07T10:00:00.000Z' },
    }];
    const merged = mergeRegeneratedActionItems(existing, [{ id: 'ai-0', source: 'ai', text: 'Iets anders' }]);
    assert.deepStrictEqual(merged[0].destination, {
        kind: 'automation', ref: 'aut-7', label: 'Weging', at: '2026-09-07T10:00:00.000Z',
    });
    assert.strictEqual(merged[0].due, '2026-09-30');
});

test('user items come back in front of the freshly extracted ones', () => {
    const merged = mergeRegeneratedActionItems(
        [{ id: 'u-1', source: 'user', text: 'Mijne' }],
        [{ id: 'ai-0', source: 'ai', text: 'AI-0' }, { id: 'ai-1', source: 'ai', text: 'AI-1' }],
    );
    assert.deepStrictEqual(merged.map((i) => i.text), ['Mijne', 'AI-0', 'AI-1']);
});

test('an id collision between a survivor and a fresh item is re-minted, never merged away', () => {
    // A client that put source:'user' on an item wearing an extractor id would
    // otherwise produce two items with one id — every toggle would hit both.
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'user', text: 'Toch van mij' }],
        [{ id: 'ai-0', source: 'ai', text: 'Van het model' }],
    );
    assert.strictEqual(merged.length, 2);
    assert.notStrictEqual(merged[0].id, merged[1].id);
    assert.deepStrictEqual(merged.map((i) => i.text), ['Toch van mij', 'Van het model']);
});

test('the extractor output is marked ai even when it arrives unmarked', () => {
    const merged = mergeRegeneratedActionItems([], [{ text: 'Kaal item uit het model' }]);
    assert.strictEqual(merged[0].source, 'ai');
});

test('re-transcribing drops the anchors into the transcript that no longer exists', () => {
    const merged = mergeRegeneratedActionItems(
        [{ id: 'u-1', source: 'user', text: 'Mijne', segmentIndex: 42, timestamp: '12:30', due: '2026-09-30' }],
        [],
        { transcriptChanged: true },
    );
    assert.strictEqual(merged[0].text, 'Mijne');
    assert.ok(!('segmentIndex' in merged[0]), 'a moved line must not be seek-able to the wrong sentence');
    assert.ok(!('timestamp' in merged[0]));
    assert.strictEqual(merged[0].due, '2026-09-30', 'a deadline is not an anchor into the audio');
});

test('a regenerate keeps the anchors when the transcript did not change', () => {
    const merged = mergeRegeneratedActionItems(
        [{ id: 'u-1', source: 'user', text: 'Mijne', segmentIndex: 42, timestamp: '12:30' }],
        [],
    );
    assert.strictEqual(merged[0].segmentIndex, 42);
    assert.strictEqual(merged[0].timestamp, '12:30');
});

test('a junk row already in the column drops out instead of throwing', () => {
    // Regenerate must not 500 because one legacy item is a string.
    const merged = mergeRegeneratedActionItems(
        ['not an object', null, { source: 'user', text: '   ' }, { source: 'user', text: 'Echt punt' }],
        [{ id: 'ai-0', source: 'ai', text: 'Vers' }],
    );
    assert.deepStrictEqual(merged.map((i) => i.text), ['Echt punt', 'Vers']);
});

// ── Who put the item there ──────────────────────────────────────────

test('actionItemSource: declared wins, then the ai-<n> namespace, then user', () => {
    assert.strictEqual(actionItemSource({ source: 'user', id: 'ai-3' }), 'user');
    assert.strictEqual(actionItemSource({ source: 'ai', id: 'u-3' }), 'ai');
    assert.strictEqual(actionItemSource({ id: 'ai-12' }), 'ai');
    assert.strictEqual(actionItemSource({ id: 'ai-x' }), 'user');
    assert.strictEqual(actionItemSource({ id: 'u-abc' }), 'user');
    assert.strictEqual(actionItemSource({}), 'user');
    assert.strictEqual(actionItemSource({ source: 'somewhere-else' }), 'user');
});

// ── Validation on the way in (PATCH) ────────────────────────────────

test('a non-array actionItems is refused, not silently emptied', () => {
    const res = validateActionItems('urgent');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /must be an array/);
});

test('an item without text is refused with its index', () => {
    const res = validateActionItems([{ text: 'ok' }, { assignee: 'Tom' }]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /actionItems\[1\]\.text/);
});

test('a non-object item is refused', () => {
    assert.strictEqual(validateActionItems(['just a string']).ok, false);
});

test('an item with no id is accepted and given one — the Android client sends none', () => {
    const [item] = ok(validateActionItems([{ text: 'Bel de klant', done: true }]));
    assert.ok(item.id, 'an id was minted');
    assert.strictEqual(item.source, 'user');
    assert.strictEqual(item.done, true);
});

test('a user item may not keep an extractor id', () => {
    const [item] = ok(validateActionItems([{ id: 'ai-4', source: 'user', text: 'Van mij' }]));
    assert.notStrictEqual(item.id, 'ai-4');
    assert.strictEqual(actionItemSource(item), 'user', 'and it still reads as the user\'s afterwards');
});

test('an AI item keeps its id and source untouched on a round trip', () => {
    const [item] = ok(validateActionItems([
        { id: 'ai-2', source: 'ai', text: 'Rapport opsturen', assignee: 'Tom', timestamp: '12:30', done: false, due: '2026-07-31' },
    ]));
    assert.deepStrictEqual(item, {
        id: 'ai-2', text: 'Rapport opsturen', source: 'ai', done: false,
        assignee: 'Tom', timestamp: '12:30', due: '2026-07-31',
    });
});

test('unknown keys never reach the column', () => {
    const [item] = ok(validateActionItems([
        { id: 'u-1', source: 'user', text: 'Punt', isAdmin: true, __proto__marker: 1, notes: 'x' },
    ]));
    assert.deepStrictEqual(Object.keys(item).sort(), ['done', 'id', 'source', 'text']);
});

test('done is tolerant on the way in — "true" stays checked', () => {
    // The library rail counts open actions with `->>'done' <> 'true'`, so a
    // string "true" already reads as done there; coercing it to false here
    // would silently uncheck the box.
    assert.strictEqual(ok(validateActionItems([{ text: 'x', done: 'true' }]))[0].done, true);
    assert.strictEqual(ok(validateActionItems([{ text: 'x', done: 'yes' }]))[0].done, false);
    assert.strictEqual(ok(validateActionItems([{ text: 'x' }]))[0].done, false);
});

test('due survives only as a plain ISO day', () => {
    assert.strictEqual(ok(validateActionItems([{ text: 'x', due: '2026-07-31' }]))[0].due, '2026-07-31');
    assert.ok(!('due' in ok(validateActionItems([{ text: 'x', due: 'volgende week' }]))[0]));
    assert.ok(!('due' in ok(validateActionItems([{ text: 'x', due: null }]))[0]));
});

test('segmentIndex: a real line number only — null and true never become line 0', () => {
    assert.strictEqual(ok(validateActionItems([{ text: 'x', segmentIndex: 0 }]))[0].segmentIndex, 0);
    assert.strictEqual(ok(validateActionItems([{ text: 'x', segmentIndex: '12' }]))[0].segmentIndex, 12);
    for (const bad of [null, true, -1, 1.5, 'zes', {}]) {
        assert.ok(!('segmentIndex' in ok(validateActionItems([{ text: 'x', segmentIndex: bad }]))[0]),
            `segmentIndex ${JSON.stringify(bad)} must be dropped`);
    }
});

test('duplicate ids are broken apart', () => {
    const items = ok(validateActionItems([
        { id: 'u-1', source: 'user', text: 'Een' },
        { id: 'u-1', source: 'user', text: 'Twee' },
    ]));
    assert.notStrictEqual(items[0].id, items[1].id);
    assert.deepStrictEqual(items.map((i) => i.text), ['Een', 'Twee']);
});

test('an unbounded array is refused', () => {
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ text: `punt ${i}` }));
    assert.strictEqual(validateActionItems(many).ok, false);
});

test('over-long text is truncated, never a permanent 400 on the note', () => {
    // Refusing would lock the owner out of PATCHing at all: every checkbox
    // toggle re-sends the whole array, bad item included.
    const [item] = ok(validateActionItems([{ text: 'x'.repeat(5000) }]));
    assert.strictEqual(item.text.length, 2000);
});

// ── destination ─────────────────────────────────────────────────────

test('the three destinations are the only ones', () => {
    assert.deepStrictEqual([...DESTINATION_KINDS], ['automation', 'datatable_row', 'kb']);
    for (const kind of DESTINATION_KINDS) {
        const [item] = ok(validateActionItems([{ text: 'x', destination: { kind, ref: 'r-1', label: 'L' } }]));
        assert.strictEqual(item.destination.kind, kind);
        assert.strictEqual(item.destination.ref, 'r-1');
        assert.strictEqual(item.destination.label, 'L');
    }
});

test('an unknown destination kind is refused, never stored', () => {
    const res = validateActionItems([{ text: 'x', destination: { kind: 'cowork_task', ref: 't-1' } }]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /destination\.kind/);
});

test('a destination without a ref is refused', () => {
    const res = validateActionItems([{ text: 'x', destination: { kind: 'kb', label: 'Kennisbank' } }]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /destination\.ref/);
});

test('no destination is the normal case and stays absent', () => {
    for (const value of [undefined, null, '']) {
        const [item] = ok(validateActionItems([{ text: 'x', destination: value }]));
        assert.ok(!('destination' in item));
    }
});

test('a destination that is not an object is refused', () => {
    assert.strictEqual(validateActionItems([{ text: 'x', destination: 'automation' }]).ok, false);
    assert.strictEqual(validateActionItems([{ text: 'x', destination: ['kb'] }]).ok, false);
});

test('`at` is a server stamp when the client sends nothing usable', () => {
    const before = Date.now();
    const [item] = ok(validateActionItems([{ text: 'x', destination: { kind: 'kb', ref: 'kb-1', at: 'gisteren' } }]));
    const at = Date.parse(item.destination.at);
    assert.ok(Number.isFinite(at), '`at` is an ISO timestamp');
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, '`at` is now, not the client\'s clock');
});

test('a usable `at` round-trips normalised, so a second PATCH does not restamp it', () => {
    const [item] = ok(validateActionItems([
        { text: 'x', destination: { kind: 'kb', ref: 'kb-1', at: '2026-09-01T08:30:00Z' } },
    ]));
    assert.strictEqual(item.destination.at, '2026-09-01T08:30:00.000Z');
});

test('the run/row a destination created is recorded next to the container it lives in', () => {
    const [item] = ok(validateActionItems([{
        text: 'Weging draaien',
        destination: { kind: 'automation', ref: 'aut-7', itemRef: 'run-42', label: 'Weging' },
    }]));
    assert.strictEqual(item.destination.ref, 'aut-7', 'the chip links to the automation');
    assert.strictEqual(item.destination.itemRef, 'run-42', 'and can reach the run it started');
});

test('a run with no id yet (the 202 pending answer) still records where it went', () => {
    // POST /api/automation/:id/run answers 202 {pending:true} with no run id
    // when the run outlives its 60s response window. The run started; refusing
    // the destination, or inventing a run id, would both be lies.
    const [item] = ok(validateActionItems([{
        text: 'Weging draaien',
        destination: { kind: 'automation', ref: 'aut-7', label: 'Weging' },
    }]));
    assert.strictEqual(item.destination.ref, 'aut-7');
    assert.ok(!('itemRef' in item.destination), 'no run id is recorded until there is one');
});

test('destination is rebuilt from the allow-list — a payload smuggled in extra keys is dropped', () => {
    const [item] = ok(validateActionItems([{
        text: 'x',
        destination: { kind: 'automation', ref: 'aut-1', label: 'Weging', at: '2026-09-01T08:30:00Z', payload: { name: 'Tom Smit' } },
    }]));
    assert.deepStrictEqual(Object.keys(item.destination).sort(), ['at', 'kind', 'label', 'ref']);
});

// ── decisions & questions ───────────────────────────────────────────

test('decisions and questions are validated like action items', () => {
    assert.strictEqual(validateDecisions('nope').ok, false);
    assert.strictEqual(validateDecisions([{ timestamp: '00:10' }]).ok, false);
    const [d] = ok(validateDecisions([{ id: 'd-0', text: 'Plan A goedgekeurd', timestamp: '00:10', junk: 1 }]));
    // `source` joined the shape in M4 — derived from the extractor's `d-<n>`
    // namespace, not defaulted. `junk` still does not reach the column.
    assert.deepStrictEqual(d, { id: 'd-0', text: 'Plan A goedgekeurd', source: 'ai', timestamp: '00:10' });
});

test('a question keeps `open`, defaulting to open when the client says nothing', () => {
    const [a] = ok(validateQuestions([{ id: 'q-0', text: 'Wie regelt de licentie?' }]));
    assert.strictEqual(a.open, true);
    const [b] = ok(validateQuestions([{ id: 'q-0', text: 'Beantwoord?', open: false }]));
    assert.strictEqual(b.open, false);
});

test('a decision or question with no id gets one outside the extractor namespaces', () => {
    const [d] = ok(validateDecisions([{ text: 'Zelf toegevoegd besluit' }]));
    assert.ok(d.id && !/^d-\d+$/.test(d.id));
    const [q] = ok(validateQuestions([{ text: 'Zelf toegevoegde vraag' }]));
    assert.ok(q.id && !/^q-\d+$/.test(q.id));
});

// ── the lenient door ────────────────────────────────────────────────

test('normalizeActionItems never throws and never returns a non-array', () => {
    assert.deepStrictEqual(normalizeActionItems(undefined), []);
    assert.deepStrictEqual(normalizeActionItems('urgent'), []);
    assert.deepStrictEqual(normalizeActionItems({ text: 'x' }), []);
    assert.strictEqual(normalizeActionItems([{ text: 'x' }, 7, null]).length, 1);
});


// ── The preservation rule protected almost nothing ───────────────────
//
// From M3's own adversarial round, confirmed HIGH. `source === 'user'` reads
// like the whole rule and guarded an empty set: nothing in the product creates
// a user item yet (that is M4), while the one thing a person CAN do today —
// give an action a destination — happens on an item the model extracted, which
// keeps `source: 'ai'`. So "Regenerate" threw away exactly the act that had
// already reached outside the note.

test('a destination makes an item the person\'s, whatever produced its text', () => {
    const existing = [
        { id: 'ai-1', text: 'Check the quote', source: 'ai', destination: { kind: 'automation', ref: 'a1', label: 'Nightly', at: '2026-09-07T00:00:00.000Z' } },
        { id: 'ai-2', text: 'A plain AI item', source: 'ai' },
    ];
    const out = mergeRegeneratedActionItems(existing, [{ id: 'ai-1', text: 'Freshly extracted' }]);
    const kept = out.find((i) => i.destination);
    assert.ok(kept, 'the item carrying a destination survives');
    assert.strictEqual(kept.destination.ref, 'a1');
    assert.ok(!out.some((i) => i.text === 'A plain AI item'), 'an untouched AI item is still replaced');
    assert.strictEqual(kept.source, 'ai', 'and it is not relabelled — nobody typed that text');
});

test('the destination survives a reprocess too, without the stale anchors', () => {
    const existing = [{
        id: 'ai-1', text: 'Check the quote', source: 'ai', segmentIndex: 42, timestamp: '12:30',
        destination: { kind: 'kb', ref: 'kb1', label: 'Sales', at: '2026-09-07T00:00:00.000Z' },
    }];
    const [kept] = mergeRegeneratedActionItems(existing, [], { transcriptChanged: true });
    assert.strictEqual(kept.destination.ref, 'kb1');
    assert.strictEqual(kept.segmentIndex, undefined, 'the anchor into the old transcript goes');
    assert.strictEqual(kept.timestamp, undefined);
});


// ── The same rule, one column over (M4) ──────────────────────────────
//
// M3's note said out loud that `done` and an edited text were M4's question,
// "because M4 is what introduces items a person authored outright". It does:
// the transcript tab's per-line popover writes an ACTION from a line, and a
// DECISION from a line. The action half was already covered by the rule above.
// The decision half was not covered by anything — regenerate replaced the
// whole `decisions` column with the extractor's fresh list, so the one thing
// a person can now write there would be gone the next time they pressed a
// button that promises to rewrite the summary.

test('noteSource: declared wins, then the extractor namespace, then user', () => {
    assert.strictEqual(noteSource({ id: 'd-0' }, 'decisions'), 'ai');
    assert.strictEqual(noteSource({ id: 'q-7' }, 'questions'), 'ai');
    // The namespaces do not cross: `q-0` is not a decision the model made.
    assert.strictEqual(noteSource({ id: 'q-0' }, 'decisions'), 'user');
    assert.strictEqual(noteSource({ id: 'ud-abc' }, 'decisions'), 'user');
    assert.strictEqual(noteSource({}, 'decisions'), 'user');
    assert.strictEqual(noteSource({ source: 'ai', id: 'ud-abc' }, 'decisions'), 'ai');
    assert.strictEqual(noteSource({ source: 'user', id: 'd-0' }, 'decisions'), 'user');
    assert.strictEqual(noteSource({ source: 'elsewhere' }, 'decisions'), 'user');
});

test('a decision picked off a transcript line survives a regenerate', () => {
    // THE BITE OF THIS STAGE. The person selected line 12, chose "Besluit",
    // and later pressed "Opnieuw". Nothing about re-running the extractor
    // un-decides what was decided.
    const existing = [
        { id: 'd-0', text: 'Model besloot dit', timestamp: '00:20' },
        { id: 'ud-77', source: 'user', text: 'We gaan met leverancier B verder', segmentIndex: 12, timestamp: '04:10' },
    ];
    const merged = mergeRegeneratedNotes(existing, [{ id: 'd-0', text: 'Model besloot iets anders' }], { field: 'decisions' });

    const mine = merged.find((d) => d.id === 'ud-77');
    assert.ok(mine, 'the decision the person made off a line is still there');
    assert.strictEqual(mine.text, 'We gaan met leverancier B verder');
    assert.strictEqual(mine.segmentIndex, 12, 'and still points at the line it came from');
    assert.strictEqual(mine.timestamp, '04:10');
    assert.deepStrictEqual(
        merged.map((d) => d.text),
        ['We gaan met leverancier B verder', 'Model besloot iets anders'],
        'the model\'s previous decision is replaced, and the person\'s comes first',
    );
});

test('a legacy decision (no `source`, extractor id) is still replaced, not duplicated', () => {
    // Every decision written before M4 looks like this. Treating them as a
    // person's would make the list grow by the whole extraction every time.
    const merged = mergeRegeneratedNotes(
        [{ id: 'd-0', text: 'Oud besluit', timestamp: '00:10' }],
        [{ id: 'd-0', text: 'Nieuw besluit' }],
        { field: 'decisions' },
    );
    assert.deepStrictEqual(merged.map((d) => d.text), ['Nieuw besluit']);
});

test('a question a person raised survives, and keeps its open flag', () => {
    const merged = mergeRegeneratedNotes(
        [{ id: 'uq-3', source: 'user', text: 'Wie betaalt de licentie?', open: false, segmentIndex: 5 }],
        [{ id: 'q-0', text: 'Vraag van het model' }],
        { field: 'questions' },
    );
    assert.strictEqual(merged[0].id, 'uq-3');
    assert.strictEqual(merged[0].open, false, 'answering it is not undone by a regenerate');
    assert.strictEqual(merged[1].open, true, 'and the extractor\'s question defaults to open');
});

test('extractor output is marked ai even when it arrives unmarked', () => {
    const merged = mergeRegeneratedNotes([], [{ text: 'Kaal besluit uit het model' }], { field: 'decisions' });
    assert.strictEqual(merged[0].source, 'ai');
});

test('re-transcribing drops a note\'s anchors but never the note', () => {
    const merged = mergeRegeneratedNotes(
        [{ id: 'ud-1', source: 'user', text: 'Besloten', segmentIndex: 42, timestamp: '12:30' }],
        [],
        { field: 'decisions', transcriptChanged: true },
    );
    assert.strictEqual(merged[0].text, 'Besloten');
    assert.ok(!('segmentIndex' in merged[0]), 'a moved line must not chip the wrong sentence');
    assert.ok(!('timestamp' in merged[0]));
});

test('an id collision between a surviving note and a fresh one is re-minted', () => {
    const merged = mergeRegeneratedNotes(
        [{ id: 'd-0', source: 'user', text: 'Toch van mij' }],
        [{ id: 'd-0', text: 'Van het model' }],
        { field: 'decisions' },
    );
    assert.strictEqual(merged.length, 2);
    assert.notStrictEqual(merged[0].id, merged[1].id);
    assert.ok(!/^d-\d+$/.test(merged[0].id), 'a person\'s note never keeps an extractor id');
});

test('a junk row in the decisions column drops out instead of throwing', () => {
    const merged = mergeRegeneratedNotes(
        ['not an object', null, { source: 'user', text: '  ' }, { source: 'user', text: 'Echt besluit' }],
        [{ id: 'd-0', text: 'Vers' }],
        { field: 'decisions' },
    );
    assert.deepStrictEqual(merged.map((d) => d.text), ['Echt besluit', 'Vers']);
});

test('normalizeNotes never throws and never returns a non-array', () => {
    assert.deepStrictEqual(normalizeNotes(undefined, 'decisions'), []);
    assert.deepStrictEqual(normalizeNotes('besloten', 'decisions'), []);
    assert.deepStrictEqual(normalizeNotes({ text: 'x' }, 'decisions'), []);
    assert.strictEqual(normalizeNotes([{ text: 'x' }, 7, null], 'decisions').length, 1);
});

// ── The line a per-line artifact points at ──────────────────────────

test('segmentIndex is kept on an action item, and only for a real line number', () => {
    const [zero] = ok(validateActionItems([{ text: 'Van regel 0', segmentIndex: 0 }]));
    assert.strictEqual(zero.segmentIndex, 0, 'the first line is a line');
    const [str] = ok(validateActionItems([{ text: 'Van regel 12', segmentIndex: '12' }]));
    assert.strictEqual(str.segmentIndex, 12);
    for (const bad of [null, true, false, -1, 1.5, 'twaalf', {}, []]) {
        const [item] = ok(validateActionItems([{ text: 'x', segmentIndex: bad }]));
        assert.ok(!('segmentIndex' in item), `segmentIndex ${JSON.stringify(bad)} must not anchor anything`);
    }
});

test('segmentIndex is kept on a decision and a question the same way', () => {
    const [d] = ok(validateDecisions([{ text: 'Besloten op regel 3', segmentIndex: 3 }]));
    assert.strictEqual(d.segmentIndex, 3);
    assert.strictEqual(d.source, 'user', 'a decision with no extractor id is a person\'s');
    const [q] = ok(validateQuestions([{ text: 'Gevraagd op regel 4', segmentIndex: '4' }]));
    assert.strictEqual(q.segmentIndex, 4);
    const [bad] = ok(validateDecisions([{ text: 'x', segmentIndex: null }]));
    assert.ok(!('segmentIndex' in bad));
});

test('a person\'s note may never keep an extractor id, whatever it claims', () => {
    // The id is the only evidence a pre-M4 row leaves behind, so an item
    // wearing `d-0` and claiming `source:'user'` would be deleted by the very
    // next regenerate no matter what it said. It gets a fresh id instead.
    const [d] = ok(validateDecisions([{ id: 'd-0', source: 'user', text: 'Van mij' }]));
    assert.ok(!/^d-\d+$/.test(d.id));
    assert.strictEqual(d.source, 'user');
});


// ── Menselijke invoer wint van hergeneratie (M4) ─────────────────────
//
// M3 liet deze vraag expliciet aan M4 over ("What `done` and an edited text
// should count for is a real question and M4's to settle"). Tot hier gooide
// "Opnieuw" van elk AI-punt twee dingen weg: of het afgevinkt was, en de
// tekst die iemand met de hand had gecorrigeerd. Allebei zijn handelingen van
// een mens, allebei zonder undo, en allebei onzichtbaar — het punt kwam terug
// ONDER DEZELFDE `ai-<n>`-id, met andere tekst en het vinkje weer open.
//
// De sleutel waarmee een hergenereerd punt als HETZELFDE punt wordt herkend
// is het transcriptanker (timestamp + assignee), niet de id en niet de tekst.
// Zie de kop boven `anchorKey` in actionItems.js voor waarom.

test('een afgevinkt AI-punt blijft afgevinkt als de nieuwe pass het weer oplevert', () => {
    const existing = [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true }];
    const fresh = [{ id: 'ai-0', source: 'ai', text: 'Klant bellen (herzien)', assignee: 'Tom', timestamp: '12:30', done: false }];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    assert.strictEqual(merged.length, 1, 'herkend als hetzelfde punt, dus niet verdubbeld');
    assert.strictEqual(merged[0].done, true, 'het vinkje is een handeling, geen modeluitvoer');
    assert.strictEqual(merged[0].text, 'Klant bellen (herzien)', 'de AI-tekst mag wél verversen');
});

test('handmatig gecorrigeerde tekst wordt niet teruggezet naar de AI-versie', () => {
    // `aiText` is wat het model zelf schreef; wijkt `text` daarvan af, dan
    // heeft een mens hem overgetypt.
    const existing = [{ id: 'ai-0', source: 'ai', text: 'Jansen BV bellen', aiText: 'Klant bellen', assignee: 'Tom', timestamp: '12:30' }];
    const fresh = [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30' }];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].text, 'Jansen BV bellen', 'de correctie blijft staan');
    assert.strictEqual(merged[0].aiText, 'Klant bellen', 'en de AI-versie wordt bijgehouden voor de volgende ronde');
});

test('de twee helften werken los van elkaar: alleen afgevinkt, en alleen hertypt', () => {
    const merged = mergeRegeneratedActionItems(
        [
            { id: 'ai-0', source: 'ai', text: 'Alleen afgevinkt', assignee: 'Tom', timestamp: '01:00', done: true },
            { id: 'ai-1', source: 'ai', text: 'Alleen hertypt', aiText: 'Wat het model zei', assignee: 'Sandra', timestamp: '02:00', done: false },
        ],
        [
            { id: 'ai-0', source: 'ai', text: 'Alleen afgevinkt (nieuw)', assignee: 'Tom', timestamp: '01:00', done: false },
            { id: 'ai-1', source: 'ai', text: 'Wat het model nu zegt', assignee: 'Sandra', timestamp: '02:00', done: false },
        ],
    );
    const checked = merged.find((i) => i.assignee === 'Tom');
    assert.strictEqual(checked.done, true);
    assert.strictEqual(checked.text, 'Alleen afgevinkt (nieuw)', 'ongewijzigde tekst ververst gewoon');
    const retyped = merged.find((i) => i.assignee === 'Sandra');
    assert.strictEqual(retyped.text, 'Alleen hertypt');
    assert.strictEqual(retyped.done, false, 'en een vinkje dat er nooit stond komt er niet bij');
});

test('de sleutel is het anker, niet de id — een verschoven ai-<n> zet het vinkje niet op een ander punt', () => {
    // DE VAL. `ai-<n>` is de POSITIE in de uitvoer van deze pass. Laat het
    // model één punt weg, dan schuift alles op en heet het afgevinkte punt
    // opeens ai-0. Wie op id vergelijkt, verplaatst het vinkje naar een actie
    // die niemand heeft afgevinkt.
    const existing = [
        { id: 'ai-0', source: 'ai', text: 'Notulen rondsturen', assignee: 'Sandra', timestamp: '02:00', done: false },
        { id: 'ai-1', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true },
    ];
    const fresh = [
        { id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: false },
        { id: 'ai-1', source: 'ai', text: 'Offerte nakijken', assignee: 'Sandra', timestamp: '18:00', done: false },
    ];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    assert.deepStrictEqual(
        merged.map((i) => [i.text, i.done]),
        [['Klant bellen', true], ['Offerte nakijken', false]],
    );
});

test('een AI-punt waar niemand aan zat wordt nog steeds vervangen, ook als het anker matcht', () => {
    // De keerzijde van de regel: zonder dit zou "Opnieuw" niets meer doen.
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'ai', text: 'Oud', assignee: 'Tom', timestamp: '12:30', done: false }],
        [{ id: 'ai-0', source: 'ai', text: 'Nieuw', assignee: 'Tom', timestamp: '12:30', done: false }],
    );
    assert.deepStrictEqual(merged.map((i) => i.text), ['Nieuw']);
});

test('een aangeraakt punt dat de AI NIET meer oplevert wordt bewaard én gemarkeerd', () => {
    // Verwijderen-en-opnieuw-aanmaken zou de menselijke invoer alsnog wissen.
    // Dus blijft het punt staan zoals het is, met een vlag zodat het scherm
    // kan zeggen waaróm het er nog staat.
    const existing = [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true }];
    const fresh = [{ id: 'ai-0', source: 'ai', text: 'Iets heel anders', assignee: 'Ewald', timestamp: '30:00', done: false }];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    assert.strictEqual(merged.length, 2, 'niet verwijderd, en niet opnieuw aangemaakt');
    const kept = merged.find((i) => i.text === 'Klant bellen');
    assert.strictEqual(kept.done, true);
    assert.strictEqual(kept.orphaned, true, 'stil weglaten mag niet — het scherm moet dit kunnen tonen');
    const other = merged.find((i) => i.text === 'Iets heel anders');
    assert.ok(!('orphaned' in other), 'een vers punt is nooit wees');
    assert.notStrictEqual(kept.id, other.id, 'en de twee botsen niet op één id');
});

// ── EEN ANKER DAT NIETS ONDERSCHEIDT IS GEEN ANKER ───────────────────
//
// Het anker is timestamp + assignee. `sanitizeTimestamp` geeft '' terug voor
// elke stempel die niet te parsen is of voorbij het einde van de vergadering
// ligt, en `assignee` valt terug op de CONSTANTE 'Niet toegewezen'/'Unassigned'
// — de prompt vraagt daar zelfs expliciet om. Alle punten zonder bruikbare
// stempel en zonder genoemde eigenaar kregen dan LETTERLIJK dezelfde sleutel,
// viel de hele lijst in één emmer, en matchte de merge op VOLGORDE: precies de
// `ai-<n>`-val die de kop boven `anchorKey` zegt te vermijden.

test('zonder stempel wordt er niet gematcht — het vinkje verhuist niet naar de actie eronder', () => {
    const existing = [
        { id: 'ai-0', source: 'ai', text: 'Contract tekenen', assignee: 'Unassigned', timestamp: '', done: true },
        { id: 'ai-1', source: 'ai', text: 'Offerte sturen', assignee: 'Unassigned', timestamp: '', done: false },
        { id: 'ai-2', source: 'ai', text: 'Notulen delen', assignee: 'Unassigned', timestamp: '', done: false },
    ];
    // De verse pass laat het eerste punt weg — alles schuift op.
    const fresh = [
        { id: 'ai-0', source: 'ai', text: 'Offerte sturen', assignee: 'Unassigned', timestamp: '', done: false },
        { id: 'ai-1', source: 'ai', text: 'Notulen delen', assignee: 'Unassigned', timestamp: '', done: false },
    ];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    const moved = merged.filter((i) => i.done);
    assert.strictEqual(moved.length, 1, 'er is precies één afgevinkt punt, en dat was er ook precies één');
    assert.strictEqual(moved[0].text, 'Contract tekenen', 'het vinkje zit nog op de actie waar iemand hem zette');
    assert.strictEqual(moved[0].orphaned, true, 'bewaard én gemarkeerd — het scherm kan zeggen waarom hij er staat');
    // En de twee verse punten staan er gewoon, zonder vinkje.
    assert.deepStrictEqual(
        merged.filter((i) => !i.orphaned).map((i) => [i.text, i.done]),
        [['Offerte sturen', false], ['Notulen delen', false]],
    );
});

test('zonder stempel matcht ook een LIJST VAN ÉÉN niet — een lege sleutel is geen bewijs', () => {
    // De regel staat los van de emmergrootte. Twee punten die allebei geen
    // anker hebben, hebben niets gemeen behalve dat: dat er toevallig maar één
    // van elk is, maakt van "geen bewijs" geen bewijs. Zonder deze regel
    // verhuist het vinkje naar een actie die niemand afvinkte zodra het model
    // de tekst verandert.
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'ai', text: 'Contract tekenen', assignee: 'Unassigned', timestamp: '', done: true }],
        [{ id: 'ai-0', source: 'ai', text: 'Zaal reserveren', assignee: 'Unassigned', timestamp: '', done: false }],
    );
    assert.strictEqual(merged.length, 2, 'bewaard naast het verse punt, niet erop geplakt');
    const kept = merged.find((i) => i.text === 'Contract tekenen');
    assert.strictEqual(kept.done, true);
    assert.strictEqual(kept.orphaned, true);
    const fresh = merged.find((i) => i.text === 'Zaal reserveren');
    assert.strictEqual(fresh.done, false, 'het verse punt is niet afgevinkt');
});

test('zonder stempel wordt een overgetypte tekst niet op een andere actie geplakt', () => {
    const existing = [
        { id: 'ai-0', source: 'ai', text: 'Jansen BV bellen', aiText: 'Klant bellen', assignee: 'Unassigned', timestamp: '' },
        { id: 'ai-1', source: 'ai', text: 'Offerte sturen', aiText: 'Offerte sturen', assignee: 'Unassigned', timestamp: '' },
    ];
    const fresh = [
        { id: 'ai-0', source: 'ai', text: 'Offerte sturen', assignee: 'Unassigned', timestamp: '' },
        { id: 'ai-1', source: 'ai', text: 'Zaal reserveren', assignee: 'Unassigned', timestamp: '' },
    ];

    const merged = mergeRegeneratedActionItems(existing, fresh);

    const mine = merged.find((i) => i.text === 'Jansen BV bellen');
    assert.ok(mine, 'de correctie bestaat nog');
    assert.strictEqual(mine.aiText, 'Klant bellen', 'en hangt nog aan de AI-tekst waar hij bij hoort');
    assert.strictEqual(mine.orphaned, true);
    assert.ok(!merged.some((i) => i.text === 'Jansen BV bellen' && i.aiText === 'Offerte sturen'),
        'de correctie is NIET op een andere actie geplakt');
});

test('één regelstart in het transcript: dezelfde stempel voor alles matcht ook niet', () => {
    // De degradatie die transcriptArtifacts.js zelf beschrijft — een
    // solo-dictaat, of een run waarin diarisatie naar één label terugvalt.
    // Elke stempel is dan geldig én identiek, dus is de emmer weer de hele
    // lijst. Een emmer met meer dan één kandidaat is geen bewijs.
    const existing = [
        { id: 'ai-0', source: 'ai', text: 'Contract tekenen', assignee: 'Tom', timestamp: '00:00', done: true },
        { id: 'ai-1', source: 'ai', text: 'Offerte sturen', assignee: 'Tom', timestamp: '00:00', done: false },
    ];
    const fresh = [
        { id: 'ai-0', source: 'ai', text: 'Offerte sturen', assignee: 'Tom', timestamp: '00:00', done: false },
        { id: 'ai-1', source: 'ai', text: 'Notulen delen', assignee: 'Tom', timestamp: '00:00', done: false },
    ];

    const merged = mergeRegeneratedActionItems(existing, fresh);
    const checked = merged.filter((i) => i.done);
    assert.strictEqual(checked.length, 1);
    assert.strictEqual(checked[0].text, 'Contract tekenen');
    assert.strictEqual(checked[0].orphaned, true);
});

test('een ondubbelzinnig anker matcht nog gewoon — versmallen is geen "nooit meer matchen"', () => {
    // De keerzijde: zolang de stempel er is en maar één punt hem draagt, is
    // dit precies het geval waar de sleutel voor bestaat.
    const merged = mergeRegeneratedActionItems(
        [
            { id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true },
            { id: 'ai-1', source: 'ai', text: 'Zaal boeken', assignee: 'Tom', timestamp: '', done: false },
        ],
        [
            { id: 'ai-0', source: 'ai', text: 'Klant bellen (herzien)', assignee: 'Tom', timestamp: '12:30', done: false },
        ],
    );
    assert.strictEqual(merged.length, 1, 'geen wees: het ongestempelde punt was niet aangeraakt');
    assert.strictEqual(merged[0].done, true);
    assert.strictEqual(merged[0].text, 'Klant bellen (herzien)');
});

test('een ONaangeraakt punt dat de AI niet meer oplevert verdwijnt gewoon', () => {
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'ai', text: 'Achterhaald', assignee: 'Tom', timestamp: '12:30', done: false }],
        [{ id: 'ai-0', source: 'ai', text: 'Vers', assignee: 'Ewald', timestamp: '30:00', done: false }],
    );
    assert.deepStrictEqual(merged.map((i) => i.text), ['Vers']);
});

test('de weesmarkering verdwijnt zodra de AI het punt weer oplevert', () => {
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true, orphaned: true }],
        [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: false }],
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].done, true);
    assert.ok(!('orphaned' in merged[0]), 'het punt is weer gewoon van deze pass');
});

test('na een hertranscriptie wordt niet gematcht — het anker is weg, dus alles wat een mens aanraakte blijft als wees', () => {
    // /reprocess vervangt het transcript. Het anker waarop we herkennen is
    // dan niet meer van dezelfde vergaderregels afgeleid, dus is er niets te
    // bewijzen. Onbekend versmalt: bewaren en markeren, nooit een vinkje op
    // goed geluk op een ander punt zetten.
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true }],
        [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:31', done: false }],
        { transcriptChanged: true },
    );
    assert.strictEqual(merged.length, 2);
    const kept = merged.find((i) => i.done);
    assert.ok(kept, 'het afgevinkte punt staat er nog');
    assert.strictEqual(kept.orphaned, true);
    assert.ok(!('timestamp' in kept), 'zonder anker in een transcript dat niet meer bestaat');
});

test('aiText overleeft de rondgang door PATCH — anders is het bewijs weg bij het eerste vinkje', () => {
    // De webclient stuurt de HELE lijst terug bij elke toggle. Valt `aiText`
    // uit de allow-list, dan is de correctie na één klik niet meer als
    // correctie herkenbaar.
    const [item] = ok(validateActionItems([
        { id: 'ai-0', source: 'ai', text: 'Jansen BV bellen', aiText: 'Klant bellen', done: true },
    ]));
    assert.strictEqual(item.aiText, 'Klant bellen');
    // Ook als hij gelijk is aan `text`: dat is het ijkpunt voor de VOLGENDE
    // correctie. Wegstrippen zou betekenen dat wie vandaag afvinkt en morgen
    // de tekst verbetert, die verbetering weer onbeschermd maakt.
    const [same] = ok(validateActionItems([{ id: 'ai-0', source: 'ai', text: 'Klant bellen', aiText: 'Klant bellen' }]));
    assert.strictEqual(same.aiText, 'Klant bellen');
});

test('een punt zonder aiText telt niet als gecorrigeerd — anders bevriest elke oude rij', () => {
    // Geen bewijs is geen correctie: de gepinde regel "a legacy AI item is
    // still replaced, not duplicated" hangt hieraan.
    const merged = mergeRegeneratedActionItems(
        [{ id: 'ai-0', source: 'ai', text: 'Oude AI-tekst', assignee: 'Tom', timestamp: '12:30' }],
        [{ id: 'ai-0', source: 'ai', text: 'Nieuwe AI-tekst', assignee: 'Tom', timestamp: '12:30' }],
    );
    assert.deepStrictEqual(merged.map((i) => i.text), ['Nieuwe AI-tekst']);
});
