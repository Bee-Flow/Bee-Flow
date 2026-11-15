/**
 * `script` and `rawscript` modules (PLAN B3, appendix 7.1):
 *
 *   hub/<v>/nextcloud/<slug>      -> the Hub table (hubScripts.mts)
 *   f/… or u/… (a workspace script in the export) -> as an inline script with that code
 *   TypeScript / JavaScript       -> the OCS matcher, then the code shim, then the AI builder
 *   Python, Bash, Go, SQL, …      -> the AI builder (never run)
 *
 * The decision is a ScriptPlan; this module writes the step it describes.
 */

import type { WmInput, WmNode } from '../ir.mts';
import type { MapCtx, Port, Step } from '../context.mts';
import type { ScriptPlan } from '../plan.mts';
import type { Binding } from '../mapExpr.mts';
import { addStep, newId, register } from '../context.mts';
import { bindInputs, flagUntranslated, labelOf, placeholder, reportModule } from '../emit.mts';
import { planHub, parseHubPath } from '../hubScripts.mts';
import { planOcs } from '../ocsMatcher.mts';
import { shimScript } from '../codeShim.mts';

const TS_LANGUAGES = new Set(['bun', 'deno', 'nativets', 'bunnative', 'javascript', 'typescript']);
const SQL_LANGUAGES = new Set(['postgresql', 'mysql', 'mssql', 'oracledb', 'bigquery', 'snowflake', 'duckdb']);

/** The language and code of a module, a workspace script resolved from the export. */
function codeOf(ctx: MapCtx, node: WmNode): { language: string; source: string } | null {
    if (node.kind === 'rawscript') return { language: node.language ?? 'unknown', source: node.source ?? '' };
    const script = node.scriptPath ? ctx.bundle.scripts.get(node.scriptPath) : undefined;
    if (script && script.source !== undefined) return { language: script.language ?? 'unknown', source: script.source };
    return null;
}

/** True when the module's own work is only making the approval link (it becomes the approval step). */
export function isApprovalCarrier(ctx: MapCtx, node: WmNode): boolean {
    // A rawscript may carry the path of the Hub script it was copied from; only a `script` IS that script.
    if (node.kind === 'script' && parseHubPath(node.scriptPath)) return planHub(node, ctx.caps).kind === 'approval';
    const code = codeOf(ctx, node);
    return !!code && code.source.includes('getResumeUrls');
}

export function decidePlan(ctx: MapCtx, node: WmNode): ScriptPlan {
    if (node.kind === 'script' && parseHubPath(node.scriptPath)) return planHub(node, ctx.caps);
    const code = codeOf(ctx, node);
    if (!code) return { kind: 'ai', reason: `The script ${node.scriptPath ?? ''} is not in the export; add its code or rebuild what it does.` };
    if (node.kind === 'script') node.source = code.source;
    node.language = code.language;
    return planForCode(ctx, node, code.language, code.source);
}

function planForCode(ctx: MapCtx, node: WmNode, language: string, source: string): ScriptPlan {
    if (TS_LANGUAGES.has(language)) {
        const ocs = planOcs(source, node.inputs, ctx.caps);
        if (ocs) return ocs;
        if (!ctx.caps.codeStep) return { kind: 'ai', reason: 'Code steps are not available on this installation.' };
        const shim = shimScript(source, node.summary);
        if ('reason' in shim) return { kind: 'ai', reason: shim.reason };
        const inputs: Record<string, WmInput> = {};
        for (const p of shim.params) if (node.inputs[p]) inputs[p] = node.inputs[p];
        return { kind: 'code', code: shim.code, inputs, allowedHosts: shim.allowedHosts, reason: 'Plain script without packages: it runs as a code step.' };
    }
    if (language === 'graphql') return { kind: 'ai', reason: 'A GraphQL query becomes a web request with a connection; the builder sets the address.' };
    if (SQL_LANGUAGES.has(language)) return { kind: 'ai', reason: `${language} queries are not run by Bee Flow; the builder rebuilds them with datatable steps or an app action.` };
    return { kind: 'ai', reason: `${language} code is never run by Bee Flow; the builder rebuilds what it does.` };
}

export function mapScript(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    const plan = decidePlan(ctx, node);
    switch (plan.kind) {
        case 'tool': return writeTool(ctx, node, plan, ports);
        case 'ai_step': return writeAiStep(ctx, node, plan, ports);
        case 'code': return writeCode(ctx, node, plan, ports);
        case 'alias':
            register(ctx, node.wmId, plan.path, plan.reshape ?? 'same');
            reportModule(ctx, node, ['mapped', 'medium', plan.reason, []]);
            return ports;
        case 'drop':
            reportModule(ctx, node, ['dropped', 'high', plan.reason, []]);
            return ports;
        case 'approval':
            return placeholder(ctx, node, 'An approval link without a suspend step; add an approval where the flow should wait.', ports);
        case 'unsupported':
            return placeholder(ctx, node, plan.reason, ports, { status: 'unsupported' });
        default:
            return placeholder(ctx, node, plan.reason, ports, plan.title ? { title: plan.title } : {});
    }
}

