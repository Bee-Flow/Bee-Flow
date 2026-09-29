/**
 * App-trigger contract helpers.
 *
 * An `app_trigger` automation is fired by a Studio App action (run_automation)
 * with DECLARED TYPED INPUTS: `definition.trigger.params = [{ name, type,
 * required?, description? }]`. This module is the single home for that
 * contract — the declaration rules (used by automation/validate.js on save)
 * and the runtime value checking (used by the App Studio action bridge in
 * appStudio/actionExecutor.js before executeAutomation).
 *
 * Files never travel as bytes: a `file` param's raw value is an attachment
 * DESCRIPTOR `{ kind: 'studio_attachment', fileId }` produced by the app's
 * file input; the bridge verifies the id against the studio_app_attachments
 * ledger and expands it to `{ fileId, name, mime, size, url }` for the run.
 *
 * Intentionally dependency-light (like stepContract.js): pure functions, no
 * I/O, safe to require from stores and routes.
 */

'use strict';

const PARAM_TYPES = Object.freeze(['string', 'number', 'boolean', 'array', 'object', 'file']);

// Identifier, no leading underscore — `_`-prefixed keys are reserved for the
// bridge's audit fields (_viewerUserId/_studioAppId/_actionId/_stepKind), which
// are spread into the same flat triggerPayload as the inputs.
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

// ── appRef: WHICH button in WHICH screen of WHICH app opened this routine ──
//
// `definition.trigger.appRef = { appId, screenId, nodeId }` is a BACK-pointer,
// written when a routine is made from a button in App Studio. It is a label,
// never an authorisation: the run-time gate stays owner-equality in
// appStudio/actionExecutor/automationBridge.js, and nothing here is allowed to
// widen it. Storing it lets the builder say what it is for ("Button in an
// app · <app> · <screen>") instead of showing a nameless app_trigger, and lets
// the card say so when the app or the screen is gone.
//
// Only the SHAPE is checked here. Whether the ids still point at anything —
// and whether the person looking is allowed to be told the names — is decided
// per viewer in appStudio/appRefLookup.js, because both answers change without
// the routine changing.
//
// A studio app id is a crypto.randomUUID(); screen and node ids are App
// Studio's own `(scr|sec|cmp|act)_<6-12 chars>` (componentSpecs/ids.js ID_RE).
// Both regexes are deliberately spelled out rather than imported: this module
// is dependency-light on purpose (automation must not require appStudio), and
// a shape check that silently loosens because another module relaxed its own
// id format is worse than one that has to be changed in two places.
const APP_REF_APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const APP_REF_NODE_ID_RE = /^(scr|sec|cmp|act)_[a-z0-9]{4,12}$/;

const MAX_PARAMS = 50;
const MAX_DESCRIPTION_LEN = 500;
// Per-value caps. The route's 64KB body cap bounds the total; the per-value
// cap exists to fail with a per-param message before the blunt 413.
const MAX_JSON_VALUE_BYTES = 32 * 1024;
// Mirrors appStudio LIMITS.MAX_STRING — kept local so the dependency direction
// stays automation ← appStudio (never the reverse).
const MAX_STRING_VALUE = 5000;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True when a definition's PRIMARY trigger is an app trigger. */
function isAppTriggerDefinition(definition) {
    return definition?.trigger?.kind === 'app_trigger';
}

/** Normalized declared params (same reading idiom as stepContract.stepParams). */
function appTriggerParams(definition) {
    const params = definition?.trigger?.params;
    if (!Array.isArray(params)) return [];
    return params
        .filter(isPlainObject)
        .map((p) => ({
            name: p.name,
            type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
            required: !!p.required,
            description: typeof p.description === 'string' ? p.description : '',
        }))
        .filter((p) => typeof p.name === 'string' && p.name)
        .slice(0, MAX_PARAMS);
}

/**
 * Validate the DECLARATION (`trigger.params`) — used at save time.
 * Returns issue records `[{ code, path, message, hint }]`; empty = valid.
 */
function validateAppTriggerParams(params) {
    const issues = [];
    const push = (code, path, message, hint) => issues.push({ code, path, message, hint });

    if (params === undefined) return issues; // zero-input trigger is legal
    if (!Array.isArray(params)) {
        push('params_shape', 'params', 'trigger.params must be an array of { name, type, required?, description? }.', 'Declare the inputs the app action must provide.');
        return issues;
    }
    if (params.length > MAX_PARAMS) {
        push('params_too_many', 'params', `Too many inputs: ${params.length} > ${MAX_PARAMS}.`, 'Group related values into a single object/array input.');
    }
    const seen = new Set();
    params.forEach((p, i) => {
        const at = `params[${i}]`;
        if (!isPlainObject(p)) { push('param_shape', at, 'Each input must be an object { name, type, required?, description? }.', 'Remove the malformed entry.'); return; }
        if (typeof p.name !== 'string' || !PARAM_NAME_RE.test(p.name)) {
            push('param_name', `${at}.name`, `Input name "${p.name}" is invalid.`, 'Use a letter followed by letters/digits/underscores (max 60 chars); names may not start with "_".');
        } else if (seen.has(p.name)) {
            push('param_name_duplicate', `${at}.name`, `Input name "${p.name}" is duplicated.`, 'Every input needs a unique name.');
        } else {
            seen.add(p.name);
        }
        if (p.type !== undefined && !PARAM_TYPES.includes(p.type)) {
            push('param_type', `${at}.type`, `Input type "${p.type}" is not supported.`, `Use one of: ${PARAM_TYPES.join(', ')}.`);
        }
        if (p.required !== undefined && typeof p.required !== 'boolean') {
            push('param_required', `${at}.required`, 'required must be a boolean.', 'Remove the field or set true/false.');
        }
        if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > MAX_DESCRIPTION_LEN)) {
            push('param_description', `${at}.description`, `description must be a string of at most ${MAX_DESCRIPTION_LEN} chars.`, 'Shorten the description.');
        }
    });
    return issues;
}

