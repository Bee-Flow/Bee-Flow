/**
 * OpenFlow (a Windmill flow, as `flows/get` returns it, as `flow.yaml` holds
 * it, or wrapped as `{ flow: … }` the way the Hub serves it) to a `WmFlow`.
 *
 * Tolerant by design (research 01 §6): unknown keys are ignored, old shapes
 * are accepted (a missing `skip_failures`, a module without `summary`), and
 * nothing here throws on odd input; what cannot be read becomes a module of
 * kind `unknown` that the mapper reports.
 *
 * Dialect A (the old Nextcloud Flow ExApp) is detected here: a first module
 * whose summary is `CORE:LISTEN_TO_EVENT` carries the event classes and the
 * filter as static inputs and is taken out of the module list.
 */

import type { FlowOptions, JsonObject, ModuleKind, ModuleOptions, WmBranch, WmFlow, WmInput, WmNode, WmSuspend } from './ir.mts';
import { asArray, asObject, cleanJson, entries, isObject, num, str } from './util.mts';

export const LISTEN_TO_EVENT = 'CORE:LISTEN_TO_EVENT';

const KINDS: ReadonlySet<string> = new Set([
    'script', 'rawscript', 'flow', 'forloopflow', 'whileloopflow', 'branchone', 'branchall', 'identity', 'aiagent', 'aidecision',
]);

/** Module options the converter does not map, only names in the report. */
const MODULE_REPORT_ONLY = ['priority', 'debouncing', 'job_token_scopes', 'cache_ignore_s3_path', 'tag'];

/** Flow-level options the converter does not map, only names in the report. */
const FLOW_REPORT_ONLY = [
    'same_worker', 'priority', 'concurrency_key', 'concurrency_time_window_s', 'on_concurrency_limit', 'cache_ttl',
    'cache_ignore_s3_path', 'chat_input_enabled', 'preserve_step_tags', 'debounce_delay_s', 'debounce_key',
    'debounce_args_to_accumulate', 'max_total_debouncing_time', 'max_total_debounces_amount',
];

/** Resolves `content: '!inline <file>'` against the flow's folder; null when the file is absent. */
export type InlineResolver = (ref: string) => string | null;

export interface ParseFlowContext {
    resolveInline?: InlineResolver;
    readWarnings?: string[];
}

/** The OpenFlow body of a flow object, whatever wrapper it came in. */
export function unwrapFlow(raw: unknown): Record<string, unknown> {
    const obj = asObject(raw);
    if (isObject(obj.flow) && isObject(obj.flow.value)) return obj.flow;
    return obj;
}

export function parseFlow(raw: unknown, path: string, ctx: ParseFlowContext = {}): WmFlow {
    const flow = unwrapFlow(raw);
    const value = asObject(flow.value);
    const modules = asArray(value.modules);
    const listen = readListenModule(modules[0]);
    const body = listen ? modules.slice(1) : modules;
    const summary = str(flow.summary) ?? lastSegment(path);
    const out: WmFlow = {
        path,
        summary,
        dialect: listen ? 'exapp' : 'none',
        nodes: body.map((m, i) => parseNode(m, `m${i + 1}`, ctx)),
        options: parseFlowOptions(flow, value),
        notes: readNotes(value),
    };
    const description = str(flow.description);
    if (description) out.description = description;
    if (isObject(flow.schema)) out.schema = cleanJson(flow.schema) as JsonObject;
    if (listen) out.listenEvents = listen;
    if (isObject(value.failure_module)) out.failure = parseNode(value.failure_module, 'failure', ctx);
    if (isObject(value.preprocessor_module)) out.preprocessor = parseNode(value.preprocessor_module, 'preprocessor', ctx);
    return out;
}

function lastSegment(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'Windmill flow';
}

function readListenModule(first: unknown): WmFlow['listenEvents'] | null {
    const m = asObject(first);
    if (m.summary !== LISTEN_TO_EVENT) return null;
    const inputs = asObject(asObject(m.value).input_transforms);
    const events = asArray(staticValue(inputs.events)).filter((e): e is string => typeof e === 'string');
    const filters = staticValue(inputs.filters);
    return isObject(filters) ? { events, filters: cleanJson(filters) as JsonObject } : { events };
}

function staticValue(input: unknown): unknown {
    const t = asObject(input);
    return t.type === 'static' ? t.value : undefined;
}

function readNotes(value: Record<string, unknown>): string[] {
    const notes: string[] = [];
    for (const n of asArray(value.notes)) {
        const text = str(asObject(n).text) ?? str(asObject(n).content) ?? (typeof n === 'string' ? n : undefined);
        if (text) notes.push(text);
    }
    for (const g of asArray(value.groups)) {
        const text = str(asObject(g).summary) ?? str(asObject(g).name);
        if (text) notes.push(`Group: ${text}`);
    }
    return notes;
}

