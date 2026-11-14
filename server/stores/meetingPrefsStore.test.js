/**
 * meetingPrefsStore — the per-meeting recording preference (M5 part A).
 *
 * What is fixed here, in order of how bad it is if it breaks:
 *   1. THE BACKFILL. An exclusion in the OLD shape (the four
 *      configStore arrays) must end up in the new table as `record = false`
 *      — org-wide and per user, Talk and Meet. If that goes wrong,
 *      someone who had turned recording off silently gets it turned back on.
 *   2. THE SCOPE. The row is per user; the read must never pick up someone
 *      else's row, and a read without a scope yields nothing instead of
 *      everything.
 *   3. THE 1-ON-1 DEFAULT. At two participants or fewer, recording defaults to OFF,
 *      and "count unknown" does NOT count as "more than two" — unknown narrows.
 *
 * On a real Postgres: PGlite behind db.js's pool (testUtils/pglitePool.js),
 * with the table, its primary key and its CHECK from the store's own DDL. The
 * OLD exclusion documents come from configStore, whose three methods the
 * backfill calls are replaced on the store object by an in-memory map.
 *
 * Run: cd server && node --test stores/meetingPrefsStore.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../testUtils/pglitePool');
const { pg, close } = usePglitePool();
test.after(close);

/** The rows of meeting_prefs, as the database holds them. */
const table = async () => (await pg.query('SELECT * FROM meeting_prefs ORDER BY provider, id_kind, external_id, user_id, org_id')).rows;
const reset = () => pg.exec('DELETE FROM meeting_prefs');

/** The statements db.js sends while `fn` runs. @param {() => Promise<unknown>} fn */
async function recordStatements(fn) {
    const db = require('../db');
    const saved = db.pool.query;
    /** @type {string[]} */
    const sent = [];
    db.pool.query = /** @type {any} */ ((/** @type {any} */ sql, /** @type {any} */ params) => { sent.push(String(sql)); return saved(sql, params); });
    try { await fn(); } finally { db.pool.query = saved; }
    return sent;
}

// ── fake configStore with the OLD exclusion documents ───────────────────
// Filled before the require: the store runs its backfill in initDB, and initDB
// is triggered when the module loads. So this is literally the boot
// situation of an installation that has exclusions today.
const cfg = new Map();
const cfgReads = [];
cfg.set('user_talk_notes_u1', { autoRecord: true, excludedRoomTokens: ['room-geheim'], excludedEventUids: ['uid-1op1'] });
cfg.set('org_talk_notes_orgA', { autoRecord: true, excludedRoomTokens: ['room-org'] });
cfg.set('user_gmeet_notes_u1', { autoImport: true, excludedEventIds: ['ev-excl'], excludedMeetingCodes: ['zzz-zzzz-zzz'] });
cfg.set('user_talk_notes_u2', { excludedRoomTokens: ['room-van-u2'] });

const configStore = require('./configStore');
const savedConfig = { getConfig: configStore.getConfig, setConfig: configStore.setConfig, listKeysWithPrefix: configStore.listKeysWithPrefix };
Object.assign(configStore, {
    getConfig: async (/** @type {string} */ k) => { cfgReads.push(k); return cfg.has(k) ? cfg.get(k) : null; },
    setConfig: async (/** @type {string} */ k, /** @type {unknown} */ v) => { cfg.set(k, v); },
    listKeysWithPrefix: async (/** @type {string} */ prefix) => Array.from(cfg.keys()).filter(k => k.startsWith(prefix)),
});
test.after(() => { Object.assign(configStore, savedConfig); });

const store = require('./meetingPrefsStore');

// ═══ 1. the backfill ═════════════════════════════════════════════════

