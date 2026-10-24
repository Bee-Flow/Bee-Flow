/**
 * webpage_versions: the NUMBER, the MAKER and the LINE DIFFERENCE (W4).
 *
 * ── WHAT IS AT STAKE HERE ───────────────────────────────────────────────────
 *
 * "v14" has to mean something. Two things can make that break:
 *
 *   1. TWO WRITERS, ONE NUMBER. The number is computed in the INSERT
 *      (`COALESCE(MAX(seq),0)+1`). Under READ COMMITTED — the setting of this pool —
 *      two concurrent saves see the same maximum. The unique index (webpage_id, seq)
 *      from schema.js turns the second into a 23505; this store then has to TRY AGAIN
 *      rather than let the error through or, worse, write the duplicate.
 *   2. A NUMBER THAT MEASURES NOTHING. `line_delta` and `seq` are NULL on every row from
 *      before their column. Whoever flattens those with `|| 0` makes the list say "v0" and
 *      "0 lines changed" about rows where nothing is known.
 *
 * ── WHAT THIS TEST CAN AND CANNOT PROVE ─────────────────────────────────────
 *
 * CAN: that the store computes the number in one statement, that it retries on 23505 with a
 * FRESH maximum, that after a series of collisions it fails loudly, and that maker and line
 * difference are recorded and read back exactly as described above.
 *
 * CANNOT: that Postgres actually enforces the index. No database runs here — `../../db` is
 * replaced. That the index exists is stated in schema.js and is checked below as SOURCE TEXT;
 * that it does its job is Postgres' responsibility and not something a unit test can show.
 *
 * Run: node --test --test-force-exit stores/webpage/versions.seq.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const calls = { run: [], getOne: [], getAll: [] };

// Rijen die de gemockte getOne kan oplossen (patroon van
// webpageStore.publishLifecycle.test.js).
const versionRows = [
    {
        id: 'v-old', webpage_id: 'wp1', summary: 'Edited in code', source: 'manual',
        html_sha256: 'h', css_sha256: 'c', js_sha256: 'j', content_length: 10,
        seq: 7, actor_user_id: 'alice', line_delta: -3,
    },
    {
        // A row from before W4: no number, no maker, no line difference.
        id: 'v-legacy', webpage_id: 'wp1', summary: 'Auto-save', source: 'manual',
        html_sha256: '', css_sha256: '', js_sha256: '', content_length: 0,
        seq: null, actor_user_id: null, line_delta: null,
    },
];

function matchRow(rows, sql, params) {
    const conds = [...sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)].map(m => [m[1], params[Number(m[2]) - 1]]);
    return rows.find(r => conds.every(([col, val]) => r[col] === val)) || null;
}

// Wat de INSERT teruggeeft, per test in te stellen. `null` = normaal gedrag
// (een oplopend nummer); een functie mag gooien om een botsing na te bootsen.
let insertBehaviour = null;
let nextSeq = 1;
/** Wat de LIJST-query teruggeeft; per test in te stellen. */
let listRows = [];

const mockDb = {
    run: async (sql, params = []) => { calls.run.push({ sql, params }); return { rowCount: 1 }; },
    getOne: async (sql, params = []) => {
        calls.getOne.push({ sql, params });
        if (/^\s*INSERT INTO webpage_versions/i.test(sql)) {
            if (insertBehaviour) return insertBehaviour(calls.getOne.filter(c => /^\s*INSERT/i.test(c.sql)).length);
            return { seq: nextSeq++ };
        }
        if (/FROM webpage_versions/i.test(sql)) return matchRow(versionRows, sql, params);
        if (/FROM webpages/i.test(sql)) return { id: 'wp1', user_id: 'alice', html_sha256: '', css_sha256: '', js_sha256: '', html_size: 0, css_size: 0, js_size: 0 };
        return null;
    },
    getAll: async (sql, params = []) => {
        calls.getAll.push({ sql, params });
        return listRows;
    },
    exec: async () => undefined,
};
const mockStorage = {
    deleteFile: async () => undefined,
    isAvailable: () => false,
    copyObject: async () => undefined,
    streamFile: async () => { throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); },
    buildWebpageKey: (userId, webpageId, slot, versionId) =>
        `webpages/${userId}/${webpageId}/${versionId || 'current'}/${slot}`,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db' || request === '../../db') return 'mock-db';
    if (request === './storageStore' || request === '../storageStore') return 'mock-storage';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-storage'] = { id: 'mock-storage', exports: mockStorage };

const versions = require('./versions');

function reset() {
    calls.run = []; calls.getOne = []; calls.getAll = [];
    insertBehaviour = null; nextSeq = 1; listRows = [];
}
const insertCalls = () => calls.getOne.filter(c => /^\s*INSERT INTO webpage_versions/i.test(c.sql));

const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

// ── 1. Het nummer ─────────────────────────────────────────────────────

