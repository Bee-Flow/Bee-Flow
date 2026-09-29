/**
 * App Studio — capture a LIVE app as a reusable template.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now a template could only be born as CODE: a module in
 * appStudio/templates/ baked into the API image by `COPY . .`. That is the
 * right home for the twenty templates the product ships, and the wrong home for
 * the template a customer wants of the app they just built — it would mean a
 * rebuild and a release to hand someone a copy of their own work.
 *
 * So this module reads an app the way it actually exists (definition + data
 * model + the rows worth keeping + datasets) and produces a template object of
 * EXACTLY the shape templates.js entries have — same keys, same install path.
 * A captured template goes through templateInstall.installTemplate like every
 * built-in one. There is no second installer and no "import a definition blob"
 * back door.
 *
 * WHAT GETS SCRUBBED, AND WHY EACH ONE
 * ------------------------------------
 * A running app is full of references that mean something HERE and nothing in
 * the app somebody installs from it. Carrying them over would produce a
 * template that looks fine and is quietly broken:
 *
 *   • run_automation.automationId → null. Every shipped template does this
 *     (templates.js says so): the installer wires their own routine, and
 *     validate.js reports the friendly `action.automation_unset` warning that
 *     the editor renders as a "connect a routine" checklist. A real routine id
 *     from another user's instance is worse than useless — it is a dangling
 *     pointer with a plausible shape.
 *   • Seed rows lose the SYSTEM columns (id / created_at / created_by / org_id):
 *     templateInstall writes every row through actionExecutor.writeRecord,
 *     which stamps those itself. A captured created_by is one user's id being
 *     handed to a different user.
 *   • Seed rows lose `file` fields. A file value points at a row in
 *     studio_app_attachments belonging to THIS app; the bytes do not travel
 *     with the template, so the value would resolve to nothing.
 *   • Seed rows lose `computed` fields — derived by definition, and a stored
 *     computed column is written by the engine, not by the seed.
 *   • Relations become { $ref } aliases. A relation holds a real rec_ id, which
 *     is meaningless in the installed copy; templateInstall already knows how
 *     to rewrite { $ref: alias } to the newly-seeded parent's id, so capture
 *     emits that shape and drops any reference to a row it did not capture.
 *
 * WHAT DOES NOT GET SCRUBBED, DELIBERATELY
 * ----------------------------------------
 * `connectorId` stays as authored. In the shipped templates it is a STABLE
 * NAME (`conn_qimail`, `conn_sdmail`), not an opaque id — the app carries the
 * connector's identity and the installer supplies its credentials. Rewriting it
 * would break the app it was captured from on the next round-trip. Instead
 * every connector the definition references comes back as a `requires` entry so
 * whoever installs the template is told what to connect, rather than finding
 * out when a mailbox screen renders empty.
 *
 * DATA IS OPT-IN, PER TABLE
 * -------------------------
 * `seedTables` is a list of table ids, never a boolean. That is the whole
 * design: the app this was written for holds 65 materials and a 24-row portal
 * column map (vocabulary — the reason MAX_SEED_ROWS_PER_TABLE was raised to
 * 100) in the same model as its customers' purchase orders, e-mail bodies and
 * internal notes. An `includeData: true` flag would ship both. Naming tables
 * makes shipping personal data something you have to ask for by name.
 *
 * THE GATE
 * --------
 * captureTemplate canonicalizes and validates before it returns anything, with
 * the captured data model and dataset ids passed in so the data-reference
 * cross-checks actually resolve. A capture with validation ERRORS is refused —
 * templates.test.js holds every built-in template to exactly that bar, and a
 * user-made one that installs broken would be a worse experience than not
 * having the feature.
 */

'use strict';

const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { canonicalizeDataModel, SYSTEM_COLUMNS } = require('./dataModel');
const log = require('../telemetry/log');

// Mirrors templateInstall.MAX_SEED_ROWS_PER_TABLE. Kept as a default rather
// than a require so the pure half of this module loads without the store graph;
// captureFromApp passes the installer's own constant in, and
// templateCapture.test.js asserts the two still agree.
const DEFAULT_MAX_SEED_ROWS = 100;

