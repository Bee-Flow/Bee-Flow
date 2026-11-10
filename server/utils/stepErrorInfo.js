// @typecheck
/**
 * A failed step, explained in plain language (Studio → Automations handoff 5,
 * round 4, artboard 4a).
 *
 * The run history used to show the raw error ("Nextcloud PROPFIND failed
 * (403)") and, for Nextcloud, one remediation line. The step drawer now draws
 * a card: a title a non-developer understands, one sentence of cause, the
 * buttons that fix it, and the raw message behind "technical message". It
 * also rings the step SETTING that fixes the problem. This module turns an
 * error into that card's data:
 *
 *   {
 *     code,         stable snake_case code ('nextcloud_no_access', 'rate_limited', ...)
 *     title,        English title, params filled in
 *     cause,        English sentence, params filled in
 *     titleKey,     i18n key for the title ('automations.step_error.<code>.title')
 *     causeKey,     i18n key for the cause ('...cause' or '...cause_generic')
 *     params,       the values the texts interpolate ({ service, target, folder, field, app })
 *     settingKey,   the step setting that fixes it: 'connection', 'inputs.<name>',
 *                   'prompt', 'modelTier', 'tool', or null
 *     fixes,        [{ id, label, labelKey, params }], most useful first
 *     technical,    the raw message, capped
 *   }
 *
 * Pure: no I/O. The runner calls it where it records a failed attempt; the
 * row mapper calls it for rows written before the column existed. It lives in
 * utils/ (platform), beside the Nextcloud classifier it builds on, because the
 * store's row mapper reads it and platform may not reach up into core/.
 *
 * Privacy: the params come from the step's own settings (a folder path, a
 * field name) and the tool's name, never from run data such as an e-mail
 * body. The store redacts the whole object with the same pass as `error`.
 */

'use strict';

const { classifyNextcloudError, nextcloudAppOf } = require('./nextcloudErrorClassifier');

const MAX_TECHNICAL = 2000;
const MAX_PARAM = 200;

// ── Texts ────────────────────────────────────────────────────────────────
// The title and cause per code live in stepErrorTexts.mts.
const { TEXTS } = require('./stepErrorTexts.mts');

const STEP_ERROR_CODES = Object.freeze(Object.keys(TEXTS));

// The fix buttons. Keys match the ones agent-hub's ErrorCard already uses.
const FIX_LABELS = {
    share_folder: { label: 'Share the folder', labelKey: 'automations.output.fix_share' },
    share_folder_with: { label: 'Share the folder with {account}', labelKey: 'automations.output.fix_share_with' },
    switch_account: { label: 'Other account', labelKey: 'automations.output.fix_switch_account' },
    reconnect: { label: 'Reconnect', labelKey: 'automations.output.fix_reconnect' },
    pick_other: { label: 'Pick another', labelKey: 'automations.output.fix_pick_other' },
    open_settings: { label: 'Open the setting', labelKey: 'automations.output.fix_open_settings' },
    retry: { label: 'Try again', labelKey: 'automations.output.fix_retry' },
};

// ── Helpers ──────────────────────────────────────────────────────────────

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function cap(s, n) {
    const t = String(s);
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function fill(template, params) {
    return String(template).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null && params[k] !== '' ? String(params[k]) : m));
}

/** The raw text of an error: the pre-enrichment message when there is one. */
function rawMessageOf(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    if (typeof err.ncRawMessage === 'string' && err.ncRawMessage) return err.ncRawMessage;
    if (typeof err.message === 'string') return err.message;
    return String(err);
}

/** An HTTP status, only when the error says so plainly (no bare-number guessing). */
function statusOf(err, text) {
    const s = err && typeof err === 'object'
        ? (err.status ?? err.statusCode ?? err.response?.status ?? null)
        : null;
    if (Number.isInteger(s)) return s;
    const m = String(text || '').match(/\((\d{3})\)|\bfailed:\s*(\d{3})\b|\bstatus(?: code)?:?\s*(\d{3})\b|^(\d{3})\s/i);
    if (m) return Number(m[1] || m[2] || m[3] || m[4]);
    return null;
}

