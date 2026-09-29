/**
 * App Studio action executor — SHARED primitives (extracted verbatim from
 * actionExecutor.js): table resolution, the server-side formula scope, binding
 * resolution and the viewer helpers. Leaf relative to every step module —
 * nothing here requires another actionExecutor module.
 */

'use strict';

const { CURRENT_USER_KEYS, seedVariableDefaults } = require('../componentSpecs');
const { tryEvaluate } = require('../../automation/expr');

// Hygiene ceiling on how many column bindings one record write resolves. Far
// above any real table (dataModel caps fields at 100) — just an abuse guard.
const MAX_VALUE_KEYS = 200;

// ── Table resolution ────────────────────────────────────────────────
// A step's tableId is the model table's STABLE id (tbl_…) — the same identity
// relations use. Fall back to matching by key for resilience against a
// key-vs-id authoring mix-up; either way the compiler quotes tableMeta.key.
function findTable(model, tableId) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    if (typeof tableId !== 'string' || !tableId) return null;
    return tables.find((t) => t && (t.id === tableId || t.key === tableId)) || null;
}

// ── Server-side formula scope ───────────────────────────────────────
// Byte-identical roots to the client buildScope (RuntimeContext.buildScope) so
// a `formula` binding resolves the same server-side as it previews client-side.

/**
 * The `currentUser` attributes a server-side formula can read.
 *
 * Kept in lockstep with the runtime payload's viewer ({id,name,email,isOwner,
 * roleKey}) because they drifted: the editor's scope panel offered
 * `currentUser.name`, the client resolved it, and the server had only `id` and
 * `roles` — so every activity-log row written by an action recorded an empty
 * "Who". Exported so validate.js can reject a formula reading an attribute this
 * does not carry, instead of it failing silently at run time.
 */
const SERVER_CURRENT_USER_KEYS = Object.freeze([...CURRENT_USER_KEYS]);

/** The scope ROOTS a server-side formula may read. */
const SERVER_SCOPE_ROOTS = Object.freeze([
    'actions', 'form', 'forms', 'screen', 'vars', 'item', 'index', 'value',
    'currentUser', 'records', 'datasets', 'now', 'today',
]);

function buildServerScope(ctx) {
    const now = new Date().toISOString();
    const clientVars = (ctx.vars && typeof ctx.vars === 'object') ? ctx.vars : {};
    /*
     * A declared default is a FLOOR, not an override.
     *
     * `vars` is live user state: a filter the person set, or a resultVar an
     * earlier step in this very sequence just produced and posted back with the
     * next step. If the server preferred its own default it would clobber the
     * value the user is looking at, and a two-step sequence would forget what
     * step one worked out.
     *
     * This widens no trust boundary: ctx.vars was already the one
     * client-supplied root (and is size-capped by sanitizeBag on the way in);
     * the defaults are author-controlled definition bytes the server reads
     * itself. A caller that passes no `variables` gets exactly today's scope.
     */
    const vars = { ...seedVariableDefaults(ctx.variables), ...clientVars };
    return {
        actions: {},           // action results are a client concern
        form: (ctx.formValues && typeof ctx.formValues === 'object') ? ctx.formValues : {},
        forms: {},
        screen: {},
        vars,
        item: ctx.item,
        index: ctx.index,
        // The trigger's value (kanban drop target, onChange's new value) — a
        // declared root that used to be hardcoded undefined, so `expr: 'value'`
        // silently read nothing in every server step. Client-supplied at the
        // same trust level as `item`.
        value: ctx.value,
        currentUser: {
            id: ctx.viewerId ?? null,
            // A person's display name is the whole point of an audit column.
            // Falling back to the e-mail (and then to the id) keeps "Who" a
            // human-readable answer rather than a uuid.
            name: ctx.viewerName || ctx.viewerEmail || ctx.viewerId || null,
            email: ctx.viewerEmail ?? null,
            roleKey: ctx.role ?? null,
            isOwner: ctx.role === 'owner',
            roles: ctx.role ? [ctx.role] : [],
        },
        records: {},
        datasets: {},
        now,
        today: now.slice(0, 10),
    };
}

// ── Binding resolution (SERVER-SIDE, never trusts client-computed values) ──
// Each column value / recordId is an authored binding object. We resolve only
// the kinds meaningful on the server:
//   static  → the authored literal
//   field   → one value pulled from the viewer's formValues
//   formula → RE-EVALUATED with the shared engine against ctx (degrades to null)
// actionResult/record/records/dataset have no server context in a single-step
// call and resolve to null (they can never smuggle in a client-computed value).
function resolveBinding(binding, ctx, scope) {
    if (binding === null || binding === undefined) return null;
    if (typeof binding !== 'object') return binding; // a bare scalar literal
    if (typeof binding.kind !== 'string') return null; // object without a kind → untrusted

    switch (binding.kind) {
        case 'static':
            return binding.value === undefined ? null : binding.value;
        case 'field': {
            const values = (ctx.formValues && typeof ctx.formValues === 'object') ? ctx.formValues : {};
            const name = binding.name;
            if (typeof name !== 'string') return null;
            const v = Object.hasOwn(values, name) ? values[name] : undefined;
            return v === undefined ? null : v;
        }
        case 'formula': {
            const expr = typeof binding.expr === 'string' ? binding.expr : binding.value;
            if (typeof expr !== 'string' || !expr.trim()) return null;
            const { value } = tryEvaluate(expr, scope);
            return value === undefined ? null : value;
        }
        default:
            return null;
    }
}

