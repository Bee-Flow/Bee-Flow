// @typecheck
/**
 * Document Store — rendered documents (invoices, quotes, letters) as two text
 * slots: the body markup and the stylesheet.
 *
 * WHY NOT RustFS, when webpages uses it. A webpage is a project: three slots,
 * arbitrary extra files, binary assets, a SQLite database, version snapshots of
 * all of it. An invoice is a page of markup and a stylesheet — kilobytes, read
 * on every render, never streamed. Putting those in Postgres removes a network
 * round-trip per read AND removes a hard dependency: webpageStore.writeSlot
 * throws outright when RustFS is unconfigured, which would make documents
 * unavailable on a self-host that never set object storage up. The size caps
 * below are what keeps that honest.
 *
 * WHY THE TABLES ARE `studio_documents` AND NOT `documents`. That name was
 * already taken — stores/knowledgeBases.js owns a `documents` table for
 * knowledge-base source documents (tenant_id, knowledge_base_id, chunk_count).
 * Claiming it here did not collide loudly: `CREATE TABLE IF NOT EXISTS` simply
 * did nothing, and the first `CREATE INDEX ... (user_id)` then failed against
 * somebody else's schema, so every create answered `column "user_id" does not
 * exist`. The prefix matches the route (/api/studio-documents) and the Studio
 * section, which is where the rest of this feature already lives.
 *
 * WHAT A SLOT HOLDS. `bodyHtml` is the document's BODY markup only — no
 * <html>, <head> or <body> wrapper, no <style>. `css` is the stylesheet,
 * including the @page rules that decide paper size and margins. The wrapper is
 * built at render time by services/documentCompose.js, which is what lets the
 * hand-editor round-trip: what contenteditable hands back IS body.innerHTML, so
 * it maps onto the slot with nothing to parse out.
 */

const crypto = require('crypto');
const contentCrypto = require('./lib/documentCrypto');
const { run, getOne, getAll, exec, withTransaction } = contentCrypto.readingDb(require('../db'));
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl, CODES } = require('./lib/_ddl');
const { projectRoleOf, canEditAs } = require('./lib/projectRole');
const versions = require('./documentVersions');
const { isCoEdited } = require('./lib/coEditGuard');
const solutionTemplates = require('./document/solutionTemplates');
const managedParts = require('./lib/managedParts');
const notebookLibrary = require('./notebookLibrary');
const { sharingDdl, sharingSql, visibilitySql } = require('./lib/documentSharing');
const { SHEET_DOC_TYPE, applySheetRules, keepSheetOnUpdate, sheetSettingsForCreate } = require('./lib/sheetDocument');

// A document is a person-sized artefact. 512 KB of markup is already a very
// long invoice; the cap exists so a runaway model or a paste-bomb cannot turn
// a Postgres row into something the PDF renderer will choke on anyway.
const MAX_HTML_BYTES = 512 * 1024;
const MAX_CSS_BYTES = 128 * 1024;

// The kinds the UI knows how to label and the model is told to pick from. An
// unknown value is stored as 'document' rather than rejected — the type is a
// display hint, never a permission. ONE of them changes what the slots hold:
// a 'presentation' keeps a slide OUTLINE (the deck markdown of
// core/documents/deckModel.js) in the body slot and nothing in `css`, and
// renders through core/documents/deckDocument.js instead of the composer.
//
// A 'page' is the other one: a document written in the rich-text editor
// (BeeEditor) instead of designed in the frame, and the kind a project
// creates by default. Its body slot holds the editor's HTML, SANITISED ON
// EVERY WRITE (not only on render as a designed document is): it is edited
// together, live, and what one person stores is what the next one's editor
// loads. Its `css` stays empty; it prints with the house style and the page
// stylesheet of core/documents/pageDocument.js.
// A 'spreadsheet' keeps its cells in a datatable (stores/lib/sheetDocument.js).
const DOC_TYPES = Object.freeze(['invoice', 'quote', 'letter', 'report', 'security', 'document', 'presentation', 'page', 'spreadsheet']);
const DEFAULT_DOC_TYPE = 'document';
const DECK_DOC_TYPE = 'presentation';
const PAGE_DOC_TYPE = 'page';
// The library's 'designed': written in the frame (no deck, page or sheet).
const DESIGNED_FILTER = 'designed';

// A presentation's settings may carry a template deck (two backdrop pictures
// and a logo, as data: URLs — see core/documents/pptxTemplate.js), which a
// letter never needs. The cap is per type so a deck can hold its own template
// without every invoice being allowed to grow to it.
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_DECK_SETTINGS_BYTES = 4 * 1024 * 1024;

function normaliseType(t) {
    return DOC_TYPES.includes(t) ? t : DEFAULT_DOC_TYPE;
}

/**
 * A page body as it may be stored: the composer's sanitiser (no script, no
 * remote fetch, no forms), applied on write. Required on first use so loading
 * the store does not load jsdom.
 *
 * @param {unknown} html
 */
function sanitizePageBody(html) {
    return require('../services/documentCompose').sanitizeDocumentBody(String(html ?? ''));
}