test('backfill: een uitsluiting in de OUDE vorm wordt record=false in de nieuwe store', async () => {
    await store.initDB();

    // Talk, per gebruiker: ruimte én occurrence, elk in hun eigen id-ruimte.
    const rows = await table();
    const mine = rows.filter(r => r.user_id === 'u1' && r.provider === 'talk');
    assert.deepEqual(
        mine.map(r => [r.id_kind, r.external_id, r.record]).sort(),
        [['event', 'uid-1op1', false], ['room', 'room-geheim', false]],
        'roomToken → id_kind room, eventUid → id_kind event, allebei record=false',
    );

    // Talk, org-breed: user_id leeg, org_id gevuld.
    const org = rows.find(r => r.org_id === 'orgA');
    assert.equal(org.user_id, '', 'org-brede regel heeft geen user_id');
    assert.equal(org.external_id, 'room-org');
    assert.equal(org.record, false);

    // Meet: eventId → event, meetingCode → code (the series).
    const meet = rows.filter(r => r.provider === 'gmeet');
    assert.deepEqual(
        meet.map(r => [r.id_kind, r.external_id, r.record]).sort(),
        [['code', 'zzz-zzzz-zzz', false], ['event', 'ev-excl', false]],
    );

    // ... and the effect that matters: the reader says "do not record", even though
    // the global switch is on and a room full of people is sitting there.
    const prefs = await store.loadMeetingPrefs({ provider: 'talk', userId: 'u1', orgId: 'orgA' });
    const d = prefs.decide({ ids: store.talkIds({ roomToken: 'room-geheim' }), participantCount: 9, fallback: true });
    assert.equal(d.record, false);
    assert.equal(d.reason, 'opted_out');
});

test('backfill: schrijft ALLEEN uitsluitingen — geen record=true voor de rest', async () => {
    await store.initDB();
    const rows = await table();
    assert.equal(rows.some(r => r.record === true), false,
        'een true-rij zou de globale autoRecord/autoImport-schakelaar bevriezen op zijn stand van nu');
    assert.equal(rows.every(r => r.record === false), true);
});

test('backfill: idempotent en niet destructief — een tweede pas overschrijft een nieuwere keuze niet', async () => {
    await store.initDB();
    // Since then the user deliberately turned recording back ON for that room.
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'room-geheim' }), userId: 'u1', record: true });
    const before = (await table()).length;

    const res = await store.backfillFromExclusions({ force: true });

    assert.equal((await table()).length, before, 'geen dubbele rijen');
    const row = (await table()).find(r => r.user_id === 'u1' && r.external_id === 'room-geheim');
    assert.equal(row.record, true, 'ON CONFLICT DO NOTHING: de nieuwe keuze blijft staan');
    assert.equal(res.inserted, 0);
});

test('backfill: de oude configvelden blijven staan (een rollback mag geen dataverlies zijn)', async () => {
    await store.initDB();
    assert.deepEqual(cfg.get('user_talk_notes_u1').excludedRoomTokens, ['room-geheim']);
    assert.deepEqual(cfg.get('user_gmeet_notes_u1').excludedMeetingCodes, ['zzz-zzzz-zzz']);
});

test('backfill: een tweede boot slaat het scannen over via de marker', async () => {
    await store.initDB();
    assert.ok(cfg.get(store.BACKFILL_KEY)?.completedAt, 'de marker is gezet');
    cfgReads.length = 0;
    const res = await store.backfillFromExclusions();
    assert.equal(res.skipped, true);
    assert.deepEqual(cfgReads, [store.BACKFILL_KEY], 'alleen de marker gelezen, geen prefix-scan');
});

test('backfill: een ONLEESBAAR document faalt luid — het telt niet als leeg', async () => {
    await store.initDB();
    cfg.set('user_talk_notes_kapot', 'niet-eens-een-object');
    await assert.rejects(
        () => store.backfillFromExclusions({ force: true }),
        /onleesbaar telt niet als leeg/,
        'die gebruiker overslaan zou zijn uitsluiting stil laten verdwijnen',
    );
    cfg.delete('user_talk_notes_kapot');
});

// ═══ 2. the scope: never someone else's row ═══════════════════════════

test('lezen is per gebruiker: u1 ziet zijn eigen rijen plus die van zijn org, nooit die van u2', async () => {
    await store.initDB();
    const rows = await store.listPrefs({ provider: 'talk', userId: 'u1', orgId: 'orgA' });
    const ids = rows.map(r => r.externalId).sort();
    assert.deepEqual(ids, ['room-geheim', 'room-org', 'uid-1op1']);
    assert.equal(rows.some(r => r.externalId === 'room-van-u2'), false, 'de rij van u2 hoort hier niet');

    // and the other way round: u2 sees nothing of u1's
    const other = await store.listPrefs({ provider: 'talk', userId: 'u2' });
    assert.deepEqual(other.map(r => r.externalId), ['room-van-u2']);
});