// A captured template is a JSONB row. The definition ceiling is enforced by the
// store; this is the belt-and-braces cap on the WHOLE payload (definition +
// model + seed + datasets) so a 100-row × 10-table seed cannot produce a
// template nothing can load.
const MAX_TEMPLATE_BYTES = 4 * 1024 * 1024;

const FIELD_TYPES_NEVER_SEEDED = new Set(['file', 'computed']);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deepClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/**
 * Walk every object in a definition, depth-first, calling `fn` on each. Used
 * for the scrub + reference sweeps: the same id can appear on an action, on a
 * sequence step, or on a component prop, and a walker means adding a rule does
 * not mean finding all three places again.
 */
function walkObjects(node, fn) {
    if (Array.isArray(node)) {
        for (const item of node) walkObjects(item, fn);
        return;
    }
    if (!isObject(node)) return;
    fn(node);
    for (const value of Object.values(node)) walkObjects(value, fn);
}

/**
 * Null out every automation reference, and report how many were cut so the
 * result can say "3 routines need connecting" instead of staying silent about
 * an app that will not run until someone notices.
 */
function scrubAutomationIds(definition) {
    const cut = [];
    walkObjects(definition, (obj) => {
        if (obj.kind === 'run_automation' && typeof obj.automationId === 'string' && obj.automationId) {
            cut.push(obj.automationId);
            obj.automationId = null;
        }
    });
    return cut;
}

/** Every connector the definition points at — a prop, a step or an action. */
function collectConnectorIds(definition) {
    const ids = new Set();
    walkObjects(definition, (obj) => {
        if (typeof obj.connectorId === 'string' && obj.connectorId) ids.add(obj.connectorId);
    });
    return [...ids];
}

/**
 * Knowledge bases the definition points at — instance-specific, like routines.
 *
 * Both spellings: `knowledgeBaseIds` (an AI step grounding itself, an App
 * Studio action) and the singular `knowledgeBaseId` a `knowledge_write` step
 * carries. The list is what `requires` reports and what scrub then blanks, so a
 * spelling missed here is a base the installer is never asked to pick.
 */
function collectKnowledgeBaseIds(definition) {
    const ids = new Set();
    walkObjects(definition, (obj) => {
        if (Array.isArray(obj.knowledgeBaseIds)) {
            for (const id of obj.knowledgeBaseIds) if (typeof id === 'string' && id) ids.add(id);
        }
        if (obj.type === 'knowledge_write' && typeof obj.knowledgeBaseId === 'string' && obj.knowledgeBaseId) {
            ids.add(obj.knowledgeBaseId);
        }
    });
    return [...ids];
}

/** Dataset ids reached through a `{ kind:'dataset', datasetId }` binding. */
function collectDatasetBindingIds(definition) {
    const ids = new Set();
    walkObjects(definition, (obj) => {
        if (obj.kind === 'dataset' && typeof obj.datasetId === 'string' && obj.datasetId) ids.add(obj.datasetId);
    });
    return [...ids];
}

/**
 * Turn one live row into a seed row.
 *
 * `capturedIds` maps a real rec_ id → the alias it was captured under, so a
 * relation to a row that IS in this capture becomes { $ref: alias } and a
 * relation to one that is not becomes null (an honest empty, not a pointer
 * into a database the installer cannot see).
 */
function toSeedRow(row, table, capturedIds) {
    const fieldsByKey = new Map(
        (Array.isArray(table.fields) ? table.fields : []).map((f) => [f.key, f]),
    );
    const out = {};
    for (const [key, value] of Object.entries(isObject(row) ? row : {})) {
        if (SYSTEM_COLUMNS.includes(key)) continue;
        const field = fieldsByKey.get(key);
        if (!field) continue;                                   // dropped column, stale read
        if (FIELD_TYPES_NEVER_SEEDED.has(field.type)) continue;  // files/computed never travel
        if (value === undefined) continue;
        if (field.type === 'relation') {
            const alias = (typeof value === 'string' && value) ? capturedIds.get(value) : null;
            out[key] = alias ? { $ref: alias } : null;
            continue;
        }
        out[key] = value;
    }
    return out;
}