export function parseInput(raw: unknown): WmInput {
    const t = asObject(raw);
    if (t.type === 'javascript') return { type: 'javascript', expr: typeof t.expr === 'string' ? t.expr : '' };
    if (t.type === 'ai') return { type: 'ai' };
    return { type: 'static', value: cleanJson(t.value) };
}

function parseInputs(raw: unknown): Record<string, WmInput> {
    const out: Record<string, WmInput> = {};
    for (const [k, v] of entries(raw)) out[k] = parseInput(v);
    return out;
}

export function parseNode(raw: unknown, fallbackId: string, ctx: ParseFlowContext): WmNode {
    const m = asObject(raw);
    const value = asObject(m.value);
    const rawType = str(value.type) ?? 'unknown';
    const kind = (KINDS.has(rawType) ? rawType : 'unknown') as ModuleKind;
    const node: WmNode = {
        wmId: str(m.id) ?? fallbackId,
        kind,
        inputs: parseInputs(value.input_transforms),
        options: parseModuleOptions(m),
    };
    const summary = str(m.summary);
    if (summary) node.summary = summary;
    if (kind === 'unknown') node.rawType = rawType;
    readKindFields(node, value, ctx);
    return node;
}

function readKindFields(node: WmNode, value: Record<string, unknown>, ctx: ParseFlowContext): void {
    switch (node.kind) {
        case 'rawscript': readRawScript(node, value, ctx); break;
        case 'script': case 'flow': node.scriptPath = str(value.path); break;
        case 'forloopflow': case 'whileloopflow': readLoop(node, value, ctx); break;
        case 'branchone': readBranchOne(node, value, ctx); break;
        case 'branchall': readBranchAll(node, value, ctx); break;
        case 'aiagent': readAgent(node, value); break;
        default: break;
    }
}

function readRawScript(node: WmNode, value: Record<string, unknown>, ctx: ParseFlowContext): void {
    node.language = str(value.language) ?? 'unknown';
    let content = typeof value.content === 'string' ? value.content : '';
    if (content.startsWith('!inline ')) {
        const ref = content.slice('!inline '.length).trim();
        const resolved = ctx.resolveInline ? ctx.resolveInline(ref) : null;
        if (resolved === null) ctx.readWarnings?.push(`The inline script "${ref}" of step "${node.wmId}" is not in the export.`);
        content = resolved ?? '';
    }
    node.source = content;
    if (str(value.path)) node.scriptPath = str(value.path);
}

function readLoop(node: WmNode, value: Record<string, unknown>, ctx: ParseFlowContext): void {
    node.children = asArray(value.modules).map((m, i) => parseNode(m, `${node.wmId}_${i + 1}`, ctx));
    if (value.iterator !== undefined) node.iterator = parseInput(value.iterator);
    const parallelism = num(value.parallelism) ?? num(staticValue(value.parallelism));
    node.loop = {
        parallel: value.parallel === true,
        skipFailures: value.skip_failures === true,
        ...(parallelism !== undefined ? { parallelism } : {}),
        ...(num(value.max_iterations) !== undefined ? { maxIterations: num(value.max_iterations) } : {}),
    };
}

function readBranchOne(node: WmNode, value: Record<string, unknown>, ctx: ParseFlowContext): void {
    node.branches = asArray(value.branches).map((b, i) => readBranch(b, `${node.wmId}_b${i + 1}`, ctx));
    node.defaultBranch = asArray(value.default).map((m, i) => parseNode(m, `${node.wmId}_d${i + 1}`, ctx));
}

function readBranchAll(node: WmNode, value: Record<string, unknown>, ctx: ParseFlowContext): void {
    node.branches = asArray(value.branches).map((b, i) => readBranch(b, `${node.wmId}_b${i + 1}`, ctx));
    node.loop = { parallel: value.parallel === true };
}

function readBranch(raw: unknown, prefix: string, ctx: ParseFlowContext): WmBranch {
    const b = asObject(raw);
    const branch: WmBranch = { nodes: asArray(b.modules).map((m, i) => parseNode(m, `${prefix}_${i + 1}`, ctx)) };
    if (str(b.summary)) branch.summary = str(b.summary);
    if (typeof b.expr === 'string') branch.expr = b.expr;
    if (b.skip_failure === true) branch.skipFailure = true;
    return branch;
}

