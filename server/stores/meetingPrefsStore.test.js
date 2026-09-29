/**
 * meetingPrefsStore — de per-vergadering opnamevoorkeur (M5 deel A).
 *
 * Wat hier vastligt, in volgorde van hoe erg het is als het breekt:
 *   1. DE BACKFILL. Een uitsluiting in de OUDE vorm (de vier
 *      configStore-arrays) moet in de nieuwe tabel als `record = false`
 *      terechtkomen — org-breed én per gebruiker, Talk én Meet. Gaat dat mis,
 *      dan krijgt iemand die opnemen had uitgezet het stilzwijgend weer aan.
 *   2. DE SCOPE. De rij is per gebruiker; de lees mag nooit de rij van iemand
 *      anders pakken, en een lees zonder scope levert niets in plaats van
 *      alles.
 *   3. DE 1-OP-1-STANDAARD. Bij ten hoogste twee deelnemers staat opnemen
 *      standaard UIT, en "aantal onbekend" telt daarbij NIET als "meer dan
 *      twee" — onbekend versmalt.
 *
 * DB-vrij: ../db en ./configStore worden via require.cache vervangen. De
 * nep-db is geen loze recorder maar een mini-Postgres voor precies deze tabel:
 * hij kent de primaire sleutel, de CHECK op de scope en ON CONFLICT DO
 * NOTHING/DO UPDATE, en hij WEIGERT een WHERE-vorm die hij niet herkent — zo
 * valt een gewijzigde scoping op in plaats van dat hij stil door glipt.
 *
 * Run: cd server && node --test --test-force-exit stores/meetingPrefsStore.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.NODE_ENV = 'test';

// ── nep-Postgres voor meeting_prefs ──────────────────────────────────
const PK = ['provider', 'id_kind', 'external_id', 'user_id', 'org_id'];
const db = {
    ddl: [],        // via exec uitgevoerde DDL (runDdl's stub-pad)
    queries: [],    // { sql, params }
    table: [],      // de rijen
};

function reset() {
    db.queries.length = 0;
    db.table.length = 0;
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const pkOf = (row) => JSON.stringify(PK.map(c => row[c]));

function applyInsert(sql, params) {
    // NOW() draagt zelf haakjes; tokeniseer die weg vóór het splitsen.
    const flat = sql.replace(/NOW\(\)/gi, 'NOW_TS');
    const cols = flat.match(/INSERT INTO meeting_prefs\s*\(([^)]+)\)/)[1].split(',').map(s => s.trim());
    const vals = flat.match(/VALUES\s*\(([^)]+)\)/)[1].split(',').map(s => s.trim());
    const row = { provider: null, id_kind: null, external_id: null, user_id: '', org_id: '', tags: '[]', record: null, updated_at: null, updated_by: null };
    cols.forEach((col, i) => {
        const v = vals[i];
        const ph = v.match(/^\$(\d+)/);
        if (ph) row[col] = params[Number(ph[1]) - 1];
        else if (/^NOW_TS$/i.test(v)) row[col] = new Date().toISOString();
        else if (/^TRUE$/i.test(v)) row[col] = true;
        else if (/^FALSE$/i.test(v)) row[col] = false;
        else row[col] = null;
    });
    // CHECK meeting_prefs_one_scope — precies één scope gevuld.
    const okScope = (row.user_id !== '' && row.org_id === '') || (row.user_id === '' && row.org_id !== '');
    if (!okScope) { const e = new Error('new row violates check constraint "meeting_prefs_one_scope"'); e.code = '23514'; e.severity = 'ERROR'; throw e; }

    const existing = db.table.find(r => pkOf(r) === pkOf(row));
    if (!existing) { db.table.push(row); return { rowCount: 1, rows: [] }; }
    if (/DO NOTHING/i.test(sql)) return { rowCount: 0, rows: [] };
    const setPart = flat.match(/DO UPDATE SET (.+?)(?:RETURNING|$)/i);
    if (!setPart) throw new Error(`onbekende ON CONFLICT-vorm: ${sql}`);
    for (const assign of setPart[1].split(',')) {
        const [lhs, rhs] = assign.split('=').map(s => s.trim());
        if (/^EXCLUDED\./i.test(rhs)) existing[lhs] = row[rhs.split('.')[1]];
        else if (/^NOW_TS$/i.test(rhs)) existing[lhs] = new Date().toISOString();
    }
    return { rowCount: 1, rows: [] };
}

function applySelect(sql, params) {
    // Alleen de twee scope-vormen die de store hoort te schrijven. Alles
    // anders is een gewijzigde scoping en moet opvallen, niet slagen.
    const userClause = sql.match(/user_id = \$(\d+)/);
    const orgClause = sql.match(/\(user_id = '' AND org_id = \$(\d+)\)/);
    if (!userClause && !orgClause) throw new Error(`onverwachte WHERE — scoping veranderd: ${sql}`);
    return db.table.filter((r) => {
        if (r.provider !== params[0]) return false;
        if (userClause && r.user_id === params[Number(userClause[1]) - 1]) return true;
        if (orgClause && r.user_id === '' && r.org_id === params[Number(orgClause[1]) - 1]) return true;
        return false;
    }).map(r => ({ ...r }));
}

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        exec: async (sql) => { db.ddl.push(norm(sql)); },
        run: async (sql, params = []) => {
            const s = norm(sql);
            db.queries.push({ sql: s, params });
            if (/^INSERT INTO meeting_prefs/.test(s)) return applyInsert(s, params);
            return { rowCount: 0, rows: [] };
        },
        getAll: async (sql, params = []) => {
            const s = norm(sql);
            db.queries.push({ sql: s, params });
            if (/FROM meeting_prefs/.test(s)) return applySelect(s, params);
            return [];
        },
        getOne: async () => null,
        makeStoreInit: (tag, fn) => {
            let p = null;
            return () => {
                if (!p) p = Promise.resolve().then(fn).catch((e) => { p = null; throw e; });
                return p;
            };
        },
    },
};

// ── nep-configStore met de OUDE uitsluitdocumenten ───────────────────
// Vóór de require gevuld: de store draait zijn backfill in initDB, en initDB
// wordt bij het laden van de module afgetrapt. Dit is dus letterlijk de
// boot-situatie van een installatie die vandaag uitsluitingen heeft.
const cfg = new Map();
const cfgReads = [];
cfg.set('user_talk_notes_u1', { autoRecord: true, excludedRoomTokens: ['room-geheim'], excludedEventUids: ['uid-1op1'] });
cfg.set('org_talk_notes_orgA', { autoRecord: true, excludedRoomTokens: ['room-org'] });
cfg.set('user_gmeet_notes_u1', { autoImport: true, excludedEventIds: ['ev-excl'], excludedMeetingCodes: ['zzz-zzzz-zzz'] });
cfg.set('user_talk_notes_u2', { excludedRoomTokens: ['room-van-u2'] });

const cfgPath = require.resolve(path.join(__dirname, 'configStore.js'));
require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        getConfig: async (k) => { cfgReads.push(k); return cfg.has(k) ? cfg.get(k) : null; },
        setConfig: async (k, v) => { cfg.set(k, v); },
        listKeysWithPrefix: async (prefix) => Array.from(cfg.keys()).filter(k => k.startsWith(prefix)),
    },
};

const store = require('./meetingPrefsStore');

// ═══ 1. de backfill ══════════════════════════════════════════════════

test('backfill: een uitsluiting in de OUDE vorm wordt record=false in de nieuwe store', async () => {
    await store.initDB();

    // Talk, per gebruiker: ruimte én occurrence, elk in hun eigen id-ruimte.
    const mine = db.table.filter(r => r.user_id === 'u1' && r.provider === 'talk');
    assert.deepEqual(
        mine.map(r => [r.id_kind, r.external_id, r.record]).sort(),
        [['event', 'uid-1op1', false], ['room', 'room-geheim', false]],
        'roomToken → id_kind room, eventUid → id_kind event, allebei record=false',
    );

    // Talk, org-breed: user_id leeg, org_id gevuld.
    const org = db.table.find(r => r.org_id === 'orgA');
    assert.equal(org.user_id, '', 'org-brede regel heeft geen user_id');
    assert.equal(org.external_id, 'room-org');
    assert.equal(org.record, false);

    // Meet: eventId → event, meetingCode → code (de serie).
    const meet = db.table.filter(r => r.provider === 'gmeet');
    assert.deepEqual(
        meet.map(r => [r.id_kind, r.external_id, r.record]).sort(),
        [['code', 'zzz-zzzz-zzz', false], ['event', 'ev-excl', false]],
    );

    // ... en het effect waar het om gaat: de lezer zegt "niet opnemen", ook al
    // staat de globale schakelaar aan en zit er een zaal vol mensen in.
    const prefs = await store.loadMeetingPrefs({ provider: 'talk', userId: 'u1', orgId: 'orgA' });
    const d = prefs.decide({ ids: store.talkIds({ roomToken: 'room-geheim' }), participantCount: 9, fallback: true });
    assert.equal(d.record, false);
    assert.equal(d.reason, 'opted_out');
});

test('backfill: schrijft ALLEEN uitsluitingen — geen record=true voor de rest', async () => {
    await store.initDB();
    assert.equal(db.table.some(r => r.record === true), false,
        'een true-rij zou de globale autoRecord/autoImport-schakelaar bevriezen op zijn stand van nu');
    assert.equal(db.table.every(r => r.record === false), true);
});

test('backfill: idempotent en niet destructief — een tweede pas overschrijft een nieuwere keuze niet', async () => {
    await store.initDB();
    // De gebruiker zet opnemen sindsdien bewust weer AAN voor die ruimte.
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'room-geheim' }), userId: 'u1', record: true });
    const before = db.table.length;

    const res = await store.backfillFromExclusions({ force: true });

    assert.equal(db.table.length, before, 'geen dubbele rijen');
    const row = db.table.find(r => r.user_id === 'u1' && r.external_id === 'room-geheim');
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

// ═══ 2. de scope: nooit de rij van iemand anders ═════════════════════

test('lezen is per gebruiker: u1 ziet zijn eigen rijen plus die van zijn org, nooit die van u2', async () => {
    await store.initDB();
    const rows = await store.listPrefs({ provider: 'talk', userId: 'u1', orgId: 'orgA' });
    const ids = rows.map(r => r.externalId).sort();
    assert.deepEqual(ids, ['room-geheim', 'room-org', 'uid-1op1']);
    assert.equal(rows.some(r => r.externalId === 'room-van-u2'), false, 'de rij van u2 hoort hier niet');

    // en andersom: u2 ziet niets van u1
    const other = await store.listPrefs({ provider: 'talk', userId: 'u2' });
    assert.deepEqual(other.map(r => r.externalId), ['room-van-u2']);
});

test('twee deelnemers aan dezelfde vergadering mogen verschillend beslissen', async () => {
    reset();
    await store.setRecord({ provider: 'gmeet', ids: store.gmeetIds({ eventId: 'ev-samen' }), userId: 'u1', record: false });
    await store.setRecord({ provider: 'gmeet', ids: store.gmeetIds({ eventId: 'ev-samen' }), userId: 'u2', record: true });

    const ids = store.gmeetIds({ eventId: 'ev-samen' });
    const a = await store.loadMeetingPrefs({ provider: 'gmeet', userId: 'u1' });
    const b = await store.loadMeetingPrefs({ provider: 'gmeet', userId: 'u2' });
    assert.equal(a.decide({ ids, participantCount: 8, fallback: true }).record, false);
    assert.equal(b.decide({ ids, participantCount: 8, fallback: true }).record, true);
});

test('een lees zonder scope levert NIETS in plaats van alles', async () => {
    reset();
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r1' }), userId: 'u1', record: false });
    db.queries.length = 0;
    assert.deepEqual(await store.listPrefs({ provider: 'talk' }), []);
    assert.deepEqual(await store.listPrefs({ provider: 'talk', userId: '  ' }), []);
    assert.deepEqual(await store.listPrefs({ userId: 'u1' }), [], 'onbekende provider levert ook niets');
    assert.equal(db.queries.length, 0, 'zonder scope wordt de tabel niet eens bevraagd');
});

test('een org-brede uitsluiting versmalt ook de gebruiker die zelf ja zei', async () => {
    reset();
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r-org' }), orgId: 'orgA', record: false });
    await store.setRecord({ provider: 'talk', ids: store.talkIds({ roomToken: 'r-org' }), userId: 'u1', record: true });
    const prefs = await store.loadMeetingPrefs({ provider: 'talk', userId: 'u1', orgId: 'orgA' });
    assert.equal(prefs.opinionFor(store.talkIds({ roomToken: 'r-org' })), false,
        'zoals de oude unie van org- en user-arrays: één FALSE wint');
});

// ═══ 3. de 1-op-1-standaard ══════════════════════════════════════════

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
    // ... en zonder het argument helemaal.
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
    reset();
    const ids = store.talkIds({ eventUid: 'uid-9', roomToken: 'room-9' });
    await store.setRecord({ provider: 'talk', ids, userId: 'u1', record: false });
    assert.equal(db.table.length, 2, 'één rij per identiteit');

    await store.setRecord({ provider: 'talk', ids, userId: 'u1', record: true });
    assert.equal(db.table.length, 2, 'geen nieuwe rijen — dezelfde sleutel');
    assert.equal(db.table.every(r => r.record === true), true);

    await store.setRecord({ provider: 'talk', ids, userId: 'u1', record: null });
    assert.equal(db.table.every(r => r.record === null), true, 'NULL = geen mening, terug naar erven');

    const ins = db.queries.find(q => /INSERT INTO meeting_prefs/.test(q.sql));
    assert.match(ins.sql, /ON CONFLICT \(provider, id_kind, external_id, user_id, org_id\)/,
        'de sleutel moet user_id bevatten, anders overschrijft de ene deelnemer de ander');
});

test('setTags raakt de opnamekeuze niet aan', async () => {
    reset();
    const ids = store.gmeetIds({ eventId: 'ev-tags' });
    await store.setTags({ provider: 'gmeet', ids, userId: 'u1', tags: ['klant', 'klant', ' offerte '] });
    let row = db.table[0];
    assert.equal(row.record, null, 'tags zetten mag nooit stilletjes een opnamekeuze maken');
    assert.deepEqual(JSON.parse(row.tags), ['klant', 'offerte'], 'ontdubbeld en getrimd');

    await store.setRecord({ provider: 'gmeet', ids, userId: 'u1', record: false });
    row = db.table[0];
    assert.equal(row.record, false);
    assert.deepEqual(JSON.parse(row.tags), ['klant', 'offerte'], 'en de tags blijven staan');

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
    reset();
    // _scopeOf laat dit niet toe; de tabel moet het óók niet toelaten, anders
    // kan dezelfde voorkeur als twee rijen bestaan.
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

test('DDL: driewaardige record-kolom, tags als JSONB, sleutel inclusief user_id', () => {
    const create = db.ddl.find(s => /CREATE TABLE IF NOT EXISTS meeting_prefs/.test(s));
    assert.ok(create, 'de DDL loopt via runDdl in de store zelf, niet via bootMigrations');
    assert.match(create, /record\s+BOOLEAN(?!\s+NOT NULL)/, 'record moet NULL kunnen zijn: "geen mening" is een derde toestand');
    assert.match(create, /tags\s+JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(create, /PRIMARY KEY \(provider, id_kind, external_id, user_id, org_id\)/);
    assert.match(create, /CHECK \(\(user_id <> '' AND org_id = ''\) OR \(user_id = '' AND org_id <> ''\)\)/);
});

// ═══ de sluitronde ═══════════════════════════════════════════════════

test('backfill: een LEGE scan zet GEEN marker — niets gezien is niets bewezen', async () => {
    // De race die dit dicht: `migrateConfigJson()` in configStore is
    // fire-and-forget en schrijft een achtergebleven data/config.json rij voor
    // rij weg. Draait de backfill in dat venster, dan is de prefix-scan leeg —
    // en met een onvoorwaardelijke marker sloeg élke latere boot de scan over
    // en waren die uitsluitingen voorgoed weg.
    await store.initDB();
    const saved = new Map(cfg);
    try {
        cfg.clear();                                   // geen enkel instellingendocument
        const res = await store.backfillFromExclusions({ force: true });
        assert.equal(res.scanned, 0);
        assert.equal(res.marked, false, 'geen marker op een lege scan');
        assert.equal(cfg.has(store.BACKFILL_KEY), false);

        // …en zodra de documenten er WEL zijn, pakt de volgende poging ze op.
        cfg.set('user_talk_notes_u9', { excludedRoomTokens: ['room-laat'] });
        const again = await store.backfillFromExclusions({ force: true });
        assert.equal(again.scanned, 1);
        assert.equal(again.marked, true);
        assert.ok(db.table.some(r => r.user_id === 'u9' && r.external_id === 'room-laat' && r.record === false));
    } finally {
        cfg.clear();
        for (const [k, v] of saved) cfg.set(k, v);
    }
});

test('een uitsluiting op een RUIMTE raakt een agenda-item met dezelfde string niet', async () => {
    // Dit is de reden dat `id_kind` in de sleutel staat. Zonder de
    // kind-controle in de lezer zou een uitsluiting op een ruimte die van een
    // occurrence worden — of erger, die van een toevallig gelijke string.
    const rows = [
        { idKind: 'room', externalId: 'zelfde-string', record: false, tags: [] },
        { idKind: 'event', externalId: 'zelfde-string', record: true, tags: [] },
    ];
    assert.equal(store.resolvePrefs(rows, [{ kind: 'room', id: 'zelfde-string' }]).record, false);
    assert.equal(store.resolvePrefs(rows, [{ kind: 'event', id: 'zelfde-string' }]).record, true);
    // En een soort die er niet is, raakt niets.
    assert.equal(store.resolvePrefs(rows, [{ kind: 'code', id: 'zelfde-string' }]).record, null);
});

test('tags volgen dezelfde kind-scheiding als record', async () => {
    const rows = [
        { idKind: 'room', externalId: 'x', record: null, tags: ['van-de-ruimte'] },
        { idKind: 'event', externalId: 'x', record: null, tags: ['van-de-afspraak'] },
    ];
    assert.deepEqual(store.resolvePrefs(rows, [{ kind: 'room', id: 'x' }]).tags, ['van-de-ruimte']);
    // Meest specifieke eerst bepaalt de volgorde van de unie.
    assert.deepEqual(
        store.resolvePrefs(rows, [{ kind: 'event', id: 'x' }, { kind: 'room', id: 'x' }]).tags,
        ['van-de-afspraak', 'van-de-ruimte'],
    );
});
