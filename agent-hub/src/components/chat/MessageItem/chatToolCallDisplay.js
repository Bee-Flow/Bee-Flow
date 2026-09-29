/**
 * One chat tool call → the row the activity card shows for it.
 *
 * The chat's sibling of automation/Builder/chat/toolCallDisplay.js and
 * AppStudio/chat/appToolCallDisplay.js. Those read a builder tool's `result`
 * to name what it built; a chat tool has no such answer, so the row is named
 * by the tool (getToolLabel, the same word the "How I got this answer" panel
 * used) and qualified by the ONE argument a reader would want to see next to
 * it — the query, the URL, the file — rather than a fan of key/value chips.
 *
 * Everything here is pure so the card can be tested without a DOM, and so
 * the ActivityIndicator below the card can ask the same question ("is there
 * a card above me?") without duplicating the filter.
 */

import { getToolLabel } from '../../../utils/helpers';

/** The tool whose calls the thinking panel already narrates; never a row here. */
const HIDDEN_TOOLS = new Set(['sequentialthinking']);

const SESSION_SKILL_TOOL_NAMES = new Set(['activate_session_skill', 'activate_skill']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The argument keys worth a place on the row, most telling first. A search
 * has a `query`, a fetch a `url`, a file tool a `path`: one of these says what
 * the call was about; `limit: 10` does not.
 */
const DETAIL_KEYS = [
    'query', 'q', 'search', 'url', 'path', 'file', 'filename', 'file_path', 'title', 'subject',
    'name', 'to', 'question', 'prompt', 'text', 'command', 'code', 'sql', 'expression', 'task',
];

const DETAIL_MAX = 90;

/** `msg.toolHistory` minus the rows the card must not show. */
export function visibleToolHistory(msg) {
    const history = Array.isArray(msg?.toolHistory) ? msg.toolHistory : [];
    return history.filter(e => isPlainObject(e) && !HIDDEN_TOOLS.has(e.name));
}

/**
 * For activate_session_skill / activate_skill, the skill's own name ("Step 2:
 * Draft the reply") beats the tool's. Same rule the old chip applied.
 */
function skillAwareLabel(t, entry, sessionSkills) {
    if (!SESSION_SKILL_TOOL_NAMES.has(entry.name)) return null;
    const ids = Array.isArray(entry.args?.skill_ids) ? entry.args.skill_ids : [];
    if (ids.length === 0 || !Array.isArray(sessionSkills) || sessionSkills.length === 0) return null;
    const match = sessionSkills.find(s => s.id === ids[0]);
    if (!match) return null;
    return typeof match.order === 'number'
        ? (t ? t('chat.msg.tool_skill_step', 'Step {order}: {name}', { order: match.order, name: match.name })
            : `Step ${match.order}: ${match.name}`)
        : match.name;
}

/** The one argument that says what the call was about, cut to a line. */
export function detailOf(args) {
    if (!isPlainObject(args)) return '';
    let value = null;
    for (const key of DETAIL_KEYS) {
        const v = str(args[key]);
        if (v) { value = v; break; }
    }
    if (!value) {
        const first = Object.entries(args).find(([k, v]) => !k.startsWith('_') && str(v));
        value = first ? str(first[1]) : null;
    }
    if (!value) return '';
    const line = value.replace(/\s+/g, ' ');
    return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/**
 * Did the tool fail? The stream carries no status for it — a refusal arrives
 * as an ordinary result — so the result itself is read: a `{ error }` object,
 * the guard's "[Tool blocked …]" strings, or a preview that starts that way.
 * Returns the reason, or null for a result that reads as success.
 */
export function errorOf(result, preview) {
    if (isPlainObject(result)) {
        const e = str(result.error);
        if (e) return e;
        if (result.ok === false) return str(result.message) || str(result.reason) || JSON.stringify(result).slice(0, 120);
        return null;
    }
    const text = str(result) || str(preview);
    if (!text) return null;
    if (/^\[Tool (input )?blocked/i.test(text)) return text.replace(/^\[|\]$/g, '');
    if (/^Error:/i.test(text)) return text;
    const m = /^\s*\{\s*"error"\s*:\s*"([^"]*)"/.exec(text);
    if (m) return m[1];
    return null;
}

/**
 * The full result for the i-th history entry, when the message still has it.
 * `toolResults` is a flat list in call order with the tool's name on each
 * entry, so the k-th result named X belongs to the k-th history row named X.
 * A persisted message has no `toolResults` at all; then the 200-char
 * `resultPreview` is all there is, and null says so.
 */
export function resultFor(msg, index) {
    const history = visibleToolHistory(msg);
    const entry = history[index];
    if (!entry) return null;
    const results = Array.isArray(msg?.toolResults) ? msg.toolResults : [];
    const ordinal = history.slice(0, index).filter(e => e.name === entry.name).length;
    let seen = 0;
    for (const r of results) {
        if (!isPlainObject(r) || r.name !== entry.name) continue;
        if (seen === ordinal) return r.result;
        seen += 1;
    }
    return null;
}

/**
 * @param {{name?: string, args?: object, status?: string, startTime?: number, endTime?: number, resultPreview?: string}} entry
 * @param {{t?: Function|null, sessionSkills?: Array, result?: any, streaming?: boolean}} ctx
 * @returns {{title: string, detail: string, status: 'running'|'done'|'failed'|'interrupted',
 *            error: string|null, durationMs: number|null}}
 *
 * `interrupted` is a row that was still running when the stream ended — a
 * stopped turn, a dropped connection. It gets no tick: nothing says it
 * finished, and a tick would.
 */
export function describeChatTool(entry, { t = null, sessionSkills = [], result = null, streaming = false } = {}) {
    const name = str(entry?.name) || '';
    const title = skillAwareLabel(t, entry || {}, sessionSkills) || getToolLabel(name);
    const detail = detailOf(entry?.args);
    const durationMs = (Number.isFinite(entry?.startTime) && Number.isFinite(entry?.endTime))
        ? entry.endTime - entry.startTime
        : null;
    const error = entry?.status === 'done' ? errorOf(result, entry?.resultPreview) : null;
    let status;
    if (entry?.status === 'running') status = streaming ? 'running' : 'interrupted';
    else status = error ? 'failed' : 'done';
    return { title, detail, status, error, durationMs };
}

/**
 * What the row shows behind its chevron: the call's arguments without the
 * model-facing `_` fields, and the result — the whole thing while the message
 * is live, the stored preview once it has been reloaded.
 */
export function detailPayload(entry, result) {
    const args = isPlainObject(entry?.args)
        ? Object.fromEntries(Object.entries(entry.args).filter(([k]) => !k.startsWith('_')))
        : entry?.args;
    const out = result != null ? result : (str(entry?.resultPreview) || null);
    return { args: args ?? null, result: out };
}
