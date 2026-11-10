/**
 * The schema-3 field types on the App Studio write path (writeRecord, writeRecordBatch, the
 * create_record step), against a REAL in-memory SQLite with the real compiler and RLS gateway.
 * Only the Postgres-backed stores are swapped for stand-ins that run the compiled SQL.
 *
 * What it pins: an autonumber is assigned by the server (a sent value is ignored, an update never
 * writes it), a batch numbers every row, a json value is stored as JSON text, a user field takes the
 * creator through currentUser.id, and a text format refuses a bad value before anything is written.
 *
 * Run: cd server && node --test appStudio/actionExecutor/records.fieldTypesV3.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useSqliteAppStores } = require('../../testUtils/sqliteAppStores.testkit');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const db = useSqliteAppStores(test);

const dataModel = require('../dataModel');
const { executeDataStep } = require('./dispatch');
const { writeRecord, writeRecordBatch } = require('./records');

const TICKETS = {
    id: 'tbl_tickets', key: 'tickets', name: 'Tickets',
    fields: [
        { id: 'fld_no0000', key: 'no', name: 'Number', type: 'autonumber', unique: true },
        { id: 'fld_title0', key: 'title', name: 'Title', type: 'text' },
        { id: 'fld_mail00', key: 'mail', name: 'E-mail', type: 'text', format: 'email' },
        { id: 'fld_meta00', key: 'meta', name: 'Meta', type: 'json' },
        { id: 'fld_owner0', key: 'owner', name: 'Owner', type: 'user', dynamicDefault: 'currentUser.id' },
    ],
    access: { default: 'app', roles: {}, rowFilters: {} },
};
const MODEL = { modelVersion: 1, roles: [], tables: [TICKETS] };
db.exec(dataModel.ddlForTable(TICKETS, { tableKeyById: new Map(), dialect: 'sqlite' }));
const viewer = { id: OWNER, role: 'owner' };
const rows = () => db.prepare('SELECT no, title, mail, meta, owner FROM tickets ORDER BY no').all();

test('the model is valid and every create gets the next number, whatever was sent', async () => {
    assert.deepEqual(dataModel.validateDataModel(MODEL).errors, []);
    await writeRecord(app, MODEL, TICKETS, { title: 'a', no: 500, meta: { tags: ['x'] } }, { viewer });
    await writeRecordBatch(app, MODEL, TICKETS, [{ title: 'b' }, { title: 'c', meta: '[1]' }], { viewer });
    const res = await executeDataStep(app, MODEL, { kind: 'create_record', tableId: 'tbl_tickets', values: { title: { kind: 'static', value: 'd' } } },
        { viewerId: OWNER, viewer: { id: OWNER }, role: 'owner', vars: {} });
    assert.equal(res.ok, true);
    assert.deepEqual(rows(), [
        { no: 1, title: 'a', mail: null, meta: '{"tags":["x"]}', owner: OWNER },
        { no: 2, title: 'b', mail: null, meta: null, owner: OWNER },
        { no: 3, title: 'c', mail: null, meta: '[1]', owner: OWNER },
        { no: 4, title: 'd', mail: null, meta: null, owner: OWNER },
    ]);
});

test('an update never writes the number; a bad e-mail or JSON text is refused and writes nothing', async () => {
    const { id } = await writeRecord(app, MODEL, TICKETS, { title: 'e' }, { viewer });
    await writeRecord(app, MODEL, TICKETS, { no: 1, title: 'e2' }, { viewer, recordId: id });
    assert.deepEqual(db.prepare('SELECT no, title FROM tickets WHERE id = ?').get(id), { no: 5, title: 'e2' });

    const before = rows().length;
    await assert.rejects(writeRecord(app, MODEL, TICKETS, { title: 'f', mail: 'not-an-address' }, { viewer }),
        (e) => e.code === 'field_invalid' && e.fieldErrors.mail === '"E-mail" must be an e-mail address.');
    await assert.rejects(writeRecord(app, MODEL, TICKETS, { meta: '{bad' }, { viewer, recordId: id }), /must be valid JSON/);
    assert.equal(rows().length, before);
    await writeRecord(app, MODEL, TICKETS, { mail: 'help@example.org' }, { viewer, recordId: id });
    assert.equal(db.prepare('SELECT mail FROM tickets WHERE id = ?').get(id).mail, 'help@example.org');
});
