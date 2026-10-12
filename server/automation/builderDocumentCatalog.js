/**
 * The Documents ONE user may fill, in the shape both AI builders read.
 *
 * Same job as builderDatatableCatalog.js, and the same lesson behind it: a
 * prompt that says "documentId must be a document that exists" while the
 * catalog it renders carries no documents teaches the model to invent ids.
 * The automation builder and the App Studio builder both read this list, so a
 * `fill_document` step is either pointed at a real template or refused.
 *
 * FAILURE IS THE CALLER'S DECISION, exactly as for datatables: this throws on
 * a store failure rather than returning []. The two answers mean different
 * things — [] is "this user has no documents" (the step is refused, and the
 * model tells them to design one in Studio → Documents first), null is "could
 * not tell" (permissive). Swallowing the error here would turn an outage into
 * a refusal.
 *
 * WHY IT IS USER-SCOPED and the datatable list is not: a document belongs to
 * the person who made it (stores/documentStore.js is owner-scoped in SQL),
 * where a datatable belongs to an organisation with per-table grades. A
 * automation runs as its owner, so the owner's documents are exactly the ones it
 * can fill — there is no second scope to walk.
 */

'use strict';

// A picker, not an export. Twenty-five templates is already an unusual number
// of designed documents, and every extra one costs prompt tokens on a surface
// that is read on every builder turn.
const CATALOG_LIMIT = 25;

/**
 * @param {string} userId
 * @returns {Promise<Array<{id, name, docType, description,
 *          placeholders: Array<{key, kind, fields?}>}>>} newest first
 */
async function buildDocumentCatalogForUser(userId) {
    if (!userId) return [];
    const documentStore = require('../stores/documentStore');
    const templates = await documentStore.listTemplates(userId, { limit: CATALOG_LIMIT });
    return templates.map(t => ({
        ...t,
        id: t.id,
        name: t.name,
        docType: t.docType,
        description: t.description,
        placeholders: Array.isArray(t.placeholders) ? t.placeholders : [],
    }));
}

module.exports = { buildDocumentCatalogForUser, CATALOG_LIMIT };
