'use strict';

/**
 * The WINDOW of a regeneration, against a REAL Postgres (@electric-sql/pglite,
 * in-process).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────
 * "Regenerate" reads the note, then talks for minutes with a model (four LLM calls,
 * three of them cut off at 540 s) and only then writes. Everything a person records
 * in that window — a decision they pick from a line in the transcript tab, an action
 * they check off — was not in the snapshot the merge runs against, and was
 * overwritten when the update landed. Without notice, without undo: the screen then
 * neatly showed the new reality in which that line had just disappeared.
 *
 * The merge cannot see that: it compares only `source` and looks at rows that were
 * read minutes ago. So the answer has to come from the DATABASE at the moment of
 * writing — and that is precisely why this suite runs a real Postgres instead of a
 * simulated `run()`. A fake db proves that the route passes the right intention on;
 * only a real database proves that the SQL also carries that intention out.
 *
 * ── ONE CLOCK ────────────────────────────────────────────────────────
 * The starting point (`readAt`) and the `createdAt` of each artifact row both come
 * from `NOW()` of this one Postgres. Node's clock does not come into it: two clocks
 * that differ by milliseconds would decide the wrong way exactly at the edges of
 * this window.
 *
 * Run: cd server && node --test stores/transcriptionStore.artifactWindow.pg.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');

// De echte db.js, met zijn pool beantwoord door één pglite-verbinding.
const { usePglitePool } = require('../testUtils/pglitePool');
const { query } = usePglitePool();

const store = require('./transcriptionStore');
const { mergeRegeneratedActionItems, mergeRegeneratedNotes } = require('../core/meetingNotes/actionItems');

const OWNER = 'owner-1';

before(async () => {
    // One real schema init: the same DDL that production runs, so that a column
    // missing here also fails here.
    await store.getTranscriptions(OWNER, { limit: 1 });
});

/** De drie artefactkolommen zoals ze ECHT in de tabel staan. */
async function readColumns(id) {
    const { rows } = await query(
        'SELECT action_items, decisions, questions FROM transcriptions WHERE id = $1', [id],
    );
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || []));
    return {
        actionItems: parse(rows[0].action_items),
        decisions: parse(rows[0].decisions),
        questions: parse(rows[0].questions),
    };
}

/**
 * Wait until the database clock is past `readAt`.
 *
 * In reality there are minutes between the read of a run and what a person does
 * "during the run". Here there is one `await` in between, and PGlite's clock ticks
 * per millisecond: two statements in a row mostly get the same `NOW()` (measured:
 * 4452 of 5000 consecutive statements). The write action "during the run" then
 * carried the stamp of the read itself, and `>` correctly counts equal as before the
 * run. The test then failed on an order it had not set up itself, most often on a
 * fast, quiet machine (22 of 30 runs).
 *
 * This weakens no assertion: every write action "during the run" below happens after
 * the read, and now that is also true on the database's clock. The next statement
 * starts after this SELECT, so its `NOW()` does not lie before it.
 */
async function untilTheClockPasses(readAt) {
    for (let tries = 0; tries < 1000; tries++) {
        const { rows } = await query('SELECT NOW() > $1::timestamptz AS passed', [readAt]);
        if (rows[0].passed) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`de databaseklok kwam niet voorbij ${readAt}`);
}

/** De run leest zijn invoer; alles wat hierna gebeurt, gebeurt TIJDENS de run. */
async function readForTheRun(id) {
    const snapshot = await store.getTranscription(id, OWNER);
    assert.ok(snapshot.readAt, 'de read geeft het moment mee waarop hij las');
    await untilTheClockPasses(snapshot.readAt);
    return snapshot;
}

/** A note with exactly what the model found last time. */
async function seedNote() {
    const { id } = await store.createTranscription({
        userId: OWNER,
        title: 'Weekstart',
        fileName: 'weekstart.m4a',
        transcript: 'Hallo.',
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Oud AI-punt' }],
        decisions: [{ id: 'd-0', source: 'ai', text: 'Oud AI-besluit' }],
        questions: [{ id: 'q-0', source: 'ai', text: 'Oude AI-vraag', open: true }],
    });
    return id;
}

/**
 * What a person does during the run: PATCH /:id sends back the WHOLE list —
 * the rows they got when opening the note, plus the new one.
 */
async function personAddsDuringTheRun(id, snapshot) {
    return store.updateTranscription(id, OWNER, {
        decisions: [...snapshot.decisions, { id: 'ud-live', source: 'user', text: 'TIJDENS DE RUN VASTGELEGD' }],
        actionItems: [...snapshot.actionItems, { id: 'ua-live', source: 'user', text: 'Tijdens de run toegevoegd' }],
    });
}