/**
 * Build the { [tableId]: Row[] } seed block from rows already read out of the
 * app, and the alias map that makes relations resolvable.
 *
 * `rowsByTable` is { [tableId]: liveRow[] }. Aliases are positional and stable
 * (`<tableKey>_1`), which keeps a captured template readable when someone opens
 * it — an opaque id tells a reader nothing about which row it is.
 */
function buildSeed(model, rowsByTable, maxRows) {
    const tables = Array.isArray(model && model.tables) ? model.tables : [];
    const capturedIds = new Map(); // real rec_ id → alias
    const seed = {};
    const counts = {};

    // Two passes: every alias must exist before any relation is rewritten, or a
    // child captured before its parent would lose the link for no reason.
    for (const table of tables) {
        const rows = (Array.isArray(rowsByTable[table.id]) ? rowsByTable[table.id] : []).slice(0, maxRows);
        rows.forEach((row, i) => {
            const id = row && typeof row.id === 'string' ? row.id : null;
            if (id) capturedIds.set(id, `${table.key}_${i + 1}`);
        });
    }

    for (const table of tables) {
        const rows = (Array.isArray(rowsByTable[table.id]) ? rowsByTable[table.id] : []).slice(0, maxRows);
        if (!rows.length) continue;
        seed[table.id] = rows.map((row) => {
            const values = toSeedRow(row, table, capturedIds);
            const alias = row && typeof row.id === 'string' ? capturedIds.get(row.id) : null;
            // $id is only worth carrying when something can point AT this row.
            return alias ? { $id: alias, ...values } : values;
        });
        counts[table.id] = seed[table.id].length;
    }

    return { seed, counts };
}

/**
 * The OTHER way a seed arrives: already written down, in the shape buildSeed
 * emits, read out of a file somebody handed us (templatePortability.js).
 *
 * buildSeed turns live rows into a seed and can trust every one of them — they
 * came out of this installation's own database, through the compiled-query and
 * RLS path, one field at a time. This function starts from a blob of JSON with
 * no provenance at all, so it re-decides every question buildSeed answered:
 * which tables exist, which columns exist, which field types may be seeded, and
 * which relation values mean anything here.
 *
 * The rule that matters most is the relation one. A relation value must be a
 * `{ $ref }` at an alias THIS FILE declares; anything else — most of all a bare
 * `rec_…` string, which is what a relation looks like in the database it came
 * from — becomes null. templateInstall.resolveSeedRow resolves a `$ref` against
 * a GLOBAL alias map, which is why the alias set is collected across every
 * table before any row is judged: a child listed before its parent still has to
 * resolve.
 *
 * Nothing here throws. A row that cannot be made sense of is dropped and
 * counted, because a template that installs minus three rows is worth more than
 * a refusal, and the count is reported rather than swallowed.
 *
 * `fileRefs` is the ONE thing a caller may widen, and only one caller does.
 * A template never carries files — bytes are not a blueprint — so the default
 * is null and a `file` column is dropped exactly as `computed` is. An APP
 * ARCHIVE (appPortability.js) does carry them, and hands in the set of refs its
 * own `files` block declares; a `{ $file }` at a ref outside that set is as
 * meaningless as a `{ $ref }` at an alias the file does not have, and is
 * emptied for the same reason. Widening it here rather than writing a second
 * row-rebuilder keeps ONE list of what a value may be per field type: the two
 * formats disagree about files and about nothing else, so that is the only
 * place they are allowed to differ.
 */
