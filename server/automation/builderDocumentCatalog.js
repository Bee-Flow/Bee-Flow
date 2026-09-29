/**
 * The Documents ONE user may fill, in the shape both AI builders read.
 *
 * Same job as builderDatatableCatalog.js, and the same lesson behind it: a
 * prompt that says "documentId must be a document that exists" while the
 * catalog it renders carries no documents teaches the model to invent ids.
 * The routine builder and the App Studio builder both read this list, so a
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
 * routine runs as its owner, so the owner's documents are exactly the ones it
 * can fill — there is no second scope to walk.
 *
 * THE LICENCE LINE (enterprise split, 2026-10). Filling a designed document is
 * Studio Documents, the Enterprise capability `studio_documents`. Without it
 * the catalogue is EMPTY, which both builders already read as "a fill_document
 * step cannot be built" (automation/builderTools/stepBuilders/documentSteps.js
 * refuses the step, the prompt tells the model to stop), so the builders do
 * not offer the step to someone whose runs would refuse it
 * (core/automationRunner/execFillDocument.js). The capability is asked of the
 * same user the list is read for, and hasCapability fails closed, so an
 * entitlement outage leaves the catalogue empty rather than offering a step
 * nobody can tell is licensed.
 */

'use strict';

// A picker, not an export. Twenty-five templates is already an unusual number
// of designed documents, and every extra one costs prompt tokens on a surface
// that is read on every builder turn.
const CATALOG_LIMIT = 25;

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {object} [opts.session]        the caller's session, when there is one
 * @param {string} [opts.orgId]          the caller's organisation, when known
 * @param {Function} [opts.hasCapability] injectable entitlements check (tests)
 * @param {object} [opts.documentStore]   injectable store (tests)
 * @returns {Promise<Array<{id, name, docType, description,
 *          placeholders: Array<{key, kind, fields?}>}>>} newest first
 */
async function buildDocumentCatalogForUser(userId, opts = {}) {
    if (!userId) return [];
    const hasCapability = opts.hasCapability || require('../core/entitlements/entitlements').hasCapability;
    const licensed = await hasCapability('studio_documents', {
        userId, orgId: opts.orgId || null, session: opts.session || null,
    });
    if (!licensed) return [];
    const documentStore = opts.documentStore || require('../stores/documentStore');
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