const SERVICE_NAMES = {
    nextcloud: 'Nextcloud', gmail: 'Gmail', drive: 'Google Drive', sheets: 'Google Sheets',
    slides: 'Google Slides', docs: 'Google Docs', keep: 'Google Keep', calendar: 'Google Calendar',
    contacts: 'Google Contacts', groups: 'Google Groups', ms: 'Microsoft 365', outlook: 'Outlook',
    onedrive: 'OneDrive', github: 'GitHub', youtrack: 'YouTrack', n8n: 'n8n', afas: 'AFAS',
    nmbrs: 'Nmbrs', gamma: 'Gamma', signrequest: 'SignRequest', fireflies: 'Fireflies',
    withings: 'Withings', linkedin: 'LinkedIn', maps: 'Google Maps', slack: 'Slack',
};

// Same set as automation/automationGraph.js AI_STEP_TYPES (summarize is not one).
const AI_STEP_TYPES = new Set(['ai_step', 'data_extraction', 'ai_tool']);

/** Who the step talks to, in words: 'Nextcloud', 'Gmail', 'The AI model', ... */
function serviceOf(step) {
    const tool = typeof step?.tool === 'string' ? step.tool : '';
    if (tool) {
        const seg = tool.split('_')[0].toLowerCase();
        if (SERVICE_NAMES[seg]) return SERVICE_NAMES[seg];
        if (seg) return seg.charAt(0).toUpperCase() + seg.slice(1);
    }
    if (AI_STEP_TYPES.has(step?.type)) return 'The AI model';
    if (step?.type === 'http_request') return 'The web service';
    return 'The service';
}

const isAiStep = (step) => AI_STEP_TYPES.has(step?.type);

// Input names that point at the thing a step acts on, most specific first.
// Used when the message itself does not say which setting it means.
const TARGET_KEYS = [
    'path', 'fileId', 'file_id', 'folder', 'folderPath', 'source', 'destination', 'trashPath',
    'boardId', 'stackId', 'cardId', 'roomToken', 'conversationToken', 'token', 'tableId',
    'calendarId', 'noteId', 'formId', 'shareId', 'documentId', 'spreadsheetId', 'messageId',
    'threadId', 'id', 'url',
];

/** The literal string of an input value (a binding object or a bare value). */
function literalOf(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (isObj(v) && v.kind === 'literal' && (typeof v.value === 'string' || typeof v.value === 'number')) return String(v.value);
    return null;
}

/**
 * Which input the error is about. First an input whose (resolved or literal)
 * value the message quotes ("File not found: /Invoices/a.pdf" names `path`),
 * then the first target-like input the step has.
 */
function targetInputOf(step, resolvedInputs, text) {
    const configured = isObj(step?.inputs) ? step.inputs : {};
    const resolved = isObj(resolvedInputs) ? resolvedInputs : {};
    const keys = [...new Set([...Object.keys(resolved), ...Object.keys(configured)])];
    let quoted = null;
    for (const k of keys) {
        const v = literalOf(resolved[k]) ?? literalOf(configured[k]);
        if (v && v.length >= 2 && text.includes(v)) {
            if (!quoted || v.length > quoted.value.length) quoted = { key: k, value: v };
        }
    }
    if (quoted) return quoted;
    for (const k of TARGET_KEYS) {
        if (k in resolved || k in configured) {
            return { key: k, value: literalOf(resolved[k]) ?? literalOf(configured[k]) };
        }
    }
    return null;
}