function readAgent(node: WmNode, value: Record<string, unknown>): void {
    node.agentTools = asArray(value.tools).map((t) => {
        const tool = asObject(t);
        const name = str(tool.summary) ?? str(tool.id);
        return { type: str(asObject(tool.value).tool_type) ?? str(tool.tool_type) ?? 'unknown', ...(name ? { name } : {}) };
    });
}

function parseModuleOptions(m: Record<string, unknown>): ModuleOptions {
    const o: ModuleOptions = { reportOnly: MODULE_REPORT_ONLY.filter((k) => m[k] !== undefined && m[k] !== null) };
    const skip = str(asObject(m.skip_if).expr);
    if (skip) o.skipIf = skip;
    const stop = readStop(m.stop_after_if);
    if (stop) o.stopAfterIf = stop;
    const stopAll = readStop(m.stop_after_all_iters_if);
    if (stopAll) o.stopAfterAllItersIf = stopAll;
    if (m.sleep !== undefined && m.sleep !== null) o.sleep = parseInput(m.sleep);
    if (m.timeout !== undefined && m.timeout !== null) o.timeout = isObject(m.timeout) ? parseInput(m.timeout) : { type: 'static', value: m.timeout };
    if (isObject(m.retry)) o.retry = readRetry(m.retry);
    if (m.continue_on_error === true) o.continueOnError = true;
    if (isObject(m.mock)) o.mock = { enabled: m.mock.enabled === true, returnValue: cleanJson(m.mock.return_value) };
    if (isObject(m.suspend)) o.suspend = readSuspend(m.suspend);
    if (num(m.cache_ttl) !== undefined) o.cacheTtl = num(m.cache_ttl);
    if (num(m.delete_after_secs) !== undefined) o.deleteAfterSecs = num(m.delete_after_secs);
    return o;
}

function readStop(raw: unknown): ModuleOptions['stopAfterIf'] | undefined {
    const s = asObject(raw);
    const expr = str(s.expr);
    if (!expr) return undefined;
    const errorMessage = str(s.error_message);
    return { expr, ...(errorMessage ? { errorMessage } : {}), ...(s.skip_if_stopped === true ? { skipIfStopped: true } : {}) };
}

function readRetry(r: Record<string, unknown>): NonNullable<ModuleOptions['retry']> {
    const out: NonNullable<ModuleOptions['retry']> = {};
    if (isObject(r.constant)) out.constant = { attempts: num(r.constant.attempts), seconds: num(r.constant.seconds) };
    if (isObject(r.exponential)) {
        out.exponential = { attempts: num(r.exponential.attempts), seconds: num(r.exponential.seconds), multiplier: num(r.exponential.multiplier) };
    }
    const retryIf = str(asObject(r.retry_if).expr);
    if (retryIf) out.retryIf = retryIf;
    return out;
}

function readSuspend(s: Record<string, unknown>): WmSuspend {
    const out: WmSuspend = {};
    if (num(s.required_events) !== undefined) out.requiredEvents = num(s.required_events);
    if (num(s.timeout) !== undefined) out.timeoutS = num(s.timeout);
    if (s.continue_on_disapprove_timeout === true) out.continueOnDisapproveTimeout = true;
    const schema = asObject(s.resume_form).schema;
    if (isObject(schema)) out.resumeSchema = cleanJson(schema) as JsonObject;
    if (s.user_groups_required !== undefined) out.userGroupsRequired = parseInput(s.user_groups_required);
    if (s.self_approval_disabled === true) out.selfApprovalDisabled = true;
    return out;
}

function parseFlowOptions(flow: Record<string, unknown>, value: Record<string, unknown>): FlowOptions {
    const o: FlowOptions = { reportOnly: FLOW_REPORT_ONLY.filter((k) => value[k] !== undefined && value[k] !== null && value[k] !== false) };
    const skipExpr = str(value.skip_expr);
    if (skipExpr) o.skipExpr = skipExpr;
    const limit = num(value.concurrent_limit);
    if (limit !== undefined) o.concurrentLimit = limit;
    const timeout = num(value.timeout) ?? num(flow.timeout);
    if (timeout !== undefined) o.timeoutS = timeout;
    const del = num(value.delete_after_secs);
    if (del !== undefined) o.deleteAfterSecs = del;
    const env: Record<string, string> = {};
    for (const [k, v] of entries(value.flow_env)) if (typeof v === 'string') env[k] = v;
    if (Object.keys(env).length) o.flowEnv = env;
    const early = str(value.early_return);
    if (early) o.earlyReturn = early;
    const who = str(flow.on_behalf_of) ?? str(flow.on_behalf_of_email);
    if (who) o.onBehalfOf = who;
    return o;
}