function normalizeSeed(model, rawSeed, maxRows, { fileRefs = null } = {}) {
    const tables = Array.isArray(model && model.tables) ? model.tables : [];
    const byId = new Map(tables.map((t) => [t.id, t]));
    const seed = {};
    const counts = {};
    const dropped = { tables: [], fields: [], rows: 0, refs: 0, files: 0, duplicateAliases: 0 };

    // Pass 1 — apply the per-table ceiling, then collect every alias the
    // SURVIVING rows declare. Capping first matters: an alias on a row that the
    // ceiling cuts is not an alias this seed has.
    const kept = new Map();
    const aliases = new Set();
    for (const [tableId, rows] of Object.entries(isObject(rawSeed) ? rawSeed : {})) {
        if (!byId.has(tableId)) {
            dropped.tables.push(tableId);
            continue;
        }
        const list = (Array.isArray(rows) ? rows : []).filter(isObject);
        dropped.rows += Math.max(0, (Array.isArray(rows) ? rows.length : 0) - list.length);
        dropped.rows += Math.max(0, list.length - maxRows);
        const capped = list.slice(0, maxRows);
        kept.set(tableId, capped);
        for (const row of capped) {
            if (typeof row.$id !== 'string' || !row.$id) continue;
            if (aliases.has(row.$id)) dropped.duplicateAliases += 1;
            aliases.add(row.$id);
        }
    }

    // Pass 2 — rebuild each row from the table's own field list.
    for (const [tableId, rows] of kept) {
        const table = byId.get(tableId);
        const out = rows.map((row) => normalizeSeedRow(row, table, aliases, dropped, fileRefs));
        if (!out.length) continue;
        seed[tableId] = out;
        counts[tableId] = out.length;
    }

    return { seed, counts, dropped };
}

/** One untrusted seed row, rebuilt against its table. See normalizeSeed. */
function normalizeSeedRow(row, table, aliases, dropped, fileRefs = null) {
    const fieldsByKey = new Map(
        (Array.isArray(table.fields) ? table.fields : []).map((f) => [f.key, f]),
    );
    const alias = (typeof row.$id === 'string' && row.$id) ? row.$id : null;
    const values = {};
    for (const [key, value] of Object.entries(row)) {
        if (key === '$id') continue;
        if (SYSTEM_COLUMNS.includes(key)) { dropped.fields.push(`${table.key}.${key}`); continue; }
        const field = fieldsByKey.get(key);
        if (!field) { dropped.fields.push(`${table.key}.${key}`); continue; }
        // A file column, when the caller carries files. The value that means
        // something is `{ $file: ref }` and nothing else — a stored descriptor
        // (`{ kind:'studio_attachment', fileId }`) names a ledger row in the
        // database this file came out of, so letting one through would write a
        // pointer into a store this installation cannot read, and the preview
        // would 404 forever rather than say so once.
        if (field.type === 'file' && fileRefs) {
            const fref = (isObject(value) && typeof value.$file === 'string') ? value.$file : null;
            if (fref && fileRefs.has(fref)) { values[key] = { $file: fref }; continue; }
            if (value !== null && value !== undefined) dropped.files += 1;
            values[key] = null;
            continue;
        }
        if (FIELD_TYPES_NEVER_SEEDED.has(field.type)) { dropped.fields.push(`${table.key}.${key}`); continue; }
        if (value === undefined) continue;
        const ref = (isObject(value) && typeof value.$ref === 'string') ? value.$ref : null;
        if (field.type === 'relation') {
            if (ref && aliases.has(ref)) { values[key] = { $ref: ref }; continue; }
            // A relation this file cannot resolve is an honest empty. A bare
            // string here is a rec_ id from the source database and is never
            // carried across, whatever it looks like.
            if (value !== null) dropped.refs += 1;
            values[key] = null;
            continue;
        }
        // `$ref` is resolved by templateInstall on ANY key, not just relation
        // ones. On a text or number column that would quietly write a record id
        // into a field the author meant as a word, so it is refused here rather
        // than resolved there.
        if (ref) { dropped.refs += 1; values[key] = null; continue; }
        values[key] = value;
    }
    return alias ? { $id: alias, ...values } : values;
}

