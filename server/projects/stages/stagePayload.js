/**
 * The ONE canonical payload per part kind (design 6.3).
 *
 * A stage deploy stamps every part with `install_hash = hashPayload(canonicalOf
 * (kind, boundEntity))` (commit), and the plan calls a part `unchanged` when the
 * bound release entity hashes to that stamp AND the part as it is stored still
 * does (`readStagePayload`), and `drift` when the stored part no longer does.
 * Both sides therefore go through `canonicalOf`, which takes an entity in the
 * MANIFEST shape (the release entity with its pointers resolved to stage ids
 * and its bindings applied) and keeps exactly the fields a release carries.
 * `readStagePayload` reads a stored part back into that same shape first.
 *
 * `upgrade.currentPayload` is deliberately not used: it returns only an
 * agent's config, a page's slots and an app's definition, and null for every
 * other kind, so a changed table or prompt would read as unchanged.
 *
 * ── What each kind covers ───────────────────────────────────────────────────
 *
 *   automation       kind (automation | block | layer), title, description,
 *                    definition (the working copy: equal to live in steady state)
 *   app              name, description, icon, accent, definition, data model
 *   webpage          name, texts, the PINNED version's slots, bridge grants
 *                    (automations, tables, agent, integration tools; never the
 *                    `ai` block or public columns: audience is a stage
 *                    setting), knowledgeBaseIds
 *   datatable        logical key, name, description, row scope, the columns
 *                    (stable ids) and the ids of retired columns. Governance
 *                    (lawful basis, retention, subject column) is a stage
 *                    setting after create, so it is not in the hash.
 *   agent            name, description, prompt, model, starters, flags, the
 *                    config subset a release carries, avatar, persona
 *   skill            the design 2 allow-list plus its pointers
 *   document         a template's name, type, description, body, css and
 *                    settings (without sample values / section overrides)
 *                    A page's address (slug) and a table's mirror `source` are
 *                    applied bindings, not part of the hash (a release does not
 *                    carry them and a stage may choose its own): the shape
 *                    reads them (`slug`, `source`) and plan.js compares them
 *                    with the stage's binding (`settingsChanged`).
 *   knowledge_base   the shell (name, description, icon, usage contexts)
 *   knowledge_listing  the set of document content hashes (carry mode)
 *   reference_rows   the content hash of the rows (referenceRows.js)
 *
 * Every reader takes its stores through `deps`, so a test writes doubles.
 */

'use strict';

const { hashOf } = require('./model');

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const str = (v) => (typeof v === 'string' ? v : '');
const strOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
const sortedIds = (list) => [...new Set((Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x))].sort();
/** camelCase first, snake_case as the store row spells it. */
const read = (src, camel, snake) => (src[camel] !== undefined ? src[camel] : (snake ? src[snake] : undefined));

/** Manifest section → part kind (the stamp vocabulary install writes). */
const KIND_OF_SECTION = Object.freeze({
    automations: 'automation', apps: 'app', webpages: 'webpage', datatables: 'datatable',
    agents: 'agent', knowledgeBases: 'knowledge_base', skills: 'skill', documents: 'document',
});
const SECTION_OF_KIND = Object.freeze(Object.fromEntries(Object.entries(KIND_OF_SECTION).map(([s, k]) => [k, s])));
const PAYLOAD_KINDS = Object.freeze([...Object.values(KIND_OF_SECTION), 'block', 'knowledge_listing', 'reference_rows']);

// ── canonicalOf ───────────────────────────────────────────────────────────────

function canonicalAutomation(s) {
    const definition = isObject(s.definition) ? clone(s.definition) : {};
    // A run sample, never carried (portability.buildExport strips it).
    delete definition.manualTriggerPayload;
    const kind = ['block', 'layer'].includes(s.kind) ? s.kind : 'automation';
    return { kind, title: str(s.title), description: str(s.description), definition };
}

function hasTables(model) {
    return isObject(model) && Array.isArray(model.tables) && model.tables.length > 0;
}

function canonicalApp(s) {
    const model = read(s, 'dataModel', 'data_model');
    return {
        name: str(s.name),
        description: str(s.description),
        icon: strOrNull(s.icon),
        accentColor: strOrNull(read(s, 'accentColor', 'accent_color')),
        definition: isObject(s.definition) ? clone(s.definition) : {},
        dataModel: hasTables(model) ? clone(model) : null,
    };
}

