/**
 * App Studio data model — validateDataModel: the whole-model gate (tables,
 * fields, relations, computed expressions, roles and the directory block).
 */

'use strict';

const { isPlainObject } = require('./shared');
const {
    FIELD_TYPES,
    DATA_LIMITS,
    SYSTEM_COLUMNS,
    KEY_RE,
    RESERVED_KEY_PREFIX_RE,
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    TABLE_SOURCE_KEYS,
    DATATABLE_ID_RE,
} = require('./vocabulary');
const { validateConnectors } = require('./connectorValidate');

/**
 * De VORM van `table.source` — waar de rijen van deze tabel staan.
 *
 * Afwezig (of null) betekent: de app bezit haar eigen opslag. Dat is de soort
 * die er altijd al was, dus die tak zwijgt en er verandert niets aan bestaande
 * modellen.
 *
 * Alles wat er wél staat wordt bij naam beoordeeld. Geen enkele tak repareert
 * stilzwijgend: een onbekende `mode` naar 'read' duwen zou een typefout in een
 * recht veranderen dat niemand heeft aangevraagd, en de auteur zou een tabel
 * zien die "readwrite" heet en niet schrijft. Een ONTBREKENDE mode is iets
 * anders — daar is nooit om gevraagd, en canonicalizeDataModel vult daar 'read'
 * in voordat dit draait.
 *
 * @returns {string[]} foutmeldingen (leeg = in orde)
 */
function tableSourceErrors(source, where) {
    if (source === undefined || source === null) return [];
    if (!isPlainObject(source)) {
        return [`${where}.source must be an object { kind, datatableId, mode }`];
    }
    const errors = [];
    if (!TABLE_SOURCE_KINDS.includes(source.kind)) {
        errors.push(`${where}.source.kind ${JSON.stringify(source.kind)} is not a known table source kind (${TABLE_SOURCE_KINDS.join(', ')})`);
    }
    if (typeof source.datatableId !== 'string' || !DATATABLE_ID_RE.test(source.datatableId)) {
        errors.push(`${where}.source.datatableId ${JSON.stringify(source.datatableId)} must match tbl_<hex>`);
    }
    if (!TABLE_SOURCE_MODES.includes(source.mode)) {
        errors.push(`${where}.source.mode ${JSON.stringify(source.mode)} must be one of: ${TABLE_SOURCE_MODES.join(', ')}`);
    }
    // Een sleutel die hier niet hoort is een sleutel waarvan iemand dacht dat
    // hij iets deed. Stil negeren is hoe een `readOnly: true` er ingeschakeld
    // uitziet en niets doet. Zelfde regel als model.directory.
    const extra = Object.keys(source).filter((k) => !TABLE_SOURCE_KEYS.includes(k));
    if (extra.length) errors.push(`${where}.source has unknown keys: ${extra.join(', ')}`);
    return errors;
}