/**
 * `seedPeople` — the declaration templateInstall reads to deal a demo board out
 * to the installer's real colleagues. Small, and worth carrying: without it an
 * imported sprint board arrives assigned to people who do not exist.
 *
 * It names tables and fields, so it is checked against the model rather than
 * copied: a half that points at a table or a column this template does not have
 * would make applySeedPeople a no-op at best, and it is better to say so now.
 * Each half stands or falls on its own.
 */
function normalizeSeedPeople(spec, model) {
    if (!isObject(spec)) return { seedPeople: null, dropped: [] };
    const tables = Array.isArray(model && model.tables) ? model.tables : [];
    const byId = new Map(tables.map((t) => [t.id, t]));
    const dropped = [];

    const half = (name, value, fields) => {
        if (!isObject(value)) return null;
        const table = byId.get(value.tableId);
        if (!table) { dropped.push(`${name} (no table ${value.tableId})`); return null; }
        const keys = new Set((Array.isArray(table.fields) ? table.fields : []).map((f) => f.key));
        const out = { tableId: table.id };
        for (const [field, required] of Object.entries(fields)) {
            const key = value[field];
            if (typeof key !== 'string' || !key) {
                if (required) { dropped.push(`${name} (no ${field})`); return null; }
                continue;
            }
            if (!keys.has(key)) {
                if (required) { dropped.push(`${name} (${table.key} has no ${key})`); return null; }
                continue;
            }
            out[field] = key;
        }
        return out;
    };

    const roster = half('roster', spec.roster, { nameField: true, emailField: false });
    const assign = half('assign', spec.assign, { idField: true, nameField: true, emailField: false });
    if (!roster && !assign) return { seedPeople: null, dropped };
    return {
        seedPeople: { ...(roster ? { roster } : {}), ...(assign ? { assign } : {}) },
        dropped,
    };
}

/** Trim + cap a string field, returning null when nothing is left. */
function cleanStr(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/** Tag list: strings only, deduped, capped. */
function cleanTags(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const tag of value) {
        const clean = cleanStr(tag, 40);
        if (clean && !out.includes(clean)) out.push(clean);
        if (out.length >= 8) break;
    }
    return out;
}

/**
 * captureTemplate — the pure half. Everything it needs is passed in; it does no
 * I/O, so the interesting rules are testable without a database.
 *
 * TWO SEED INPUTS, ONE GATE. `rowsByTable` is a capture from this database;
 * `seed` is a seed already written down, which is how an IMPORTED file arrives
 * (templatePortability.js). They are mutually exclusive and `seed` wins, because
 * the one caller that passes it has no live rows to read. Everything after the
 * seed is built — the scrub, the canonicalize, the validate, the ceiling, the
 * `requires` list — is deliberately shared: a template that came out of a file
 * has to clear exactly the bar a template captured from an app clears, and the
 * surest way to guarantee that is for there to be one piece of code that says
 * what the bar is.
 *
 * @param {object}   opts
 * @param {object}   opts.definition   the app's CURRENT definition
 * @param {object?}  opts.dataModel    the app's data model (tables/fields/roles)
 * @param {object?}  opts.rowsByTable  { [tableId]: liveRow[] } for seeded tables only
 * @param {object?}  opts.seed         { [tableId]: seedRow[] } already in seed shape
 * @param {object?}  opts.seedPeople   demo-people declaration, checked against the model
 * @param {object[]} opts.datasets     dataset rows to carry as descriptors
 * @param {object}   opts.meta         { id, title, description, category, icon, tags, version }
 * @param {number?}  opts.maxSeedRows  per-table seed ceiling
 * @returns {{ok:true, template, report}|{ok:false, errors:string[]}}
 */