function canonicalGrants(raw) {
    const g = isObject(raw) ? raw : {};
    const automations = (Array.isArray(g.automations) ? g.automations : [])
        .filter(e => isObject(e) && typeof e.automationId === 'string' && e.automationId)
        .map(e => ({ automationId: e.automationId, ...(e.label ? { label: String(e.label) } : {}) }));
    // Deduplicated per table, the last entry winning, as the store does.
    const tables = new Map();
    for (const e of Array.isArray(g.tables) ? g.tables : []) {
        if (!isObject(e) || typeof e.datatableId !== 'string' || !e.datatableId) continue;
        tables.set(e.datatableId, {
            datatableId: e.datatableId,
            mode: e.mode === 'readwrite' ? 'readwrite' : 'read',
            columns: sortedIds(e.columns),
        });
    }
    const integrations = (Array.isArray(g.integrations) ? g.integrations : [])
        .filter(e => isObject(e) && typeof e.tool === 'string' && e.tool)
        .map(e => ({ tool: e.tool, ...(e.label ? { label: String(e.label) } : {}) }))
        .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
    const agentId = isObject(g.agent) && typeof g.agent.agentId === 'string' && g.agent.agentId ? g.agent.agentId : null;
    return {
        automations,
        tables: [...tables.values()].sort((a, b) => (a.datatableId < b.datatableId ? -1 : 1)),
        integrations,
        agent: agentId ? { agentId } : null,
    };
}

function canonicalWebpage(s) {
    const files = isObject(s.files) ? s.files : {};
    return {
        name: str(s.name),
        description: str(s.description),
        instructions: str(s.instructions),
        icon: strOrNull(s.icon),
        accentColor: strOrNull(read(s, 'accentColor', 'accent_color')),
        tagline: strOrNull(s.tagline),
        files: { html: str(files.html), css: str(files.css), js: str(files.js) },
        bridgeGrants: canonicalGrants(read(s, 'bridgeGrants', 'bridge_grants')),
        knowledgeBaseIds: sortedIds(read(s, 'knowledgeBaseIds', 'knowledge_base_ids')),
    };
}

const COLUMN_FIELDS = ['key', 'name', 'type', 'options', 'required', 'unique'];

function canonicalColumn(c) {
    const out = { id: str(c.id) };
    for (const f of COLUMN_FIELDS) {
        if (f === 'required' || f === 'unique') out[f] = c[f] === true;
        else if (f === 'options') { if (c.options !== undefined && c.options !== null) out.options = clone(c.options); }
        else out[f] = str(c[f]);
    }
    if (!out.name) out.name = out.key;
    if (!out.type) out.type = 'text';
    return out;
}

function canonicalDatatable(s) {
    const columns = Array.isArray(s.columns) ? s.columns : (Array.isArray(s.fields) ? s.fields : []);
    const retired = read(s, 'retiredFields', 'retired_fields');
    return {
        key: str(read(s, 'logicalKey', 'logical_key')) || str(s.key),
        name: str(s.name),
        description: str(s.description),
        rowScope: read(s, 'rowScope', 'row_scope') === 'own' ? 'own' : 'all',
        fields: columns.filter(isObject).map(canonicalColumn),
        retiredFields: sortedIds((Array.isArray(retired) ? retired : []).map(r => (isObject(r) ? r.id : r))),
    };
}

/** An agent's tool grants as a release carries them: actAs is always viewer. */
function canonicalTools(tools) {
    if (!isObject(tools)) return undefined;
    const out = {};
    for (const app of Object.keys(tools).sort()) {
        const e = tools[app];
        if (!isObject(e)) continue;
        out[app] = {
            actions: e.actions === '*' ? '*' : sortedIds(e.actions),
            actAs: 'viewer',
            ...(e.confirm === 'ask' || e.confirm === 'direct' ? { confirm: e.confirm } : {}),
        };
    }
    return out;
}