const initDB = makeStoreInit('DocumentStore', async () => {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_documents (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled document',
            doc_type TEXT NOT NULL DEFAULT 'document',
            description TEXT DEFAULT '',
            body_html TEXT NOT NULL DEFAULT '',
            css TEXT NOT NULL DEFAULT '',
            settings JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_documents_user ON studio_documents(user_id);
        CREATE INDEX IF NOT EXISTS idx_studio_documents_updated ON studio_documents(user_id, updated_at DESC);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_document_versions (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
            summary TEXT DEFAULT '',
            body_html TEXT NOT NULL DEFAULT '',
            css TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_document_versions_doc
            ON studio_document_versions(document_id, created_at DESC);
    `);
    await exec(`
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS organization_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'document';
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS folder_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]';
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS version_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS baseline_version_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS snapshot JSONB;
        CREATE TABLE IF NOT EXISTS studio_document_folders (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT REFERENCES studio_document_folders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_studio_documents_library ON studio_documents(organization_id, visibility, kind);
        UPDATE studio_documents d SET organization_id = u."organizationId" FROM users u
            WHERE d.user_id = u.id AND d.organization_id IS NULL;
        UPDATE studio_documents SET version_id = 'baseline-' || id, baseline_version_id = 'baseline-' || id WHERE version_id IS NULL;
        INSERT INTO studio_document_versions(id, document_id, summary, body_html, css, snapshot)
            SELECT version_id, id, 'Initial revision', body_html, css,
                jsonb_build_object('id', id, 'userId', user_id, 'name', name, 'docType', doc_type,
                    'description', description, 'bodyHtml', body_html, 'css', css, 'settings', settings,
                    'kind', kind, 'versionId', version_id, 'organizationId', organization_id)
            FROM studio_documents ON CONFLICT (id) DO NOTHING;
    `);
    await exec(sharingDdl('studio_documents'));
    await exec(`CREATE TABLE IF NOT EXISTS studio_sheet_documents (datatable_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE)`);
    // Project membership (projects/membership.js, kind 'document').
    //
    // A NULL project_id is today's document exactly: its owner's, private. A set
    // one files it into a collaborative project, where every member may read it
    // and editors may change its content (see getDocument / updateDocument).
    // Soft reference, like notebooks.project_id: deleting a project detaches its
    // documents (clearProjectFromDocuments) and never deletes them, and a hard
    // FK would tie this store's boot order to the project store's.
    const ddl = await runDdl('documentStore', [
        `ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_studio_documents_project ON studio_documents(project_id, updated_at DESC)
            WHERE project_id IS NOT NULL`,
        {
            sql: `UPDATE studio_documents SET project_id = NULL
                WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`,
            tolerate: CODES.UNDEFINED_TABLE,
            reden: 'projects table may not exist yet on a cold boot',
        },
        // A template filed into a Solution (D21; functions in document/solutionTemplates.js).
        `ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS solution_project_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_studio_documents_solution ON studio_documents(solution_project_id) WHERE solution_project_id IS NOT NULL`,
        // Version rows describe their making (documentVersions.js), and a
        // document remembers who changed it last.
        ...versions.VERSION_DDL,
    ]);
    // Claim to be initialised only when the column really exists: every read
    // below names it, and a memo resolved over a half-migrated table would
    // fail each of them until a restart.
    if (ddl.failures.length > 0) {
        throw new Error(`${ddl.failures.length} document migration(s) failed; retrying on the next call`);
    }
    // Complete legacy history and freeze branding during migration, before an
    // organization can change it. Later reads must never mutate a pinned version.
    let afterId = '';
    for (;;) {
        const revisions = await getAll(`SELECT v.id, v.body_html, v.css, v.snapshot,
                b.snapshot AS baseline, d.organization_id
            FROM studio_document_versions v
            JOIN studio_documents d ON d.id = v.document_id
            JOIN studio_document_versions b ON b.id = d.baseline_version_id
            WHERE v.id > $1 AND NOT (COALESCE(v.snapshot, '{}'::jsonb) ? '_bfenc') AND (v.snapshot IS NULL OR NOT (COALESCE(v.snapshot->'settings','{}'::jsonb) ? 'resolvedHouseStyleCss'))
            ORDER BY v.id LIMIT 100`, [afterId]);
        if (!revisions.length) break;
        for (const revision of revisions) {
            const snapshot = { ...(revision.snapshot || revision.baseline), bodyHtml: revision.body_html, css: revision.css, versionId: revision.id };
            snapshot.settings = { ...snapshot.settings, resolvedHouseStyleCss: await require('../core/documents/renderFilledDocument').houseStyleCssFor(snapshot, revision.organization_id) };
            await run(`UPDATE studio_document_versions SET snapshot = $2::jsonb WHERE id = $1
                AND (snapshot IS NULL OR NOT (COALESCE(snapshot->'settings','{}'::jsonb) ? 'resolvedHouseStyleCss'))`, [revision.id, JSON.stringify(snapshot)]);
        }
        afterId = revisions.at(-1).id;
    }
    await exec(`UPDATE studio_documents d SET settings = COALESCE(d.settings,'{}'::jsonb)
            || jsonb_build_object('resolvedHouseStyleCss',v.snapshot->'settings'->'resolvedHouseStyleCss')
        FROM studio_document_versions v WHERE v.id = d.version_id
            AND NOT (COALESCE(d.settings,'{}'::jsonb) ? 'resolvedHouseStyleCss')`);
});

// Kick init off at require time — migrateDb.js and boot both depend on it.

const { mapRow, mapListRow, mapProjectCard } = require('./document/rowMappers');

/**
 * Refuse oversized slot content rather than truncating it. A silently cut-off
 * invoice is worse than an error: it looks complete and is missing its total.
 */
/** @param {{ bodyHtml?: string, css?: string }} slots */
function assertWithinCaps({ bodyHtml, css }) {
    if (typeof bodyHtml === 'string' && Buffer.byteLength(bodyHtml, 'utf8') > MAX_HTML_BYTES) {
        throw Object.assign(
            new Error(`The document body is larger than the ${Math.round(MAX_HTML_BYTES / 1024)} KB limit.`),
            { errorClass: 'document_too_large', status: 413 },
        );
    }
    if (typeof css === 'string' && Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) {
        throw Object.assign(
            new Error(`The document stylesheet is larger than the ${Math.round(MAX_CSS_BYTES / 1024)} KB limit.`),
            { errorClass: 'document_too_large', status: 413 },
        );
    }
}

// ── CRUD ─────────────────────────────────────────────────────────────

function actor(context) { return typeof context === 'string' ? { userId: context } : context; }
const { normalizeContract, getContract } = require('../core/documents/documentContract');
const failure = (message, status = 422, errorClass = 'document_invalid') => Object.assign(new Error(message), { status, errorClass });
function metadata(input) {
    if (input.settings != null && (typeof input.settings !== 'object' || Array.isArray(input.settings))) throw failure('Settings must be an object');
    input.settings ||= {};
    if (!['document', 'template', 'section'].includes(input.kind || 'document')) throw failure('Invalid document kind');
    if (!['private', 'team'].includes(input.visibility || 'private')) throw failure('Invalid visibility');
    if (input.visibility === 'team' && input.kind === 'document') throw failure('Only templates and sections can be shared');
    if (input.settings?.contract) input.settings.contract = normalizeContract(input.settings.contract);
    if (input.kind !== 'document' && input.settings) {
        input.settings = { ...input.settings }; delete input.settings.sampleValues; delete input.settings.sectionOverrides;
    }
    const isDeck = normaliseType(input.docType) === DECK_DOC_TYPE;
    if (isDeck) {
        // The per-deck look is validated the way an automation's overrides are: an
        // unknown key or a bad colour is dropped, never an error, and '' means
        // "as the house style has it" — so only real choices are stored.
        const { normaliseDeckOverrides } = require('../core/documents/deckThemeOptions');
        input.settings = { ...input.settings, deck: normaliseDeckOverrides(input.settings.deck) };
        if (input.kind === 'section') throw failure('A presentation cannot be a reusable section');
    }
    if (normaliseType(input.docType) === SHEET_DOC_TYPE) applySheetRules(input, failure);
    const cap = isDeck ? MAX_DECK_SETTINGS_BYTES : MAX_SETTINGS_BYTES;
    if (Buffer.byteLength(JSON.stringify(input.settings || {})) > cap) throw failure(`Document settings exceed ${Math.round(cap / 1024)} KB`);
    input.categories = [...new Set((Array.isArray(input.categories) ? input.categories : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
    return input;
}
/**
 * Create a document. `input.projectId` files it into a project at birth; the
 * caller (routes/projects/content.js) has checked the creator's role on that
 * project, and this checks the one thing only the store knows: that the
 * document's organisation is the project's. An empty organisation on either
 * side matches only an equally empty one.
 */
async function createDocument(input) {
    await initDB();
    const d = metadata({ ...input }); assertWithinCaps(d);
    const id = crypto.randomUUID(); const versionId = crypto.randomUUID();
    // Verify membership even when a trusted caller supplies an organization.
    const owner = await getOne('SELECT "organizationId" FROM users WHERE id = $1', [d.userId]);
    let org = d.organizationId || owner?.organizationId || null;
    if (d.organizationId && owner?.organizationId !== d.organizationId) throw failure('Organization mismatch', 403);
    if (d.visibility === 'team' && !org) throw failure('Team libraries require an organization');
    const projectId = d.projectId || null;
    if (projectId) {
        if ((d.kind || 'document') !== 'document') throw failure('Only documents can be filed into a project, not templates or sections', 422);
        const project = await getOne('SELECT organization_id FROM projects WHERE id = $1', [projectId]);
        if (!project) throw failure('Project not found', 404, 'project_not_found');
        if (d.projectOrgChecked === true) {
            // The caller (projects/projectOrg.belongsToProjectOrg) has checked the creator belongs to the project's
            // organisation, which for an account whose organisation comes from a group is not the one on the account row.
            // The item then carries the organisation the project stores, which is what later filing compares on.
            org = project.organization_id || org;
        } else if ((project.organization_id || '') !== (org || '')) {
            throw failure('This project belongs to another organization', 409, 'project_org_mismatch');
        }
    }
    if (d.folderId) await assertFolder(d.folderId, d.userId);
    const docType = normaliseType(d.docType);
    const isPage = docType === PAGE_DOC_TYPE;
    const doc = { id, userId: d.userId, organizationId: org, name: d.name || 'Untitled document',
        docType, description: d.description || '',
        bodyHtml: isPage ? sanitizePageBody(d.bodyHtml) : (d.bodyHtml || ''), css: isPage ? '' : (d.css || ''),
        settings: sheetSettingsForCreate(d.settings, docType, input.sheetTableId, failure), kind: d.kind || 'document', visibility: d.visibility || 'private',
        folderId: d.folderId || null, categories: d.categories, versionId, baselineVersionId: versionId };
    doc.settings = { ...doc.settings, resolvedHouseStyleCss: await require('../core/documents/renderFilledDocument').houseStyleCssFor(doc,org) };
    return withTransaction(async client => {
        const resource = { ...contentCrypto.resourceOfDocument(doc), projectId };
        const stored = await contentCrypto.sealFields({ body_html: doc.bodyHtml, css: doc.css, settings: doc.settings }, resource, contentCrypto.DOCUMENT_FIELDS);
        await client.query(`INSERT INTO studio_documents
            (id,user_id,organization_id,name,doc_type,description,body_html,css,settings,kind,visibility,folder_id,categories,version_id,baseline_version_id,project_id,updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$2)`,
        [id,d.userId,org,doc.name,doc.docType,doc.description,stored.body_html,stored.css,JSON.stringify(stored.settings),doc.kind,doc.visibility,doc.folderId,JSON.stringify(doc.categories),versionId,projectId]);
        if (docType === SHEET_DOC_TYPE) await require('./lib/sheetCrypto').attach(client, doc);
        await versions.writeRevision(client, { ...doc, projectId }, { summary: 'Created', source: 'created', actorId: d.userId });
        const { rows } = await client.query('SELECT * FROM studio_documents WHERE id = $1', [id]);
        return rows[0] ? mapRow(rows[0]) : { ...doc, projectId };
    });
}
function accessSql(alias = 'd', write = false) {
    const sharing = write ? '' : ` OR (${alias}.archived = false AND ${sharingSql(alias)})`;
    return `(((${alias}.user_id = $2 AND (${alias}.organization_id IS NULL OR ${alias}.organization_id = (SELECT "organizationId" FROM users WHERE id = $2))) OR (${alias}.visibility = 'team' AND ${alias}.sharing_audience IS NULL AND ${alias}.kind IN ('template','section')
        AND ${alias}.organization_id = (SELECT "organizationId" FROM users WHERE id = $2)${write ? ' AND $3::boolean' : ''}))${sharing})`;
}
// A document a project member may see: filed, a plain document (templates and
// sections have their own team sharing and are never project content), and not
// archived by its owner.
// What a library row reads, in the order notebookLibrary.notebookBranchSql
// answers them, so the two halves of the library UNION line up.
const LIBRARY_COLUMNS = `d.id, d.user_id, d.name, d.doc_type, d.description, d.kind, ${visibilitySql('d')} AS visibility, d.folder_id, d.categories,
    d.version_id, OCTET_LENGTH(d.body_html) AS html_size, d.project_id, d.updated_by, d.archived, d.created_at, d.updated_at,
    NULL::int AS source_count`;
const PROJECT_DOCUMENT_SQL = `d.project_id IS NOT NULL AND d.kind = 'document' AND d.archived = false`;

/**
 * Read a document the caller may see: their own, a team template or section
 * of their organisation, or a document filed into a project they are a member
 * of (any role). The last one carries `projectRole`, which is what the caller
 * may do with it: 'viewer' reads, 'editor' and 'owner' also edit.
 *
 * The owner path stays one indexed query; the project path is a second read,
 * taken only when the first finds nothing.
 */
async function getDocument(documentId, context) {
    await initDB(); const a = actor(context);
    const own = await getOne(`SELECT d.* FROM studio_documents d WHERE d.id = $1 AND ${accessSql()}`, [documentId, a.userId]);
    if (own) {
        const doc = mapRow(own);
        if (own.user_id === a.userId || (own.visibility === 'team' && own.sharing_audience === null)) return doc;
        const role = own.project_id ? await projectRoleOf(a.userId, own.project_id) : null;
        return { ...doc, ...(role ? { projectRole: role } : {}), sharingRole: canEditAs(role) ? 'editor' : 'viewer' };
    }
    if (!documentId || !a?.userId) return null;
    const filed = await getOne(`SELECT d.id, d.project_id FROM studio_documents d WHERE d.id = $1 AND ${PROJECT_DOCUMENT_SQL}`, [documentId]);
    if (!filed) return null;
    const role = await projectRoleOf(a.userId, filed.project_id);
    if (!role) return null;
    const shared = await getOne(`SELECT d.* FROM studio_documents d WHERE d.id = $1 AND d.project_id = $2 AND ${PROJECT_DOCUMENT_SQL}`, [documentId, filed.project_id]);
    if (!shared) return null;
    return { ...mapRow(shared), projectRole: role };
}
async function getDocumentVersion(documentId, context, versionId) {
    const doc = await getDocument(documentId, context);
    if (!doc) return null;
    const id = versionId || doc.baselineVersionId || doc.versionId;
    const v = await getOne('SELECT * FROM studio_document_versions WHERE id = $1 AND document_id = $2', [id, documentId]);
    if (!v) return null;
    const snapshot = typeof v.snapshot === 'string' ? JSON.parse(v.snapshot) : v.snapshot;
    // A revision is the document's CONTENT at that time; where the document is
    // filed now is today's fact, never the one frozen into an old snapshot.
    return { ...doc, ...(snapshot || { bodyHtml: v.body_html, css: v.css }), versionId: id, projectId: doc.projectId, sharingRole: doc.sharingRole, projectRole: doc.projectRole };
}
/**
 * The library list, one page of it, and how many there are in all.
 *
 * `archived: true` lists what the caller archived themselves (their own
 * documents only), which is where "restore" is offered; otherwise archived
 * documents are left out.
 */
async function listDocumentsPage(context, options = {}) {
    await initDB(); const a = actor(context);
    const { limit = 50, offset = 0, query = '', kind, visibility, folderId, category, sort } = options;
    const archived = options.archived === true;
    const params = [null, a.userId];
    const bind = (value) => { params.push(value); return '$' + params.length; };
    const where = archived ? [accessSql(), 'd.archived = true', 'd.user_id = $2'] : [accessSql(), 'd.archived = false'];
    // The filters a notebook row answers too, by placeholder (notebookLibrary).
    const shared = { query: '', folder: null, folderSet: folderId !== undefined, category: '', visibility };
    if (query) {
        shared.query = bind('%' + String(query).slice(0, 200) + '%');
        where.push(`(d.name ILIKE ${shared.query} OR d.description ILIKE ${shared.query})`);
    }
    if (kind) where.push(`d.kind = ${bind(kind)}`);
    else if (options.onlyFillable) where.push("d.kind != 'section'");
    if (options.onlyFillable) where.push(`d.doc_type <> ${bind(SHEET_DOC_TYPE)}`); // nothing in a sheet is filled in
    // `docType` narrows to one type; 'designed' is every document written in
    // the frame, so neither a presentation nor a page. 'notebook' is no
    // studio_documents type: only notebook rows answer it.
    if (options.docType === DESIGNED_FILTER) {
        where.push(`d.doc_type <> ${bind(DECK_DOC_TYPE)}`, `d.doc_type <> ${bind(PAGE_DOC_TYPE)}`, `d.doc_type <> ${bind(SHEET_DOC_TYPE)}`);
    } else if (options.docType === notebookLibrary.NOTEBOOK_DOC_TYPE) where.push('false');
    else if (options.docType && DOC_TYPES.includes(options.docType)) where.push(`d.doc_type = ${bind(options.docType)}`);
    if (visibility) where.push(`${visibilitySql('d')} = ${bind(visibility)}`);
    if (shared.folderSet) {
        if (folderId) shared.folder = bind(folderId);
        where.push(folderId ? `d.folder_id = ${shared.folder}` : 'd.folder_id IS NULL');
    }
    if (category) {
        shared.category = bind(JSON.stringify([category]));
        where.push(`d.categories @> ${shared.category}::jsonb`);
    }
    // Notebooks join the list only for a reader the route let through the
    // notebook gates, and only where the filters leave room for one.
    const withNotebooks = options.includeNotebooks === true && notebookLibrary.listsNotebooks({ ...options, archived });
    if (withNotebooks) await notebookLibrary.ready();
    const from = `SELECT ${LIBRARY_COLUMNS} FROM studio_documents d WHERE ${where.join(' AND ')}`
        + (withNotebooks ? ` UNION ALL ${notebookLibrary.notebookBranchSql(shared)}` : '');
    params[0] = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const offsetAt = bind(Math.max(Number(offset) || 0, 0));
    const order = sort === 'name' ? 'u.name ASC, u.id' : 'u.updated_at DESC, u.id';
    const rows = await getAll(`SELECT u.*, COUNT(*) OVER() AS total_count FROM (${from}) u
        ORDER BY ${order} LIMIT $1 OFFSET ${offsetAt}`, params);
    // An offset past the end answers no rows and so no window count; ask once.
    let total = rows[0] ? Number(rows[0].total_count) || 0 : 0;
    if (!rows.length && Number(params[params.length - 1]) > 0) {
        // $1 (the page size) is not needed for a count; typed and passed as
        // null so the filters keep their parameter numbers.
        const count = await getOne(`SELECT COUNT(*)::int AS n FROM (${from}) u WHERE $1::int IS NULL`, [null, ...params.slice(1, -1)]);
        total = Number(count?.n) || 0;
    }
    return { documents: rows.map(mapListRow), total };
}
async function listDocuments(context, options = {}) {
    return (await listDocumentsPage(context, options)).documents;
}
async function listTemplates(context, options = {}) {
    const list = await listDocuments(context, { ...options, onlyFillable:true });
    return Promise.all(list.filter(d => d.kind !== 'section').map(async d => {
        const doc = await getDocument(d.id, context);
        return { ...d, ...getContract(doc), placeholders: getContract(doc).placeholders };
    }));
}
// What only the document's OWNER may change, also on a project document: its
// kind and sharing, and where it sits in their own library.
const OWNER_ONLY_KEYS = Object.freeze(['kind', 'visibility', 'folderId', 'categories']);
const CONTENT_KEYS = Object.freeze(['name','docType','description','bodyHtml','css','settings','kind','visibility','folderId','categories']);

/**
 * The project through which `userId` may EDIT this document, or null: the
 * document is filed there and the caller is an editor or the owner of it.
 */
async function editableProjectOf(documentId, userId) {
    if (!documentId || !userId) return null;
    const row = await getOne(`SELECT d.project_id FROM studio_documents d WHERE d.id = $1 AND ${PROJECT_DOCUMENT_SQL}`, [documentId]);
    if (!row) return null;
    return canEditAs(await projectRoleOf(userId, row.project_id)) ? row.project_id : null;
}

/**
 * Lock a document for a write by `a`, inside `client`'s transaction: the owner
 * (and an org admin, for a team template or section), or an editor of the
 * project it is filed in. Null for everybody else, a project viewer included.
 * A template a Solution stage manages is refused (solutionTemplates.guardManagedLock).
 *
 * @returns {Promise<{ row: any, asMember: boolean } | null>}
 */
async function lockForWrite(client, documentId, a) {
    let { rows } = await client.query(`SELECT d.* FROM studio_documents d WHERE d.id = $1 AND ${accessSql('d', true)} FOR UPDATE`, [documentId,a.userId,a.isAdmin === true]);
    if (rows[0]) return solutionTemplates.guardManagedLock(client, { row: rows[0], asMember: false }, a);
    const projectId = await editableProjectOf(documentId, a.userId);
    if (!projectId) return null;
    // Locked again ON that project: a removal from the project between the
    // role check and here must not leave the edit going through.
    ({ rows } = await client.query(`SELECT d.* FROM studio_documents d WHERE d.id = $1 AND d.project_id = $2 AND ${PROJECT_DOCUMENT_SQL} FOR UPDATE`, [documentId, projectId]));
    return rows[0] ? solutionTemplates.guardManagedLock(client, { row: rows[0], asMember: true }, a) : null;
}

/**
 * A save made from a revision that is no longer current: merge it, or refuse
 * it with everything the editor needs to let the person choose.
 *
 * Only a body save can be merged, and only when the caller handed a merge
 * function (the routes pass core/documents/sectionMerge.mergeBodies; the
 * store does not reach into the feature layer by itself). Anything else is
 * the plain 409 it always was.
 */
async function mergeStale(client, current, updates) {
    const conflict = (extra = {}) => Object.assign(
        failure('This document changed while you were editing. Compare the two versions and choose what to keep.', 409, 'document_conflict'),
        extra,
    );
    const bodyOnly = typeof updates.bodyHtml === 'string'
        && CONTENT_KEYS.every(k => k === 'bodyHtml' || k === 'name' || updates[k] === undefined);
    if (typeof updates.mergeWith !== 'function' || !bodyOnly) throw conflict();
    const { rows } = await client.query('SELECT body_html FROM studio_document_versions WHERE id = $1 AND document_id = $2',
        [updates.expectedVersionId, current.id]);
    if (!rows[0]) throw conflict();
    const result = updates.mergeWith(rows[0].body_html || '', updates.bodyHtml, current.bodyHtml);
    if (result.conflicts > 0 || typeof result.html !== 'string') {
        throw conflict({ conflict: { currentVersionId: current.versionId, parts: result.parts } });
    }
    return { bodyHtml: result.html, merge: { merged: true, fromOthers: result.fromOthers, othersOutsideSections: result.othersOutsideSections } };
}

/**
 * Change a document. The owner (and an org admin, for a team template or
 * section) as before; and a project EDITOR on a document filed into their
 * project, for its content — never its kind, sharing or library place. A
 * project viewer gets null, like a stranger.
 *
 * `updates` may also say how the revision it writes came about (the routes
 * and tools decide; a client never does): `source` (documentVersions
 * VERSION_SOURCES, 'autosave' by default), `contributors`, `summary`,
 * `restoredFrom`; and `mergeWith` for a stale body save (see mergeStale).
 * The answer carries `merge` when a stale save was merged.
 */
async function updateDocument(documentId, context, updates = {}) {
    await initDB(); const a = actor(context); assertWithinCaps(updates);
    return withTransaction(async client => {
        // Order-independent (jsonb returns its own key order): a resent, unchanged settings object is no change.
        const changedKeysOf = (row) => managedParts.changedKeysOf(mapRow(row), Object.fromEntries(CONTENT_KEYS.map(k => [k, updates[k]])));
        const locked = await lockForWrite(client, documentId, { ...a, changedKeysOf });
        if (!locked) return null;
        const { asMember } = locked;
        const current = mapRow(locked.row);
        let merge = null;
        if (updates.expectedVersionId && updates.expectedVersionId !== current.versionId) {
            const merged = await mergeStale(client, current, updates);
            updates = { ...updates, bodyHtml: merged.bodyHtml };
            merge = merged.merge;
        }
        const next = metadata({ ...current, ...Object.fromEntries(CONTENT_KEYS.filter(k => updates[k] !== undefined).map(k => [k,updates[k]])) });
        if (asMember && OWNER_ONLY_KEYS.some(k => JSON.stringify(current[k]) !== JSON.stringify(next[k]))) {
            throw failure('Only the owner of this document can change its type, sharing, folder or categories', 403, 'document_owner_only');
        }
        const wasPage = current.docType === PAGE_DOC_TYPE;
        if (wasPage !== (normaliseType(next.docType) === PAGE_DOC_TYPE)) {
            throw failure('A page stays a page, and a designed document cannot become one. Make a new page instead.', 422, 'document_type_fixed');
        }
        keepSheetOnUpdate(current, next, normaliseType(next.docType), failure);
        if (wasPage) { next.bodyHtml = sanitizePageBody(next.bodyHtml); next.css = ''; }
        // A page edited live: its body is the live state's (lib/coEditGuard.js), never this save's.
        if (wasPage && next.bodyHtml !== current.bodyHtml && await isCoEdited(client, 'document', documentId)) {
            throw failure('This page is being edited live. Join in to keep editing; your text was not saved over it.', 409, 'document_live');
        }
        if (!Object.hasOwn(next.settings,'resolvedHouseStyleCss') && typeof current.settings.resolvedHouseStyleCss === 'string') {
            next.settings = {...next.settings,resolvedHouseStyleCss:current.settings.resolvedHouseStyleCss};
        }
        if (next.settings.houseStyle !== current.settings.houseStyle) { next.settings = { ...next.settings }; delete next.settings.resolvedHouseStyleCss; }
        if (next.visibility === 'team' && !current.organizationId) throw failure('Team libraries require an organization');
        if (next.folderId) await assertFolder(next.folderId, current.userId);
        if (CONTENT_KEYS.every(k => JSON.stringify(current[k]) === JSON.stringify(next[k]))) return merge ? { ...current, merge } : current;
        const { houseStyleCssFor } = require('../core/documents/renderFilledDocument');
        next.settings = { ...next.settings, resolvedHouseStyleCss: await houseStyleCssFor(next, next.organizationId) };
        if (updates.source === 'restore') await writePreRestore(client, current, a.userId);
        next.versionId = crypto.randomUUID();
        const visibilityChanged = next.visibility !== current.visibility;
        if (visibilityChanged) next.sharing = { audience: next.visibility === 'team' ? 'organisation' : 'private', sharedGroups: [], sharedUserIds: [] };
        const stored = await contentCrypto.sealFields({ body_html: next.bodyHtml, css: next.css, settings: next.settings }, contentCrypto.resourceOfDocument(next), contentCrypto.DOCUMENT_FIELDS);
        const result = await client.query(`UPDATE studio_documents SET name=$2,doc_type=$3,description=$4,body_html=$5,css=$6,settings=$7,
            kind=$8,visibility=$9,folder_id=$10,categories=$11,version_id=$12,updated_by=$13,updated_at=NOW(),
            sharing_audience = CASE WHEN $14 THEN NULL ELSE sharing_audience END,
            shared_groups = CASE WHEN $14 THEN '[]'::jsonb ELSE shared_groups END,
            shared_user_ids = CASE WHEN $14 THEN '[]'::jsonb ELSE shared_user_ids END WHERE id=$1 RETURNING *`,
        [documentId,String(next.name).slice(0,200),normaliseType(next.docType),String(next.description).slice(0,2000),stored.body_html,stored.css,JSON.stringify(stored.settings),next.kind,next.visibility,next.folderId,JSON.stringify(next.categories),next.versionId,a.userId || null,visibilityChanged]);
        let saved = mapRow(result.rows[0]);
        if (visibilityChanged) {
            await require('./lib/documentSharingCrypto').transition(client, 'document', result.rows[0], next.sharing.audience);
            saved = mapRow((await client.query('SELECT * FROM studio_documents WHERE id = $1', [documentId])).rows[0]);
        }
        if (saved.docType === SHEET_DOC_TYPE) await require('./lib/sheetCrypto').attach(client, saved);
        await versions.writeRevision(client, saved, {
            summary: updates.summary || (merge ? 'Merged with changes made meanwhile' : 'Edited'),
            source: updates.source || 'autosave', actorId: a.userId || null,
            contributors: updates.contributors, restoredFrom: updates.restoredFrom || null,
        }, current);
        return merge ? { ...saved, merge } : saved;
    });
}

/**
 * Before a restore replaces the document, make sure the state it replaces is
 * a version of its own. Every save writes one, so this only adds a row when
 * the document moved on without one (a page edited live, whose body is
 * materialised between checkpoints); an identical state is not written twice.
 */
async function writePreRestore(client, current, actorId) {
    const head = await versions.headRow(client, current.id, current.versionId);
    if (head && head.content_hash === versions.contentHash(current)) return;
    const snapshot = { ...current, versionId: crypto.randomUUID() };
    await versions.writeRevision(client, snapshot, { summary: 'Before restore', source: 'pre_restore', actorId }, current);
}
/**
 * Archive a document. OWNER-ONLY (plus an org admin for a team template or
 * section), also when it is filed into a project: editing is the
 * collaboration, removing a colleague's work is not. A project owner who wants
 * it out of the project takes it out (detachDocumentFromProject) instead.
 */
async function deleteDocument(documentId, context) {
    await initDB(); const a = actor(context); const params = [documentId,a.userId,a.isAdmin === true];
    // Access first: someone who may not archive it gets the same "not found" as always, never a managed_part naming its Solution.
    if (!await getOne(`SELECT d.id FROM studio_documents d WHERE d.id = $1 AND ${accessSql('d', true)}`, params)) return false;
    await solutionTemplates.assertTemplateWrite(documentId, ['archived']);
    const result = await run(`UPDATE studio_documents d SET archived = true WHERE d.id = $1 AND ${accessSql('d', true)}`, params);
    return (result?.rowCount || 0) > 0;
}
async function assertFolder(id, userId) {
    if (!await getOne('SELECT id FROM studio_document_folders WHERE id = $1 AND user_id = $2', [id,userId])) throw failure('Folder not found',404);
}
async function listFolders(userId) { await initDB(); return getAll('SELECT id, name, parent_id AS "parentId" FROM studio_document_folders WHERE user_id = $1 ORDER BY name', [userId]); }
async function createFolder(userId, name, parentId = null) {
    await initDB(); if (!String(name || '').trim()) throw failure('Folder name is required');
    if (parentId) await assertFolder(parentId,userId);
    const id = crypto.randomUUID();
    await run('INSERT INTO studio_document_folders(id,user_id,name,parent_id) VALUES ($1,$2,$3,$4)', [id,userId,String(name).trim().slice(0,200),parentId]);
    return { id, name, parentId };
}
async function deleteFolder(userId, id) {
    await initDB();
    return withTransaction(async client => {
        const { rows } = await client.query('SELECT * FROM studio_document_folders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
        if (!rows[0]) throw failure('Folder not found',404);
        await client.query('UPDATE studio_documents SET folder_id=$2 WHERE folder_id=$1 AND user_id=$3',[id,rows[0].parent_id,userId]);
        await notebookLibrary.reparentNotebooks(client, userId, id, rows[0].parent_id);
        await client.query('UPDATE studio_document_folders SET parent_id=$2 WHERE parent_id=$1 AND user_id=$3',[id,rows[0].parent_id,userId]);
        await client.query('DELETE FROM studio_document_folders WHERE id=$1 AND user_id=$2',[id,userId]);
    });
}

// ── Project membership ───────────────────────────────────────────────

/**
 * File a document into a project (projects/membership.js, kind 'document').
 *
 * Owner-only: filing exposes the document to every member of the project, and
 * that is the owner's call. The route checks the caller's role on the TARGET
 * project; this checks the rest in the statement itself, so there is no gap
 * between a check and the write: the caller owns it, it is a plain document
 * (not a template or section, which have their own team sharing), it is not
 * archived, and the project exists in the document's own organisation.
 */
async function setDocumentProject(documentId, userId, projectId, callerOrgIds = []) {
    await initDB();
    if (!documentId || !userId || !projectId) return false;
    // `callerOrgIds`: the organisations the owner belongs to (auth/orgScope), so a document of someone whose
    // organisation only comes from a group (none on the document) can be filed into that organisation's project.
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE studio_documents d SET project_id = $1
              WHERE d.id = $2 AND d.user_id = $3 AND d.kind = 'document' AND d.archived = false
                AND EXISTS (SELECT 1 FROM projects p
                    WHERE p.id = $1 AND (COALESCE(p.organization_id, '') = COALESCE(d.organization_id, '')
                        OR (COALESCE(d.organization_id, '') = '' AND p.organization_id = ANY($4::text[])))) RETURNING d.*`,
            [projectId, documentId, userId, [...callerOrgIds]]);
        if (!rows[0]) return false;
        await require('./lib/documentSharingCrypto').transition(client, 'document', rows[0], rows[0].sharing_audience || 'private');
        return true;
    });
}