function captureTemplate({
    definition,
    dataModel = null,
    rowsByTable = {},
    seed: presetSeed = null,
    seedPeople = null,
    datasets = [],
    meta = {},
    maxSeedRows = DEFAULT_MAX_SEED_ROWS,
} = {}) {
    const title = cleanStr(meta.title, 80);
    if (!title) return { ok: false, errors: ['A title is required for the template.'] };
    if (!isObject(definition)) return { ok: false, errors: ['The app has no definition to capture.'] };

    // Clone FIRST: everything below mutates, and the caller handed us the live
    // draft object the rest of the request is still using.
    const def = deepClone(definition);

    // Collect BEFORE scrubbing: everything reported in `requires` below has to
    // be read while it is still in the definition.
    const connectorIds = collectConnectorIds(def);
    const knowledgeBaseIds = collectKnowledgeBaseIds(def);

    // One sweep, shared with automation export and with Blueprint packaging.
    // It nulls routine references as this module always did, and additionally
    // removes the approver seats and knowledge-base references that NEITHER
    // export path used to remove — one organisation's user, group and KB ids
    // were travelling to another's install.
    const { scrubAppDefinition, RULES } = require('../projects/packaging/scrub');
    const scrubbed = scrubAppDefinition(def);
    const automationIds = scrubbed
        .filter(r => r.rule === RULES.APP_AUTOMATION_REFERENCE)
        .map(r => r.automationId);
    const approverSeatsRemoved = scrubbed.filter(r => r.rule === RULES.APP_APPROVER_IDENTITY).length;

    // The template's own meta drives the app card of anything installed from
    // it, so it carries the template's name rather than the source app's.
    def.meta = { ...(isObject(def.meta) ? def.meta : {}) , name: title };
    const description = cleanStr(meta.description, 400);
    if (description) def.meta.description = description;
    const icon = cleanStr(meta.icon, 40);
    if (icon) def.meta.icon = icon;

    const { def: canonicalDef } = canonicalizeAppDefinition(def);

    let model = null;
    if (isObject(dataModel) && Array.isArray(dataModel.tables) && dataModel.tables.length) {
        model = canonicalizeDataModel(deepClone(dataModel)).model;
    }

    const seedCeiling = Math.max(0, Math.min(DEFAULT_MAX_SEED_ROWS, maxSeedRows));
    const { seed, counts: seedCounts, dropped: seedDropped } = model
        ? (presetSeed
            ? normalizeSeed(model, presetSeed, seedCeiling)
            : { ...buildSeed(model, rowsByTable, seedCeiling), dropped: null })
        : { seed: {}, counts: {}, dropped: null };

    // Rows with no tables to put them in. Only a file can be in this state, and
    // dropping them without a word is how a template arrives looking like it
    // never had examples rather than like it lost its data model on the way.
    const orphanSeedRows = (!model && isObject(presetSeed))
        ? Object.values(presetSeed).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0)
        : 0;

    const { seedPeople: people, dropped: peopleDropped } = model
        ? normalizeSeedPeople(seedPeople, model)
        : { seedPeople: null, dropped: [] };

    const datasetDescriptors = (Array.isArray(datasets) ? datasets : []).map((d) => ({
        id: d.id,
        name: d.name,
        tableId: d.tableId ?? null,
        source: d.source ?? {},
        descriptor: d.descriptor ?? {},
        cacheTtlSeconds: d.cacheTtlSeconds,
    })).filter((d) => d.name);

    // The same gate templates.test.js applies to every built-in template.
    const validateOpts = model
        ? { dataModel: model, datasets: datasetDescriptors.map((d) => d.id).filter(Boolean) }
        : {};
    const result = validateAppDefinition(canonicalDef, validateOpts);
    if (result.errors.length) {
        return {
            ok: false,
            errors: result.errors.slice(0, 10).map((e) => `${e.code} @ ${e.path}`),
        };
    }

    const template = {
        id: meta.id || null,               // the store mints this when absent
        version: Number.isInteger(meta.version) && meta.version > 0 ? meta.version : 1,
        title,
        description: description || '',
        category: cleanStr(meta.category, 40) || 'Van je team',
        icon: icon || canonicalDef.meta?.icon || 'LayoutGrid',
        tags: cleanTags(meta.tags),
        definition: canonicalDef,
        ...(model ? { dataModel: model } : {}),
        ...(Object.keys(seed).length ? { seed } : {}),
        ...(people ? { seedPeople: people } : {}),
        ...(datasetDescriptors.length ? { datasets: datasetDescriptors } : {}),
    };

    const bytes = Buffer.byteLength(JSON.stringify(template), 'utf8');
    if (bytes > MAX_TEMPLATE_BYTES) {
        return {
            ok: false,
            errors: [`The captured template is ${Math.round(bytes / 1024)}kB, over the ${MAX_TEMPLATE_BYTES / 1024 / 1024}MB ceiling. Capture fewer seed tables.`],
        };
    }

    // Everything the installer has to supply by hand. Reported, never guessed.
    const requires = [];
    if (connectorIds.length) requires.push({ kind: 'connector', ids: connectorIds });
    if (automationIds.length) requires.push({ kind: 'automation', count: automationIds.length });
    // A COUNT, not the ids. The connector entry above carries names on purpose
    // (they are stable, and the installer supplies credentials for them); a KB
    // id is an opaque identifier of a resource in the source organisation, so
    // reporting it to the recipient would leak by the back door what the
    // definition no longer carries. The automation entry made the same call.
    if (knowledgeBaseIds.length) requires.push({ kind: 'knowledge_base', count: knowledgeBaseIds.length });
    if (approverSeatsRemoved) requires.push({ kind: 'approver', count: approverSeatsRemoved });

    const warnings = [];
    // Only the file path can drop anything here (buildSeed reads rows this
    // installation just handed it). Silence would read as "the template had no
    // rows", which is a different and much more confusing thing than "nine rows
    // in it did not belong to any column this template has".
    if (orphanSeedRows) {
        warnings.push(`${orphanSeedRows} example row(s) dropped: the file carries rows but no data model to put them in.`);
    }
    if (seedDropped) {
        if (seedDropped.tables.length) {
            warnings.push(`${seedDropped.tables.length} seed table(s) dropped: the file seeds tables this template's data model does not contain.`);
        }
        if (seedDropped.fields.length) {
            const shown = [...new Set(seedDropped.fields)].slice(0, 5).join(', ');
            warnings.push(`${seedDropped.fields.length} seed value(s) dropped — no such column, or a type that never travels (file/computed): ${shown}.`);
        }
        if (seedDropped.rows) warnings.push(`${seedDropped.rows} seed row(s) dropped (not an object, or over the ${seedCeiling}-row per-table ceiling).`);
        if (seedDropped.refs) warnings.push(`${seedDropped.refs} relation value(s) emptied: they pointed at rows this file does not carry.`);
        if (seedDropped.duplicateAliases) warnings.push(`${seedDropped.duplicateAliases} seed row(s) reuse an alias another row already claimed; a reference to it resolves to the last one seeded.`);
    }
    for (const what of peopleDropped) {
        warnings.push(`The demo-people declaration was dropped (${what}) — seeded rows keep the names the file carries.`);
    }
    const danglingDatasets = collectDatasetBindingIds(canonicalDef);
    if (danglingDatasets.length) {
        warnings.push(
            `${danglingDatasets.length} dataset binding(s) will not survive install: datasets are re-created with fresh ids, so the bindings point at ids that will not exist. Re-point them after installing.`,
        );
    }
    // Every OTHER validation warning is worth repeating to the author: the
    // template installs, but something in it is worth a second look.
    // `action.automation_unset` is excluded — it is the DESIRED state of a
    // captured template (routines are wired by the installer) and is already
    // reported once, as a count, under `requires`.
    for (const w of result.warnings) {
        if (w.code === 'action.automation_unset') continue;
        warnings.push(`${w.code} @ ${w.path}`);
        if (warnings.length >= 12) break;
    }

    return {
        ok: true,
        template,
        report: {
            screens: Array.isArray(canonicalDef.screens) ? canonicalDef.screens.length : 0,
            actions: isObject(canonicalDef.actions) ? Object.keys(canonicalDef.actions).length : 0,
            tables: model ? model.tables.length : 0,
            seededTables: seedCounts,
            seededRows: Object.values(seedCounts).reduce((a, b) => a + b, 0),
            bytes,
            requires,
            warnings,
        },
    };
}

