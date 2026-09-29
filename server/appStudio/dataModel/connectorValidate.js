/**
 * App Studio data model — the persisted-shape gate for model.connectors[]: url
 * templates, chains, sync blocks (children + dependents) and the mailbox kind.
 */

'use strict';

const { isPlainObject } = require('./shared');
const {
    CONNECTOR_KINDS,
    MAX_CONNECTOR_ROWS,
    DATA_LIMITS,
    KEY_RE,
    CONNECTOR_ID_RE,
    CONNECTOR_PARAM_KEY_RE,
    CONNECTOR_INTEGRATION_ID_RE,
    CONNECTOR_SECRET_KEY_RE,
    MAX_CONNECTOR_PARAMS,
    MAX_CHAIN_STEPS,
    SOURCE_PATH_RE,
    CHAIN_MERGE_MODES,
    DEPENDENT_KEYS,
    SYNC_MODES,
    SYNC_INCREMENTAL_FORMATS,
    minSyncMinutes,
    MAILBOX_PROVIDERS,
    MAILBOX_MODES,
    MAILBOX_FOLDER_RE,
    MAILBOX_EMAIL_RE,
    MAX_MAILBOX_QUERY_LEN,
    MAX_MAILBOX_CONNECTORS,
    MAILBOX_KEY_FIELD,
    MAILBOX_THREAD_KEY_FIELD,
    MAX_MAILBOX_RETENTION_DAYS,
} = require('./vocabulary');