type ToolPlan = Extract<ScriptPlan, { kind: 'tool' }>;

function writeTool(ctx: MapCtx, node: WmNode, plan: ToolPlan, ports: Port[]): Port[] {
    const built = toolInputs(ctx, node, plan, ports);
    if (plan.tableFromContext) applyTableHint(ctx, node, built.inputs);
    if (plan.tool === 'nextcloud_tables_list_columns' && node.inputs.tableId?.type === 'static') ctx.tableHint = node.inputs.tableId;
    const id = newId(ctx, node.wmId);
    const out = addStep(ctx, { id, type: 'integration_action', label: labelOf(node, plan.tool), tool: plan.tool, inputs: built.inputs } as Step, built.ports);
    register(ctx, node.wmId, `steps.${id}.output`, plan.reshape);
    afterTool(ctx, node, plan, id, built.bound);
    return out;
}

/** The tool's inputs; object inputs may add an "Edit data" step first (the answered ports). */
function toolInputs(ctx: MapCtx, node: WmNode, plan: ToolPlan, ports: Port[]): { inputs: Record<string, Binding>; bound: ReturnType<typeof bindInputs>; ports: Port[] } {
    const pathParts: Record<string, WmInput> = {};
    const direct: Record<string, WmInput> = {};
    for (const [k, v] of Object.entries(plan.inputs)) {
        if (k.startsWith('__path_')) pathParts[k.slice('__path_'.length)] = v;
        else direct[k] = v;
    }
    const bound = bindInputs(ctx, node, direct);
    const inputs: Record<string, Binding> = { ...bound.bindings };
    for (const [k, v] of Object.entries(plan.fixed ?? {})) inputs[k] = { kind: 'literal', value: v };
    if (Object.keys(pathParts).length && typeof plan.fixed?.path === 'string') {
        const parts = bindInputs(ctx, node, pathParts);
        bound.untranslated.push(...parts.untranslated);
        inputs.path = composePath(plan.fixed.path, parts.bindings);
    }
    const objects: Record<string, Record<string, Binding>> = {};
    for (const [name, fields] of Object.entries(plan.objects ?? {})) {
        const parts = bindInputs(ctx, node, fields);
        bound.untranslated.push(...parts.untranslated);
        objects[name] = parts.bindings;
    }
    if (plan.wrapValuesAs && inputs.values) objects.values = { [plan.wrapValuesAs]: inputs.values };
    let open = ports;
    for (const [name, fields] of Object.entries(objects)) {
        const built = objectBinding(ctx, node, name, fields, open);
        inputs[name] = built.binding;
        open = built.ports;
    }
    return { inputs, bound, ports: open };
}

function afterTool(ctx: MapCtx, node: WmNode, plan: ToolPlan, id: string, bound: ReturnType<typeof bindInputs>): void {
    flagUntranslated(ctx, node, id, bound);
    if (plan.leftover?.length) {
        ctx.report.ai({ wmId: node.wmId, stepId: id, title: `Check the inputs of "${labelOf(node, plan.tool)}"`, why: `These Windmill inputs have no counterpart on ${plan.tool}: ${plan.leftover.join(', ')}.` });
    }
    for (const what of plan.repick ?? []) ctx.report.warn('repick_id', `Pick ${what} again for "${labelOf(node, plan.tool)}": ids differ between installations.`, node.wmId);
    for (const n of plan.notes ?? []) ctx.report.warn('option_approximated', n, node.wmId);
    const lowered = bound.untranslated.length ? 'low' : (bound.medium ? 'medium' : plan.confidence);
    reportModule(ctx, node, [plan.status, lowered, plan.reason, [id]]);
}

function applyTableHint(ctx: MapCtx, node: WmNode, inputs: Record<string, Binding>): void {
    const hint = ctx.tableHint;
    if (hint && hint.type === 'static') inputs.tableId = { kind: 'literal', value: hint.value };
    else ctx.report.warn('repick_id', `Pick the table for "${labelOf(node, 'update row')}": the Windmill step named only the row.`, node.wmId);
}

