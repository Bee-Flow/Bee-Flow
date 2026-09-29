/**
 * App Studio data model — canonicalization: repair a model into the canonical
 * shape (ids, keys, defaults, access + roleMapping blocks, mailbox connector
 * defaults) and the blank model every new app starts from.
 */

'use strict';

const { isPlainObject } = require('./shared');
const { hex6, newTableId, newFieldId, newConnectorId } = require('./ids');
const {
    FIELD_TYPES,
    DATA_LIMITS,
    SYSTEM_COLUMNS,
    KEY_RE,
    ACCESS_MODES,
    MAILBOX_PROVIDERS,
    MAILBOX_MODES,
    MAILBOX_KEY_FIELD,
    MAILBOX_THREAD_KEY_FIELD,
} = require('./vocabulary');

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

function slugifyKey(input, fallbackPrefix) {
    let s = String(input || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 63);
    if (!s || !/^[a-z]/.test(s)) s = `${fallbackPrefix}_${s}`.slice(0, 63).replace(/_+$/g, '');
    if (!KEY_RE.test(s)) s = `${fallbackPrefix}${hex6()}`;
    return s;
}

function boolish(v, dflt) {
    if (v === undefined) return dflt;
    return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Repair a model into a canonical shape: fill missing ids/keys/names, default
 * the access + roleMapping blocks, coerce required/unique to booleans, clamp
 * select options. Returns { model, repairs } where repairs is a list of
 * human-readable strings describing each change. Does NOT dedupe or drop
 * invalid entries — validateDataModel is responsible for rejecting those.
 */
function canonicalizeDataModel(model) {
    const repairs = [];
    const src = isPlainObject(model) ? model : {};
    const out = { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} } };

    if (src.modelVersion !== 1) repairs.push('set modelVersion=1');

    const usedTableKeys = new Set();
    const tables = Array.isArray(src.tables) ? src.tables : [];
    for (const t of tables) {
        const table = isPlainObject(t) ? { ...t } : {};
        if (typeof table.id !== 'string' || !/^tbl_/.test(table.id)) {
            table.id = newTableId(); repairs.push(`assigned id ${table.id} to a table`);
        }
        if (typeof table.key !== 'string' || !KEY_RE.test(table.key) || usedTableKeys.has(table.key)) {
            const nk = slugifyKey(table.key || table.name, 'tbl');
            let unique = nk, n = 2;
            while (usedTableKeys.has(unique)) unique = `${nk}_${n++}`.slice(0, 63);
            if (unique !== table.key) repairs.push(`table key "${table.key}" → "${unique}"`);
            table.key = unique;
        }
        usedTableKeys.add(table.key);
        if (typeof table.name !== 'string' || !table.name.trim()) {
            table.name = table.key; repairs.push(`table "${table.key}" got a default name`);
        }
        if (table.icon === undefined) table.icon = null;

        /*
         * Tabelbron (additief — een tabel zonder `source` canonicaliseert
         * byte-identiek, want de sleutel bestaat dan niet).
         *
         * Alleen de ONTBREKENDE `mode` wordt hier ingevuld, en wel met de
         * smalste: er is nooit om schrijfrecht gevraagd, dus krijgt niemand het.
         * Een INGEVULDE mode blijft staan zoals hij is, ook als hij nergens op
         * slaat — hem naar 'read' duwen zou een typefout ('readWrite',
         * 'read-write') veranderen in een recht dat er niet is, en de auteur zou
         * nergens zien dat zijn keuze is overschreven. validateDataModel wijst
         * hem daarom af in plaats van dat wij hem repareren. Datzelfde geldt voor
         * een `source` die geen object is.
         */
        if (isPlainObject(table.source)) {
            const source = { ...table.source };
            if (source.mode === undefined || source.mode === null) {
                source.mode = 'read';
                repairs.push(`table "${table.key}" source mode defaulted to read`);
            }
            table.source = source;
        } else if (table.source === null) {
            // Expliciet niets = de eerste soort; laat de sleutel niet rondslingeren.
            delete table.source;
        }

        const usedFieldKeys = new Set();
        table.fields = (Array.isArray(table.fields) ? table.fields : []).map((f) => {
            const field = isPlainObject(f) ? { ...f } : {};
            if (typeof field.id !== 'string' || !/^fld_/.test(field.id)) {
                field.id = newFieldId(); repairs.push(`assigned id ${field.id} to a field`);
            }
            if (typeof field.key !== 'string' || !KEY_RE.test(field.key)
                || SYSTEM_COLUMNS.includes(field.key) || usedFieldKeys.has(field.key)) {
                const nk = slugifyKey(field.key || field.name, 'fld');
                let unique = nk, n = 2;
                while (usedFieldKeys.has(unique) || SYSTEM_COLUMNS.includes(unique)) unique = `${nk}_${n++}`.slice(0, 63);
                if (unique !== field.key) repairs.push(`field key "${field.key}" → "${unique}"`);
                field.key = unique;
            }
            usedFieldKeys.add(field.key);
            if (!FIELD_TYPES.includes(field.type)) {
                repairs.push(`field "${field.key}" had unknown type "${field.type}" → text`);
                field.type = 'text';
            }
            field.required = boolish(field.required, false);
            field.unique = boolish(field.unique, false);
            if (typeof field.name !== 'string' || !field.name.trim()) field.name = field.key;
            if ((field.type === 'select' || field.type === 'multiselect')) {
                if (!Array.isArray(field.options)) { field.options = []; repairs.push(`field "${field.key}" options defaulted to []`); }
                if (field.options.length > DATA_LIMITS.MAX_SELECT_OPTIONS) {
                    field.options = field.options.slice(0, DATA_LIMITS.MAX_SELECT_OPTIONS);
                    repairs.push(`field "${field.key}" options clamped to ${DATA_LIMITS.MAX_SELECT_OPTIONS}`);
                }
            }
            return field;
        });

        // Access block — defined for the RLS gateway; we only fill the shape.
        const access = isPlainObject(table.access) ? { ...table.access } : {};
        if (!ACCESS_MODES.includes(access.default)) access.default = 'app';
        if (!isPlainObject(access.roles)) access.roles = {};
        if (!isPlainObject(access.rowFilters)) access.rowFilters = {};
        table.access = access;

        out.tables.push(table);
    }

    out.roles = (Array.isArray(src.roles) ? src.roles : [])
        .filter(isPlainObject)
        .map(r => ({ key: typeof r.key === 'string' ? r.key : slugifyKey(r.label, 'role'), label: r.label || r.key || 'Role' }));

    const rm = isPlainObject(src.roleMapping) ? src.roleMapping : {};
    out.roleMapping = {
        // An explicit null is NOT the same as absent. Absent means the author
        // never thought about roles, and 'app' — everyone who can open the app —
        // is the friendly default. An explicit null says "opening the app grants
        // nothing until someone is given a role", which is the only correct
        // answer for an app whose roles carry real authority. Coercing it to
        // 'app' handed every viewer of a support desk the agent role.
        default: typeof rm.default === 'string' ? rm.default : (rm.default === null ? null : 'app'),
        byGroup: isPlainObject(rm.byGroup) ? rm.byGroup : {},
    };

    // Connectors (additive — only emitted when the source carries them, so a
    // connectorless model canonicalizes byte-identically). Assign a conn_ id and
    // a display name; leave every other field for validateConnectors to gate.
    if (Array.isArray(src.connectors)) {
        const usedConnIds = new Set();
        out.connectors = src.connectors.filter(isPlainObject).map((c) => {
            const conn = { ...c };
            if (typeof conn.id !== 'string' || !/^conn_/.test(conn.id) || usedConnIds.has(conn.id)) {
                conn.id = newConnectorId(); repairs.push(`assigned id ${conn.id} to a connector`);
            }
            usedConnIds.add(conn.id);
            if (typeof conn.name !== 'string' || !conn.name.trim()) conn.name = conn.id;
            if (conn.params !== undefined && !Array.isArray(conn.params)) { conn.params = []; repairs.push(`connector "${conn.id}" params defaulted to []`); }
            if (conn.kind === 'mailbox') canonicalizeMailboxConnector(conn, repairs);
            return conn;
        });
    }

    // Directory access (additive, like connectors — a model without it
    // canonicalizes byte-identically, and absent means OFF).
    //
    // This is the app SAYING it reads the organisation's member list. It is a
    // single boolean and it could have been implicit in the binding, but then
    // an app that quietly grew a `sys_org_members` binding would quietly start
    // reading colleagues' names, and nobody would see it in the schema. On a
    // privacy product the declaration is the point.
    if (isPlainObject(src.directory)) {
        out.directory = { orgMembers: src.directory.orgMembers === true };
    }

    return { model: out, repairs };
}