/**
 * Take a document out of ONE project. With `userId`, only when that person
 * owns it; with null, whoever owns it, which projects/membership.js allows
 * only the owner of that project. Scoped to `projectId` either way, so a
 * removal can never reach a document filed somewhere else.
 */
async function detachDocumentFromProject(documentId, projectId, userId = null) {
    await initDB();
    if (!documentId || !projectId) return false;
    const { rowCount } = await run(
        `UPDATE studio_documents SET project_id = NULL
          WHERE id = $1 AND project_id = $2 AND ($3::text IS NULL OR user_id = $3)`,
        [documentId, projectId, userId]
    );
    return (rowCount || 0) > 0;
}

/** The documents filed into a project, as cards (no slots), newest first. */
async function listProjectDocuments(projectId, { limit = 100, offset = 0 } = {}) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT d.id, d.name, d.doc_type, d.kind, d.user_id, d.project_id, d.updated_by, d.created_at, d.updated_at
           FROM studio_documents d
          WHERE d.project_id = $1 AND ${PROJECT_DOCUMENT_SQL}
          ORDER BY d.updated_at DESC, d.id
          LIMIT $2 OFFSET $3`,
        [projectId, Math.min(Math.max(Number(limit) || 100, 1), 200), Math.max(Number(offset) || 0, 0)]
    );
    return rows.map(mapProjectCard);
}

/**
 * How many documents each of these projects holds, in ONE query. A project
 * missing from the map holds none; a failed read rejects, so a caller can
 * tell "none" from "could not count".
 */
async function countProjectDocuments(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT d.project_id, COUNT(*)::int AS n FROM studio_documents d
          WHERE d.project_id = ANY($1::text[]) AND ${PROJECT_DOCUMENT_SQL}
          GROUP BY d.project_id`,
        [ids]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * Detach every document from a deleted project. They go back to being their
 * owners' private documents; deleting a project never deletes what its members
 * wrote in it.
 */
