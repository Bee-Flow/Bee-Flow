'use strict';

/**
 * Het VENSTER van een regeneratie, tegen een ECHTE Postgres
 * (@electric-sql/pglite, in-proces).
 *
 * ── WAAROM DIT BESTAND BESTAAT ──────────────────────────────────────
 * "Opnieuw" leest de notitie, praat daarna minutenlang met een model (vier
 * LLM-aanroepen, drie ervan gekapt op 540 s) en schrijft dán pas. Alles wat
 * een mens in dat venster vastlegt — een besluit dat hij in het
 * transcript-tabblad van een regel plukt, een actie die hij aanvinkt — zat
 * niet in de momentopname waartegen de merge draait, en werd bij de landing
 * van de update overschreven. Zonder melding, zonder undo: het scherm toonde
 * daarna keurig de nieuwe werkelijkheid waarin die regel zojuist verdween.
 *
 * De merge kan dat niet zien: die vergelijkt alleen `source` en kijkt naar
 * rijen die minuten geleden zijn gelezen. Het antwoord moet dus uit de
 * DATABASE komen op het moment van schrijven — en dat is precies waarom deze
 * suite een echte Postgres draait in plaats van een nagespeelde `run()`. Een
 * fake db bewijst dat de route de juiste bedoeling doorgeeft; alleen een
 * echte database bewijst dat het SQL die bedoeling ook uitvoert.
 *
 * ── ÉÉN KLOK ────────────────────────────────────────────────────────
 * Het vertrekpunt (`readAt`) en de `createdAt` van elke artefactregel komen
 * allebei uit `NOW()` van deze ene Postgres. Node's klok komt er niet aan te
 * pas: twee klokken die milliseconden uit elkaar lopen zouden precies aan de
 * randen van dit venster de verkeerde kant op beslissen.
 *
 * Draaien: cd server && node --test stores/transcriptionStore.artifactWindow.pg.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adapt(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
}

async function query(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adapt(await pg.query(sql, params));
    if (/;\s*\S/.test(String(sql).trim())) return adapt(await pg.exec(sql));
    return adapt(await pg.query(sql));
}

// De db-facade die de store ziet. Bewust ZONDER withTransaction, zodat
// stores/lib/_ddl.js zijn sequentiële exec-variant pakt (pglite heeft één
// verbinding en kan geen overlappende BEGIN/SAVEPOINT-reeksen aan).
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        run: query,
        exec: async (sql) => { await query(sql); },
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        isSqlStateError: (err) => typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code),
    },
};

const store = require('./transcriptionStore');
const { mergeRegeneratedActionItems, mergeRegeneratedNotes } = require('../core/meetingNotes/actionItems');

const OWNER = 'owner-1';

before(async () => {
    // Eén echte schema-init: dezelfde DDL die productie draait, zodat een
    // kolom die hier ontbreekt ook hier omvalt.
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
 * Wacht tot de databaseklok ná `readAt` staat.
 *
 * In het echt zitten er minuten tussen de read van een run en wat een mens
 * "tijdens de run" doet. Hier zit er één `await` tussen, en PGlite's klok tikt
 * per milliseconde: twee statements na elkaar krijgen meestal dezelfde
 * `NOW()` (gemeten: 4452 van 5000 opeenvolgende statements). De schrijfactie
 * "tijdens de run" droeg dan de stempel van de read zelf, en `>` telt gelijk
 * terecht als vóór de run. De test faalde daarmee op een volgorde die hij niet
 * zelf had neergezet, op een snelle, stille machine het vaakst (22 van 30
 * runs).
 *
 * Dit verzwakt geen assertie: elke schrijfactie "tijdens de run" hieronder
 * gebeurt ná de read, en nu staat dat ook zo in de klok van de database. Het
 * volgende statement begint na deze SELECT, dus zijn `NOW()` ligt er niet voor.
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

/** Een notitie met precies wat het model de vorige keer vond. */
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
 * Wat een mens tijdens de run doet: PATCH /:id stuurt de HELE lijst terug —
 * de rijen die hij bij het openen van de notitie kreeg, plus de nieuwe.
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

    // 1. De run leest zijn invoer. Dít is het vertrekpunt, en het komt uit
    //    dezelfde database als de stempels waartegen het straks vergelijkt.
    const snapshot = await readForTheRun(id);
    assert.ok(snapshot.readAt, 'de read geeft het moment mee waarop hij las');

    // 2. Terwijl het model praat: iemand plukt in het transcript-tabblad een
    //    besluit van een regel en voegt een actie toe.
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
    // Anders staat de rij veilig in de database maar verdwijnt hij van het
    // scherm tot de volgende ophaalronde — voor de persoon die kijkt niet te
    // onderscheiden van verliezen. De route antwoordt met déze lijsten.
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
    // De valkuil van een stempel: PATCH herschrijft de HELE lijst, dus zonder
    // zorg zou elke oude rij daar een verse `createdAt` van krijgen en als
    // "nieuw" overleven — precies de rijen die "Opnieuw" hoort te vervangen.
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
    // Zo staat een rij in de kolom die gestempeld is vóór de klok naar
    // microseconden ging. Tekst tegen tekst vergelijkt dat goed met een read
    // van nu, zolang de twee niet in dezelfde milliseconde vallen.
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