// Conservative computed-expression guard: string, bounded, no statement
// terminators or comment sequences that could smuggle extra SQL into DDL.
function computedExprError(expr) {
    if (typeof expr !== 'string' || !expr.trim()) return 'computed.expr must be a non-empty string';
    if (expr.length > DATA_LIMITS.MAX_COMPUTED_EXPR) return `computed.expr exceeds ${DATA_LIMITS.MAX_COMPUTED_EXPR} chars`;
    if (/;|--|\/\*|\*\//.test(expr)) return 'computed.expr may not contain ";", "--", or block comments';
    return null;
}

/**
 * Validate a data model. Returns { errors, warnings } — arrays of message
 * strings. Errors block persistence; warnings are advisory (canonicalize
 * repairs most of them).
 */
function validateDataModel(model) {
    const errors = [];
    const warnings = [];

    if (!isPlainObject(model)) {
        return { errors: ['model must be an object'], warnings };
    }
    if (model.modelVersion !== undefined && model.modelVersion !== 1) {
        errors.push(`unsupported modelVersion ${model.modelVersion} (expected 1)`);
    }
    if (!Array.isArray(model.tables)) {
        return { errors: [...errors, 'model.tables must be an array'], warnings };
    }
    if (model.tables.length > DATA_LIMITS.MAX_TABLES_PER_APP) {
        errors.push(`too many tables: ${model.tables.length} > ${DATA_LIMITS.MAX_TABLES_PER_APP}`);
    }

    // Build the id/key catalog up front so relations can resolve targets.
    const tableIds = new Set();
    const tableKeys = new Set();
    const tableIdSet = new Set(model.tables.filter(isPlainObject).map(t => t.id));
    // A LINKED table (source.kind 'datatable') may carry a relation field that
    // still names the Studio datatable it points at — a Nextcloud mirror's
    // relation to the mirror of another table arrives that way. It resolves
    // when THAT datatable is linked into this app too; the model table linking
    // it is the target. The compiler never sees this: reads of a linked table
    // compile against the datatable's own descriptor (dataReadRunner.readPlan).
    const linkedDatatableIds = new Set(model.tables.filter(isPlainObject)
        .map(t => t.source && typeof t.source === 'object' ? t.source.datatableId : null)
        .filter(id => typeof id === 'string' && id));

    for (const [ti, table] of model.tables.entries()) {
        const where = `tables[${ti}]`;
        if (!isPlainObject(table)) { errors.push(`${where} must be an object`); continue; }

        if (typeof table.id !== 'string' || !/^tbl_[a-z0-9]{4,}$/.test(table.id)) {
            errors.push(`${where}.id must match tbl_<hex>`);
        } else if (tableIds.has(table.id)) {
            errors.push(`${where}.id "${table.id}" is duplicated`);
        } else { tableIds.add(table.id); }

        if (typeof table.key !== 'string' || !KEY_RE.test(table.key)) {
            errors.push(`${where}.key "${table.key}" must match ${KEY_RE}`);
        } else if (RESERVED_KEY_PREFIX_RE.test(table.key)) {
            errors.push(`${where}.key "${table.key}" may not start with a reserved engine prefix (pg_, sqlite_)`);
        } else if (tableKeys.has(table.key)) {
            errors.push(`${where}.key "${table.key}" is duplicated`);
        } else { tableKeys.add(table.key); }

        if (typeof table.name === 'string' && table.name.length > DATA_LIMITS.MAX_NAME_LEN) {
            errors.push(`${where}.name exceeds ${DATA_LIMITS.MAX_NAME_LEN} chars`);
        }

        // Tabelbron — additief: zonder `source` verandert er niets.
        errors.push(...tableSourceErrors(table.source, where));

        if (!Array.isArray(table.fields)) { errors.push(`${where}.fields must be an array`); continue; }
        if (table.fields.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
            errors.push(`${where} has too many fields: ${table.fields.length} > ${DATA_LIMITS.MAX_FIELDS_PER_TABLE}`);
        }

        const fieldIds = new Set();
        const fieldKeys = new Set();
        for (const [fi, field] of table.fields.entries()) {
            const fw = `${where}.fields[${fi}]`;
            if (!isPlainObject(field)) { errors.push(`${fw} must be an object`); continue; }

            if (typeof field.id !== 'string' || !/^fld_[a-z0-9]{4,}$/.test(field.id)) {
                errors.push(`${fw}.id must match fld_<hex>`);
            } else if (fieldIds.has(field.id)) {
                errors.push(`${fw}.id "${field.id}" is duplicated`);
            } else { fieldIds.add(field.id); }

            if (typeof field.key !== 'string' || !KEY_RE.test(field.key)) {
                errors.push(`${fw}.key "${field.key}" must match ${KEY_RE}`);
            } else if (RESERVED_KEY_PREFIX_RE.test(field.key)) {
                errors.push(`${fw}.key "${field.key}" may not start with a reserved engine prefix (pg_, sqlite_)`);
            } else if (SYSTEM_COLUMNS.includes(field.key)) {
                errors.push(`${fw}.key "${field.key}" collides with a reserved system column`);
            } else if (fieldKeys.has(field.key)) {
                errors.push(`${fw}.key "${field.key}" is duplicated`);
            } else { fieldKeys.add(field.key); }

            if (!FIELD_TYPES.includes(field.type)) {
                errors.push(`${fw}.type "${field.type}" is not a known field type`);
                continue;
            }

            if (field.type === 'select' || field.type === 'multiselect') {
                if (!Array.isArray(field.options)) {
                    errors.push(`${fw} (${field.type}) requires an options array`);
                } else if (field.options.length > DATA_LIMITS.MAX_SELECT_OPTIONS) {
                    errors.push(`${fw} has too many options: ${field.options.length} > ${DATA_LIMITS.MAX_SELECT_OPTIONS}`);
                }
            }

            if (field.type === 'relation') {
                if (!isPlainObject(field.relation) || typeof field.relation.table !== 'string') {
                    errors.push(`${fw} (relation) requires relation.table`);
                } else if (!tableIdSet.has(field.relation.table)) {
                    if (table.source && linkedDatatableIds.has(field.relation.table)) {
                        // resolves through the model table that links that datatable
                    } else if (table.source && /^tbl_[a-z0-9]{4,}$/.test(field.relation.table)) {
                        errors.push(`${fw}.relation.table "${field.relation.table}" is a Studio table this app does not link — link it as a table too, or drop the relation field from the copy`);
                    } else {
                        errors.push(`${fw}.relation.table "${field.relation.table}" does not resolve to a table in this model`);
                    }
                }
            }

            if (field.type === 'computed') {
                if (!isPlainObject(field.computed)) {
                    errors.push(`${fw} (computed) requires a computed descriptor`);
                } else {
                    const ce = computedExprError(field.computed.expr);
                    if (ce) errors.push(`${fw}.${ce}`);
                    if (field.computed.stored === true && (field.required || field.unique)) {
                        warnings.push(`${fw}: stored computed columns ignore required/unique`);
                    }
                }
            }
        }
    }

    // roles / roleMapping — shape checks only (RLS gateway enforces semantics).
    if (model.roles !== undefined) {
        if (!Array.isArray(model.roles)) errors.push('model.roles must be an array');
        else for (const [ri, role] of model.roles.entries()) {
            if (!isPlainObject(role) || typeof role.key !== 'string' || !KEY_RE.test(role.key)) {
                errors.push(`roles[${ri}].key must match ${KEY_RE}`);
            }
        }
    }
    if (model.roleMapping !== undefined && !isPlainObject(model.roleMapping)) {
        errors.push('model.roleMapping must be an object');
    }

    validateConnectors(model, errors);

    if (model.directory !== undefined) {
        if (!isPlainObject(model.directory)) {
            errors.push('model.directory must be an object { orgMembers: boolean }');
        } else {
            if (model.directory.orgMembers !== undefined && typeof model.directory.orgMembers !== 'boolean') {
                errors.push('model.directory.orgMembers must be true or false');
            }
            // Anything else here is a key someone expected to mean something.
            // Silently ignoring it is how a `orgMembers: "yes"` or a hopeful
            // `includeEmail: true` ends up looking enabled and doing nothing.
            const extra = Object.keys(model.directory).filter((k) => k !== 'orgMembers');
            if (extra.length) errors.push(`model.directory has unknown keys: ${extra.join(', ')}`);
        }
    }

    return { errors, warnings };
}

module.exports = { validateDataModel, _tableSourceErrors: tableSourceErrors };