test('twee deelnemers aan dezelfde vergadering mogen verschillend beslissen', async () => {
    await reset();
    await store.setRecord({ provider: 'gmeet', ids: store.gmeetIds({ eventId: 'ev-samen' }), userId: 'u1', record: false });
    await store.setRecord({ provider: 'gmeet', ids: store.gmeetIds({ eventId: 'ev-samen' }), userId: 'u2', record: true });

    const ids = store.gmeetIds({ eventId: 'ev-samen' });
    const a = await store.loadMeetingPrefs({ provider: 'gmeet', userId: 'u1' });
    const b = await store.loadMeetingPrefs({ provider: 'gmeet', userId: 'u2' });
    assert.equal(a.decide({ ids, participantCount: 8, fallback: true }).record, false);
    assert.equal(b.decide({ ids, participantCount: 8, fallback: true }).record, true);
});

test('een lees zonder scope levert NIETS in plaats van alles', async () => {
    await reset();
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r1' }), userId: 'u1', record: false });
    const sent = await recordStatements(async () => {
        assert.deepEqual(await store.listPrefs({ provider: 'talk' }), []);
        assert.deepEqual(await store.listPrefs({ provider: 'talk', userId: '  ' }), []);
        assert.deepEqual(await store.listPrefs({ userId: 'u1' }), [], 'onbekende provider levert ook niets');
    });
    assert.ok(!sent.some(q => /\bmeeting_prefs\b/.test(q)), 'zonder scope wordt de tabel niet eens bevraagd');
});

test('een org-brede uitsluiting versmalt ook de gebruiker die zelf ja zei', async () => {
    await reset();
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r-org' }), orgId: 'orgA', record: false });
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r-org' }), userId: 'u1', record: true });
    const prefs = await store.loadMeetingPrefs({ provider: 'talk', userId: 'u1', orgId: 'orgA' });
    assert.equal(prefs.opinionFor(store.talkIds({ roomToken: 'r-org' })), false,
        'zoals de oude unie van org- en user-arrays: één FALSE wint');
});

// ═══ 3. the one-on-one default ═══════════════════════════════════════

test('zonder mening: ten hoogste twee deelnemers → record FALSE, ook met de globale schakelaar AAN', () => {
    const call = (participantCount) => store.decideRecord({ rows: [], ids: store.talkIds({ roomToken: 'r' }), participantCount, fallback: true });
    assert.deepEqual(call(1), { record: false, reason: 'small_meeting' });
    assert.deepEqual(call(2), { record: false, reason: 'small_meeting' });
    assert.deepEqual(call(3), { record: true, reason: 'auto' }, 'pas boven de twee beslist de globale schakelaar');
});

test('zonder mening: ONBEKEND aantal telt NIET als "meer dan twee" — het versmalt', () => {
    const call = (participantCount) => store.decideRecord({ rows: [], ids: store.talkIds({ roomToken: 'r' }), participantCount, fallback: true });
    for (const onbekend of [null, undefined, NaN, '3', {}, -1]) {
        const d = call(onbekend);
        assert.equal(d.record, false, `onbekend (${String(onbekend)}) mag niet als groot gelden`);
        assert.equal(d.reason, 'unknown_size');
    }
    // ... and without the argument at all.
    assert.equal(store.decideRecord({ rows: [], ids: store.talkIds({ roomToken: 'r' }), fallback: true }).record, false);
});

test('een expliciete keuze wint van de 1-op-1-standaard', () => {
    const ids = store.talkIds({ roomToken: 'r' });
    const rows = [{ provider: 'talk', idKind: 'room', externalId: 'r', record: true, tags: [] }];
    assert.deepEqual(store.decideRecord({ rows, ids, participantCount: 2, fallback: true }), { record: true, reason: 'opted_in' });
    assert.deepEqual(store.decideRecord({ rows, ids, participantCount: null, fallback: false }), { record: true, reason: 'opted_in' });
});