// ── Rijen zonder stempel: de normale toestand, niet de uitzondering ──
//
// Alles wat via createTranscription is aangemaakt (Talk, Meet, auto-import)
// en elke notitie die door /reprocess is gegaan (die schrijft de kolom rauw)
// draagt GEEN stempel. Hoe zo'n rij zich tot het venster verhoudt wordt door
// één regel beslist, en die regel is de gevaarlijkste van dit bestand: hij
// stempelde ongestempelde rijen met `updated_at` van de NOTITIE, en dat is
// geen bewijs dat de rij oud is — het is het moment van de vorige willekeurige
// schrijfactie, die net zo goed TIJDENS de lopende run kan hebben plaatsgevonden.

test('een ongestempelde AI-rij herrijst NIET doordat er tijdens de run iets anders op de notitie werd geschreven', async () => {
    const { id } = await store.createTranscription({
        userId: OWNER,
        title: 'Weekstart',
        fileName: 'weekstart.m4a',
        transcript: 'Hallo.',
        // Zoals een auto-import ze wegschrijft: geen stempels.
        actionItems: [
            { id: 'ai-0', source: 'ai', text: 'AI punt 0' },
            { id: 'ai-1', source: 'ai', text: 'AI punt 1' },
            { id: 'ai-2', source: 'ai', text: 'AI punt 2' },
        ],
    });

    // 1. De run leest.
    const snapshot = await readForTheRun(id);

    // 2. Tijdens de run hernoemt de eigenaar de notitie. `updated_at` verspringt,
    //    geen artefactkolom wordt geraakt — dus geen stempel.
    await store.updateTranscription(id, OWNER, { title: 'Weekstart (hernoemd)' });

    // 3. Nog steeds tijdens de run voegt hij een actie toe: de HELE lijst gaat
    //    terug naar de kolom, met de drie ongestempelde AI-rijen erin.
    await store.updateTranscription(id, OWNER, {
        actionItems: [...snapshot.actionItems, { id: 'ua-live', source: 'user', text: 'Tijdens de run toegevoegd' }],
    });

    // 4. De regeneratie landt: de verse pass levert nog maar één punt op.
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

// ── ONTSTAAN is niet het enige wat tijdens de run gebeurt ────────────
//
// Het venster redde alleen rijen die tijdens de run ZIJN ONTSTAAN. Een
// bestaand AI-punt dat iemand in datzelfde venster afvinkt houdt zijn oude
// aanmaakmoment én staat gewoon in de verse lijst, dus beide voorwaarden
// faalden en de minuten oude momentopname draaide het vinkje stil terug.

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
    // De keerzijde, zodat "de kolom wint" niet stiekem "Opnieuw doet niets meer"
    // wordt: een PATCH die dezelfde inhoud terugstuurt is geen wijziging.
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
    // `>` en niet `>=`. Op de terugvalroute (noteActions gebruikt `updatedAt`
    // als er geen `readAt` is) is dat precies het verschil tussen "vervangen"
    // en "blijft staan", en die grens hoort vast te liggen.
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
    // En het is de rij van de MENS, niet de verse: hij is tijdens de run
    // aangeraakt, dus de kolom wint.
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

    // En de client kan ook deze stempel niet zetten.
    await store.updateTranscription(id, OWNER, {
        decisions: [{ id: 'ud-1', source: 'user', text: 'Gecorrigeerd', touchedAt: '2099-01-01T00:00:00.000Z' }],
    });
    assert.notStrictEqual((await readColumns(id)).decisions[0].touchedAt, '2099-01-01T00:00:00.000Z');
});

// ── DE TWEE REGELS SAMEN, IN ÉÉN SCHRIJFACTIE ────────────────────────
//
// Fix 2 (het venster) en fix 3 (menselijke invoer) beslissen allebei wat er
// blijft staan, en ze mogen elkaar niet in de weg zitten. Ze kijken naar
// verschillende TIJDVAKKEN, en dat is precies wat ze verenigbaar maakt:
//
//   invoer VÓÓR het vertrekpunt  → staat in de momentopname → de JS-merge
//                                  (mergeRegeneratedActionItems) beschermt hem
//   invoer NÁ het vertrekpunt    → onzichtbaar voor die merge → het SQL-venster
//                                  beschermt hem, tegen de kolom van NU
//
// Waar ze elkaar raken — dezelfde rij, in beide tijdvakken aangeraakt — wint
// de KOLOM, want die is per definitie verser dan de invoer van de merge.

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

    // De regeneratie landt: de verse pass levert het eerste punt weer op met
    // nieuwe tekst, en het tweede niet meer.
    await store.updateTranscription(id, OWNER, {
        actionItems: mergeRegeneratedActionItems(snapshot.actionItems, [
            { id: 'ai-0', text: 'Klant bellen (herzien)', assignee: 'Tom', timestamp: '12:30' },
        ]),
        artifactsSince: snapshot.readAt,
    });

    const after = await readColumns(id);
    const byText = Object.fromEntries(after.actionItems.map((i) => [i.text, i]));

    // FIX 3: het vinkje van vóór de run staat er nog, én de AI-tekst is ververst.
    assert.ok(byText['Klant bellen (herzien)'], 'de verse tekst landde');
    assert.strictEqual(byText['Klant bellen (herzien)'].done, true, 'het oude vinkje reisde mee');

    // FIX 2, deel 1: het vinkje dat TIJDENS de run werd gezet op een punt dat
    // de merge weggooide, houdt dat punt in de kolom.
    assert.ok(byText['Notulen delen'], 'tijdens de run afgevinkt, dus niet vervangen');
    assert.strictEqual(byText['Notulen delen'].done, true);

    // FIX 2, deel 2: het punt dat tijdens de run ontstond staat er ook nog.
    assert.ok(byText['Tijdens de run toegevoegd']);

    assert.strictEqual(after.actionItems.length, 3, 'geen duplicaten uit de twee regels samen');
});
