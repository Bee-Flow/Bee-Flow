/**
 * App Studio validator — the rules of an `http_request` step beyond its field types:
 * the connector is a `rest` connector of the app, the path stays a path on that connector's
 * host, placeholders are path reads, header names are ones a step may set, and `retry` on a
 * write needs an idempotencyKey. The executor (actionExecutor/steps/http_request.mts) holds
 * the same rules again at run time, on the filled-in values.
 */

import { createRequire } from 'node:module';

import { FORBIDDEN_HEADERS, headerNameProblem, isWrite, pathProblem } from '../actionExecutor/httpRequest/request.mts';
import { TEMPLATE_ROOTS, literalText, placeholderProblems } from '../actionExecutor/httpRequest/template.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as { LIMITS: { MAX_HTTP_STEP_ENTRIES: number } };

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = {
    pushE: (f: Finding) => void; pushW: (f: Finding) => void;
    dataRestConnectors?: Set<string> | null; dataRefsAsWarnings?: boolean;
};

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const PLACEHOLDER_HINT = `A placeholder reads one value: {{form.<field>}}, {{vars.<name>}}, {{item.<field>}} or {{params.<name>}} (roots: ${TEMPLATE_ROOTS.join(', ')}).`;

/** A reference into the data model: an error at publish, a warning on a draft save. */
function pushDataRef(ctx: Ctx, finding: Finding): void {
    if (ctx.dataRefsAsWarnings) ctx.pushW({ ...finding, severity: 'warning' });
    else ctx.pushE(finding);
}

function checkConnector(step: Obj, path: string, ctx: Ctx): void {
    const known = ctx.dataRestConnectors;
    if (!known || typeof step.connectorId !== 'string' || known.has(step.connectorId)) return;
    const ids = [...known];
    pushDataRef(ctx, {
        code: 'action.http_connector_invalid', severity: 'error', path: `${path}.connectorId`,
        message: `Step "http_request" references ${JSON.stringify(step.connectorId)}, which is not a REST connection of this app.`,
        hint: ids.length ? `REST connections in this app: ${ids.join(', ')}.` : 'A person adds a REST connection under Data · Connections first; a step cannot name a URL of its own.',
    });
}

function checkPath(step: Obj, path: string, ctx: Ctx): void {
    if (typeof step.path !== 'string' || !step.path) return;
    const at = `${path}.path`;
    for (const raw of placeholderProblems(step.path).slice(0, 5)) {
        ctx.pushE({ code: 'action.http_placeholder_invalid', severity: 'error', path: at, message: `The path placeholder ${raw.slice(0, 80)} is not a value the step can read.`, hint: PLACEHOLDER_HINT });
    }
    // A placeholder is filled in URL-encoded, so only what the author typed can break the path.
    const problem = pathProblem(literalText(step.path));
    if (problem) ctx.pushE({ code: 'action.http_path_invalid', severity: 'error', path: at, message: problem, hint: 'Write the path on the connection\'s host, for example "/v1/orders/{{form.orderId}}". The host comes from the connection.' });
}

function checkEntries(step: Obj, field: 'query' | 'headers', path: string, ctx: Ctx): string[] {
    const map = step[field];
    if (!isObject(map)) return [];
    const names = Object.keys(map);
    if (names.length > LIMITS.MAX_HTTP_STEP_ENTRIES) {
        ctx.pushE({ code: 'action.http_too_many_entries', severity: 'error', path: `${path}.${field}`, message: `\`${field}\` has ${names.length} entries; the maximum is ${LIMITS.MAX_HTTP_STEP_ENTRIES} (LIMITS.MAX_HTTP_STEP_ENTRIES).`, hint: 'Send the rest in the body.' });
    }
    return names;
}

function checkHeaders(step: Obj, path: string, ctx: Ctx): void {
    for (const name of checkEntries(step, 'headers', path, ctx)) {
        const problem = headerNameProblem(name);
        if (problem) {
            ctx.pushE({
                code: 'action.http_header_refused', severity: 'error', path: `${path}.headers.${name}`, message: problem,
                hint: `A step never sets ${FORBIDDEN_HEADERS.slice(0, 4).join(', ')} or other identity and framing headers: the credential belongs to the connection.`,
            });
        }
    }
}

function checkBody(step: Obj, method: string, path: string, ctx: Ctx): void {
    const body = step.body;
    if (body === undefined || body === null) return;
    const at = `${path}.body`;
    if (!isWrite(method)) {
        ctx.pushW({ code: 'action.http_body_ignored', severity: 'warning', path: at, message: 'A GET sends no body, so `body` is ignored.', hint: 'Remove it, put the values in `query`, or use POST.' });
        return;
    }
    if (!isObject(body) || body.kind !== 'static') return;
    const format = typeof step.bodyFormat === 'string' ? step.bodyFormat : 'json';
    if (format === 'json' && typeof body.value === 'string') {
        let parses = true;
        try { JSON.parse(body.value); } catch { parses = false; }
        if (!parses) ctx.pushE({ code: 'action.http_body_invalid', severity: 'error', path: at, message: 'With bodyFormat "json" a text body must be valid JSON.', hint: 'Write the JSON with placeholders inside its text values, e.g. {"note": "{{form.note}}"}, or set bodyFormat to "text".' });
    }
    for (const raw of staticPlaceholderProblems(body.value).slice(0, 5)) {
        ctx.pushE({ code: 'action.http_placeholder_invalid', severity: 'error', path: at, message: `The body placeholder ${raw.slice(0, 80)} is not a value the step can read.`, hint: PLACEHOLDER_HINT });
    }
}

function staticPlaceholderProblems(value: unknown, depth = 0): string[] {
    if (typeof value === 'string') return placeholderProblems(value);
    if (depth >= 8) return [];
    if (Array.isArray(value)) return value.flatMap((v) => staticPlaceholderProblems(v, depth + 1));
    if (isObject(value)) return Object.values(value).flatMap((v) => staticPlaceholderProblems(v, depth + 1));
    return [];
}

/** The per-kind check of an http_request step (validate/stepKindChecks.js KIND_CHECKS). */
export function checkHttpRequest(step: Obj, path: string, ctx: Ctx): void {
    const method = typeof step.method === 'string' ? step.method : 'GET';
    checkConnector(step, path, ctx);
    checkPath(step, path, ctx);
    checkEntries(step, 'query', path, ctx);
    checkHeaders(step, path, ctx);
    checkBody(step, method, path, ctx);
    const hasKey = step.idempotencyKey !== undefined && step.idempotencyKey !== null;
    if (isWrite(method) && step.retry !== undefined && step.retry !== null && !hasKey) {
        ctx.pushE({
            code: 'action.http_retry_unsafe', severity: 'error', path: `${path}.retry`,
            message: `A ${method} may not be retried without an idempotencyKey: a second attempt could do the same thing twice on the other side.`,
            hint: 'Set idempotencyKey to a value that names this one write (an order id, a uuid from an earlier step), or remove retry.',
        });
    }
}

/** The ids of the connectors of one kind in a data model; null when no model was given (references are not checked). */
export function connectorIdsOfKind(dataModel: unknown, kind: string): Set<string> | null {
    if (dataModel === undefined) return null;
    const out = new Set<string>();
    const connectors = isObject(dataModel) && Array.isArray(dataModel.connectors) ? dataModel.connectors : [];
    for (const c of connectors) {
        if (isObject(c) && c.kind === kind && typeof c.id === 'string' && c.id) out.add(c.id);
    }
    return out;
}