/** `/path/{{name}}/rest` with each name's binding put in its place. */
function composePath(template: string, parts: Record<string, Binding>): Binding {
    let text = '';
    let rest = template;
    let canTemplate = true;
    const exprParts: string[] = [];
    while (rest.length) {
        const open = rest.indexOf('{{');
        const close = open === -1 ? -1 : rest.indexOf('}}', open);
        const lit = open === -1 || close === -1 ? rest : rest.slice(0, open);
        text += lit;
        if (lit) exprParts.push(JSON.stringify(lit));
        if (open === -1 || close === -1) break;
        const b = parts[rest.slice(open + 2, close)];
        const piece = b ? templatePiece(b) : null;
        if (piece === null) canTemplate = false; else text += piece;
        exprParts.push(b ? `toStr(${dslOf(b)})` : '""');
        rest = rest.slice(close + 2);
    }
    return canTemplate ? { kind: 'template', value: text } : { kind: 'expr', value: exprParts.join(' + ') };
}

function templatePiece(b: Binding): string | null {
    if (b.kind === 'ref') return `{{${b.path}}}`;
    if (b.kind === 'template') return b.value;
    if (b.kind === 'literal' && (typeof b.value === 'string' || typeof b.value === 'number')) return String(b.value);
    return null;
}

/** A binding as an expression. */
export function dslOf(b: Binding): string {
    if (b.kind === 'ref') return b.path;
    if (b.kind === 'expr') return `(${b.value})`;
    if (b.kind === 'literal') return JSON.stringify(b.value ?? null);
    const parts: string[] = [];
    let rest = b.value;
    while (rest.length) {
        const open = rest.indexOf('{{');
        const close = open === -1 ? -1 : rest.indexOf('}}', open);
        if (open === -1 || close === -1) { parts.push(JSON.stringify(rest)); break; }
        if (open > 0) parts.push(JSON.stringify(rest.slice(0, open)));
        parts.push(`toStr(${rest.slice(open + 2, close).trim()})`);
        rest = rest.slice(close + 2);
    }
    return parts.length ? `(${parts.join(' + ')})` : '""';
}

/**
 * An object input. A Bee Flow expression has no object literals, so an object
 * with run-time values is built by an "Edit data" (set) step just before.
 */
function objectBinding(ctx: MapCtx, node: WmNode, name: string, fields: Record<string, Binding>, ports: Port[]): { binding: Binding; ports: Port[] } {
    const literal: Record<string, unknown> = {};
    let allLiteral = true;
    for (const [k, b] of Object.entries(fields)) {
        if (b.kind === 'literal') literal[k] = b.value; else allLiteral = false;
    }
    if (allLiteral) return { binding: { kind: 'literal', value: literal }, ports };
    const id = newId(ctx, `${node.wmId}_${name}`);
    const out = addStep(ctx, { id, type: 'set', label: `${labelOf(node, 'Step')}: ${name}`, fields }, ports);
    return { binding: { kind: 'ref', path: `steps.${id}.output` }, ports: out };
}

function writeAiStep(ctx: MapCtx, node: WmNode, plan: Extract<ScriptPlan, { kind: 'ai_step' }>, ports: Port[]): Port[] {
    const bound = bindInputs(ctx, node, plan.inputs);
    const id = newId(ctx, node.wmId);
    const step: Step = { id, type: 'ai_step', label: labelOf(node, 'AI step'), prompt: plan.prompt, inputs: bound.bindings, modelTier: 'auto' };
    const out = addStep(ctx, step, ports);
    register(ctx, node.wmId, `steps.${id}.output`, null);
    flagUntranslated(ctx, node, id, bound);
    for (const n of plan.notes ?? []) ctx.report.warn('ai_destination', n, node.wmId);
    reportModule(ctx, node, ['pattern', bound.untranslated.length ? 'low' : plan.confidence, plan.reason, [id]]);
    return out;
}

function writeCode(ctx: MapCtx, node: WmNode, plan: Extract<ScriptPlan, { kind: 'code' }>, ports: Port[]): Port[] {
    const bound = bindInputs(ctx, node, plan.inputs);
    const id = newId(ctx, node.wmId);
    const step: Step = { id, type: 'code', label: labelOf(node, 'Code'), code: plan.code, inputs: bound.bindings, allowedHosts: plan.allowedHosts };
    const out = addStep(ctx, step, ports);
    register(ctx, node.wmId, `steps.${id}.output.result`, 'same');
    for (const h of plan.allowedHosts) {
        ctx.report.host(h);
        ctx.report.warn('outbound_host', `The code of "${labelOf(node, 'Code')}" sends data to ${h}.`, node.wmId);
    }
    flagUntranslated(ctx, node, id, bound);
    reportModule(ctx, node, ['shim', bound.untranslated.length ? 'low' : 'medium', plan.reason, [id]]);
    return out;
}