// Resolve a { [col]: binding } map into { [col]: value }. The compiler then
// drops system columns, rejects unknown fields (422) and coerces per type.
function resolveValues(values, ctx, scope) {
    const out = {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
    let n = 0;
    for (const [col, binding] of Object.entries(values)) {
        if (n >= MAX_VALUE_KEYS) break;
        n += 1;
        out[col] = resolveBinding(binding, ctx, scope);
    }
    return out;
}

function coerceRecordId(v) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
}

function viewerOf(ctx) {
    if (ctx.viewer && typeof ctx.viewer === 'object') return ctx.viewer;
    return { id: ctx.viewerId ?? null };
}

// The viewer object writeRecord expects: the ctx viewer plus the resolved RLS
// role (the run route sends viewer:{id} with role alongside; the data route's
// viewer already carries it).
function writeViewer(ctx) {
    const base = viewerOf(ctx);
    return (base.role === undefined) ? { ...base, role: ctx.role ?? null } : base;
}

// ── Text coercion ───────────────────────────────────────────────────

function coerceText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

/**
 * Keep rendered bytes as an app attachment — the tail generate_file and
 * fill_document both run, in one place: size gate before any I/O → storage
 * availability → quota → blob → AV scan → ledger row (+ scan flag) → the bare
 * `studio_attachment` descriptor. A failed ledger write never orphans a blob.
 *
 * `attachToRecordId` + `attachToFieldKey` are the access path for everyone
 * but the owner (a ledger row with recordId null is owner-only). They are
 * resolved AFTER the scan so a dirty file never gets a ledger row.
 *
 * Returns `{ ok:false, error }` for the author-facing refusals and
 * `{ ok:true, result }` with the descriptor; throws on infrastructure faults.
 */
async function storeStudioAttachment({ app, step, ctx, scope, buffer, contentType, fileName, extra = {} }) {
    const { DATA_LIMITS } = require('../dataModel');
    if (buffer.length > DATA_LIMITS.MAX_ATTACHMENT_BYTES) {
        return { ok: false, error: `The file is larger than the ${Math.round(DATA_LIMITS.MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB attachment limit` };
    }
    const storageStore = require('../../stores/storageStore');
    if (!storageStore.isAvailable()) return { ok: false, error: 'File storage is not available' };

    const studioAppQuota = require('../studioAppQuota');
    const { assertAttachmentTotalBytes } = require('../mailboxAttachments');
    await studioAppQuota.assertAttachmentQuota(app, buffer.length);
    await assertAttachmentTotalBytes(app, buffer.length);

    const crypto = require('crypto');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, sha256);
    await storageStore.uploadFile(key, buffer, contentType);

    const { scanBuffer } = require('../../middleware/uploadGuard');
    const verdict = await scanBuffer(buffer);
    if (!verdict.clean) {
        await storageStore.deleteFile(key).catch(() => {});
        return { ok: false, error: 'The generated file failed a malware scan and was discarded' };
    }

    const attachToRecordId = coerceRecordId(resolveBinding(step.attachToRecordId, ctx, scope));
    const fieldKey = typeof step.attachToFieldKey === 'string' && step.attachToFieldKey ? step.attachToFieldKey : null;

    const studioAppDataStore = require('../../stores/studioAppDataStore');
    let ledger;
    try {
        ledger = await studioAppDataStore.addAttachment(app.id, app.userId, {
            recordId: attachToRecordId || null,
            fieldKey: attachToRecordId ? fieldKey : null,
            mimeType: contentType,
            sha256,
            size: buffer.length,
        });
        await studioAppDataStore.setAttachmentScan(ledger.id, app.id, app.userId, { scanned: true, quarantined: false });
    } catch (e) {
        await storageStore.deleteFile(key).catch(() => {});
        throw e;
    }

    return {
        ok: true,
        result: {
            kind: 'studio_attachment',
            fileId: ledger.id,
            name: fileName,
            mime: contentType,
            size: buffer.length,
            ...extra,
        },
    };
}

module.exports = {
    MAX_VALUE_KEYS,
    findTable,
    storeStudioAttachment,
    SERVER_CURRENT_USER_KEYS,
    SERVER_SCOPE_ROOTS,
    buildServerScope,
    resolveBinding,
    resolveValues,
    coerceRecordId,
    viewerOf,
    writeViewer,
    coerceText,
};