/** Wat de regeneratie schrijft: de merge tegen de MOMENTOPNAME van stap 2. */
function regeneratedFrom(snapshot) {
    return {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        decisions: mergeRegeneratedNotes(snapshot.decisions, [{ id: 'd-0', text: 'Vers AI-besluit' }], { field: 'decisions' }),
        questions: mergeRegeneratedNotes(snapshot.questions, [{ id: 'q-0', text: 'Verse AI-vraag' }], { field: 'questions' }),
    };
}

// ── De bevinding zelf ────────────────────────────────────────────────

test('een artefact dat TUSSEN het lezen en het schrijven ontstaat, overleeft de regeneratie', async () => {
    const id = await seedNote();

    // 1. The run reads its input. THIS is the starting point, and it comes from
    //    the same database as the stamps it is compared against later.
    const snapshot = await readForTheRun(id);
    assert.ok(snapshot.readAt, 'de read geeft het moment mee waarop hij las');

    // 2. While the model is talking: someone picks a decision from a line in the
    //    transcript tab and adds an action.
    await personAddsDuringTheRun(id, snapshot);

    // 3. De regeneratie landt, met het vertrekpunt uit stap 1.
    await store.updateTranscription(id, OWNER, {
        ...regeneratedFrom(snapshot),
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    assert.deepStrictEqual(
        after.decisions.map((d) => d.text),
        ['Vers AI-besluit', 'TIJDENS DE RUN VASTGELEGD'],
        'het besluit van tijdens de run staat er nog, naast het verse AI-besluit',
    );
    assert.deepStrictEqual(
        after.actionItems.map((i) => i.text),
        ['Vers AI-punt', 'Tijdens de run toegevoegd'],
        'en hetzelfde voor de actie',
    );
    // Wat er vóór het vertrekpunt stond is wél vervangen — dat is de hele
    // bedoeling van de knop.
    assert.ok(!after.decisions.some((d) => d.text === 'Oud AI-besluit'));
    assert.ok(!after.actionItems.some((i) => i.text === 'Oud AI-punt'));
});

test('de schrijfactie MELDT wat er landde, zodat de client die rij ook ziet', async () => {
    // Otherwise the row is safe in the database but disappears from the screen until
    // the next fetch round — for the person looking, indistinguishable from a loss.
    // The route responds with THESE lists.
    const id = await seedNote();
    const snapshot = await readForTheRun(id);
    await personAddsDuringTheRun(id, snapshot);

    const written = await store.updateTranscription(id, OWNER, {
        ...regeneratedFrom(snapshot),
        artifactsSince: snapshot.readAt,
    });
    assert.ok(written && written.ok, 'een geslaagde schrijfactie blijft truthy voor `if (!updated) 404`');
    assert.deepStrictEqual(written.decisions.map((d) => d.text),
        ['Vers AI-besluit', 'TIJDENS DE RUN VASTGELEGD']);
    assert.deepStrictEqual(written.decisions, (await readColumns(id)).decisions,
        'en het is letterlijk wat in de kolom staat');
});

test('zonder vertrekpunt wist dezelfde schrijfactie hem — dat is wat er misging', async () => {
    const id = await seedNote();
    const snapshot = await readForTheRun(id);
    await personAddsDuringTheRun(id, snapshot);

    // Exact dezelfde update, alleen zonder `artifactsSince`.
    await store.updateTranscription(id, OWNER, regeneratedFrom(snapshot));

    const after = await readColumns(id);
    assert.ok(
        !after.decisions.some((d) => d.text === 'TIJDENS DE RUN VASTGELEGD'),
        'zonder vertrekpunt is de rij weg — deze assertie pint waarom het vertrekpunt er is',
    );
});

test('een AI-rij die de verse pass NIET opnieuw mint verdwijnt, ook al werd de kolom tijdens de run herschreven', async () => {
    // The trap of a stamp: PATCH rewrites the WHOLE list, so without care every old row
    // would get a fresh `createdAt` there and survive as "new" — exactly the rows that
    // "Regenerate" should replace.
    const id = await seedNote();
    await store.updateTranscription(id, OWNER, {
        actionItems: [{ id: 'ai-9', source: 'ai', text: 'AI-punt dat straks niet terugkomt' }],
    });

    const snapshot = await readForTheRun(id);
    // Tijdens de run vinkt iemand iets aan: de hele lijst gaat opnieuw naar de
    // kolom, mét de oude AI-rij erin.
    await store.updateTranscription(id, OWNER, {
        actionItems: [...snapshot.actionItems, { id: 'ua-live', source: 'user', text: 'Tijdens de run toegevoegd' }],
    });

    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    assert.deepStrictEqual(after.actionItems.map((i) => i.text), ['Vers AI-punt', 'Tijdens de run toegevoegd']);
});

test('de stempel is een AANMAAKmoment: hij blijft staan als de rij wordt herschreven', async () => {
    const id = await seedNote();
    const first = await store.getTranscription(id, OWNER);
    await untilTheClockPasses(first.readAt);
    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'ud-1', source: 'user', text: 'Eerste versie' }],
    });
    const stamped = (await readColumns(id)).decisions[0].createdAt;
    assert.ok(stamped, 'de database zet de stempel, niet de client');
    assert.ok(stamped > first.readAt, 'en hij ligt na het moment waarop er nog niets stond');

    // Een tekstcorrectie later: dezelfde id, dus dezelfde aanmaaktijd.
    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'ud-1', source: 'user', text: 'Gecorrigeerde tekst' }],
    });
    const again = (await readColumns(id)).decisions[0];
    assert.strictEqual(again.text, 'Gecorrigeerde tekst');
    assert.strictEqual(again.createdAt, stamped, 'herschrijven verjongt de rij niet');
});

