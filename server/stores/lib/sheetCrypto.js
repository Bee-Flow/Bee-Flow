'use strict';

const db = require('../../db');
const content = require('./documentCrypto');
const { sheetTabsOf } = require('./sheetDocument');
const { HttpError } = require('../../shared/httpErrors');
const COLUMNS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const isSheet = (resolved) => (resolved.table.managedKind || resolved.table.managed_kind) === 'document_sheet';
const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;

async function attach(client, document) {
    for (const tab of sheetTabsOf(document)) {
        await client.query('INSERT INTO studio_sheet_documents(datatable_id, document_id) VALUES ($1,$2) ON CONFLICT (datatable_id) DO NOTHING', [tab.datatableId, document.id]);
    }
}

async function documentFor(tableId) {
    const present = await db.getOne("SELECT to_regclass('public.studio_sheet_documents') AS present");
    if (!present?.present) return null;
    return db.getOne(`SELECT d.* FROM studio_documents d JOIN studio_sheet_documents s ON s.document_id = d.id WHERE s.datatable_id = $1`, [tableId]);
}

function resourceFor(row, tableId) {
    return { ...content.resourceOf(row, 'sheet'), id: tableId,
        cryptoContext: content.envelopeOf(row.settings)?.documentContext || row._contentCryptoContext };
}

async function withWrite(resolved, fn) {
    if (!isSheet(resolved)) return fn();
    const document = await documentFor(resolved.table.id);
    if (!document) return fn();
    return db.withTransaction(async (client) => {
        await client.query('SELECT id FROM studio_documents WHERE id = $1 FOR UPDATE', [document.id]);
        return fn();
    });
}

async function assertQuery(resolved, fields) {
    if (!isSheet(resolved) || !fields.some((field) => COLUMNS.includes(field))) return;
    const document = await documentFor(resolved.table.id);
    if (!document || !(await content.writeContext(resourceFor(document, resolved.table.id)))) return;
    const error = new HttpError(400, 'encrypted_sheet_query', 'Filtering, sorting and aggregating encrypted cells is available in the spreadsheet editor.');
    error.safe = true;
    throw error;
}

async function openRow(tableId, row, keys = new Map()) {
    if (!row) return row;
    const out = { ...row };
    for (const column of COLUMNS) {
        const env = content.envelopeOf(row[column]);
        if (!env) continue;
        const field = env.documentResource?.field;
        if (!field || !field.endsWith(`:${column}`) || (row.row_no != null && field !== `${row.row_no}:${column}`)) {
            throw new HttpError(423, 'document_encryption_invalid', 'The encrypted cell does not belong to this row.');
        }
        const context = env.documentContext;
        const cacheKey = JSON.stringify([context?.scope, context?.tier, context?.orgId, context?.userId]);
        if (!keys.has(cacheKey)) keys.set(cacheKey, content.keyFor(context, 'sheet', tableId));
        out[column] = await content.open(row[column], 'sheet', tableId, field, false, await keys.get(cacheKey));
    }
    return out;
}

async function openRows(tableId, rows) {
    const keys = new Map();
    return Promise.all(rows.map((row) => openRow(tableId, row, keys)));
}

async function sealValues(resolved, values, rowId = null) {
    if (!isSheet(resolved)) return values;
    const document = await documentFor(resolved.table.id);
    const resource = document ? resourceFor(document, resolved.table.id) : {
        type: 'sheet', id: resolved.table.id, userId: resolved.table.ownerUserId,
        organizationId: (await db.getOne('SELECT "organizationId" FROM users WHERE id = $1', [resolved.table.ownerUserId]))?.organizationId || null,
    };
    const context = await content.writeContext(resource);
    if (!context) return values;
    let rowNo = values.row_no;
    if (rowNo == null && rowId) {
        const store = require('../datatableDbStore');
        const result = await store.query(resolved.scopeKey, resolved.scopeKey,
            `SELECT row_no FROM ${quote(resolved.meta.key)} WHERE id = ?`, [rowId]);
        rowNo = result?.rows?.[0]?.row_no;
    }
    if (rowNo == null) throw new Error('An encrypted cell needs its row number.');
    const out = { ...values };
    const key = await content.keyFor(context, resource.type, resource.id);
    for (const column of COLUMNS) if (out[column] != null) out[column] = await content.seal(out[column], resource, `${rowNo}:${column}`, { context, key });
    return out;
}

async function transition(client, document, resource, context) {
    const store = require('../datatableDbStore');
    const schema = store._schemaFor(store.scopeKey({ kind: 'user', id: resource.userId }));
    for (const tab of sheetTabsOf({ settings: document.settings })) {
        const { rows: tables } = await client.query(`SELECT key FROM datatables WHERE id = $1 AND scope_kind = 'user' AND scope_id = $2 AND managed_kind = 'document_sheet'`, [tab.datatableId, resource.userId]);
        if (!tables[0]) throw new Error('The spreadsheet table is unavailable.');
        const table = `${quote(schema)}.${quote(tables[0].key)}`;
        const { rows } = await client.query(`SELECT * FROM ${table} FOR UPDATE`);
        const key = await content.keyFor(context, 'sheet', tab.datatableId);
        const keys = new Map();
        for (const stored of rows) {
            const row = await openRow(tab.datatableId, stored, keys);
            const columns = COLUMNS.filter((column) => row[column] != null);
            if (!columns.length) continue;
            const values = [];
            for (const column of columns) values.push(await content.seal(row[column], { ...resource, type: 'sheet', id: tab.datatableId }, `${row.row_no}:${column}`, { context, key }));
            await client.query(`UPDATE ${table} SET ${columns.map((column, i) => `${quote(column)} = $${i + 2}`).join(', ')} WHERE id = $1`, [row.id, ...values]);
        }
        await attach(client, { ...document, settings: { sheet: { tabs: [tab] } } });
    }
}

module.exports = { attach, transition, isSheet, withWrite, assertQuery, openRow, openRows, sealValues };