test('de globale schakelaar UIT wint van alles wat geen expliciete keuze is', () => {
    const ids = store.talkIds({ roomToken: 'r' });
    assert.deepEqual(store.decideRecord({ rows: [], ids, participantCount: 9, fallback: false }), { record: false, reason: 'auto_off' });
});

test('participantCountOf: deelnemerslijst + organisator, leeg is ONBEKEND en niet nul', () => {
    // Google Meet-vorm
    assert.equal(store.participantCountOf({
        attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }], organizerEmail: 'a@x.nl',
    }), 2, 'de organisator die ook in de lijst staat telt één keer');
    assert.equal(store.participantCountOf({
        attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }], organizerEmail: 'c@x.nl',
    }), 3);
    // Nextcloud Talk-vorm (ICS ATTENDEE: cn, soms zonder e-mail)
    assert.equal(store.participantCountOf({ attendees: [{ cn: 'Sanne' }, { cn: 'Tom' }], organizer: { cn: 'Ines' } }), 3);
    assert.equal(store.participantCountOf({ attendees: [{}, {}] }), 2, 'naamloze deelnemers tellen wél mee');
    // Onbekend
    assert.equal(store.participantCountOf({ attendees: [] }), null, 'lege lijst = de agenda vertelde niets');
    assert.equal(store.participantCountOf({}), null);
    assert.equal(store.participantCountOf(null), null);
});

// ═══ schrijven ═══════════════════════════════════════════════════════

test('setRecord: upsert op de volledige sleutel, en NULL wist de mening', async () => {
    await reset();
    const ids = store.talkIds({ eventUid: 'uid-9', roomToken: 'room-9' });
    await store.setRecord({ provider: 'talk', ids, userId: 'u1', record: false });
    assert.equal((await table()).length, 2, 'één rij per identiteit');

    await store.setRecord({ provider: 'talk', ids, userId: 'u1', record: true });
    assert.equal((await table()).length, 2, 'geen nieuwe rijen — dezelfde sleutel');
    assert.equal((await table()).every(r => r.record === true), true);

    // The key holds user_id: a second participant does not overwrite the first.
    await store.setRecord({ provider: 'talk', ids, userId: 'u2', record: false });
    const rows = await table();
    assert.equal(rows.length, 4);
    assert.equal(rows.filter(r => r.user_id === 'u1').every(r => r.record === true), true,
        'de sleutel moet user_id bevatten, anders overschrijft de ene deelnemer de ander');

    await store.setRecord({ provider: 'talk', ids, userId: 'u1', record: null });
    assert.equal((await table()).filter(r => r.user_id === 'u1').every(r => r.record === null), true, 'NULL = geen mening, terug naar erven');
});

test('setTags raakt de opnamekeuze niet aan', async () => {
    await reset();
    const ids = store.gmeetIds({ eventId: 'ev-tags' });
    await store.setTags({ provider: 'gmeet', ids, userId: 'u1', tags: ['klant', 'klant', ' offerte '] });
    let [row] = await table();
    assert.equal(row.record, null, 'tags zetten mag nooit stilletjes een opnamekeuze maken');
    assert.deepEqual(row.tags, ['klant', 'offerte'], 'ontdubbeld en getrimd');

    await store.setRecord({ provider: 'gmeet', ids, userId: 'u1', record: false });
    [row] = await table();
    assert.equal(row.record, false);
    assert.deepEqual(row.tags, ['klant', 'offerte'], 'en de tags blijven staan');

    const prefs = await store.loadMeetingPrefs({ provider: 'gmeet', userId: 'u1' });
    assert.deepEqual(prefs.tagsFor(ids), ['klant', 'offerte']);
});

test('een schrijf zonder user én zonder org wordt geweigerd', async () => {
    await assert.rejects(
        () => store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r' }), record: false }),
        /userId of een orgId/,
    );
});