test('de client kan de stempel niet zetten — de database overschrijft wat er binnenkomt', async () => {
    const id = await seedNote();
    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'ud-1', source: 'user', text: 'Vals', createdAt: '2099-01-01T00:00:00.000Z' }],
    });
    const stored = (await readColumns(id)).decisions[0];
    assert.notStrictEqual(stored.createdAt, '2099-01-01T00:00:00.000Z');
    // Microseconden: de volle klok van Postgres, zie DB_CLOCK_ISO in de store.
    assert.match(stored.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
});

test('een stempel met drie cijfers, van vóór de microseconden, telt nog steeds als vóór de run', async () => {
    // This is how a row sits in the column when it was stamped before the clock went to
    // microseconds. Text against text compares fine with a read of now, as long as the
    // two do not fall in the same millisecond.
    const legacy = '2026-01-05T09:30:00.123Z';
    const { id } = await store.createTranscription({
        userId: OWNER, title: 'Weekstart', fileName: 'w.m4a', transcript: 'Hallo.',
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Oud AI-punt', createdAt: legacy, touchedAt: legacy }],
    });
    const snapshot = await readForTheRun(id);
    await personAddsDuringTheRun(id, snapshot);

    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        artifactsSince: snapshot.readAt,
    });
    assert.deepStrictEqual((await readColumns(id)).actionItems.map((i) => i.text),
        ['Vers AI-punt', 'Tijdens de run toegevoegd']);
});

// ── Rows without a stamp: the normal state, not the exception ──
//
// Everything created via createTranscription (Talk, Meet, auto-import) and every note
// that went through /reprocess (which writes the column raw) carries NO stamp. How
// such a row relates to the window is decided by one rule, and that rule is the most
// dangerous in this file: it stamped unstamped rows with the `updated_at` of the NOTE,
// and that is no proof that the row is old — it is the moment of the previous arbitrary
// write, which may just as well have happened DURING the running run.

test('een ongestempelde AI-rij herrijst NIET doordat er tijdens de run iets anders op de notitie werd geschreven', async () => {
    const { id } = await store.createTranscription({
        userId: OWNER,
        title: 'Weekstart',
        fileName: 'weekstart.m4a',
        transcript: 'Hallo.',
        // As an auto-import writes them away: no stamps.
        actionItems: [
            { id: 'ai-0', source: 'ai', text: 'AI punt 0' },
            { id: 'ai-1', source: 'ai', text: 'AI punt 1' },
            { id: 'ai-2', source: 'ai', text: 'AI punt 2' },
        ],
    });

    // 1. De run leest.
    const snapshot = await readForTheRun(id);

    // 2. During the run the owner renames the note. `updated_at` jumps, and no
    //    artifact column is touched — so no stamp.
    await store.updateTranscription(id, OWNER, { title: 'Weekstart (hernoemd)' });

    // 3. Still during the run he adds an action: the WHOLE list goes back to the column,
    //    with the three unstamped AI rows in it.
    await store.updateTranscription(id, OWNER, {
        actionItems: [...snapshot.actionItems, { id: 'ua-live', source: 'user', text: 'Tijdens de run toegevoegd' }],
    });

    // 4. The regeneration lands: the fresh pass yields only one item.
    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    assert.deepStrictEqual(
        after.actionItems.map((i) => i.text),
        ['Vers AI-punt', 'Tijdens de run toegevoegd'],
        'ai-1 en ai-2 zijn vervangen — een ongestempelde rij telt als oud, wat er verder ook op de notitie gebeurde',
    );
});