/**
 * captureFromApp — the I/O half. Reads the app, its model, the rows for the
 * named tables and its datasets, then hands them to captureTemplate.
 *
 * Rows are read through the SAME compiled-query + RLS path app_query_data uses
 * (queryCompiler.compileRecordList with an owner access filter), not raw SQL —
 * a capture must not be able to read rows the caller could not read in the app.
 *
 * @param {object}   opts
 * @param {string}   opts.appId
 * @param {string}   opts.userId      the caller (must own/be able to edit the app)
 * @param {object}   opts.definition  the canonical draft definition
 * @param {object?}  opts.dataModel
 * @param {string[]} opts.seedTables  table IDS whose rows to capture (default none)
 * @param {object}   opts.meta
 */
async function captureFromApp({
    appId, userId, definition, dataModel = null, seedTables = [], meta = {},
} = {}) {
    const wanted = new Set((Array.isArray(seedTables) ? seedTables : []).filter((t) => typeof t === 'string' && t));
    const tables = (isObject(dataModel) && Array.isArray(dataModel.tables)) ? dataModel.tables : [];

    const unknown = [...wanted].filter((id) => !tables.some((t) => t.id === id));
    if (unknown.length) {
        return {
            ok: false,
            errors: [`Unknown seedTables id(s): ${unknown.join(', ')}.`],
            _fixHint: `Known table ids: ${tables.map((t) => `${t.id} (${t.key})`).join(', ') || '(none)'}.`,
        };
    }

    const { MAX_SEED_ROWS_PER_TABLE } = require('./templateInstall');
    const rowsByTable = {};

    if (wanted.size) {
        const queryCompiler = require('./queryCompiler');
        const rlsGateway = require('./rlsGateway');
        const studioAppDbStore = require('../stores/studioAppDbStore');
        for (const table of tables) {
            if (!wanted.has(table.id)) continue;
            try {
                const accessFilter = rlsGateway.compileAccessFilter(table, 'owner', { id: userId }, 'read');
                const { sql, params } = queryCompiler.compileRecordList(
                    table, { limit: MAX_SEED_ROWS_PER_TABLE }, accessFilter,
                );
                const out = await studioAppDbStore.query(userId, appId, sql, params);
                rowsByTable[table.id] = (Array.isArray(out.rows) ? out.rows : []).slice(0, MAX_SEED_ROWS_PER_TABLE);
            } catch (e) {
                return { ok: false, errors: [`Could not read rows from ${table.key}: ${e.message}`] };
            }
        }
    }

    let datasets = [];
    try {
        const studioAppDataStore = require('../stores/studioAppDataStore');
        datasets = await studioAppDataStore.listDatasets(appId, userId) || [];
    } catch (e) {
        // A dataset listing that will not answer must not sink the capture —
        // the definition and model are the substance.
        log.warn(`[templateCapture] dataset listing failed for ${appId}: ${e && e.message ? e.message : e}`);
    }

    return captureTemplate({
        definition,
        dataModel,
        rowsByTable,
        datasets,
        meta,
        maxSeedRows: MAX_SEED_ROWS_PER_TABLE,
    });
}

module.exports = {
    captureTemplate,
    captureFromApp,
    MAX_TEMPLATE_BYTES,
    DEFAULT_MAX_SEED_ROWS,
    // The seed half of the gate, named so templatePortability.js can describe a
    // file before deciding to install it without re-implementing any of it.
    normalizeSeed,
    normalizeSeedPeople,
    // Shared with the Solution dependency graph (projects/graph.js), which
    // reads the same definitions looking for the same references. Duplicating
    // the walk is how one of the two ends up not knowing about a place ids can
    // hide — the exact failure the scrub sweeps already learned the hard way.
    walkObjects,
    // Test-only internals.
    _walkObjects: walkObjects,
    _scrubAutomationIds: scrubAutomationIds,
    _collectConnectorIds: collectConnectorIds,
    _buildSeed: buildSeed,
    _toSeedRow: toSeedRow,
};