async function clearProjectFromDocuments(projectId) {
    await initDB();
    if (!projectId) return 0;
    const { rowCount } = await run('UPDATE studio_documents SET project_id = NULL WHERE project_id = $1', [projectId]);
    return rowCount || 0;
}

// ── Versions ─────────────────────────────────────────────────────────
//
// The history API and the live co-editing hooks live in documentHistory.js,
// built here over this store's own access rules.

const history = require('./documentHistory').makeDocumentHistory({
    initDB, withTransaction, getAll, getOne, run, getDocument, getDocumentVersion, updateDocument, lockForWrite,
    mapRow, sanitizePageBody, assertWithinCaps, failure, PAGE_DOC_TYPE,
});

/**
 * Bring an archived document back into the library. The same people who may
 * archive it: its owner, and an org admin for a team template or section.
 */
async function unarchiveDocument(documentId, context) {
    await initDB(); const a = actor(context);
    const result = await run(`UPDATE studio_documents d SET archived = false WHERE d.id = $1 AND d.archived = true AND ${accessSql('d', true)}`, [documentId,a.userId,a.isAdmin === true]);
    return (result?.rowCount || 0) > 0;
}

module.exports = {
    getDocumentVersion, listFolders, createFolder, deleteFolder, assertFolder,
    DOC_TYPES,
    DEFAULT_DOC_TYPE,
    DECK_DOC_TYPE,
    PAGE_DOC_TYPE,
    SHEET_DOC_TYPE,
    DESIGNED_FILTER,
    VERSION_SOURCES: versions.VERSION_SOURCES,
    MAX_SETTINGS_BYTES,
    MAX_DECK_SETTINGS_BYTES,
    MAX_HTML_BYTES,
    MAX_CSS_BYTES,
    initDB,
    createDocument,
    listDocuments,
    listDocumentsPage,
    listTemplates,
    getDocument,
    updateDocument,
    deleteDocument,
    unarchiveDocument,
    listVersions: history.listVersions,
    getVersion: history.getVersion,
    createNamedVersion: history.createNamedVersion,
    nameVersion: history.nameVersion,
    restoreVersion: history.restoreVersion,
    deleteVersion: history.deleteVersion,
    writeCollabBody: history.writeCollabBody,
    recordVersion: history.recordVersion,
    keepConflictCopy: history.keepConflictCopy,
    pruneVersions: history.pruneVersions,
    firstAuthorOf: history.firstAuthorOf,
    revisionSeqOf: history.revisionSeqOf,
    setDocumentProject,
    detachDocumentFromProject,
    listProjectDocuments,
    countProjectDocuments,
    clearProjectFromDocuments,
    mapRow, assertWithinCaps,
    _test: { mapRow, mapListRow, mapProjectCard, normaliseType, assertWithinCaps, sanitizePageBody },
};