// ── CREATED is not the only thing that happens during the run ────────────
//
// The window only rescued rows that were CREATED during the run. An existing AI item
// that someone checks off in that same window keeps its old creation moment AND sits
// in the fresh list, so both conditions failed and the minutes-old snapshot quietly
// turned the check back off.

test('een vinkje dat TIJDENS de run wordt gezet blijft staan', async () => {
    const { id } = await store.createTranscription({
        userId: OWNER, title: 'Weekstart', fileName: 'w.m4a', transcript: 'Hallo.',
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', done: false }],
    });
    const snapshot = await readForTheRun(id);

    // Tijdens de run vinkt de eigenaar het punt af (PATCH stuurt de hele lijst).
    await store.updateTranscription(id, OWNER, {
        actionItems: snapshot.actionItems.map((i) => ({ ...i, done: true })),
    });
    assert.strictEqual((await readColumns(id)).actionItems[0].done, true, 'het vinkje staat in de kolom');

    // De regeneratie landt met de momentopname van vóór het vinkje.
    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    assert.strictEqual(after.actionItems.length, 1, 'geen duplicaat');
    assert.strictEqual(after.actionItems[0].done, true, 'het vinkje is NIET stil teruggedraaid');
});

test('een tekstcorrectie die TIJDENS de run wordt getypt blijft staan', async () => {
    const { id } = await store.createTranscription({
        userId: OWNER, title: 'Weekstart', fileName: 'w.m4a', transcript: 'Hallo.',
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', aiText: 'Klant bellen', done: false }],
    });
    const snapshot = await readForTheRun(id);

    await store.updateTranscription(id, OWNER, {
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Jansen BV bellen', aiText: 'Klant bellen', done: false }],
    });

    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        artifactsSince: snapshot.readAt,
    });

    assert.deepStrictEqual((await readColumns(id)).actionItems.map((i) => i.text), ['Jansen BV bellen']);
});

test('een rij die NIET tijdens de run veranderde wordt gewoon vervangen', async () => {
    // The flip side, so that "the column wins" does not quietly become "Regenerate no
    // longer does anything": a PATCH that sends back the same content is not a change.
    const { id } = await store.createTranscription({
        userId: OWNER, title: 'Weekstart', fileName: 'w.m4a', transcript: 'Hallo.',
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Klant bellen', done: false }],
    });
    const snapshot = await readForTheRun(id);
    // Iemand opent de notitie en slaat hem op zonder iets te wijzigen.
    await store.updateTranscription(id, OWNER, { actionItems: snapshot.actionItems });

    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [{ id: 'ai-0', text: 'Vers AI-punt' }]),
        artifactsSince: snapshot.readAt,
    });
    assert.deepStrictEqual((await readColumns(id)).actionItems.map((i) => i.text), ['Vers AI-punt']);
});

test('het venster is strikt NA het vertrekpunt: een rij die op datzelfde moment is aangeraakt wordt vervangen', async () => {
    // `>` and not `>=`. On the fallback route (noteActions uses `updatedAt` when there is
    // no `readAt`) that is exactly the difference between "replaced" and "stays", and that
    // boundary should stay pinned down.
    const id = await seedNote();
    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'd-9', source: 'ai', text: 'Oud AI-besluit' }],
    });
    const stampedAt = (await readColumns(id)).decisions[0].touchedAt;
    assert.ok(stampedAt, 'de database zet de stempel');

    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'd-0', source: 'ai', text: 'Vers AI-besluit' }],
        artifactsSince: stampedAt,   // exact gelijk aan de stempel van d-9
    });
    assert.deepStrictEqual((await readColumns(id)).decisions.map((d) => d.text), ['Vers AI-besluit']);
});

test('een rij die tijdens de run ontstond en TOCH in de verse lijst zit komt één keer terug', async () => {
    // Zonder de id-dedup zou hij twee keer in de kolom staan: één keer als
    // bewaarde rij, één keer als verse. De kaart zou dan dubbel tellen.
    const id = await seedNote();
    const snapshot = await readForTheRun(id);
    await store.updateTranscription(id, OWNER, {
        decisions: [...snapshot.decisions, { id: 'd-1', source: 'user', text: 'Tijdens de run vastgelegd' }],
    });

    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'd-0', source: 'ai', text: 'Vers AI-besluit' }, { id: 'd-1', source: 'ai', text: 'Vers tweede besluit' }],
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    assert.strictEqual(after.decisions.filter((d) => d.id === 'd-1').length, 1, 'precies één rij met deze id');
    // And it is the row of the PERSON, not the fresh one: they touched it during the run,
    // so the column wins.
    assert.deepStrictEqual(after.decisions.map((d) => d.text), ['Vers AI-besluit', 'Tijdens de run vastgelegd']);
});