test('de tabel dwingt precies één scope af (CHECK meeting_prefs_one_scope)', async () => {
    await reset();
    // _scopeOf does not allow this; the table must not allow it either, or
    // the same preference could exist as two rows.
    await assert.rejects(async () => {
        const { run } = require('../db');
        await run(
            `INSERT INTO meeting_prefs (provider, id_kind, external_id, user_id, org_id, record, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), $6)`,
            ['talk', 'room', 'r', 'u1', 'orgA', 'test'],
        );
    }, /meeting_prefs_one_scope/);
});

// ═══ schema ══════════════════════════════════════════════════════════

test('DDL: driewaardige record-kolom, tags als JSONB, sleutel inclusief user_id', async () => {
    await store.initDB();
    const { rows } = await pg.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'meeting_prefs' AND column_name IN ('record', 'tags') ORDER BY column_name`);
    assert.deepEqual(rows, [
        { column_name: 'record', data_type: 'boolean', is_nullable: 'YES', column_default: null },
        { column_name: 'tags', data_type: 'jsonb', is_nullable: 'NO', column_default: "'[]'::jsonb" },
    ], 'record moet NULL kunnen zijn: "geen mening" is een derde toestand');
    const { rows: [pk] } = await pg.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'meeting_prefs' AND c.contype = 'p'`);
    assert.equal(pk.def, 'PRIMARY KEY (provider, id_kind, external_id, user_id, org_id)');
});

// ═══ the closing round ═══════════════════════════════════════════════

test('backfill: een LEGE scan zet GEEN marker — niets gezien is niets bewezen', async () => {
    // The race this closes: `migrateConfigJson()` in configStore is
    // fire-and-forget and writes a leftover data/config.json row by row
    // away. If the backfill runs in that window, the prefix scan is empty —
    // and with an unconditional marker every later boot skipped the scan and
    // those exclusions were gone for good.
    await store.initDB();
    const saved = new Map(cfg);
    try {
        cfg.clear();                                   // geen enkel instellingendocument
        const res = await store.backfillFromExclusions({ force: true });
        assert.equal(res.scanned, 0);
        assert.equal(res.marked, false, 'geen marker op een lege scan');
        assert.equal(cfg.has(store.BACKFILL_KEY), false);

        // …and once the documents ARE there, the next attempt picks them up.
        cfg.set('user_talk_notes_u9', { excludedRoomTokens: ['room-laat'] });
        const again = await store.backfillFromExclusions({ force: true });
        assert.equal(again.scanned, 1);
        assert.equal(again.marked, true);
        assert.ok((await table()).some(r => r.user_id === 'u9' && r.external_id === 'room-laat' && r.record === false));
    } finally {
        cfg.clear();
        for (const [k, v] of saved) cfg.set(k, v);
    }
});

test('een uitsluiting op een RUIMTE raakt een agenda-item met dezelfde string niet', async () => {
    // This is why `id_kind` is in the key. Without the kind check in the reader,
    // an exclusion on a room could become one on an occurrence — or worse, one on
    // a string that happens to be equal.
    const rows = [
        { idKind: 'room', externalId: 'zelfde-string', record: false, tags: [] },
        { idKind: 'event', externalId: 'zelfde-string', record: true, tags: [] },
    ];
    assert.equal(store.resolvePrefs(rows, [{ kind: 'room', id: 'zelfde-string' }]).record, false);
    assert.equal(store.resolvePrefs(rows, [{ kind: 'event', id: 'zelfde-string' }]).record, true);
    // And a kind that does not exist touches nothing.
    assert.equal(store.resolvePrefs(rows, [{ kind: 'code', id: 'zelfde-string' }]).record, null);
});

test('tags volgen dezelfde kind-scheiding als record', async () => {
    const rows = [
        { idKind: 'room', externalId: 'x', record: null, tags: ['van-de-ruimte'] },
        { idKind: 'event', externalId: 'x', record: null, tags: ['van-de-afspraak'] },
    ];
    assert.deepEqual(store.resolvePrefs(rows, [{ kind: 'room', id: 'x' }]).tags, ['van-de-ruimte']);
    // Most specific first decides the order of the union.
    assert.deepEqual(
        store.resolvePrefs(rows, [{ kind: 'event', id: 'x' }, { kind: 'room', id: 'x' }]).tags,
        ['van-de-afspraak', 'van-de-ruimte'],
    );
});
