/**
 * App Studio — validate an app definition before save / publish.
 *
 * Assumes canonicalize.js ran first (defaults filled, sloppy shapes repaired)
 * but never crashes on raw garbage — every check degrades to a structured
 * error instead. Record shape matches automation/validate.js:
 *
 *   { code, severity: 'error'|'warning', path, message, hint }
 *
 * Reference-resolution philosophy mirrors the automation validator: broken
 * STRUCTURE is an error; a field mapping whose input name doesn't resolve is
 * only a warning (the runtime resolves it to undefined safely, and it
 * shouldn't stop the user from saving a draft).
 *
 * opts.ownedDocuments (optional) — the owner's designed documents, so a
 *   fill_document step naming one they do not have is refused where it is
 *   written rather than at publish.
 * opts.ownedAutomations (optional, publish-time) — array of
 * { id, userId, isActive } or a Map keyed by id. When provided, every
 * run_automation.automationId must exist there and be active.
 *
 * opts.dataModel (optional) — the app's CANONICAL data model (dataModel.js
 * shape), or null when the app has no model yet. When present (i.e. not
 * undefined), every table/dataset/field reference in bindings and sequence
 * steps is cross-checked against it: binding.unknown_table /
 * binding.unknown_dataset / binding.unknown_field and step.unknown_table /
 * step.unknown_field. opts.datasets supplies the dataset ids (array of ids or
 * { id } records, or a Set). opts.dataRefsAsWarnings demotes those
 * data-reference findings to warnings (human draft saves must stay saveable);
 * publish passes them as hard errors. When opts.dataModel is undefined the
 * checks are skipped entirely — existing callers are untouched.
 *
 * opts.datatables (optional) — de Studio-datatabel-ids die de app-EIGENAAR
 * heeft (array van ids of { id }-records, of een Set). Een modeltabel kan haar
 * rijen uit zo'n datatabel halen (model.tables[].source); is deze lijst er,
 * dan is een datatableId die er niet in staat een harde fout MET de id erin
 * (binding.unknown_datatable). Is de lijst er NIET, dan is het een
 * waarschuwing — ook met de id erin. Stil overslaan gebeurt in geen van beide
 * gevallen: dat levert een app op die publiceert en een leeg scherm toont.
 */

'use strict';

const {
    ID_RE,
    SCHEMA_VERSION_CURRENT,
    LIMITS,
    expandStyleKnobs,
    sectionHeightIsDefinite,
    VARIABLE_TYPES,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    coerceVariableDefault,
    SCREEN_SPEC,
    SECTION_STYLE_KNOBS,
    DESIGN_SPEC,
    NAV_STYLES,
    MAX_NAV_GROUPS,
    MAX_NAV_GROUP_LABEL,
} = require('./componentSpecs');
const { collectVariableWrites } = require('./collectVariableRefs');
const { validateTheme } = require('../core/cms/themeSpec');
const { isObject } = require('./validate/shared');
const {
    validateRoleRefs,
    validateAdvancedSizing,
    validateNode,
    collectReferencedActions,
} = require('./validate/nodes');
const { validateAction, DATASET_QUERY_OUTPUTS } = require('./validate/actions');

const ID_HINT = 'Ids must match <prefix>_<4-12 lowercase alphanumerics> with prefix scr/sec/cmp/act. Use newId() from componentSpecs.';

// ---------------------------------------------------------------------------
// Cheap iterative counts for the LIMITS ceilings — runs before the deep walk
// so pathological blobs never reach the O(n) per-node checks.
// ---------------------------------------------------------------------------