/**
 * The normalized back-pointer, or null when the trigger carries none.
 *
 * Returns null for a MALFORMED ref as well as an absent one — a reader wants
 * "there is nothing usable here", and the difference between the two is the
 * validator's business, not a caller's. Callers that must tell them apart run
 * validateAppTriggerRef themselves.
 */
function appTriggerRef(definition) {
    const ref = definition?.trigger?.appRef;
    if (!isPlainObject(ref)) return null;
    if (validateAppTriggerRef(ref).length) return null;
    return { appId: ref.appId, screenId: ref.screenId, nodeId: ref.nodeId };
}

/**
 * Validate the back-pointer's SHAPE — used at save time, same issue-record
 * shape as validateAppTriggerParams.
 *
 * Absent is legal: an app_trigger routine that was written by hand, or made
 * before this existed, has no ref and is not broken. A PRESENT ref must be
 * complete: two thirds of a pointer names nothing, and a card that renders
 * "<app> · " with an empty screen is the bug this rejects at the door.
 */
function validateAppTriggerRef(appRef) {
    const issues = [];
    const push = (code, path, message, hint) => issues.push({ code, path, message, hint });

    if (appRef === undefined || appRef === null) return issues; // no back-pointer is legal
    if (!isPlainObject(appRef)) {
        push('ref_shape', 'appRef', 'trigger.appRef must be an object { appId, screenId, nodeId }.', 'Remove it, or point it at the button this routine belongs to.');
        return issues;
    }
    const check = (key, re, what) => {
        const v = appRef[key];
        if (typeof v !== 'string' || !v) {
            push('ref_incomplete', `appRef.${key}`, `trigger.appRef.${key} is required.`, `A back-pointer names all three: the app, the screen and the ${what}. Remove appRef entirely rather than leaving part of it.`);
            return;
        }
        if (!re.test(v)) {
            push('ref_id', `appRef.${key}`, `trigger.appRef.${key} is not a valid id.`, 'Ids come from App Studio — do not type them by hand.');
        }
    };
    check('appId', APP_REF_APP_ID_RE, 'app');
    check('screenId', APP_REF_NODE_ID_RE, 'screen');
    check('nodeId', APP_REF_NODE_ID_RE, 'button');
    return issues;
}

function jsonByteSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Infinity; }
}

// A file param's raw value: the descriptor the app's file input produces.
// Single-element arrays are unwrapped (a `multiple` file input with one file);
// multi-element arrays are a v1 error — one file per field.
function checkFileValue(value) {
    let v = value;
    if (Array.isArray(v)) {
        if (v.length === 1) v = v[0];
        else return { ok: false, error: 'expects one file (multiple files are not supported)' };
    }
    if (!isPlainObject(v) || v.kind !== 'studio_attachment' || typeof v.fileId !== 'string' || !v.fileId) {
        return { ok: false, error: 'expects a file uploaded through the app (a studio_attachment reference)' };
    }
    return { ok: true, isFile: true, descriptor: v };
}

/**
 * Type-check/coerce ONE runtime value against a declared type.
 * Returns { ok:true, value } (coerced), { ok:true, isFile:true, descriptor }
 * for files (ledger verification is the async caller's job), or
 * { ok:false, error } with a human message fragment ("expects …").
 */
function checkInputValue(type, value) {
    switch (type) {
        case 'string': {
            if (typeof value === 'string') return { ok: true, value: value.slice(0, MAX_STRING_VALUE) };
            if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
            return { ok: false, error: 'expects text' };
        }
        case 'number': {
            if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return { ok: true, value: Number(value) };
            return { ok: false, error: 'expects a number' };
        }
        case 'boolean': {
            if (typeof value === 'boolean') return { ok: true, value };
            if (value === 'true') return { ok: true, value: true };
            if (value === 'false') return { ok: true, value: false };
            return { ok: false, error: 'expects true or false' };
        }
        case 'array':
        case 'object': {
            let v = value;
            // Static mapping values arrive as text from the inspector — parse.
            if (typeof v === 'string') {
                try { v = JSON.parse(v); } catch { return { ok: false, error: `expects valid JSON (${type})` }; }
            }
            const shapeOk = type === 'array' ? Array.isArray(v) : isPlainObject(v);
            if (!shapeOk) return { ok: false, error: `expects a JSON ${type}` };
            if (jsonByteSize(v) > MAX_JSON_VALUE_BYTES) {
                return { ok: false, error: `is too large (max ${Math.floor(MAX_JSON_VALUE_BYTES / 1024)}KB — send large data as a file)` };
            }
            return { ok: true, value: v };
        }
        case 'file':
            return checkFileValue(value);
        default:
            return { ok: false, error: `has unknown type "${type}"` };
    }
}

module.exports = {
    PARAM_TYPES,
    PARAM_NAME_RE,
    APP_REF_APP_ID_RE,
    APP_REF_NODE_ID_RE,
    MAX_PARAMS,
    MAX_JSON_VALUE_BYTES,
    MAX_STRING_VALUE,
    isAppTriggerDefinition,
    appTriggerParams,
    validateAppTriggerParams,
    appTriggerRef,
    validateAppTriggerRef,
    checkInputValue,
};