function canonicalAgent(s) {
    const config = isObject(s.config) ? s.config : {};
    const outConfig = {};
    const tools = canonicalTools(config.tools);
    if (tools && Object.keys(tools).length) outConfig.tools = tools;
    for (const key of ['memoryEnabled', 'temperature']) if (config[key] !== undefined && config[key] !== null) outConfig[key] = config[key];
    outConfig.knowledge_base_ids = sortedIds(config.knowledge_base_ids);
    outConfig.attachedSkillIds = sortedIds(config.attachedSkillIds);
    const starters = read(s, 'starterPrompts', 'starter_prompts');
    return {
        name: str(s.name),
        description: str(s.description),
        systemPrompt: str(read(s, 'systemPrompt', 'system_prompt')),
        model: strOrNull(s.model),
        starterPrompts: Array.isArray(starters) ? starters.filter(x => typeof x === 'string') : [],
        threadsEnabled: read(s, 'threadsEnabled', 'threads_enabled') !== false,
        copyEnabled: read(s, 'copyEnabled', 'copy_enabled') !== false,
        workspaceEnabled: read(s, 'workspaceEnabled', 'workspace_enabled') === true,
        config: outConfig,
        avatar: strOrNull(s.avatar) || strOrNull(config.avatar),
        persona: s.persona === undefined ? null : clone(s.persona),
    };
}

/** The skill allow-list of design 2, in camelCase, plus its pointers. */
const SKILL_TEXT = [['name'], ['description'], ['instructions'], ['workflow'], ['rules'], ['examples'], ['icon']];
const SKILL_JSON = [['steps'], ['rulesV2', 'rules_v2'], ['examplesV2', 'examples_v2']];

function canonicalSkill(s) {
    const out = {};
    for (const [camel] of SKILL_TEXT) out[camel] = str(s[camel]);
    for (const [camel, snake] of SKILL_JSON) {
        const v = read(s, camel, snake);
        out[camel] = Array.isArray(v) ? clone(v) : [];
    }
    const schema = read(s, 'outputSchema', 'output_schema');
    out.outputSchema = isObject(schema) ? clone(schema) : null;
    out.dynamicActivation = read(s, 'dynamicActivation', 'dynamic_activation') === true;
    out.knowledgeBaseIds = sortedIds(read(s, 'knowledgeBaseIds', 'knowledge_base_ids'));
    out.allowedAutomationIds = sortedIds(read(s, 'allowedAutomationIds', 'allowed_automation_ids'));
    out.automationId = strOrNull(read(s, 'automationId', 'automation_id'));
    return out;
}

function canonicalDocument(s) {
    const raw = read(s, 'settings', 'settings');
    const settings = isObject(raw) ? clone(raw) : {};
    delete settings.sampleValues;
    delete settings.sectionOverrides;
    return {
        name: str(s.name),
        docType: str(read(s, 'docType', 'doc_type')) || 'document',
        description: str(s.description),
        bodyHtml: str(read(s, 'bodyHtml', 'body_html')),
        css: str(s.css),
        settings,
    };
}

function canonicalKnowledgeBase(s) {
    let contexts = read(s, 'usageContexts', 'usage_contexts');
    if (typeof contexts === 'string') { try { contexts = JSON.parse(contexts); } catch { contexts = null; } }
    return {
        name: str(s.name),
        description: str(s.description),
        icon: strOrNull(s.icon),
        usageContexts: Array.isArray(contexts) ? contexts.filter(c => typeof c === 'string') : null,
    };
}

function canonicalListing(s) {
    const docs = Array.isArray(s.docs) ? s.docs : [];
    const hashes = Array.isArray(s.contentHashes) ? s.contentHashes : docs.map(d => d && (d.contentHash || d.content_hash));
    return { contentHashes: sortedIds(hashes) };
}

function canonicalReferenceRows(s) {
    if (typeof s.contentHash === 'string' && s.contentHash) return { contentHash: s.contentHash };
    const { hashReferenceRows } = require('./referenceRows');
    return { contentHash: hashReferenceRows(Array.isArray(s.rows) ? s.rows : []) };
}

const CANONICAL = {
    automation: canonicalAutomation,
    block: (s) => canonicalAutomation({ ...s, kind: 'block' }),
    app: canonicalApp,
    webpage: canonicalWebpage,
    datatable: canonicalDatatable,
    agent: canonicalAgent,
    skill: canonicalSkill,
    document: canonicalDocument,
    knowledge_base: canonicalKnowledgeBase,
    knowledge_listing: canonicalListing,
    reference_rows: canonicalReferenceRows,
};