function countTree(screens) {
    let total = 0; // sections + components across the whole app
    const stack = [];
    for (const screen of screens) {
        if (!isObject(screen) || !Array.isArray(screen.sections)) continue;
        for (const section of screen.sections) {
            if (!isObject(section)) continue;
            total++;
            if (Array.isArray(section.children)) stack.push(section.children);
        }
    }
    while (stack.length) {
        const arr = stack.pop();
        for (const node of arr) {
            if (!isObject(node)) continue;
            total++;
            if (total > LIMITS.MAX_TOTAL_NODES) return total; // already tripped — stop counting
            if (Array.isArray(node.children)) stack.push(node.children);
        }
    }
    return total;
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

function normalizeOwnedAutomations(owned) {
    if (!owned) return null;
    if (owned instanceof Map) return owned;
    if (Array.isArray(owned)) {
        const map = new Map();
        for (const rec of owned) {
            if (isObject(rec) && typeof rec.id === 'string') map.set(rec.id, rec);
        }
        return map;
    }
    return null;
}

/**
 * opts.ownedDocuments → documentId → record, or null.
 *
 * Accepts the catalog shape builderDocumentCatalog produces
 * ({ id, name, placeholders }) as well as a ready Map, so the builder can hand
 * over exactly what it already has.
 */
function normalizeOwnedDocuments(owned) {
    if (!owned) return null;
    if (owned instanceof Map) return owned;
    if (Array.isArray(owned)) {
        const map = new Map();
        for (const rec of owned) {
            if (isObject(rec) && typeof rec.id === 'string') map.set(rec.id, rec);
        }
        return map;
    }
    return null;
}

// opts.knownTables / opts.knownDatasets → a Set of ids (publish-gate), or null
// (draft — references are warned, not errored). Accepts a Set, an array of
// strings, or an array of { id } records.
function normalizeIdSet(known) {
    if (!known) return null;
    if (known instanceof Set) return known;
    if (Array.isArray(known)) {
        const set = new Set();
        for (const x of known) {
            if (typeof x === 'string') set.add(x);
            else if (isObject(x) && typeof x.id === 'string') set.add(x.id);
        }
        return set;
    }
    return null;
}

// opts.dataModel → Map(tableId → Set(fieldKeys)), or null when the option was
// not supplied at all (checks skipped). A null/malformed model yields an
// EMPTY map — the app has no tables, so every reference is unknown.
function buildDataTables(dataModel) {
    if (dataModel === undefined) return null;
    const map = new Map();
    const tables = isObject(dataModel) && Array.isArray(dataModel.tables) ? dataModel.tables : [];
    for (const t of tables) {
        if (!isObject(t) || typeof t.id !== 'string' || !t.id) continue;
        const fields = new Set();
        for (const f of (Array.isArray(t.fields) ? t.fields : [])) {
            if (isObject(f) && typeof f.key === 'string' && f.key) fields.add(f.key);
        }
        map.set(t.id, fields);
    }
    return map;
}

/**
 * opts.dataModel → Map(tableId → source) voor de tabellen die een `source`
 * DRAGEN, en null als de optie niet is meegegeven.
 *
 * Alleen de tweede soort staat erin. Een tabel met eigen opslag heeft geen
 * `source`, en `Map.get` geeft daar dus undefined — precies het antwoord "deze
 * tabel is van de app zelf". Een `source` die geen object is blijft er WEL in
 * staan: die moet gemeld worden, niet stilzwijgend als eigen opslag gelezen.
 */
function buildTableSources(dataModel) {
    if (dataModel === undefined) return null;
    const map = new Map();
    const tables = isObject(dataModel) && Array.isArray(dataModel.tables) ? dataModel.tables : [];
    for (const t of tables) {
        if (!isObject(t) || typeof t.id !== 'string' || !t.id) continue;
        if (t.source === undefined || t.source === null) continue;
        map.set(t.id, t.source);
    }
    return map;
}

// opts.dataModel.connectors → a Set of connector ids (data-model mode only;
// null when opts.dataModel was not supplied, so connector refs are warned not
// errored). A null/malformed model yields an EMPTY set — every ref is unknown.
function buildConnectorIds(dataModel) {
    if (dataModel === undefined) return null;
    const set = new Set();
    const connectors = isObject(dataModel) && Array.isArray(dataModel.connectors) ? dataModel.connectors : [];
    for (const c of connectors) {
        if (isObject(c) && typeof c.id === 'string' && c.id) set.add(c.id);
    }
    return set;
}

// The subset that can actually send mail. A send_email step pointed at a REST
// connector would validate against dataConnectors and then fail at runtime with
// nothing an author could act on.
function buildMailboxConnectorIds(dataModel) {
    if (dataModel === undefined) return null;
    const set = new Set();
    const connectors = isObject(dataModel) && Array.isArray(dataModel.connectors) ? dataModel.connectors : [];
    for (const c of connectors) {
        if (isObject(c) && c.kind === 'mailbox' && typeof c.id === 'string' && c.id) set.add(c.id);
    }
    return set;
}

// def.roles → a Set of role ids, validating the { id, name } shape.
function validateRolesAndCollect(def, pushE) {
    const ids = new Set();
    if (def.roles === undefined) return ids;
    if (!Array.isArray(def.roles)) {
        pushE({ code: 'roles.invalid', severity: 'error', path: 'roles', message: 'roles must be an array of { id, name }.', hint: 'Use [] when the app has no roles.' });
        return ids;
    }
    if (def.roles.length > LIMITS.MAX_ROLES) {
        pushE({ code: 'roles.too_many', severity: 'error', path: 'roles', message: `App declares ${def.roles.length} roles — the maximum is ${LIMITS.MAX_ROLES}.`, hint: 'Remove unused roles.' });
    }
    def.roles.forEach((role, i) => {
        if (!isObject(role) || typeof role.id !== 'string' || !role.id) {
            pushE({ code: 'role.invalid', severity: 'error', path: `roles[${i}]`, message: 'Each role needs a non-empty string id.', hint: 'Use { id, name }.' });
            return;
        }
        if (ids.has(role.id)) {
            pushE({ code: 'role.duplicate', severity: 'error', path: `roles[${i}].id`, message: `Duplicate role id ${JSON.stringify(role.id)}.`, hint: 'Role ids must be unique.' });
            return;
        }
        ids.add(role.id);
    });
    return ids;
}

/**
 * definition.variables — structure only. Runs BEFORE the deep walk, because
 * validateFormula consults the resulting name set while walking.
 *
 * This is the defensive gate for canonical bytes handed in directly (the same
 * role the design/nav checks play): canonicalize repairs or drops anything
 * malformed, so in the normal save path none of these fire.
 */
function validateVariablesAndCollect(def, pushE) {
    const declared = new Map();
    if (def.variables === undefined) return declared;
    if (!Array.isArray(def.variables)) {
        pushE({ code: 'variables.invalid', severity: 'error', path: 'variables', message: 'variables must be an array of { name, label, type, default, description }.', hint: 'Omit the key entirely when the app has no variables.' });
        return declared;
    }
    if (def.variables.length > LIMITS.MAX_VARIABLES) {
        pushE({ code: 'variables.too_many', severity: 'error', path: 'variables', message: `App declares ${def.variables.length} variables — the maximum is ${LIMITS.MAX_VARIABLES}.`, hint: 'Remove unused variables.' });
    }
    def.variables.forEach((v, i) => {
        const path = `variables[${i}]`;
        if (!isObject(v) || typeof v.name !== 'string' || !v.name) {
            pushE({ code: 'variable.invalid', severity: 'error', path, message: 'Each variable needs a non-empty string name.', hint: 'Use { name, label, type, default, description }.' });
            return;
        }
        if (!VARIABLE_NAME_RE.test(v.name)) {
            pushE({ code: 'variable.name_invalid', severity: 'error', path: `${path}.name`, message: `Variable name ${JSON.stringify(v.name)} is not usable.`, hint: 'It has to be a single word a formula can write as vars.<name>: a letter or _ first, then letters, digits or _.' });
            return;
        }
        if (RESERVED_VARIABLE_NAMES.includes(v.name)) {
            pushE({ code: 'variable.name_reserved', severity: 'error', path: `${path}.name`, message: `${JSON.stringify(v.name)} is reserved.`, hint: v.name === 'filters' ? 'vars.filters belongs to the filter bar component — add a filter_bar and read vars.filters.<field>.' : 'true, false and null are literals, not names.' });
            return;
        }
        if (declared.has(v.name)) {
            pushE({ code: 'variable.duplicate', severity: 'error', path: `${path}.name`, message: `Duplicate variable ${JSON.stringify(v.name)}.`, hint: 'Variable names must be unique.' });
            return;
        }
        if (!VARIABLE_TYPES.includes(v.type)) {
            pushE({ code: 'variable.type_invalid', severity: 'error', path: `${path}.type`, message: `Unknown variable type ${JSON.stringify(v.type)}.`, hint: `Use one of: ${VARIABLE_TYPES.join(', ')}.` });
            return;
        }
        const { value, coerced } = coerceVariableDefault(v.type, v.default);
        if (coerced) {
            pushE({ code: 'variable.default_invalid', severity: 'error', path: `${path}.default`, message: `Starting value for ${JSON.stringify(v.name)} does not match its type (${v.type}).`, hint: `Expected ${v.type}; canonicalize would have adjusted it to ${JSON.stringify(value)}.` });
        }
        declared.set(v.name, v);
    });
    return declared;
}

function validateAppDefinition(def, opts = {}) {
    const errors = [];
    const warnings = [];
    const pushE = (rec) => errors.push(rec);
    const pushW = (rec) => warnings.push(rec);

    if (!isObject(def)) {
        return {
            ok: false,
            errors: [{ code: 'shape.not_object', severity: 'error', path: '', message: 'Definition must be an object.', hint: 'Pass the JSON produced by canonicalizeAppDefinition.' }],
            warnings: [],
        };
    }

    // ── Basic shape ──────────────────────────────────────────────────────
    // Validation assumes canonical (post-migrate) input: the current schema.
    if (def.schemaVersion !== SCHEMA_VERSION_CURRENT) {
        pushE({ code: 'shape.schema_version', severity: 'error', path: 'schemaVersion', message: `schemaVersion must be ${SCHEMA_VERSION_CURRENT} (got ${JSON.stringify(def.schemaVersion)}).`, hint: 'Run the definition through canonicalize (it migrates v1 → v2).' });
    }
    const metaName = isObject(def.meta) ? def.meta.name : undefined;
    if (typeof metaName !== 'string' || !metaName.trim()) {
        pushE({ code: 'meta.name_missing', severity: 'error', path: 'meta.name', message: 'meta.name must be a non-empty string.', hint: 'Give the app a name.' });
    } else if (metaName.length > LIMITS.MAX_NAME_LEN) {
        pushE({ code: 'meta.name_too_long', severity: 'error', path: 'meta.name', message: `meta.name is ${metaName.length} chars — the maximum is ${LIMITS.MAX_NAME_LEN}.`, hint: 'Shorten the name.' });
    }
    const screens = Array.isArray(def.screens) ? def.screens : [];
    if (!Array.isArray(def.screens) || def.screens.length === 0) {
        pushE({ code: 'screens.missing', severity: 'error', path: 'screens', message: '`screens` must be a non-empty array.', hint: 'An app needs at least one screen.' });
    }
    const actionsObj = isObject(def.actions) ? def.actions : null;
    if (def.actions !== undefined && actionsObj === null) {
        pushE({ code: 'actions.invalid', severity: 'error', path: 'actions', message: '`actions` must be an object map of { actionId: action }.', hint: 'Run the definition through canonicalize.' });
    }

    // ── LIMITS ceilings (fail fast — skip the deep walk on abuse) ────────
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(def), 'utf8'); }
    catch {
        pushE({ code: 'shape.unserializable', severity: 'error', path: '', message: 'Definition is not JSON-serializable.', hint: 'Remove circular references / non-JSON values.' });
        return { ok: false, errors, warnings };
    }
    const capErrorsBefore = errors.length;
    if (bytes > LIMITS.MAX_DEFINITION_BYTES) {
        pushE({ code: 'shape.too_large', severity: 'error', path: '', message: `Definition is ${bytes} bytes — the maximum is ${LIMITS.MAX_DEFINITION_BYTES}.`, hint: 'Trim large static values; bind data from automations instead of inlining it.' });
    }
    if (screens.length > LIMITS.MAX_SCREENS) {
        pushE({ code: 'shape.too_many_screens', severity: 'error', path: 'screens', message: `App has ${screens.length} screens — the maximum is ${LIMITS.MAX_SCREENS}.`, hint: 'Merge or remove screens.' });
    }
    screens.forEach((screen, i) => {
        if (isObject(screen) && Array.isArray(screen.sections) && screen.sections.length > LIMITS.MAX_SECTIONS_PER_SCREEN) {
            pushE({ code: 'screen.too_many_sections', severity: 'error', path: `screens[${i}].sections`, message: `Screen has ${screen.sections.length} sections — the maximum is ${LIMITS.MAX_SECTIONS_PER_SCREEN}.`, hint: 'Merge sections.' });
        }
    });
    const totalNodes = countTree(screens);
    if (totalNodes > LIMITS.MAX_TOTAL_NODES) {
        pushE({ code: 'shape.too_many_nodes', severity: 'error', path: '', message: `App has more than ${LIMITS.MAX_TOTAL_NODES} sections + components.`, hint: 'Split the app or remove components.' });
    }
    const actionCount = actionsObj ? Object.keys(actionsObj).length : 0;
    if (actionCount > LIMITS.MAX_ACTIONS) {
        pushE({ code: 'shape.too_many_actions', severity: 'error', path: 'actions', message: `App has ${actionCount} actions — the maximum is ${LIMITS.MAX_ACTIONS}.`, hint: 'Remove unused actions.' });
    }
    if (errors.length > capErrorsBefore) return { ok: false, errors, warnings };

    // ── Id collection: format + GLOBAL uniqueness ─────────────────────────
    const idSeen = new Map(); // id → path of first occurrence
    const checkId = (id, path, what) => {
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            pushE({ code: 'id.format', severity: 'error', path, message: `${what} id ${JSON.stringify(id)} is invalid.`, hint: ID_HINT });
        } else if (idSeen.has(id)) {
            pushE({ code: 'id.duplicate', severity: 'error', path, message: `Duplicate id "${id}" (first used at ${idSeen.get(id)}) — ids are globally unique.`, hint: 'Re-key one of the entities with newId().' });
        } else {
            idSeen.set(id, path);
        }
    };

    const screenIds = new Set();
    const actionIds = new Set();
    // Actions first so node event checks can resolve against them.
    if (actionsObj) {
        for (const key of Object.keys(actionsObj)) {
            checkId(key, `actions.${key}`, 'Action');
            if (typeof key === 'string') actionIds.add(key);
        }
    }
    const collectNodeIds = (node, path, depth) => {
        if (!isObject(node) || depth > LIMITS.MAX_DEPTH + 1) return;
        checkId(node.id, `${path}.id`, 'Component');
        if (Array.isArray(node.children)) node.children.forEach((c, i) => collectNodeIds(c, `${path}.children[${i}]`, depth + 1));
    };
    screens.forEach((screen, si) => {
        if (!isObject(screen)) return;
        checkId(screen.id, `screens[${si}].id`, 'Screen');
        if (typeof screen.id === 'string') screenIds.add(screen.id);
        if (!Array.isArray(screen.sections)) return;
        screen.sections.forEach((section, ci) => {
            if (!isObject(section)) return;
            checkId(section.id, `screens[${si}].sections[${ci}].id`, 'Section');
            if (Array.isArray(section.children)) {
                section.children.forEach((n, ni) => collectNodeIds(n, `screens[${si}].sections[${ci}].children[${ni}]`, 2));
            }
        });
    });

    // ── homeScreenId ──────────────────────────────────────────────────────
    if (screens.length && !screenIds.has(def.homeScreenId)) {
        pushE({ code: 'home.unresolved', severity: 'error', path: 'homeScreenId', message: `homeScreenId ${JSON.stringify(def.homeScreenId)} does not resolve to a screen.`, hint: 'Point it at one of the screen ids.' });
    }

    // ── design / nav (App Design v2 — OPTIONAL top-level keys) ────────────
    // Canonicalize already normalizes these; validation here is the defensive
    // gate for canonical bytes handed in directly, mirroring the theme checks.
    if (def.design !== undefined) {
        if (!isObject(def.design)) {
            pushE({ code: 'design.invalid', severity: 'error', path: 'design', message: 'design must be an object.', hint: `Use the keys: ${Object.keys(DESIGN_SPEC).join(', ')}.` });
        } else {
            for (const [key, value] of Object.entries(def.design)) {
                const spec = DESIGN_SPEC[key];
                if (!spec) {
                    pushE({ code: 'design.unknown_key', severity: 'error', path: `design.${key}`, message: `Unknown design key "${key}".`, hint: `Use one of: ${Object.keys(DESIGN_SPEC).join(', ')}.` });
                } else if (spec.type === 'enum' && !spec.values.includes(value)) {
                    pushE({ code: 'design.value_invalid', severity: 'error', path: `design.${key}`, message: `design.${key} must be one of ${spec.values.join(', ')}.`, hint: `Got ${JSON.stringify(value)}.` });
                } else if (spec.type === 'url' && value !== null
                    && (typeof value !== 'string' || !/^https:\/\//.test(value) || value.length > spec.maxLen)) {
                    pushE({ code: 'design.value_invalid', severity: 'error', path: `design.${key}`, message: `design.${key} must be null or an https:// URL of at most ${spec.maxLen} characters.`, hint: 'Upload the logo somewhere reachable and paste its https URL.' });
                }
            }
        }
    }
    if (def.nav !== undefined) {
        if (!isObject(def.nav)) {
            pushE({ code: 'nav.invalid', severity: 'error', path: 'nav', message: 'nav must be an object.', hint: 'Use { style, groups? }.' });
        } else {
            if (!NAV_STYLES.includes(def.nav.style)) {
                pushE({ code: 'nav.value_invalid', severity: 'error', path: 'nav.style', message: `nav.style must be one of ${NAV_STYLES.join(', ')}.`, hint: `Got ${JSON.stringify(def.nav.style)}.` });
            }
            if (def.nav.groups !== undefined) {
                if (!Array.isArray(def.nav.groups) || def.nav.groups.length > MAX_NAV_GROUPS) {
                    pushE({ code: 'nav.groups_invalid', severity: 'error', path: 'nav.groups', message: `nav.groups must be an array of at most ${MAX_NAV_GROUPS} groups.`, hint: 'Each group is { id, label, icon, screens }.' });
                } else {
                    const screenByIdForNav = new Map(screens.filter(isObject).map((s) => [s.id, s]));
                    def.nav.groups.forEach((g, i) => {
                        const p = `nav.groups[${i}]`;
                        if (!isObject(g) || typeof g.label !== 'string' || !g.label
                            || g.label.length > MAX_NAV_GROUP_LABEL || !Array.isArray(g.screens)) {
                            pushE({ code: 'nav.group_invalid', severity: 'error', path: p, message: `Nav group must be { id, label (≤${MAX_NAV_GROUP_LABEL} chars), icon, screens[] }.`, hint: 'Give the group a short label and at least one screen.' });
                            return;
                        }
                        g.screens.forEach((sid) => {
                            const target = screenByIdForNav.get(sid);
                            if (!target) {
                                pushE({ code: 'nav.screen_unresolved', severity: 'error', path: `${p}.screens`, message: `Nav group "${g.label}" references unknown screen ${JSON.stringify(sid)}.`, hint: 'Point it at one of the screen ids.' });
                            } else if (target.showInNav === false) {
                                // Presentation contradiction, not a breakage: the
                                // group names a screen the nav is told to hide.
                                pushW({ code: 'nav.group_screen_hidden', severity: 'warning', path: `${p}.screens`, message: `Nav group "${g.label}" lists screen "${target.name || sid}", which has showInNav: false.`, hint: 'Either show the screen in navigation or drop it from the group.' });
                            }
                        });
                    });
                }
            }
        }
    }

    // ── Roles (v2 — key list; refs elsewhere resolve against these) ───────
    const roleIds = validateRolesAndCollect(def, pushE);
    const declaredVars = validateVariablesAndCollect(def, pushE);
    // Writes must be known BEFORE the walk: validateFormula consults the
    // set while walking to decide whether a `vars.<name>` read is a typo.
    const varWrites = collectVariableWrites(def);
    // The check stays OFF for an app that declares nothing, so no existing
    // app gains a warning it did not have before this feature.
    const knownVars = declaredVars.size
        ? new Set([...declaredVars.keys(), ...varWrites.names, ...RESERVED_VARIABLE_NAMES])
        : null;

    // ── Deep walk: screens → sections → nodes ─────────────────────────────
    const ctx = {
        pushE,
        pushW,
        actionIds,
        screenIds,
        roleIds,
        knownVars,
        knownVarList: knownVars ? [...knownVars].filter((n) => n !== 'true' && n !== 'false' && n !== 'null').sort() : null,
        varReads: new Set(),
        modalIds: new Set(),
        formIds: new Set(),
        inputNamesByForm: new Map(),
        allInputNames: new Set(),
        ownedAutomations: normalizeOwnedAutomations(opts.ownedAutomations),
        // The OWNER's designed documents, for a fill_document step's id. Same
        // three-way meaning as ownedAutomations: null = the caller could not
        // tell (draft; references are not checked), a map = check against it.
        ownedDocuments: normalizeOwnedDocuments(opts.ownedDocuments),
        knownTables: normalizeIdSet(opts.knownTables),
        knownDatasets: normalizeIdSet(opts.knownDatasets),
        // Data-model mode (opts.dataModel !== undefined): tableId → Set of
        // field keys, plus the known dataset ids. null model = "no model yet"
        // (every table/dataset reference is unknown). See the module header.
        dataTables: buildDataTables(opts.dataModel),
        // De tweede tabelsoort: tableId → model.tables[].source. Leeg voor een
        // app waarvan elke tabel haar eigen opslag heeft, en dat is de enige
        // vorm die vandaag bestaat — vandaar dat niets aan de bestaande soort
        // verandert.
        dataTableSources: buildTableSources(opts.dataModel),
        // De Studio-datatabellen die de EIGENAAR heeft. Anders dan opts.datasets
        // krijgt deze GEEN lege verzameling als hij ontbreekt: "geen lijst" en
        // "een lege lijst" zijn verschillende antwoorden, en de tweede zou elke
        // gekoppelde tabel afkeuren van een aanroeper die de vraag niet eens
        // gesteld heeft. Zonder lijst meldt checkTableSource de id bij naam als
        // waarschuwing; mét lijst is het een harde fout.
        knownDatatables: normalizeIdSet(opts.datatables),
        dataDatasets: opts.dataModel !== undefined ? (normalizeIdSet(opts.datasets) || new Set()) : null,
        // Connector ids ride on the data model itself (model.connectors[]), so
        // the publish gate — which already passes opts.dataModel — verifies them
        // with no extra plumbing. binding.unknown_connector mirrors dataset.
        dataConnectors: buildConnectorIds(opts.dataModel),
        dataMailboxConnectors: buildMailboxConnectorIds(opts.dataModel),
        dataRefsAsWarnings: !!opts.dataRefsAsWarnings,
        // The per-app AI-browsing opt-in (HUMAN-set — see canonicalize).
        // Consulted per ai_browse step: a step in an app whose flag is off is
        // an authoring error the builder must surface, not a runtime surprise.
        aiBrowsingEnabled: def.aiBrowsing?.enabled === true,
    };

    screens.forEach((screen, si) => {
        const sp = `screens[${si}]`;
        if (!isObject(screen)) {
            pushE({ code: 'screen.not_object', severity: 'error', path: sp, message: 'Each screen must be an object.', hint: 'Remove the malformed entry.' });
            return;
        }
        if (typeof screen.name !== 'string' || !screen.name.trim()) {
            pushE({ code: 'screen.name_missing', severity: 'error', path: `${sp}.name`, message: 'Screen needs a non-empty name.', hint: 'It labels the nav entry.' });
        }
        if (screen.kind !== undefined && screen.kind !== null && !SCREEN_SPEC.kind.values.includes(screen.kind)) {
            pushE({ code: 'screen.kind_invalid', severity: 'error', path: `${sp}.kind`, message: `screen.kind ${JSON.stringify(screen.kind)} is not legal.`, hint: `Use ${SCREEN_SPEC.kind.values.filter((v) => v).map((v) => JSON.stringify(v)).join(', ')} or omit it.` });
        }
        if (screen.visibleToRoles !== undefined) validateRoleRefs(screen.visibleToRoles, `${sp}.visibleToRoles`, ctx);
        if (!Array.isArray(screen.sections)) {
            pushE({ code: 'screen.sections_invalid', severity: 'error', path: `${sp}.sections`, message: '`sections` must be an array.', hint: 'Every screen is a vertical stack of sections.' });
            return;
        }
        screen.sections.forEach((section, ci) => {
            const secPath = `${sp}.sections[${ci}]`;
            if (!isObject(section)) {
                pushE({ code: 'section.not_object', severity: 'error', path: secPath, message: 'Each section must be an object.', hint: 'Remove the malformed entry.' });
                return;
            }
            if (!Array.isArray(section.children)) {
                pushE({ code: 'section.children_invalid', severity: 'error', path: `${secPath}.children`, message: 'Section `children` must be an array.', hint: 'Use [] for an empty section.' });
                return;
            }
            // A section's own sizing, then what it hands its children. The
            // section knob list has no `span`, so only the height pair applies.
            const sectionKnobs = expandStyleKnobs(SECTION_STYLE_KNOBS);
            if (isObject(section.style)) {
                validateAdvancedSizing(section.style, `${secPath}.style`, ctx, {
                    what: 'the section', allowedKnobs: sectionKnobs,
                    parentHeightDefinite: false, parentLabel: 'screen', isSection: true,
                });
            }
            // A section IS the grid its children sit in — no wrapper in
            // between — so its own height is what they measure against, and
            // 'fill' counts here (the screen grows the full-height chain above
            // a fill section). 'always' is therefore the right route: whatever
            // height a section has, its children get.
            const sectionParent = {
                label: 'section',
                heightDefinite: sectionHeightIsDefinite(section.style),
                heightRoute: 'always',
            };
            section.children.forEach((node, ni) => validateNode(node, `${secPath}.children[${ni}]`, 2, null, ctx, sectionParent));
        });
    });

    // ── Actions (after the walk — mapping checks need the input names) ────
    if (actionsObj) {
        for (const [id, action] of Object.entries(actionsObj)) {
            validateAction(id, action, `actions.${id}`, ctx);
        }

        // An action nothing can reach. Not an error — an app may keep one around
        // while it is being wired up — but it is invisible, and "the button that
        // was never added" looks exactly like "the feature that does not work".
        // The support desk shipped with an assign action wired to nothing, so
        // its "My queue" screen was permanently empty and there was no way to
        // put anything in it.
        const reached = collectReferencedActions(screens);
        for (const id of Object.keys(actionsObj)) {
            if (reached.has(id)) continue;
            pushW({
                code: 'action.unreachable', severity: 'warning', path: `actions.${id}`,
                message: `Action "${id}" is not wired to anything — no button, row or event can run it.`,
                hint: 'Wire it to a component event (onClick / onRowClick / onSubmit) or a row action, or remove it.',
            });
        }
    }

    // A write to a name no formula can read. `set_variable.name = "my var"`
    // lands in vars["my var"], while `vars.my var` is a parse error — so the
    // value is computed, stored, and never arrives anywhere. A WARNING, never
    // an error: published apps may already contain such a name, and they must
    // keep publishing.
    for (const { name, path, kind } of varWrites.invalid) {
        pushW({
            code: 'variable.write_unreferenceable', severity: 'warning', path,
            message: `${kind} writes "${name}", which no formula can read (vars.${name} is not a valid expression).`,
            hint: 'Use a single word: a letter or _ first, then letters, digits or _.',
        });
    }

    // Declared, but nothing reads it and nothing writes it. Same family as
    // action.unreachable: a thing that exists and does nothing reads as a
    // feature that is broken rather than one that was never finished.
    for (const [name] of declaredVars) {
        if (ctx.varReads.has(name) || varWrites.names.has(name)) continue;
        pushW({
            code: 'variable.unused', severity: 'warning', path: 'variables',
            message: `Variable "${name}" is declared but nothing reads or writes it.`,
            hint: 'Use it in a formula or a "Set a variable" step, or remove it.',
        });
    }

    // ── approval_list on a publicly shared screen (warning) ──────────────
    // Not a leak — the component shows anonymous visitors a static sign-in
    // wall and performs no fetch, and the API behind it is session-authed
    // with canView scoping. It IS a UX trap: a decide surface placed where
    // the audience can never decide. Say so at author time.
    if (isObject(def.publicAccess)) {
        // The page's own look (publicAccess.theme / .design) speaks the app
        // theme's and design's vocabulary, so it gets their checks — partial
        // by design, and never `preset` (provenance, not a knob).
        const pa = def.publicAccess;
        if (pa.theme !== undefined) {
            if (!isObject(pa.theme)) {
                pushE({ code: 'publicAccess.theme_invalid', severity: 'error', path: 'publicAccess.theme', message: 'publicAccess.theme must be an object of theme knobs.', hint: 'e.g. { canvas: "#ffda00", accent: "#009b3e" } — name only what differs from the app theme.' });
            } else {
                for (const issue of validateTheme(pa.theme, 'publicAccess.theme')) {
                    pushE({ code: `publicAccess.${issue.code}`, severity: 'error', path: issue.path, message: issue.message, hint: issue.hint });
                }
            }
        }
        if (pa.design !== undefined) {
            if (!isObject(pa.design)) {
                pushE({ code: 'publicAccess.design_invalid', severity: 'error', path: 'publicAccess.design', message: 'publicAccess.design must be an object of design knobs.', hint: `Use the keys: ${Object.keys(DESIGN_SPEC).filter((k) => k !== 'preset').join(', ')}.` });
            } else {
                for (const [key, value] of Object.entries(pa.design)) {
                    const spec = key === 'preset' ? null : DESIGN_SPEC[key];
                    if (!spec) {
                        pushE({ code: 'publicAccess.design_unknown_key', severity: 'error', path: `publicAccess.design.${key}`, message: `Unknown design key "${key}" on the public page.`, hint: `Use one of: ${Object.keys(DESIGN_SPEC).filter((k) => k !== 'preset').join(', ')}.` });
                    } else if (value === null) {
                        continue; // "no override for this knob"
                    } else if (spec.type === 'enum' && !spec.values.includes(value)) {
                        pushE({ code: 'publicAccess.design_value_invalid', severity: 'error', path: `publicAccess.design.${key}`, message: `publicAccess.design.${key} must be one of ${spec.values.join(', ')}.`, hint: `Got ${JSON.stringify(value)}.` });
                    } else if (spec.type === 'url' && !(typeof value === 'string' && /^https:\/\//.test(value) && value.length <= spec.maxLen)) {
                        pushE({ code: 'publicAccess.design_value_invalid', severity: 'error', path: `publicAccess.design.${key}`, message: `publicAccess.design.${key} must be an https:// URL of at most ${spec.maxLen} characters.`, hint: 'Upload the logo somewhere reachable and paste its https URL.' });
                    }
                }
            }
        }
        const publicIds = new Set(
            [def.publicAccess.entryScreenId, ...(Array.isArray(def.publicAccess.screenIds) ? def.publicAccess.screenIds : [])]
                .filter((id) => typeof id === 'string' && id));
        const holdsApprovalList = (nodes) => (Array.isArray(nodes) ? nodes : []).some(
            (n) => isObject(n) && (n.type === 'approval_list' || holdsApprovalList(n.children)));
        for (const screen of (Array.isArray(def.screens) ? def.screens : [])) {
            if (!isObject(screen) || !publicIds.has(screen.id)) continue;
            if ((Array.isArray(screen.sections) ? screen.sections : []).some((s) => isObject(s) && holdsApprovalList(s.children))) {
                pushW({
                    code: 'publicAccess.approval_list_walled', severity: 'warning', path: `screens.${screen.id}`,
                    message: `Screen "${screen.name || screen.id}" is publicly shared but contains an Approvals component — anonymous visitors only ever see a sign-in wall there.`,
                    hint: 'Move the component to a members-only screen, or drop the screen from publicAccess.screenIds.',
                });
            }
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
    validateAppDefinition,
    // The reachability walk, shared with appStudio/publicAccess.js so "which
    // actions can this set of screens run?" has ONE answer. A second copy is
    // exactly how a public surface drifts wider than the validated one.
    collectReferencedActions,
    // The dataset_query writeTo vocabulary — shared with datasetQueryStep so
    // the executor's row shape and the validator's list cannot drift.
    DATASET_QUERY_OUTPUTS,
};
