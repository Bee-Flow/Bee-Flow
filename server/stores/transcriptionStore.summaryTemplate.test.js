/**
 * transcriptionStore — de sjabloonstempel op een notitie.
 *
 * `summary_template_id` + `summary_template_version` zeggen met welk sjabloon
 * en welke versie ervan de samenvatting geschreven is. Wat hier vastligt:
 *
 *   1. de twee kolommen komen uit de runDdl-ladder, zonder NOT NULL en zonder
 *      DEFAULT — NULL is de betekenisvolle waarde "niet bekend";
 *   2. ze zijn te schrijven bij INSERT én bij UPDATE, en expliciet te WISSEN
 *      (een eenmalige prompt mag geen oude stempel laten staan);
 *   3. shapeRow geeft ze terug zonder er een versie bij te verzinnen.
 *
 * Nep-`db` in require.cache; geen Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/transcriptionStore.summaryTemplate.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// `ddl` wordt NOOIT geleegd: de boot-DDL draait bij module-load en zou anders
// door de eerste beforeEach weggegooid kunnen zijn — een test die dan groen is
// omdat hij niets vindt, is geen test.
const state = { calls: [], ddl: [], runResult: { rowCount: 1, rows: [] }, oneRow: null, allRows: [] };

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        exec: async (sql) => { state.calls.push({ fn: 'exec', sql }); state.ddl.push(sql); },
        run: async (sql, params) => { state.calls.push({ fn: 'run', sql, params }); return state.runResult; },
        getOne: async (sql, params) => { state.calls.push({ fn: 'getOne', sql, params }); return state.oneRow; },
        getAll: async (sql, params) => { state.calls.push({ fn: 'getAll', sql, params }); return state.allRows; },
    },
};

const store = require('./transcriptionStore');

beforeEach(() => {
    state.calls = [];
    state.runResult = { rowCount: 1, rows: [] };
    state.oneRow = null;
    state.allRows = [];
});

const lastOfKind = (re) => [...state.calls].reverse().find((c) => re.test(c.sql || ''));
const ddlSql = () => state.ddl.join('\n');

test('beide kolommen staan in de boot-DDL, zonder NOT NULL en zonder DEFAULT', async () => {
    await store.initDB();
    const stamps = state.ddl.filter((sql) => /summary_template_/.test(sql));
    assert.deepStrictEqual(stamps, [
        'ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_template_id TEXT',
        'ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS summary_template_version INTEGER',
    ], 'kaal TEXT en kaal INTEGER — een DEFAULT of NOT NULL zou van elke bestaande notitie een bewering maken');
    assert.match(ddlSql(), /ADD COLUMN IF NOT EXISTS summary_template_id/, 'via de ladder, niet via CREATE TABLE alleen');
});

test('createTranscription schrijft de stempel mee (kolommen, plaatshouders en waarden blijven uitgelijnd)', async () => {
    await store.createTranscription({
        userId: 'u1', title: 'T', fileName: 'a.mp3',
        summaryTemplateId: 'tpl-9', summaryTemplateVersion: 4,
    });
    const insert = lastOfKind(/INSERT INTO transcriptions/);
    const columns = insert.sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
    const placeholders = insert.sql.match(/VALUES \(([^)]+)\)/)[1].split(',').map((p) => p.trim());
    assert.strictEqual(columns.length, placeholders.length);
    assert.strictEqual(columns.length, insert.params.length);
    assert.deepStrictEqual(placeholders, columns.map((_, i) => `$${i + 1}`));

    assert.strictEqual(insert.params[columns.indexOf('summary_template_id')], 'tpl-9');
    assert.strictEqual(insert.params[columns.indexOf('summary_template_version')], 4);
});

test('createTranscription zonder stempel schrijft twee keer null, geen 1 en geen lege string', async () => {
    await store.createTranscription({ userId: 'u1', title: 'T', fileName: 'a.mp3' });
    const insert = lastOfKind(/INSERT INTO transcriptions/);
    const columns = insert.sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
    assert.strictEqual(insert.params[columns.indexOf('summary_template_id')], null);
    assert.strictEqual(insert.params[columns.indexOf('summary_template_version')], null);
});

test('createTranscription weigert een versie die geen geheel getal is', async () => {
    // Anders zou '4' of 2.5 als versienummer op het scherm komen.
    for (const bad of ['4', 2.5, NaN, {}]) {
        await store.createTranscription({ userId: 'u1', title: 'T', summaryTemplateId: 'tpl-9', summaryTemplateVersion: bad });
        const insert = lastOfKind(/INSERT INTO transcriptions/);
        const columns = insert.sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
        assert.strictEqual(insert.params[columns.indexOf('summary_template_version')], null, `version=${String(bad)} → null`);
        assert.strictEqual(insert.params[columns.indexOf('summary_template_id')], 'tpl-9', 'het id blijft wél staan');
    }
});

test('updateTranscription schrijft de stempel', async () => {
    await store.updateTranscription('t-1', 'u1', { summaryTemplateId: 'builtin:standup', summaryTemplateVersion: null });
    const upd = lastOfKind(/UPDATE transcriptions SET/);
    assert.match(upd.sql, /summary_template_id = \$\d+/);
    assert.match(upd.sql, /summary_template_version = \$\d+/);
    assert.ok(upd.params.includes('builtin:standup'));
});

test('updateTranscription WIST de stempel op null — een eenmalige prompt laat geen oude naam staan', async () => {
    // Dit is het verschil tussen "niet meegestuurd" en "expliciet leeg". Zou
    // null als "niets doen" gelezen worden, dan bleef er na een eenmalige
    // prompt een sjabloonnaam staan bij tekst die dat sjabloon nooit maakte.
    await store.updateTranscription('t-1', 'u1', { summaryTemplateId: null, summaryTemplateVersion: null });
    const upd = lastOfKind(/UPDATE transcriptions SET/);
    assert.match(upd.sql, /summary_template_id = \$\d+/, 'de kolom wordt echt geschreven');
    const idIdx = Number(upd.sql.match(/summary_template_id = \$(\d+)/)[1]) - 1;
    assert.strictEqual(upd.params[idIdx], null);
});

test('een update zonder stempelvelden raakt de kolommen niet aan', async () => {
    await store.updateTranscription('t-1', 'u1', { summary: 'alleen de tekst' });
    const upd = lastOfKind(/UPDATE transcriptions SET/);
    assert.ok(!/summary_template_id/.test(upd.sql), 'ongenoemd = ongewijzigd');
    assert.ok(!/summary_template_version/.test(upd.sql));
});

test('getTranscription geeft de stempel terug zoals hij is opgeslagen', async () => {
    state.oneRow = {
        id: 't-1', user_id: 'u1', title: 'T', summary: 'S',
        summary_template_id: 'tpl-9', summary_template_version: 4,
    };
    const note = await store.getTranscription('t-1', 'u1');
    assert.strictEqual(note.summaryTemplateId, 'tpl-9');
    assert.strictEqual(note.summaryTemplateVersion, 4);
});

test('een notitie van vóór deze kolommen levert null op — geen verzonnen v1', async () => {
    state.oneRow = { id: 't-1', user_id: 'u1', title: 'T', summary: 'S' };
    const note = await store.getTranscription('t-1', 'u1');
    assert.strictEqual(note.summaryTemplateId, null);
    assert.strictEqual(note.summaryTemplateVersion, null);
});

test('een onbruikbaar versienummer in de kolom leest als null', async () => {
    for (const raw of [0, -2, 'v4', '', null]) {
        state.oneRow = { id: 't-1', user_id: 'u1', title: 'T', summary_template_id: 'tpl-9', summary_template_version: raw };
        const note = await store.getTranscription('t-1', 'u1');
        assert.strictEqual(note.summaryTemplateVersion, null, `version=${String(raw)} → null`);
        assert.strictEqual(note.summaryTemplateId, 'tpl-9', 'het sjabloon blijft wél bekend');
    }
});