/** The field a "missing / invalid field" message names, when it names one. */
function fieldNamedIn(text, step, resolvedInputs) {
    const patterns = [
        /["'`]?([A-Za-z_][\w.]*)["'`]? (?:is|are) required/i,
        /missing (?:required )?(?:param(?:eter)?|field|input|value)s?:?\s*["'`]?([A-Za-z_][\w.]*)/i,
        /required (?:param(?:eter)?|field|input)s?:?\s*["'`]?([A-Za-z_][\w.]*)/i,
        /(?:invalid|bad) (?:value for |param(?:eter)? |field |input )["'`]?([A-Za-z_][\w.]*)/i,
        /["'`]([A-Za-z_][\w.]*)["'`] (?:must|should) be/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (!m) continue;
        const name = m[1].replace(/^inputs\./, '');
        // Only a name the step actually has, or could have: a generic word
        // ("value", "field") would ring nothing useful.
        if (/^(a|an|the|this|that|value|field|input|parameter|param|it)$/i.test(name)) continue;
        return name;
    }
    // "Either sourceHandle or content is required": the first input the step has.
    const either = text.match(/either (\w+).* or (\w+).* (?:is )?required/i);
    if (either) {
        const has = (k) => (isObj(resolvedInputs) && k in resolvedInputs) || (isObj(step?.inputs) && k in step.inputs);
        return has(either[1]) ? either[1] : either[2];
    }
    return null;
}

/** The folder part of a path: the path itself when it has no file extension. */
function folderOf(p) {
    const s = String(p || '').trim();
    if (!s) return null;
    const clean = s.replace(/\/+$/, '');
    const last = clean.split('/').pop() || '';
    if (/\.[A-Za-z0-9]{1,6}$/.test(last)) {
        const dir = clean.slice(0, clean.length - last.length).replace(/\/+$/, '');
        return dir || '/';
    }
    return clean || '/';
}

// ── Classification ───────────────────────────────────────────────────────

const NC_CODE_MAP = {
    NOT_CONNECTED: 'nextcloud_not_connected',
    SESSION_EXPIRED: 'nextcloud_session_expired',
    CONNECTOR_UNREACHABLE: 'nextcloud_unreachable',
    PROXY_ANSWERED: 'nextcloud_proxy_answered',
    NEXTCLOUD_MAINTENANCE: 'nextcloud_maintenance',
    TEMPORARILY_UNAVAILABLE: 'nextcloud_unavailable',
    THROTTLED: 'rate_limited',
    FILE_LOCKED: 'nextcloud_file_locked',
    QUOTA_EXCEEDED: 'nextcloud_quota_exceeded',
    TIMEOUT: 'timeout',
    ALREADY_EXISTS: 'nextcloud_already_exists',
    PARENT_MISSING: 'nextcloud_parent_missing',
    NO_ACCESS: 'nextcloud_no_access',
    APP_DISABLED: 'nextcloud_app_disabled',
    NOT_FOUND: 'nextcloud_not_found',
    MISSING_FIELD: 'missing_field',
};

/** The generic code for any error, Nextcloud or not. */
function genericCode(err, text, status, step) {
    const lower = text.toLowerCase();
    const errClass = err && typeof err === 'object' ? (err.errorClass || err.code || '') : '';
    if ((err && err.guardrailBlocked) || errClass === 'guardrail_blocked' || /privacy shield blocked|blocked by (the )?(privacy|guardrail)/i.test(text)) return 'guardrail_blocked';
    if (/(?:is|are) required\b|missing (?:required )?(?:param|field|input|value)|required (?:param|field|input)|no fields to extract|there is no text to read/i.test(text)) return 'missing_field';
    if (/prompt is too long|context[_ ]length|maximum context|context window|too many tokens|max(?:imum)?[_ ]tokens? .*exceed|input is too long/i.test(lower)) return 'model_context_too_long';
    if (/insufficient_quota|credit balance|quota (?:exceeded|reached)|exceeded your (?:current )?quota|billing/i.test(lower)) return 'model_quota';
    if (/could not resolve model|model[_ ]not[_ ]found|no model is configured|model .*(?:does not exist|not found|is not available|unavailable|not supported)|provider adapter does not support/i.test(lower)) {
        return 'model_unavailable';
    }
    if (isAiStep(step) && /content (?:policy|filter|management)|safety system|refused to|declined to/i.test(lower)) return 'model_refused';
    if (status === 429 || /rate.?limit|too many requests/i.test(lower)) return 'rate_limited';
    const netCode = err && typeof err === 'object' ? String(err.code || err.errno || '') : '';
    if (status === 408 || status === 504 || netCode === 'ETIMEDOUT' || errClass === 'TimeoutError' || /timed? ?out|timeout|deadline exceeded/i.test(lower)) return 'timeout';
    if (/not connected|no (?:\w+ )?(?:account|connection) (?:connected|found|configured)|no access token|connect .* in settings|credentials? (?:are )?(?:missing|not configured)/i.test(lower)) return 'not_connected';
    if (status === 401 || /unauthori[sz]ed|token (?:refresh|expired|is invalid)|re-?authenticate|invalid_grant|session (?:has )?expired|sign-?in (?:has )?expired/i.test(lower)) return 'auth_expired';
    if (status === 403 || /forbidden|permission denied|access denied|not allowed|insufficient permissions?|not permitted/i.test(lower)) return 'permission_denied';
    if (status === 404 || /not found|does not exist|no such/i.test(lower)) return 'not_found';
    if (status === 400 || status === 422 || errClass === 'ValidationError' || /\binvalid\b|validation|schema|must be/i.test(lower)) return 'validation';
    if ((typeof status === 'number' && status >= 500) || status === 529 || ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(netCode)
        || /overloaded|service unavailable|bad gateway|internal server error|socket hang up|econnreset|econnrefused/i.test(lower)) return 'provider_error';
    return 'unknown';
}

function isNextcloudError(err, step) {
    if (typeof step?.tool === 'string' && step.tool.startsWith('nextcloud_')) return true;
    return !!(err && typeof err === 'object' && err.ncError);
}

function classify(err, text, status, step) {
    // A step that knows exactly what is wrong says so (execOutbound sets stepErrorCode).
    if (err && typeof err === 'object' && typeof err.stepErrorCode === 'string' && TEXTS[err.stepErrorCode]) {
        return err.stepErrorCode;
    }
    if (/no longer have permission to use|could not verify your permission for this tool/i.test(text)) return 'tool_not_permitted'; // the runner's gate: ahead of the Nextcloud classifier, which reads "permission" as an app switched off
    if (isNextcloudError(err, step)) {
        const ncCode = (err && typeof err === 'object' && err.ncError?.code) || classifyNextcloudError(text).code;
        let code = NC_CODE_MAP[ncCode] || null;
        // A 403 on Deck or Talk is "no permission here", not a folder to share.
        if (code === 'nextcloud_no_access' && nextcloudAppOf(step?.tool) !== 'Files' && step?.tool) code = 'permission_denied';
        if (code === 'nextcloud_not_found' && nextcloudAppOf(step?.tool) !== 'Files' && step?.tool) code = 'not_found';
        if (code) return code;
    }
    return genericCode(err, text, status, step);
}

// ── Setting + fixes per code ─────────────────────────────────────────────

const CONNECTION_CODES = new Set([
    'nextcloud_no_access', 'nextcloud_not_connected', 'nextcloud_session_expired', 'nextcloud_app_disabled',
    'not_connected', 'auth_expired', 'permission_denied',
]);
const TARGET_CODES = new Set(['nextcloud_not_found', 'nextcloud_parent_missing', 'nextcloud_already_exists', 'not_found']);
// Codes whose text names the file, while the fix is to wait or to make room, not to pick another target.
const NAMED_TARGET_CODES = new Set(['nextcloud_file_locked', 'nextcloud_quota_exceeded']);

function fix(id, params, fillWith) {
    const key = id === 'share_folder' && params?.account ? 'share_folder_with' : id;
    const f = FIX_LABELS[key];
    const out = { id, label: fill(f.label, fillWith || params || {}), labelKey: f.labelKey };
    if (params && Object.keys(params).length) out.params = params;
    return out;
}

function settingAndFixes(code, ctx) {
    const { step, target, field, folder, account } = ctx;
    const inputKey = (k) => (k ? `inputs.${k}` : null);
    const integrationStep = !!step?.tool;
    if (CONNECTION_CODES.has(code)) {
        // Only an integration action has a connection to switch; for any other
        // step the connection lives in Settings → Connections.
        const settingKey = integrationStep ? 'connection' : null;
        const fixes = [];
        if (code === 'nextcloud_no_access') {
            const p = {};
            if (folder) p.folder = folder;
            if (account) p.account = account;
            fixes.push(fix('share_folder', p));
            fixes.push(fix('switch_account', settingKey ? { settingKey } : null));
        } else if (code === 'nextcloud_app_disabled' || code === 'permission_denied') {
            if (integrationStep) fixes.push(fix('switch_account', { settingKey }));
            fixes.push(fix('retry'));
        } else {
            fixes.push(fix('reconnect', { service: ctx.service }));
            if (integrationStep) fixes.push(fix('switch_account', { settingKey }));
        }
        return { settingKey, fixes };
    }
    if (TARGET_CODES.has(code)) {
        const settingKey = inputKey(target?.key);
        const fixes = [];
        if (settingKey) fixes.push(fix('pick_other', { settingKey }));
        if (code === 'nextcloud_not_found' || code === 'not_found') fixes.push(fix('retry'));
        return { settingKey, fixes };
    }
    switch (code) {
    case 'http_query_invalid':
    case 'http_url_invalid':
        return { settingKey: code === 'http_url_invalid' ? 'url' : 'query', fixes: [fix('open_settings', { settingKey: code === 'http_url_invalid' ? 'url' : 'query' })] };
    case 'missing_field':
    case 'validation': {
        const settingKey = field ? inputKey(field) : null;
        return { settingKey, fixes: settingKey ? [fix('open_settings', { settingKey })] : (code === 'validation' ? [fix('retry')] : []) };
    }
    case 'model_unavailable': {
        const settingKey = step?.type === 'ai_step' ? 'modelTier' : null;
        return { settingKey, fixes: settingKey ? [fix('open_settings', { settingKey })] : [fix('retry')] };
    }
    case 'model_context_too_long':
    case 'model_refused': {
        const settingKey = step?.type === 'ai_step' ? 'prompt' : null;
        return { settingKey, fixes: settingKey ? [fix('open_settings', { settingKey })] : [] };
    }
    case 'tool_not_permitted':
        return { settingKey: 'tool', fixes: [fix('pick_other', { settingKey: 'tool' })] };
    case 'guardrail_blocked':
        return { settingKey: null, fixes: [] };
    case 'nextcloud_unreachable':
    case 'nextcloud_maintenance':
    case 'nextcloud_unavailable':
    case 'nextcloud_proxy_answered':
    case 'nextcloud_file_locked':
    case 'nextcloud_quota_exceeded':
    case 'rate_limited':
    case 'timeout':
    case 'provider_error':
    case 'model_quota':
    case 'unknown':
    default:
        return { settingKey: null, fixes: [fix('retry')] };
    }
}

/**
 * Describe a failed step.
 *
 * @param {unknown} err  the thrown error (or a raw message string)
 * @param {{ step?: any, inputs?: any, account?: string|null }} [opts]
 *        step    the step definition ({ type, tool, inputs })
 *        inputs  the step's resolved inputs, when the caller has them
 *        account the connected account's login, when known (the share button names it)
 * @returns {{ code: string, title: string, cause: string, titleKey: string, causeKey: string,
 *             params: Record<string, string>, settingKey: string|null,
 *             fixes: Array<{ id: string, label: string, labelKey: string, params?: object }>,
 *             technical: string|null }}
 */
function describeStepError(err, opts = {}) {
    const step = isObj(opts.step) ? opts.step : null;
    const text = rawMessageOf(err);
    const status = statusOf(err, text);
    const code = classify(err, text, status, step);
    const service = serviceOf(step);

    const target = TARGET_CODES.has(code) || NAMED_TARGET_CODES.has(code) || code === 'nextcloud_no_access'
        ? targetInputOf(step, opts.inputs, text)
        : null;
    const field = code === 'missing_field' || code === 'validation' ? fieldNamedIn(text, step, opts.inputs) : null;
    const folder = code === 'nextcloud_no_access' && target?.value && /path|folder|source|destination/i.test(target.key)
        ? folderOf(target.value)
        : null;
    const account = typeof opts.account === 'string' && opts.account.trim() ? cap(opts.account.trim(), MAX_PARAM) : null;

    /** @type {Record<string, string>} */
    const params = { service };
    if (code.startsWith('nextcloud_') || String(step?.tool || '').startsWith('nextcloud_')) params.app = nextcloudAppOf(step?.tool);
    if (target?.value) params.target = cap(target.value, MAX_PARAM);
    if (folder) params.folder = cap(folder, MAX_PARAM);
    if (field) params.field = cap(field, MAX_PARAM);
    const userReason = err && typeof err === 'object' ? /** @type {{ userReason?: unknown }} */ (err).userReason : undefined;
    if (typeof userReason === 'string' && userReason) params.reason = cap(userReason, MAX_PARAM);
    if (account) params.account = account;

    const texts = TEXTS[code] || TEXTS.unknown;
    const generic = !!texts.need && !params[texts.need];
    const { settingKey, fixes } = settingAndFixes(code, { step, target, field, folder, account, service });
    return {
        code,
        title: fill(texts.title, params),
        cause: fill(generic ? texts.causeGeneric : texts.cause, params),
        titleKey: `automations.step_error.${code}.title`,
        causeKey: `automations.step_error.${code}.${generic ? 'cause_generic' : 'cause'}`,
        params,
        settingKey,
        fixes,
        technical: text ? cap(text, MAX_TECHNICAL) : null,
    };
}

/** describeStepError that never throws: a classification must never fail a run. */
function safeDescribeStepError(err, opts) {
    try { return describeStepError(err, opts); } catch { return null; }
}

/**
 * The card for a run-step row written before the runner stored error_info.
 * Only the message, the step type and the recorded inputs are known (the tool
 * name was never stored), so a Nextcloud message is recognised by its text.
 */
function legacyStepErrorInfo(message, stepType, inputs) {
    const text = String(message || '');
    if (!text) return null;
    const err = { message: text };
    if (/nextcloud|webdav|propfind|\bdeck\b|\btalk\b|\bocs\b/i.test(text)) {
        err.ncError = { code: classifyNextcloudError(text).code };
    }
    return safeDescribeStepError(err, { step: { type: stepType || null }, inputs });
}

/** Every English text, keyed the way the UI translates them (for the i18n dictionary). */
function stepErrorI18nDefaults() {
    const out = {};
    for (const [code, t] of Object.entries(TEXTS)) {
        out[`automations.step_error.${code}.title`] = t.title;
        out[`automations.step_error.${code}.cause`] = t.cause;
        if (t.causeGeneric) out[`automations.step_error.${code}.cause_generic`] = t.causeGeneric;
    }
    return out;
}

module.exports = {
    describeStepError,
    safeDescribeStepError,
    legacyStepErrorInfo,
    stepErrorI18nDefaults,
    STEP_ERROR_CODES,
    _test: { statusOf, targetInputOf, fieldNamedIn, folderOf, serviceOf, nextcloudAppOf },
};

/**
 * @typedef {{ message?: string, ncRawMessage?: string, status?: number, statusCode?: number,
 *   response?: { status?: number }, code?: string, errno?: string | number, errorClass?: string,
 *   guardrailBlocked?: boolean, stepErrorCode?: string, ncError?: { code?: string },
 *   userReason?: unknown }} StepErrLike
 * @typedef {string | StepErrLike | null | undefined} StepErr
 * @typedef {{ type?: string | null, tool?: string, inputs?: Record<string, unknown> }} StepDef
 * @typedef {{ key: string, value: string | null }} StepTarget
 */
