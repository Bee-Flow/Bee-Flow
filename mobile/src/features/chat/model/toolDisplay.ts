/**
 * One tool call → the row the activity card shows for it: the port of
 * agent-hub/src/components/chat/MessageItem/chatToolCallDisplay.js and of
 * getToolLabel in utils/helpers.js (pinned by toolDisplay.lockstep.test.ts).
 *
 * The row is named by the tool and qualified by the ONE argument a reader
 * would want next to it — the query, the URL, the file. Failure is read off
 * the result, because the stream marks nothing as failed: a guard refusal or
 * an `{ error }` result arrives as an ordinary one.
 *
 * The phone keeps a call's full result on the call itself (ToolActivity
 * `result`), so the web's resultFor — matching the k-th result named X to the
 * k-th call named X — is not needed: a live call has its result, a reloaded
 * one its preview.
 */

import type { ToolActivity } from './types';

/** The tool whose calls the thinking panel already narrates; never a row here. */
const HIDDEN_TOOLS = new Set(['sequentialthinking']);

/** agent-hub/src/utils/helpers.js TOOL_NAME_MAP. */
export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
    google_search: 'Google Search',
    terminal_exec: 'Terminal',
    python_interpreter: 'Python',
    web_browser: 'Web Browser',
    sql_query: 'Database',
    file_read: 'File System',
    api_fetcher: 'API Fetcher',
    sequentialthinking: 'Reasoning',
    browser_agent: 'Web Automation',
    document_reader: 'Doc Parser',
    arxiv_search: 'arXiv',
    scholar_search: 'Google Scholar',
    pubmed_search: 'PubMed',
    crossref_lookup: 'CrossRef',
    serper_search: 'Web Search',
    activate_skill: 'Activating skill',
    activate_session_skill: 'Activating chat skill',
    publish_session_skill_to_library: 'Saving skill to library',
    gamma_create_presentation: 'Gamma Create',
    gamma_create_from_template: 'Gamma Template',
    gamma_revise_as_new: 'Gamma Revise as New',
    gamma_get_generation_status: 'Gamma Status',
    gamma_list_themes: 'Gamma Themes',
    gamma_list_folders: 'Gamma Folders',
};

/** A human label for a tool name; snake_case → Title Case when it has none. */
export function toolLabel(name: string | undefined): string {
    if (!name) return 'Tool';
    if (Object.prototype.hasOwnProperty.call(TOOL_NAME_MAP, name)) return TOOL_NAME_MAP[name] as string;
    return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The argument keys worth a place on the row, most telling first. */
const DETAIL_KEYS = [
    'query', 'q', 'search', 'url', 'path', 'file', 'filename', 'file_path', 'title', 'subject',
    'name', 'to', 'question', 'prompt', 'text', 'command', 'code', 'sql', 'expression', 'task',
];

const DETAIL_MAX = 90;

/** The calls minus the ones the card must not show. */
export function visibleTools(tools: readonly ToolActivity[] | undefined): ToolActivity[] {
    return (tools ?? []).filter((t) => t && !HIDDEN_TOOLS.has(t.name));
}

/** The one argument that says what the call was about, cut to a line. */
export function detailOf(args: unknown): string {
    if (!isPlainObject(args)) return '';
    let value: string | null = null;
    for (const key of DETAIL_KEYS) {
        value = str(args[key]);
        if (value) break;
    }
    if (!value) {
        const first = Object.entries(args).find(([k, v]) => !k.startsWith('_') && str(v));
        value = first ? str(first[1]) : null;
    }
    if (!value) return '';
    const line = value.replace(/\s+/g, ' ');
    return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/** Did the tool fail? The reason, or null for a result that reads as success. */
export function errorOf(result: unknown, preview?: unknown): string | null {
    if (isPlainObject(result)) {
        const e = str(result.error);
        if (e) return e;
        if (result.ok === false) return str(result.message) || str(result.reason) || JSON.stringify(result).slice(0, 120);
        return null;
    }
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- every regex below is anchored at ^ and each \s* is followed by a literal it cannot match, so matching is linear in the text
    const text = str(result) || str(preview);
    if (!text) return null;
    if (/^\[Tool (input )?blocked/i.test(text)) return text.replace(/^\[|\]$/g, '');
    if (/^Error:/i.test(text)) return text;
    const m = /^\s*\{\s*"error"\s*:\s*"([^"]*)"/.exec(text);
    if (m) return m[1] ?? null;
    return null;
}

export type ToolRowStatus = 'running' | 'done' | 'failed' | 'interrupted';

export interface ToolRow {
    title: string;
    detail: string;
    status: ToolRowStatus;
    error: string | null;
    durationMs: number | null;
}

/**
 * The row for one call. `interrupted` is a call still running when the stream
 * ended — a stopped turn, a dropped connection — and gets no tick: nothing
 * says it finished.
 */
export function describeTool(tool: ToolActivity, { streaming = false }: { streaming?: boolean } = {}): ToolRow {
    const durationMs =
        Number.isFinite(tool.startTime) && Number.isFinite(tool.endTime)
            ? (tool.endTime as number) - (tool.startTime as number)
            : null;
    const error = tool.status !== 'running' ? errorOf(tool.result ?? null, tool.resultPreview) : null;
    let status: ToolRowStatus;
    if (tool.status === 'running') status = streaming ? 'running' : 'interrupted';
    else status = error || tool.status === 'error' ? 'failed' : 'done';
    return { title: toolLabel(tool.name), detail: detailOf(tool.args), status, error, durationMs };
}

/** Bounded: a search result is kilobytes of JSON, and the sheet is a glance, not a viewer. */
const RESULT_MAX = 4000;

function payloadText(value: unknown): string | null {
    if (value == null) return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}…` : text;
}

/**
 * What the raw-output sheet shows: the arguments without the model-facing `_`
 * fields, and the result — the whole thing while live, the stored preview
 * once reloaded.
 */
export function toolPayload(tool: ToolActivity): { args: string | null; result: string | null } {
    const args = isPlainObject(tool.args)
        ? Object.fromEntries(Object.entries(tool.args).filter(([k]) => !k.startsWith('_')))
        : null;
    const result = tool.result != null ? tool.result : str(tool.resultPreview);
    return { args: args && Object.keys(args).length ? payloadText(args) : null, result: payloadText(result) };
}

/** `1750` → `'1.8s'`, `840` → `'840ms'`; not a measurement → null (timelineParts.jsx). */
export function formatDurationMs(ms: number | null | undefined): string | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