/**
 * Fill in a mailbox connector's defaults and derive the fields the author does
 * not get to choose.
 *
 * `sharedMode` is the important one: it says HOW a shared mailbox is reached,
 * and it follows from the provider, not from intent. Outlook can address a real
 * delegated mailbox; Gmail cannot address anything but the authenticated user,
 * so its "shared" is mail delivered to a team alias. Deriving it here means the
 * UI and the runtime can never disagree about which of those the author got.
 */
function canonicalizeMailboxConnector(conn, repairs) {
    if (!MAILBOX_MODES.includes(conn.mode)) conn.mode = 'personal';
    if (typeof conn.folder !== 'string' || !conn.folder.trim()) conn.folder = 'inbox';
    if (typeof conn.address === 'string') conn.address = conn.address.trim().toLowerCase();
    if (!Number.isInteger(conn.lookbackDays)) conn.lookbackDays = 7;
    if (!Number.isInteger(conn.maxPerRun)) conn.maxPerRun = 100;
    if (typeof conn.includeBody !== 'boolean') conn.includeBody = true;
    if (typeof conn.includeAttachmentMeta !== 'boolean') conn.includeAttachmentMeta = true;
    if (conn.runAs !== 'viewer') conn.runAs = 'owner';

    // Drives the existing viewer pre-flight banner ("connect Outlook first").
    if (MAILBOX_PROVIDERS.includes(conn.provider)) conn.integrationId = conn.provider;

    if (conn.sharedMode !== undefined && conn.sharedMode !== null) {
        repairs.push(`connector "${conn.id}" sharedMode is server-derived and was replaced`);
    }
    conn.sharedMode = conn.provider === 'outlook' ? 'delegated_mailbox' : 'delivered_alias';

    if (isPlainObject(conn.sync)) {
        conn.sync = { ...conn.sync };
        if (conn.sync.mode !== 'upsert') conn.sync.mode = 'upsert';
        const wantKey = conn.groupIntoThreads ? MAILBOX_THREAD_KEY_FIELD : MAILBOX_KEY_FIELD;
        if (conn.sync.keyField !== wantKey) conn.sync.keyField = wantKey;
        if (!Number.isInteger(conn.sync.retentionDays)) conn.sync.retentionDays = 90;

        // The stamp a mailbox is incremental on, and — because retention is
        // measured from the same column — the thing that makes retentionDays
        // mean anything. A mailbox without it re-pulls its whole lookback window
        // on every tick AND deletes nothing, both silently. The column name
        // follows the shipped table shape: conversations carry last_message_at,
        // a flat message log carries received_at.
        if (!isPlainObject(conn.sync.incremental)) {
            conn.sync.incremental = {
                field: conn.groupIntoThreads ? 'last_message_at' : 'received_at',
                format: 'iso',
            };
        }

        // Default every child to cascading retention. A mailbox child holds the
        // parts with no date of their own — message bodies rolled under a
        // conversation, attachments under a message — and those are exactly the
        // rows carrying the personal data. Opting IN would mean every mailbox an
        // author or the AI builder produces keeps them forever by default, which
        // is the failure this whole path exists to prevent. A child that names
        // its own retentionField keeps it; the validator rejects both at once.
        if (Array.isArray(conn.sync.children)) {
            conn.sync.children = conn.sync.children.map((child) => {
                if (!isPlainObject(child) || typeof child.relationField !== 'string') return child;
                if (child.retentionField || typeof child.retentionCascade === 'boolean') return child;
                return { ...child, retentionCascade: true };
            });
        }
    }
}

/** A blank, valid data model. */
function emptyDataModel() {
    return { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

module.exports = { canonicalizeDataModel, emptyDataModel };