test('het nummer wordt IN de INSERT berekend, niet eerst gelezen', () => {
    reset();
    return versions.createVersion('alice', 'wp1', 'x').then(() => {
        const ins = insertCalls();
        assert.strictEqual(ins.length, 1);
        assert.match(ins[0].sql, /COALESCE\(MAX\(seq\), 0\) \+ 1/,
            'lezen-dan-schrijven laat een heel rondje open waarin een ander hetzelfde nummer pakt');
        assert.match(ins[0].sql, /FROM webpage_versions WHERE webpage_id = \$2/,
            'het maximum is per PAGINA — een globaal nummer zou v1 van een verse pagina v4013 maken');
        assert.match(ins[0].sql, /RETURNING seq/, 'de aanroeper moet het toegekende nummer terugkrijgen');
    });
});

test('createVersion geeft het toegekende nummer terug', async () => {
    reset();
    nextSeq = 14;
    const v = await versions.createVersion('alice', 'wp1', 'x');
    assert.strictEqual(v.seq, 14);
});

test('BIJT: een botsing op het nummer wordt OPNIEUW geprobeerd, niet doorgegeven', async () => {
    reset();
    // Eerste poging botst (de andere schrijver was net iets eerder), tweede
    // poging leest een vers maximum en slaagt.
    insertBehaviour = (n) => {
        if (n === 1) throw uniqueViolation();
        return { seq: 15 };
    };
    const v = await versions.createVersion('alice', 'wp1', 'x');
    assert.strictEqual(v.seq, 15);
    assert.strictEqual(insertCalls().length, 2, 'precies één herkansing was nodig');
});

test('een botsing die blijft botsen faalt LUID in plaats van een rij zonder nummer te schrijven', async () => {
    reset();
    insertBehaviour = () => { throw uniqueViolation(); };
    await assert.rejects(
        () => versions.createVersion('alice', 'wp1', 'x'),
        /duplicate key/,
        'een stille rij zonder nummer zou in de lijst verschijnen zonder dat iets zei dat er iets misging');
    assert.strictEqual(insertCalls().length, 5, 'vijf pogingen, daarna stoppen — niet eindeloos hameren');
});

test('een ANDERE databasefout wordt niet als botsing behandeld', async () => {
    reset();
    let n = 0;
    insertBehaviour = () => { n++; throw Object.assign(new Error('connection terminated'), { code: '08006' }); };
    await assert.rejects(() => versions.createVersion('alice', 'wp1', 'x'), /connection terminated/);
    assert.strictEqual(n, 1, 'opnieuw proberen op een dode verbinding is alleen maar langer wachten');
});

test('de unieke index staat in het schema — zonder hem is de herkansing zinloos', () => {
    // Genuinely textual, as the file header already says: no Postgres runs here, so that the
    // index EXISTS is the only thing a unit test can show — that it does its job is Postgres'
    // responsibility. The entire race strategy leans on 23505. Without this index the second
    // writer simply writes a duplicate and nothing ever collides.
    const src = fs.readFileSync(path.join(__dirname, 'schema.js'), 'utf8');
    assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS idx_webpage_versions_seq[\s\S]{0,120}webpage_versions\(webpage_id, seq\)/,
        'stores/webpage/schema.js moet (webpage_id, seq) uniek maken');
    assert.match(src, /idx_webpage_versions_seq[\s\S]{0,160}WHERE seq IS NOT NULL/,
        'partieel, anders zouden twee rijen zonder nummer elkaar in de weg zitten');
});

// ── 2. De maker ───────────────────────────────────────────────────────

const SOURCE_PARAM = 7;
const ACTOR_PARAM = 8;
const DELTA_PARAM = 9;

test('de maker is standaard de schrijvende gebruiker', async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x');
    assert.strictEqual(insertCalls()[0].params[ACTOR_PARAM], 'alice');
});

test('BIJT: een expliciete null-maker blijft null — "niets gezegd" is niet "niemand"', async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x', null, 'manual', { actorUserId: null });
    assert.strictEqual(insertCalls()[0].params[ACTOR_PARAM], null,
        'een aanroeper die weet dat hij het niet weet, moet dat kunnen vastleggen');
});

test('een andere maker dan de eigenaar wordt vastgelegd zoals gegeven', async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x', null, 'ai', { actorUserId: 'bob' });
    assert.strictEqual(insertCalls()[0].params[ACTOR_PARAM], 'bob');
    assert.strictEqual(insertCalls()[0].params[SOURCE_PARAM], 'ai');
});

// ── 3. Het regelverschil ──────────────────────────────────────────────

test('het regelverschil gaat mee zoals gegeven, ook negatief', async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x', null, 'manual', { lineDelta: -12 });
    assert.strictEqual(insertCalls()[0].params[DELTA_PARAM], -12);
});

test('BIJT: geen regelverschil is NULL, geen 0', async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x');
    assert.strictEqual(insertCalls()[0].params[DELTA_PARAM], null,
        '0 zou in de lijst lezen als "er veranderde niets", en dat is een bewering');
});