test('de twee stempels zijn onafhankelijk: herschrijven verjongt `createdAt` niet maar wel `touchedAt`', async () => {
    const id = await seedNote();
    await store.updateTranscription(id, OWNER, { decisions: [{ id: 'ud-1', source: 'user', text: 'Eerste versie' }] });
    const first = (await readColumns(id)).decisions[0];
    assert.ok(first.createdAt && first.touchedAt);

    await store.updateTranscription(id, OWNER, { decisions: [{ id: 'ud-1', source: 'user', text: 'Gecorrigeerd' }] });
    const second = (await readColumns(id)).decisions[0];
    assert.strictEqual(second.createdAt, first.createdAt, 'aanmaakmoment blijft');
    assert.ok(second.touchedAt >= first.touchedAt, 'aanraakmoment loopt mee');

    // And the client cannot set this stamp either.
    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'ud-1', source: 'user', text: 'Gecorrigeerd', touchedAt: '2099-01-01T00:00:00.000Z' }],
    });
    assert.notStrictEqual((await readColumns(id)).decisions[0].touchedAt, '2099-01-01T00:00:00.000Z');
});

// ── THE TWO RULES TOGETHER, IN ONE WRITE ─────────────────────────────
//
// Fix 2 (the window) and fix 3 (human input) both decide what stays, and they must not
// get in each other's way. They look at different TIME SPANS, and that is exactly what
// makes them compatible:
//
//   input BEFORE the starting point  → in the snapshot → the JS merge
//                                      (mergeRegeneratedActionItems) protects it
//   input AFTER the starting point   → invisible to that merge → the SQL window
//                                      protects it, against the column as of NOW
//
// Where they meet — the same row, touched in both spans — the COLUMN wins, because it
// is by definition fresher than the merge's input.

test('invoer van vóór én van tijdens de run overleven dezelfde schrijfactie', async () => {
    const { id } = await store.createTranscription({
        userId: OWNER, title: 'Weekstart', fileName: 'w.m4a', transcript: 'Hallo.',
        actionItems: [
            // Vóór de run afgevinkt: dit ziet de merge.
            { id: 'ai-0', source: 'ai', text: 'Klant bellen', assignee: 'Tom', timestamp: '12:30', done: true },
            // Puur modeluitvoer: dit hoort "Opnieuw" te vervangen.
            { id: 'ai-1', source: 'ai', text: 'Notulen delen', assignee: 'Sandra', timestamp: '18:00', done: false },
        ],
    });
    const snapshot = await readForTheRun(id);

    // Tijdens de run: één bestaand punt afgevinkt, één nieuw punt toegevoegd.
    await store.updateTranscription(id, OWNER, {
        actionItems: [
            ...snapshot.actionItems.map((i) => (i.id === 'ai-1' ? { ...i, done: true } : i)),
            { id: 'ua-live', source: 'user', text: 'Tijdens de run toegevoegd' },
        ],
    });

    // The regeneration lands: the fresh pass yields the first item again with new text,
    // and the second one no longer.
    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [
            { id: 'ai-0', text: 'Klant bellen (herzien)', assignee: 'Tom', timestamp: '12:30' },
        ]),
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    const byText = Object.fromEntries(after.actionItems.map((i) => [i.text, i]));

    // FIX 3: the check from before the run is still there, and the AI text has been refreshed.
    assert.ok(byText['Klant bellen (herzien)'], 'de verse tekst landde');
    assert.strictEqual(byText['Klant bellen (herzien)'].done, true, 'het oude vinkje reisde mee');

    // FIX 2, part 1: the check that was set DURING the run on an item that the merge
    // threw away keeps that item in the column.
    assert.ok(byText['Notulen delen'], 'tijdens de run afgevinkt, dus niet vervangen');
    assert.strictEqual(byText['Notulen delen'].done, true);

    // FIX 2, part 2: the item that came into existence during the run is still there too.
    assert.ok(byText['Tijdens de run toegevoegd']);

    assert.strictEqual(after.actionItems.length, 3, 'geen duplicaten uit de twee regels samen');
});