// A REST url TEMPLATE: https-only, host fixed by the owner (never templated),
// and every {placeholder} must be a declared param. Mirrors the runtime guards
// in connectors.js runRestConnector so what validates here also runs there.
function validateConnectorUrl(url, declaredKeys, where, errors) {
    let probeUrl;
    try {
        const probe = String(url).replace(/\{[a-zA-Z0-9_]+\}/g, '0');
        probeUrl = new URL(probe);
    } catch {
        errors.push(`${where}.url is not a valid https URL template`);
        return;
    }
    if (probeUrl.protocol !== 'https:') errors.push(`${where}.url must be https`);
    // The scheme://host[:port] authority may not contain a placeholder — a
    // viewer param must never be able to steer the host.
    const authorityPart = String(url).split(/[/?#]/).slice(0, 3).join('/');
    if (/\{[a-zA-Z0-9_]+\}/.test(authorityPart)) errors.push(`${where}.url may not template the host`);
    const placeholders = [...String(url).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
    for (const p of placeholders) {
        if (!declaredKeys.has(p)) errors.push(`${where}.url references undeclared param {${p}} — add it to params[]`);
    }
}

/**
 * A connector's CHAIN — follow-up actions run once per row of the previous step
 * ("read each message that search found", "download each attachment that read
 * found"). Validated here because a chain multiplies calls made with the
 * OWNER's credentials, so its shape must be bounded before it is ever persisted.
 *
 *   chain: [{ tool, argsFrom?, fixedArgs?, expand?, ownTable?, merge?, alias? }]
 *
 * `argsFrom` maps a parameter of the follow-up tool to a path on the CURRENT
 * row. Nothing here can name a credential — the same inline-secret refusal that
 * guards the top level is applied to every step's fixedArgs by the caller.
 */
function validateConnectorChain(chain, where, errors) {
    if (chain === undefined) return;
    if (!Array.isArray(chain)) { errors.push(`${where}.chain must be an array of follow-up steps`); return; }
    if (chain.length > MAX_CHAIN_STEPS) {
        errors.push(`${where}.chain has too many steps: ${chain.length} > ${MAX_CHAIN_STEPS}`);
    }
    for (const [si, step] of chain.entries()) {
        const sw = `${where}.chain[${si}]`;
        if (!isPlainObject(step)) { errors.push(`${sw} must be an object`); continue; }
        if (typeof step.tool !== 'string' || !step.tool) errors.push(`${sw} requires a tool name`);
        if (step.argsFrom !== undefined) {
            if (!isPlainObject(step.argsFrom)) {
                errors.push(`${sw}.argsFrom must be an object { param: rowPath }`);
            } else {
                for (const [param, path] of Object.entries(step.argsFrom)) {
                    if (!CONNECTOR_PARAM_KEY_RE.test(param)) {
                        errors.push(`${sw}.argsFrom key "${param}" must match ${CONNECTOR_PARAM_KEY_RE}`);
                    }
                    if (typeof path !== 'string' || !SOURCE_PATH_RE.test(path)) {
                        errors.push(`${sw}.argsFrom["${param}"] must be a field path on the previous step's rows`);
                    }
                }
            }
        }
        if (step.fixedArgs !== undefined && !isPlainObject(step.fixedArgs)) {
            errors.push(`${sw}.fixedArgs must be an object`);
        }
        if (step.expand !== undefined && step.expand !== null
            && (typeof step.expand !== 'string' || !SOURCE_PATH_RE.test(step.expand))) {
            errors.push(`${sw}.expand must be a field path to fan out over`);
        }
        // "Keep this step's result in its own table, linked to the previous
        // one." An expanding step ALREADY opens a table of its own, so the two
        // together are a contradiction rather than a stronger request — said
        // out loud instead of silently picking one.
        if (step.ownTable !== undefined && typeof step.ownTable !== 'boolean') {
            errors.push(`${sw}.ownTable must be true or false`);
        }
        if (step.ownTable === true && typeof step.expand === 'string' && step.expand) {
            errors.push(`${sw} cannot both expand and be its own table — expanding already gives it one`);
        }
        if (step.merge !== undefined && !CHAIN_MERGE_MODES.includes(step.merge)) {
            errors.push(`${sw}.merge must be one of ${CHAIN_MERGE_MODES.join(', ')}`);
        }
        if (step.merge === 'nest' && (typeof step.alias !== 'string' || !CONNECTOR_PARAM_KEY_RE.test(step.alias))) {
            errors.push(`${sw}.alias is required for merge:'nest' and must be an identifier`);
        }
    }
}

/**
 * A connector's SYNC block — "keep these rows in an app table".
 *
 * The load-bearing rule is that `sync.tableId` must resolve to a table in THIS
 * model. That single check does double duty: it rejects a dangling reference,
 * and it makes deleting a table that a connector fills a validation failure
 * instead of a silently broken sync that errors nightly.
 *
 * Runtime state (last run, watermark, cursor) deliberately lives in Postgres
 * (studio_app_connector_sync), never here — writing it into the model would
 * churn model_version under the open editor on every refresh.
 */
// `kind` is optional and trailing so every existing call site keeps working; it
// only selects the schedule floor (see minSyncMinutes). `tablesById` (also
// trailing, also optional) carries the tables' field metadata — dependents are
// validated against real columns, which a bare id-set cannot answer.
function validateConnectorSync(sync, tableIds, where, errors, kind = null, tablesById = null) {
    if (sync === undefined) return;
    if (!isPlainObject(sync)) { errors.push(`${where}.sync must be an object`); return; }

    if (typeof sync.tableId !== 'string' || !sync.tableId) {
        errors.push(`${where}.sync requires the tableId of the table it fills`);
    } else if (!tableIds.has(sync.tableId)) {
        errors.push(`${where}.sync.tableId "${sync.tableId}" is not a table in this app — the connector fills it, so it cannot be removed while the connector exists`);
    }

    if (sync.mode !== undefined && !SYNC_MODES.includes(sync.mode)) {
        errors.push(`${where}.sync.mode must be one of ${SYNC_MODES.join(', ')}`);
    }
    if (sync.mode === 'upsert' && (typeof sync.keyField !== 'string' || !SOURCE_PATH_RE.test(sync.keyField))) {
        errors.push(`${where}.sync.keyField is required for mode 'upsert' — it is the field that identifies a row`);
    }
    if (sync.keyField !== undefined && sync.mode !== 'upsert'
        && (typeof sync.keyField !== 'string' || !SOURCE_PATH_RE.test(sync.keyField))) {
        errors.push(`${where}.sync.keyField must be a field path`);
    }

    if (sync.incremental !== undefined && sync.incremental !== null) {
        const inc = sync.incremental;
        const iw = `${where}.sync.incremental`;
        if (!isPlainObject(inc)) {
            errors.push(`${iw} must be an object { field, param?, format? }`);
        } else {
            if (typeof inc.field !== 'string' || !SOURCE_PATH_RE.test(inc.field)) {
                errors.push(`${iw}.field must be the field path carrying the last-changed stamp`);
            }
            if (inc.param !== undefined && inc.param !== null && !CONNECTOR_PARAM_KEY_RE.test(String(inc.param))) {
                errors.push(`${iw}.param must be the name of a parameter on the action`);
            }
            if (inc.format !== undefined && !SYNC_INCREMENTAL_FORMATS.includes(inc.format)) {
                errors.push(`${iw}.format must be one of ${SYNC_INCREMENTAL_FORMATS.join(', ')}`);
            }
        }
    }

    if (sync.schedule !== undefined && sync.schedule !== null) {
        const sch = sync.schedule;
        const sw = `${where}.sync.schedule`;
        if (!isPlainObject(sch)) {
            errors.push(`${sw} must be an object { everyMinutes } or { cron, tz? }`);
        } else if (sch.cron !== undefined && sch.cron !== null) {
            // Validated with the SAME parser the routine scheduler uses, so a
            // cron the editor accepts is one the job can actually schedule.
            let next = null;
            try { next = require('../../automation/cron').nextRunAt(String(sch.cron), typeof sch.tz === 'string' ? sch.tz : undefined); } catch { next = null; }
            if (!next) errors.push(`${sw}.cron "${sch.cron}" is not a valid 5-field cron expression`);
        } else if (sch.everyMinutes !== undefined) {
            const m = sch.everyMinutes;
            const floor = minSyncMinutes(kind);
            if (typeof m !== 'number' || !Number.isInteger(m) || m < floor) {
                errors.push(`${sw}.everyMinutes must be a whole number of at least ${floor}`);
            }
        } else {
            errors.push(`${sw} needs either everyMinutes or cron`);
        }
    }

    if (sync.refreshOnView !== undefined && typeof sync.refreshOnView !== 'boolean') {
        errors.push(`${where}.sync.refreshOnView must be true or false`);
    }

    if (sync.retentionField !== undefined
        && (typeof sync.retentionField !== 'string' || !KEY_RE.test(sync.retentionField))) {
        errors.push(`${where}.sync.retentionField must be the column holding the timestamp retention is measured from`);
    }

    // Child tables — one per chain step that opened a grain of its own, either by
    // EXPANDING ("one row per attachment" is a different grain from "one row per
    // message") or by asking for its own table (ownTable, one child row per parent
    // row). Either way it is joined to the parent by a relation column. `level` is
    // the grain index the runner reports; the rows for it come from that grain,
    // not the flat output.
    if (sync.children !== undefined) {
        if (!Array.isArray(sync.children)) {
            errors.push(`${where}.sync.children must be an array of child tables`);
        } else {
            if (sync.children.length > MAX_CHAIN_STEPS) {
                errors.push(`${where}.sync.children has more entries (${sync.children.length}) than a chain can have steps (${MAX_CHAIN_STEPS})`);
            }
            const seenLevels = new Set();
            for (const [i, child] of sync.children.entries()) {
                const cw = `${where}.sync.children[${i}]`;
                if (!isPlainObject(child)) { errors.push(`${cw} must be an object`); continue; }
                if (typeof child.tableId !== 'string' || !tableIds.has(child.tableId)) {
                    errors.push(`${cw}.tableId must be a table in this app`);
                }
                if (child.tableId === sync.tableId) {
                    errors.push(`${cw}.tableId must differ from the connector's main table`);
                }
                if (!Number.isInteger(child.level) || child.level < 1) {
                    errors.push(`${cw}.level must be the grain this table stores (1 or higher)`);
                } else if (seenLevels.has(child.level)) {
                    errors.push(`${cw}.level ${child.level} is used by more than one table`);
                } else { seenLevels.add(child.level); }
                if (child.parentLevel !== undefined
                    && (!Number.isInteger(child.parentLevel) || child.parentLevel < 0 || child.parentLevel >= (child.level ?? 0))) {
                    errors.push(`${cw}.parentLevel must be a lower grain than ${cw}.level`);
                }
                if (typeof child.relationField !== 'string' || !KEY_RE.test(child.relationField)) {
                    errors.push(`${cw}.relationField must be the column holding the parent's record`);
                }
                if (child.keyField !== undefined && (typeof child.keyField !== 'string' || !SOURCE_PATH_RE.test(child.keyField))) {
                    errors.push(`${cw}.keyField must be a field path`);
                }
                if (child.mode !== undefined && !SYNC_MODES.includes(child.mode)) {
                    errors.push(`${cw}.mode must be one of ${SYNC_MODES.join(', ')}`);
                }
                // How this table ages out. A child that carries its own stamp
                // names the column; one that does not — an email attachment has
                // no date of its own — inherits its parent's age through the
                // relation. Declaring neither is what let a child table sit
                // outside the connector's retention promise entirely.
                if (child.retentionField !== undefined
                    && (typeof child.retentionField !== 'string' || !KEY_RE.test(child.retentionField))) {
                    errors.push(`${cw}.retentionField must be the column holding this table's timestamp`);
                }
                if (child.retentionCascade !== undefined && typeof child.retentionCascade !== 'boolean') {
                    errors.push(`${cw}.retentionCascade must be true or false`);
                }
                if (child.retentionCascade && child.retentionField) {
                    errors.push(`${cw} cannot both cascade retention from its parent and carry its own retentionField`);
                }
            }
        }
    }

    // Dependent tables — rows the connector does NOT write but whose lifetime it
    // governs: an app-written line-items or activity table hanging off the synced
    // conversation. Declaring one is what pulls it into planRetention; without it
    // those rows land in neither steps nor unreachable and outlive the purge as
    // orphans no gate ever sees. Two modes, mirroring children: a date column of
    // its own, or a cascade through a relation to a table the connector purges.
    // Validated against the REAL columns (type included) because, unlike a child,
    // the connector never writes these tables — there is no sync stamp to fall
    // back to and no control over what a text column holds.
    if (sync.dependents !== undefined) {
        if (!Array.isArray(sync.dependents)) {
            errors.push(`${where}.sync.dependents must be an array of dependent tables`);
        } else {
            if (sync.dependents.length > DATA_LIMITS.MAX_TABLES_PER_APP) {
                errors.push(`${where}.sync.dependents has more entries (${sync.dependents.length}) than this app can have tables (${DATA_LIMITS.MAX_TABLES_PER_APP})`);
            }
            for (const [i, dep] of sync.dependents.entries()) {
                const dw = `${where}.sync.dependents[${i}]`;
                if (!isPlainObject(dep)) { errors.push(`${dw} must be an object`); continue; }
                for (const dk of Object.keys(dep)) {
                    if (!DEPENDENT_KEYS.includes(dk)) {
                        errors.push(`${dw}.${dk} is not allowed — a dependent may only carry { tableId, retentionField } or { tableId, relationField, parentTableId, retentionCascade }`);
                    }
                }
                const depTable = (typeof dep.tableId === 'string' && tablesById) ? tablesById.get(dep.tableId) : null;
                if (typeof dep.tableId !== 'string' || !tableIds.has(dep.tableId)) {
                    errors.push(`${dw}.tableId must be a table in this app`);
                }
                if (dep.tableId === sync.tableId) {
                    errors.push(`${dw}.tableId must differ from the connector's main table`);
                }
                if (dep.retentionField !== undefined) {
                    if (typeof dep.retentionField !== 'string' || !KEY_RE.test(dep.retentionField)) {
                        errors.push(`${dw}.retentionField must be the column holding this table's timestamp`);
                    } else if (depTable) {
                        const f = (Array.isArray(depTable.fields) ? depTable.fields : [])
                            .find((x) => isPlainObject(x) && x.key === dep.retentionField);
                        if (!f) {
                            errors.push(`${dw}.retentionField "${dep.retentionField}" is not a column on that table`);
                        } else if (f.type !== 'datetime' && f.type !== 'date') {
                            errors.push(`${dw}.retentionField "${dep.retentionField}" must be a date or datetime column, not ${f.type}`);
                        }
                    }
                }
                if (dep.retentionCascade !== undefined && typeof dep.retentionCascade !== 'boolean') {
                    errors.push(`${dw}.retentionCascade must be true or false`);
                }
                if (dep.retentionCascade && dep.retentionField) {
                    errors.push(`${dw} cannot both cascade retention from its parent and carry its own retentionField`);
                }
                if (dep.retentionCascade) {
                    if (typeof dep.parentTableId !== 'string' || !tableIds.has(dep.parentTableId)) {
                        errors.push(`${dw}.parentTableId must be a table in this app`);
                    }
                    if (typeof dep.relationField !== 'string' || !KEY_RE.test(dep.relationField)) {
                        errors.push(`${dw}.relationField must be the column holding the parent's record`);
                    } else if (depTable) {
                        const rel = (Array.isArray(depTable.fields) ? depTable.fields : [])
                            .find((x) => isPlainObject(x) && x.key === dep.relationField);
                        if (!rel || rel.type !== 'relation') {
                            errors.push(`${dw}.relationField "${dep.relationField}" must be a relation column on that table`);
                        } else if (typeof dep.parentTableId === 'string' && rel.relation?.table !== dep.parentTableId) {
                            errors.push(`${dw}.relationField "${dep.relationField}" does not point at parentTableId "${dep.parentTableId}"`);
                        }
                    }
                }
            }
        }
    }
}

/**
 * Validate model.connectors[] — the OWNER-authored external data sources
 * (connectors.js runs them acts-as-owner). Shape is documented in
 * connectors.js's CONNECTOR SHAPE header; this is the persisted-model gate:
 *   • conn_<hex> ids, unique; kind ∈ CONNECTOR_KINDS
 *   • params[] declaration hygiene (identifier keys, bounded count)
 *   • chain[]: bounded follow-up steps with field-path bindings
 *   • sync{}: a resolvable destination table, a key for upserts, a schedule
 *   • rest: https url template, host not templated, placeholders ⊆ declared
 *     params, maxRows ≤ the runtime ceiling
 *   • NO inline secrets — the only credential reference allowed is
 *     auth.credentialProvider (resolved server-side from the owner's store)
 */
function validateConnectors(model, errors) {
    if (model.connectors === undefined) return;
    if (!Array.isArray(model.connectors)) { errors.push('model.connectors must be an array'); return; }
    if (model.connectors.length > DATA_LIMITS.MAX_CONNECTORS) {
        errors.push(`too many connectors: ${model.connectors.length} > ${DATA_LIMITS.MAX_CONNECTORS}`);
    }
    // The tables a sync block may point at. Built once so a connector that fills
    // a table keeps that table alive: removing it fails validation rather than
    // leaving a sync that errors on every tick. The full metadata map rides
    // along because dependents are checked against real columns, not just ids.
    const tablesById = new Map(
        (Array.isArray(model.tables) ? model.tables : [])
            .filter((t) => isPlainObject(t) && typeof t.id === 'string')
            .map((t) => [t.id, t]),
    );
    const tableIds = new Set(tablesById.keys());
    const seenIds = new Set();
    let mailboxCount = 0;
    for (const [ci, c] of model.connectors.entries()) {
        const where = `connectors[${ci}]`;
        if (!isPlainObject(c)) { errors.push(`${where} must be an object`); continue; }

        if (typeof c.id !== 'string' || !CONNECTOR_ID_RE.test(c.id)) {
            errors.push(`${where}.id must match conn_<hex>`);
        } else if (seenIds.has(c.id)) {
            errors.push(`${where}.id "${c.id}" is duplicated`);
        } else { seenIds.add(c.id); }

        if (!CONNECTOR_KINDS.includes(c.kind)) {
            errors.push(`${where}.kind "${c.kind}" is not a known connector kind`);
            continue;
        }
        if (typeof c.name === 'string' && c.name.length > DATA_LIMITS.MAX_NAME_LEN) {
            errors.push(`${where}.name exceeds ${DATA_LIMITS.MAX_NAME_LEN} chars`);
        }

        // params[] declaration hygiene
        const declaredKeys = new Set();
        if (c.params !== undefined) {
            if (!Array.isArray(c.params)) {
                errors.push(`${where}.params must be an array of { key, type?, required? }`);
            } else {
                if (c.params.length > MAX_CONNECTOR_PARAMS) {
                    errors.push(`${where} has too many params: ${c.params.length} > ${MAX_CONNECTOR_PARAMS}`);
                }
                for (const [pi, p] of c.params.entries()) {
                    if (!isPlainObject(p) || typeof p.key !== 'string' || !CONNECTOR_PARAM_KEY_RE.test(p.key)) {
                        errors.push(`${where}.params[${pi}].key must match ${CONNECTOR_PARAM_KEY_RE}`);
                        continue;
                    }
                    if (declaredKeys.has(p.key)) errors.push(`${where}.params[${pi}].key "${p.key}" is duplicated`);
                    declaredKeys.add(p.key);
                    if (p.type !== undefined && typeof p.type !== 'string') errors.push(`${where}.params[${pi}].type must be a string`);
                }
            }
        }

        // NO inline secrets. Any top-level or header key that reads like a
        // credential is refused — auth.credentialProvider is the only channel.
        for (const key of Object.keys(c)) {
            if (key === 'auth') continue;
            if (CONNECTOR_SECRET_KEY_RE.test(key)) {
                errors.push(`${where}.${key} looks like an inline secret — attach credentials via auth.credentialProvider instead`);
            }
        }
        if (isPlainObject(c.headers)) {
            for (const hk of Object.keys(c.headers)) {
                if (CONNECTOR_SECRET_KEY_RE.test(hk)) {
                    errors.push(`${where}.headers["${hk}"] looks like a secret header — use auth.credentialProvider instead of an inline value`);
                }
            }
        }
        // A chain step's pinned args are a second place an author could paste a
        // key, so the same refusal walks them. Missing this would leave a hole in
        // the "no inline secrets" rule the moment chains shipped.
        if (Array.isArray(c.chain)) {
            for (const [si, step] of c.chain.entries()) {
                if (!isPlainObject(step) || !isPlainObject(step.fixedArgs)) continue;
                for (const ak of Object.keys(step.fixedArgs)) {
                    if (CONNECTOR_SECRET_KEY_RE.test(ak)) {
                        errors.push(`${where}.chain[${si}].fixedArgs.${ak} looks like an inline secret — attach credentials via auth.credentialProvider instead`);
                    }
                }
            }
        }
        if (c.auth !== undefined) {
            if (!isPlainObject(c.auth)) {
                errors.push(`${where}.auth must be an object { type, header?, credentialProvider }`);
            } else {
                for (const ak of Object.keys(c.auth)) {
                    if (ak !== 'type' && ak !== 'header' && ak !== 'credentialProvider') {
                        errors.push(`${where}.auth.${ak} is not allowed — auth may only carry { type, header?, credentialProvider }`);
                    }
                }
                if (c.auth.credentialProvider !== undefined && typeof c.auth.credentialProvider !== 'string') {
                    errors.push(`${where}.auth.credentialProvider must be a string provider id`);
                }
            }
        }

        // Materialisation into a table — available to every kind (a REST feed or
        // a routine's output is as worth caching as a tool's).
        validateConnectorSync(c.sync, tableIds, where, errors, c.kind, tablesById);

        // A retention promise the purge cannot keep is worse than no promise: the
        // app tells its users data is deleted after N days and it is not. Decided
        // with the SAME pure function the purge runs on, so the gate and the
        // behaviour cannot drift apart. Lazily required — connectorSync requires
        // this module, so a top-level import would be a cycle.
        if (isPlainObject(c.sync) && Number.isInteger(c.sync.retentionDays) && c.sync.retentionDays > 0) {
            let plan = null;
            try { plan = require('../connectorSync').planRetention(model, c); } catch { plan = null; }
            if (plan && plan.unreachable.length) {
                errors.push(`${where}.sync.retentionDays promises data is deleted after ${plan.days} days, but nothing would ever delete rows from ${plan.unreachable.join(', ')} — give the table a date column, or set retentionCascade on the child so it is removed with its parent`);
            }
        }

        // Chaining is an integration_tool concept: it binds one tool call's
        // parameters to the previous call's rows. A routine already owns its own
        // sequencing, and a REST feed has no second call to make.
        if (c.chain !== undefined && c.kind !== 'integration_tool') {
            errors.push(`${where}.chain is only supported for app connectors (integration_tool)`);
        }

        // Per-kind required fields.
        if (c.kind === 'integration_tool') {
            if (typeof c.tool !== 'string' || !c.tool) errors.push(`${where} (integration_tool) requires a tool name`);
            if (c.fixedArgs !== undefined && !isPlainObject(c.fixedArgs)) errors.push(`${where}.fixedArgs must be an object`);
            if (c.integrationId !== undefined && (typeof c.integrationId !== 'string' || !CONNECTOR_INTEGRATION_ID_RE.test(c.integrationId))) {
                errors.push(`${where}.integrationId must be a provider id (letters/digits/_/:/-)`);
            }
            if (c.runAs !== undefined && c.runAs !== 'owner' && c.runAs !== 'viewer') {
                errors.push(`${where}.runAs must be 'owner' or 'viewer'`);
            }
            // rowsPath is the escape hatch when a response envelope holds more
            // than one candidate list, so the runtime heuristic can't pick.
            if (c.rowsPath !== undefined && typeof c.rowsPath !== 'string') {
                errors.push(`${where}.rowsPath must be a string dot-path`);
            }
            validateConnectorChain(c.chain, where, errors);
        } else if (c.kind === 'automation') {
            if (typeof c.automationId !== 'string' || !c.automationId) errors.push(`${where} (automation) requires an automationId`);
        } else if (c.kind === 'rest') {
            if (typeof c.url !== 'string' || !c.url) errors.push(`${where} (rest) requires a url template`);
            else validateConnectorUrl(c.url, declaredKeys, where, errors);
            if (c.maxRows !== undefined) {
                if (typeof c.maxRows !== 'number' || !Number.isInteger(c.maxRows) || c.maxRows < 1) {
                    errors.push(`${where}.maxRows must be a positive integer`);
                } else if (c.maxRows > MAX_CONNECTOR_ROWS) {
                    errors.push(`${where}.maxRows ${c.maxRows} exceeds the cap of ${MAX_CONNECTOR_ROWS}`);
                }
            }
            if (c.rowsPath !== undefined && typeof c.rowsPath !== 'string') errors.push(`${where}.rowsPath must be a string dot-path`);
            if (c.nextPagePath !== undefined && typeof c.nextPagePath !== 'string') errors.push(`${where}.nextPagePath must be a string dot-path`);
        } else if (c.kind === 'mailbox') {
            mailboxCount += 1;
            validateMailboxConnector(c, where, errors);
        }
    }

    if (mailboxCount > MAX_MAILBOX_CONNECTORS) {
        // Each one is a live poll against a user's mail quota; three is already
        // generous for a single app.
        errors.push(`an app may have at most ${MAX_MAILBOX_CONNECTORS} mailbox connectors (found ${mailboxCount})`);
    }
}

/**
 * Validate a `mailbox` connector.
 *
 * Two of these rules are security, not tidiness:
 *   • folder/address must match a strict pattern — they are interpolated into
 *     a Graph URL path, so anything else is a traversal primitive;
 *   • query may not contain a double quote — it is wrapped in Graph's
 *     $search="..." and would otherwise break out of the literal.
 */
function validateMailboxConnector(c, where, errors) {
    if (!MAILBOX_PROVIDERS.includes(c.provider)) {
        errors.push(`${where}.provider must be one of ${MAILBOX_PROVIDERS.join(', ')}`);
    }
    if (c.mode !== undefined && !MAILBOX_MODES.includes(c.mode)) {
        errors.push(`${where}.mode must be one of ${MAILBOX_MODES.join(', ')}`);
    }
    if (c.mode === 'shared') {
        if (typeof c.address !== 'string' || !MAILBOX_EMAIL_RE.test(c.address)) {
            errors.push(`${where}.address must be the shared mailbox's e-mail address`);
        }
    }
    if (c.sharedMode !== undefined && c.sharedMode !== null) {
        // Derived from the provider (Gmail cannot delegate, so its "shared" is a
        // delivered alias). An author must not be able to claim a capability the
        // runtime cannot deliver — but canonicalize STAMPS the correct value, so
        // the rule is "must match what we derive", not "must be absent".
        // Validating a canonical model has to be a no-op.
        const derived = c.provider === 'outlook' ? 'delegated_mailbox' : 'delivered_alias';
        if (c.sharedMode !== derived) {
            errors.push(`${where}.sharedMode is derived from the provider and must be "${derived}"`);
        }
    }
    if (c.folder !== undefined && (typeof c.folder !== 'string' || !MAILBOX_FOLDER_RE.test(c.folder))) {
        errors.push(`${where}.folder must be a simple folder or label name`);
    }
    if (c.query !== undefined) {
        if (typeof c.query !== 'string') {
            errors.push(`${where}.query must be a string`);
        } else if (c.query.length > MAX_MAILBOX_QUERY_LEN) {
            errors.push(`${where}.query exceeds ${MAX_MAILBOX_QUERY_LEN} chars`);
        } else if (c.query.includes('"') || [...c.query].some((ch) => ch.codePointAt(0) < 32)) {
            errors.push(`${where}.query may not contain quotes or control characters`);
        }
    }
    if (c.lookbackDays !== undefined) {
        const d = c.lookbackDays;
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 90) {
            errors.push(`${where}.lookbackDays must be a whole number between 1 and 90`);
        }
    }
    if (c.maxPerRun !== undefined) {
        const m = c.maxPerRun;
        if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > MAX_CONNECTOR_ROWS) {
            errors.push(`${where}.maxPerRun must be a whole number between 1 and ${MAX_CONNECTOR_ROWS}`);
        }
    }
    for (const flag of ['includeBody', 'includeAttachmentMeta', 'groupIntoThreads']) {
        if (c[flag] !== undefined && typeof c[flag] !== 'boolean') {
            errors.push(`${where}.${flag} must be true or false`);
        }
    }
    if (c.runAs !== undefined && c.runAs !== 'owner' && c.runAs !== 'viewer') {
        errors.push(`${where}.runAs must be 'owner' or 'viewer'`);
    }
    if (c.integrationId !== undefined && c.integrationId !== c.provider) {
        errors.push(`${where}.integrationId is derived from the provider and must match it`);
    }
    if (c.auth !== undefined) {
        // Credentials come from the user's own vault grant — there is no
        // per-mailbox secret to attach, and accepting one would create a second,
        // unaudited credential path.
        errors.push(`${where}.auth is not used by a mailbox — it runs on the connected account`);
    }

    // A mailbox that isn't materialised into a table is a poll with nowhere to
    // put the result.
    if (!isPlainObject(c.sync)) {
        errors.push(`${where} (mailbox) requires a sync block naming the table to write messages into`);
        return;
    }
    if (c.sync.mode !== undefined && c.sync.mode !== 'upsert') {
        errors.push(`${where}.sync.mode must be 'upsert' — replace would delete the conversation history on every run`);
    }
    // What identifies a row depends on WHAT the main table holds: conversations
    // dedupe on thread_key, a flat message log on the provider's message id.
    // Either way it is the thing that turns a re-listed row into an update
    // instead of a duplicate.
    const wantKey = c.groupIntoThreads ? MAILBOX_THREAD_KEY_FIELD : MAILBOX_KEY_FIELD;
    if (c.sync.keyField !== undefined && c.sync.keyField !== wantKey) {
        errors.push(`${where}.sync.keyField must be '${wantKey}' — it is what makes a re-listed row an update instead of a duplicate`);
    }
    if (c.groupIntoThreads) {
        const child = Array.isArray(c.sync.children) ? c.sync.children[0] : null;
        if (!child) {
            errors.push(`${where}.sync.children must name the table the individual messages go into when groupIntoThreads is on`);
        } else if (child.keyField !== undefined && child.keyField !== MAILBOX_KEY_FIELD) {
            errors.push(`${where}.sync.children[0].keyField must be '${MAILBOX_KEY_FIELD}'`);
        }
    }
    if (c.sync.retentionDays === undefined || c.sync.retentionDays === null) {
        // Ingesting mail copies customer personal data into the app database.
        // An unbounded copy is not defensible, so retention is required.
        errors.push(`${where}.sync.retentionDays is required for a mailbox — set how long messages are kept`);
    } else {
        const r = c.sync.retentionDays;
        if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > MAX_MAILBOX_RETENTION_DAYS) {
            errors.push(`${where}.sync.retentionDays must be a whole number between 1 and ${MAX_MAILBOX_RETENTION_DAYS}`);
        }
    }
}

module.exports = { validateConnectors };