/**
 * The canonical payload of one part. Pure. `shape` is a manifest-shaped
 * entity (camelCase; the store's snake_case is read too).
 *
 * @param {string} kind  a part kind (`automation`, `app`, …) or a section name
 * @param {object} shape
 */
function canonicalOf(kind, shape) {
    const k = KIND_OF_SECTION[kind] || kind;
    const fn = CANONICAL[k];
    if (!fn) throw new TypeError(`canonicalOf: unknown kind '${kind}'`);
    return fn(isObject(shape) ? shape : {});
}

/** The hash a stamp records: `sha256:<hex>` of the canonical payload. */
function hashPayload(payload) {
    return hashOf(payload);
}

// ── readStagePayload ──────────────────────────────────────────────────────────

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
const dbOf = (deps, client) => client || dep(deps, 'db', () => {
    const db = require('../../db');
    return { query: (sql, params) => db.run(sql, params) };
});
const rowsOf = (res) => (Array.isArray(res) ? res : (res && res.rows) || []);

async function readAutomation(id, opts, deps) {
    return dep(deps, 'automationStore', () => require('../../stores/automationStore')).getAutomation(id);
}

async function readApp(id, opts, deps) {
    const app = await dep(deps, 'studioAppStore', () => require('../../stores/studioAppStore')).getStudioApp(id);
    if (!app) return null;
    const meta = await dep(deps, 'studioAppDataStore', () => require('../../stores/studioAppDataStore'))
        .getDataModel(id, app.userId);
    return { ...app, dataModel: meta ? meta.model : null };
}

/** The page as its audience reads it: the PINNED snapshot's slots (D16). */
async function readWebpage(id, opts, deps) {
    const store = dep(deps, 'webpageStore', () => require('../../stores/webpageStore'));
    const page = await store.getWebpageRaw(id);
    if (!page) return null;
    const versionId = opts.versionId || page.publishedVersionId || null;
    const [files, bridgeGrants] = await Promise.all([
        store.readAllSlots(page.userId, id, versionId),
        store.getBridgeGrants(id),
    ]);
    return { ...page, files, bridgeGrants };
}

async function datatableRow(id, opts, deps) {
    const res = await dbOf(deps, opts.client).query('SELECT * FROM datatables WHERE id = $1', [id]);
    const row = rowsOf(res)[0];
    if (!row) return null;
    return dep(deps, 'datatableStore', () => require('../../stores/datatableStore'))._rowToDatatable(row);
}

async function readDatatable(id, opts, deps) {
    const row = await datatableRow(id, opts, deps);
    if (!row) return null;
    const meta = await dep(deps, 'datatableStore', () => require('../../stores/datatableStore')).getTableMeta(row.scope, id);
    return {
        id, key: row.key, logicalKey: row.logicalKey || null, name: row.name, description: row.description, rowScope: row.rowScope,
        lawfulBasis: row.lawfulBasis || null, scope: row.scope,
        // The mirror source is an applied setting (a stage binding), outside the canonical payload.
        source: row.source || null,
        fields: meta && Array.isArray(meta.fields) ? meta.fields : [],
        retiredFields: meta && Array.isArray(meta.retired_fields) ? meta.retired_fields : [],
        // The model entry itself: the plan fingerprints it and diffs against it.
        descriptor: meta || null,
    };
}

async function readAgent(id, opts, deps) {
    return dep(deps, 'agentStore', () => require('../../stores/agentStore')).getAgent(id);
}

async function readSkill(id, opts, deps) {
    return rowsOf(await dbOf(deps, opts.client).query('SELECT * FROM skills WHERE id = $1', [id]))[0] || null;
}