test('een regelverschil dat geen getal is telt als niet gemeten', async () => {
    reset();
    for (const bad of [NaN, Infinity, '12', null]) {
        calls.getOne = [];
        await versions.createVersion('alice', 'wp1', 'x', null, 'manual', { lineDelta: bad });
        assert.strictEqual(insertCalls()[0].params[DELTA_PARAM], null, `${String(bad)} is geen meting`);
    }
});

// ── 4. Het vocabulaire ────────────────────────────────────────────────

test("'restore' hoort bij het bestaande vocabulaire, als vierde waarde", () => {
    assert.deepStrictEqual(versions.VERSION_SOURCES, ['manual', 'ai', 'published', 'restore'],
        'W4 voegt één waarde toe; een tweede vocabulaire naast source zou de lijst laten liegen');
});

test("'restore' wordt echt opgeslagen en niet naar 'manual' teruggezet", async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x', null, 'restore');
    assert.strictEqual(insertCalls()[0].params[SOURCE_PARAM], 'restore');
});

test('een terugzet-momentopname is NIET prune-vast — alleen een publicatie is dat', async () => {
    reset();
    await versions.createVersion('alice', 'wp1', 'x', null, 'restore');
    const prune = calls.getAll.find(c => /SELECT id FROM webpage_versions/i.test(c.sql));
    assert.match(prune.sql, /source <> 'published'/);
    assert.ok(!/source <> 'restore'/.test(prune.sql),
        "een terugzetpunt is een gewoon punt in de tijd; alleen een bevroren publicatie mag de cap negeren");
});

// ── 5. Teruglezen ─────────────────────────────────────────────────────

test('getVersionMeta leest nummer, maker en regelverschil terug', async () => {
    reset();
    const meta = await versions.getVersionMeta('v-old');
    assert.strictEqual(meta.seq, 7);
    assert.strictEqual(meta.actorUserId, 'alice');
    assert.strictEqual(meta.lineDelta, -3);
});

test('BIJT: een rij van vóór W4 komt terug met null, niet met 0', async () => {
    reset();
    const meta = await versions.getVersionMeta('v-legacy');
    assert.strictEqual(meta.seq, null, 'v0 bestaat niet');
    assert.strictEqual(meta.actorUserId, null);
    assert.strictEqual(meta.lineDelta, null);
});

test('de lijst vraagt de drie kolommen op en ordent op nummer binnen dezelfde tijd', async () => {
    reset();
    await versions.getVersions('wp1');
    const q = calls.getAll.find(c => /SELECT id, webpage_id, summary/i.test(c.sql));
    assert.match(q.sql, /seq, actor_user_id, line_delta/);
    assert.match(q.sql, /ORDER BY created_at DESC, seq DESC NULLS LAST, id/,
        'created_at is transactietijd; zonder seq als tweede sleutel kon v15 onder v14 landen');
});

test('de LIJST draagt nummer, maker en regelverschil — niet alleen de query ernaar', async () => {
    // The test above reads only the SQL TEXT. That is exactly what went wrong: you could delete
    // `...mapVersionFacts(r)` from `getVersions` and everything stayed green — while the whole
    // History tab then fell over (no v-number, every maker "Unknown", no line difference). The
    // route tests do not see it, because they stub `getVersions` and supply the rows already
    // mapped.
    reset();
    listRows = [
        {
            id: 'v14', webpage_id: 'wp1', summary: 'Edited in code', content_length: 2048,
            created_at: '2026-09-01T10:00:00.000Z', source: 'manual',
            seq: 14, actor_user_id: 'alice', line_delta: -7,
        },
        {
            id: 'v-legacy', webpage_id: 'wp1', summary: 'Published', content_length: 10,
            created_at: '2026-08-01T10:00:00.000Z', source: 'published',
            seq: null, actor_user_id: null, line_delta: null,
        },
    ];
    const out = await versions.getVersions('wp1');
    assert.deepStrictEqual(out.map(v => v.seq), [14, null]);
    assert.deepStrictEqual(out.map(v => v.actorUserId), ['alice', null]);
    assert.deepStrictEqual(out.map(v => v.lineDelta), [-7, null],
        'een negatief verschil is een echt getal en mag niet als afwezig lezen; NULL blijft null, nooit 0');
    assert.deepStrictEqual(out.map(v => v.source), ['manual', 'published']);
});

test('shouldAutoVersion klokt per BRON, zodat de AI-arm de handmatige klok niet stilzet', async () => {
    reset();
    await versions.shouldAutoVersion('wp1', 'manual');
    const q = calls.getOne.find(c => /ORDER BY created_at DESC LIMIT 1/i.test(c.sql));
    assert.match(q.sql, /source = \$2/,
        'zonder bronfilter zet elke AI-beurt de klok van de handmatige autosave stil, en krijgt een bewerking '
        + 'die iemand met de hand maakt geen eigen terugzetpunt meer');
    assert.deepStrictEqual(q.params, ['wp1', 'manual']);

    reset();
    await versions.shouldAutoVersion('wp1');
    const all = calls.getOne.find(c => /ORDER BY created_at DESC LIMIT 1/i.test(c.sql));
    assert.strictEqual(/source = /.test(all.sql), false, 'zonder bron blijft het oude gedrag over');
});
