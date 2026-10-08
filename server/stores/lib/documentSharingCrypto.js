'use strict';

const content = require('./documentCrypto');

async function resealRows(client, table, parentColumn, parentId, type, fields, resource, context, files) {
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE ${parentColumn} = $1 FOR UPDATE`, [parentId]);
    for (const stored of rows) {
        const row = await content.openRow(stored);
        const sealed = await content.sealFields(row, { ...resource, type, id: row.id }, fields, context);
        const columns = Object.keys(fields);
        await client.query(`UPDATE ${table} SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')} WHERE id = $1`,
            [row.id, ...columns.map((column) => fields[column] ? JSON.stringify(sealed[column]) : sealed[column])]);
        if (type === 'notebook-source') await require('./notebookFileCrypto').transition(client, row, resource, context, files);
    }
}

// Called while the owner's resource is locked, before access is published.
async function transition(client, type, storedRow, audience, files = { created: [], replaced: [] }) {
    const row = await content.openRow(storedRow);
    const resource = content.resourceOf(row, type);
    const shared = audience !== 'private' || !!row.project_id;
    let context = await content.writeContext(resource, shared);
    if (!context) return;
    context = { ...context, scope: shared ? 'organisation' : 'user' };
    const fields = type === 'document' ? content.DOCUMENT_FIELDS : content.NOTEBOOK_FIELDS;
    const sealed = await content.sealFields(row, resource, fields, context);
    const columns = Object.keys(fields);
    await client.query(`UPDATE ${type === 'document' ? 'studio_documents' : 'notebooks'} SET
        ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [row.id, ...columns.map((column) => fields[column] ? JSON.stringify(sealed[column]) : sealed[column])]);
    if (type === 'document') {
        await resealRows(client, 'studio_document_versions', 'document_id', row.id, 'document-version',
            { body_html: false, css: false, snapshot: true }, resource, context);
        if (row.doc_type === 'spreadsheet') await require('./sheetCrypto').transition(client, row, resource, context);
    } else {
        await resealRows(client, 'notebook_versions', 'notebook_id', row.id, 'notebook-version',
            { content: false, content_md: false }, resource, context);
        await resealRows(client, 'notebook_sources', 'notebook_id', row.id, 'notebook-source',
            { content_text: false, metadata: true }, resource, context, files);
    }
}

module.exports = { transition };