/** A template; with `opts.versionId` the content of that revision (the pin a fill_document step holds). */
async function readDocument(id, opts, deps) {
    const q = dbOf(deps, opts.client);
    const row = rowsOf(await q.query('SELECT * FROM studio_documents WHERE id = $1', [id]))[0];
    if (!row) return null;
    if (!opts.versionId) return row;
    const v = rowsOf(await q.query(
        'SELECT * FROM studio_document_versions WHERE id = $1 AND document_id = $2', [opts.versionId, id],
    ))[0];
    if (!v) return null;
    const snapshot = typeof v.snapshot === 'string' ? JSON.parse(v.snapshot) : v.snapshot;
    return { ...row, ...(snapshot || { body_html: v.body_html, css: v.css }) };
}

async function readKnowledgeBase(id, opts, deps) {
    return dep(deps, 'kbStore', () => require('../../stores/knowledgeBases')).getKB(id);
}

async function readListing(id, opts, deps) {
    const rows = rowsOf(await dbOf(deps, opts.client).query(
        `SELECT content_hash FROM documents
          WHERE knowledge_base_id = $1::uuid AND status = ANY($2::text[]) AND content_hash IS NOT NULL`,
        [id, ['processed', 'redacted']],
    ));
    return { contentHashes: rows.map(r => r.content_hash) };
}

/** Every row of a stage table through the compiler, as reference rows travel. */
async function defaultReadTableRows(descriptor, scope) {
    const queryCompiler = require('../../core/dataEngine/queryCompiler');
    const datatableDbStore = require('../../stores/datatableDbStore');
    const key = datatableDbStore.scopeKey(scope);
    const out = [];
    let cursor = null;
    for (;;) {
        const compiled = queryCompiler.compileRecordList(descriptor, {
            sort: { field: 'id', dir: 'asc' }, limit: 1000, cursor, dialect: 'pg',
        }, { where: 'TRUE', params: [] });
        const page = rowsOf(await datatableDbStore.query(key, key, compiled.sql, compiled.params));
        const more = page.length > compiled.limit;
        const kept = more ? page.slice(0, compiled.limit) : page;
        out.push(...kept);
        if (!more || !kept.length) return out;
        cursor = queryCompiler.encodeCursor(kept[kept.length - 1].id, kept[kept.length - 1].id);
    }
}

async function readReferenceRows(id, opts, deps) {
    const row = await datatableRow(id, opts, deps);
    if (!row) return null;
    const descriptor = await dep(deps, 'datatableStore', () => require('../../stores/datatableStore')).getTableMeta(row.scope, id);
    if (!descriptor) return null;
    const rows = await dep(deps, 'readTableRows', () => defaultReadTableRows)(descriptor, row.scope);
    return { rows: require('./referenceRows').canonicalRows(descriptor, rows) };
}

const READERS = {
    automation: readAutomation,
    block: readAutomation,
    app: readApp,
    webpage: readWebpage,
    datatable: readDatatable,
    agent: readAgent,
    skill: readSkill,
    document: readDocument,
    knowledge_base: readKnowledgeBase,
    knowledge_listing: readListing,
    reference_rows: readReferenceRows,
};

/**
 * Read a stored stage part back into its manifest shape, or null when it is
 * gone. `deps.readers[kind]` replaces one reader whole.
 */
async function readStageShape(kind, id, opts = {}, deps = {}) {
    const k = KIND_OF_SECTION[kind] || kind;
    const custom = deps && deps.readers && deps.readers[k];
    const reader = typeof custom === 'function' ? custom : READERS[k];
    if (!reader) throw new TypeError(`readStagePayload: unknown kind '${kind}'`);
    if (typeof id !== 'string' || !id) return null;
    return reader(id, opts || {}, deps || {});
}

/**
 * The canonical payload of a stored stage part, or null when it is gone.
 *
 * @param {string} kind
 * @param {string} id  the stage entity id
 * @param {{ client?: any, versionId?: string|null }} [opts]  `client` reads
 *   inside the caller's transaction where a reader uses SQL; `versionId`
 *   reads that page snapshot / template revision instead of the pinned one
 * @param {object} [deps]  stores and `readers` doubles
 */
async function readStagePayload(kind, id, opts = {}, deps = {}) {
    const shape = await readStageShape(kind, id, opts, deps);
    return shape ? canonicalOf(kind, shape) : null;
}

module.exports = {
    KIND_OF_SECTION, SECTION_OF_KIND, PAYLOAD_KINDS,
    canonicalOf, hashPayload, readStagePayload, readStageShape,
};
