/**
 * What a step card says: its name and its one summary line — the `name` and
 * `sub` each web node component hands StepNodeBase (flow/nodes/*Node.jsx).
 * The types the web summarises in flow/nodeSummaries.js use the ported
 * functions; the rest follow their node component line for line. English
 * where the web card is English, translated where the web card translates
 * (the loop, "Back to the app").
 *
 * One difference from the web card, made at display time (readableText.ts):
 * data another step produced is named the way the fields name it, "‹gmail
 * search ▸ Body›", never `{{steps.act_4d4307a.output.body}}` or
 * `‹act_4d4307a›.body`.
 */

import {
    aggregateSummary, approvalSummary, dataExtractionSummary, datatableSummary, dateTimeSummary, dedupeSummary,
    fillDocumentSummary, flattenSummary, generateDocumentSummary, humanizeExpression, humanizeToolName,
    knowledgeWriteSummary, limitSummary, nodeDefaultLabel, presentationSummary, readRoute, ROUTE_STEP_NAME, SET_STEP_NAME,
    slideSummary, summarizeSummary, waitSummary,
    type AnyNode, type Summary, type Translate,
} from '@/features/flow-editor/model';
import { triggerName, triggerSummary } from '@/features/flow-editor/model/outline';

import { readablePath, readableRule, readableSummary, readableText } from './readableText';
import { summariseSetStep } from './setSummary';

export interface SummaryContext {
    stepLabelById?: Map<string, string> | null;
    /** id → step type: tells which steps are Conditions, so the list one keeps reads as its name. */
    stepTypeById?: Map<string, string> | null;
    tableNameById?: Record<string, string> | null;
    kbNameById?: Record<string, string> | null;
    t: Translate;
}

type Step = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const labels = (ctx: SummaryContext) => ctx.stepLabelById ?? null;
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (names: string[], max = 4) => `${names.slice(0, max).join(', ')}${names.length > max ? '…' : ''}`;

function aiSummary(step: Step): Summary {
    const preview = str(step.prompt).split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    return preview || { muted: 'no prompt yet' };
}

/**
 * The web's SwitchNode switchSubtitle: "‹Read many ▸ Attachments› · 3 outputs
 * + Otherwise" for a list Condition with several outputs, "3 outputs +
 * Otherwise" for one deciding the whole run. "+ Otherwise" stays off when the
 * catch-all is redirected into an output (`defaultBranch`); a list Condition
 * with one output whose rest goes to Otherwise (keep-rest) reads like a filter
 * card, its rule and then "+ Otherwise".
 */
function outputsWord(step: Step, cases: { expr?: unknown }[], ctx: SummaryContext): string | null {
    const n = cases.length;
    if (!n) return null;
    if (step.defaultBranch) {
        return n === 1 ? ctx.t('condition_node.canvas.output', '1 output') : ctx.t('condition_node.canvas.outputs', '{n} outputs', { n });
    }
    if (readRoute(step as Parameters<typeof readRoute>[0]).keepRest) {
        const rule = readableRule(cases[0]?.expr, labels(ctx), ctx.t) || ctx.t('condition_node.canvas.no_rule', 'no rule yet');
        return ctx.t('condition_node.canvas.rule_otherwise', '{rule} + Otherwise', { rule });
    }
    return n === 1
        ? ctx.t('condition_node.canvas.output_otherwise', '1 output + Otherwise')
        : ctx.t('condition_node.canvas.outputs_otherwise', '{n} outputs + Otherwise', { n });
}

/** The list a Condition works through, as its canvas card names it (listPathLabel's compact form). */
function routeList(step: Step, ctx: SummaryContext): string {
    return readablePath(step.arrayRef, labels(ctx), ctx.t, { compact: true, stepTypeById: ctx.stepTypeById ?? null });
}

function switchSummary(step: Step, ctx: SummaryContext): Summary {
    const cases = (Array.isArray(step.cases) ? (step.cases as { name?: unknown; expr?: unknown }[]) : []).filter((c) => c && typeof c.name === 'string' && c.name);
    const outputs = outputsWord(step, cases, ctx);
    const listMode = typeof step.arrayRef === 'string';
    const list = listMode ? routeList(step, ctx) : '';
    const missing = listMode && !list ? ctx.t('condition_node.canvas.no_list', 'no list yet') : null;
    const text = [list || missing, outputs || ctx.t('condition_node.canvas.no_rule', 'no rule yet')].filter(Boolean).join(' · ');
    return !outputs || missing ? { muted: text } : text;
}

/** The web's FilterNode filterSubtitle: the list, then the rule; muted while either is not there yet. */
function filterSummary(step: Step, ctx: SummaryContext): Summary {
    const list = routeList(step, ctx);
    const rule = readableRule(step.expr, labels(ctx), ctx.t);
    const text = `${list || ctx.t('condition_node.canvas.no_list', 'no list yet')} · ${rule || ctx.t('condition_node.canvas.no_rule', 'no rule yet')}`;
    return list && rule ? text : { muted: text };
}

function loopSummary(step: Step, ctx: SummaryContext): Summary {
    const item = str(step.itemVar) || 'item';
    const over = readablePath(step.overRef, labels(ctx), ctx.t, { stepTypeById: ctx.stepTypeById ?? null });
    const batch = Number(step.batchSize ?? 1);
    if (!over) return { muted: ctx.t('automations.canvas.loop_no_list', 'no list yet · as loop.{item}', { item }) };
    return batch > 1
        ? ctx.t('automations.canvas.loop_over_batched', 'over: {list} · as loop.{item} · ×{batch}', { list: over, item, batch })
        : ctx.t('automations.canvas.loop_over', 'over: {list} · as loop.{item}', { list: over, item });
}

/** ParallelNode's parallelSummary: the first RUNNING step of each branch, by name. */
function parallelSummary(step: Step): Summary {
    const branches = Array.isArray(step.branches) ? step.branches : [];
    if (branches.length === 0) return { muted: 'no branches yet — nothing runs here' };
    const names = branches.map((branch) => {
        const head = Array.isArray(branch) ? (branch as Step[]).find((s) => s && s.type !== 'note') : null;
        if (!head) return 'empty';
        return str(head.label).trim() || nodeDefaultLabel(str(head.type)) || 'step';
    });
    const shown = names.slice(0, 3);
    const rest = names.length - shown.length;
    return `${[...shown, ...(rest > 0 ? [`+${rest}`] : [])].join(' · ')} — all at the same time`;
}

function privacySummary(step: Step, ctx: SummaryContext, emptyText: string, extra: string[] = []): Summary {
    const source = readablePath(step.sourceRef, labels(ctx), ctx.t);
    return source ? [source, ...extra].join(' · ') : { muted: emptyText };
}

function guardSummary(step: Step, ctx: SummaryContext): Summary {
    const onFound = (step.onFound as { stop?: unknown; mask?: unknown }) || {};
    const consequences = [onFound.stop ? 'stops the run' : '', onFound.mask ? 'masks a copy' : ''].filter(Boolean);
    return privacySummary(step, ctx, 'nothing to scan yet', consequences);
}

function formPageSummary(step: Step): Summary {
    const ending = step.mode === 'ending';
    const form = (step.form as { title?: string; fields?: unknown[] } | undefined) ?? {};
    const title = form.title || (ending ? 'All done' : 'Form page');
    const n = Array.isArray(form.fields) ? form.fields.length : 0;
    return ending ? title : `${title} · ${plural(n, 'question')}`;
}

function returnToAppSummary(step: Step, ctx: SummaryContext): Summary {
    const nav = step.navigateTo && typeof step.navigateTo === 'object' ? (step.navigateTo as { screenId?: string }) : null;
    const toast = step.toast as { message?: string } | undefined;
    const parts: string[] = [];
    if (toast?.message) parts.push(String(toast.message));
    if (nav?.screenId) parts.push(`→ ${nav.screenId}`);
    if (step.refresh) {
        parts.push(step.refresh === 'resetForm'
            ? ctx.t('automations.node.return_to_app.card_resets_form', 'clears the form')
            : ctx.t('automations.node.return_to_app.card_reloads_data', 'reloads the data'));
    }
    return parts.length ? parts.join(' · ') : { muted: ctx.t('automations.node.return_to_app.card_empty', 'tells the app nothing yet') };
}

function callLayerSummary(step: Step): Summary {
    const inputs = keysOf(step.inputs);
    return inputs.length === 0 ? { muted: 'no inputs mapped' } : `${plural(inputs.length, 'input')}: ${listed(inputs)}`;
}

function codeSummary(step: Step): Summary {
    const code = str(step.code);
    const lines = code ? code.split('\n').length : 0;
    const hash = str(step.codeHash).slice(0, 8);
    return lines === 0 ? { muted: 'no code yet' } : `${plural(lines, 'line')}${hash ? ` · ${hash}` : ''}`;
}

function httpSummary(step: Step): Summary {
    const method = (str(step.method) || 'GET').toUpperCase();
    return step.url ? `${method} ${str(step.url)}` : { muted: `${method} · no URL set` };
}

function fieldNames(step: Step): Summary {
    const fields = Array.isArray(step.fields) ? (step.fields as { name?: string }[]).filter((f) => f && f.name).map((f) => f.name as string) : [];
    return fields.length === 0 ? { muted: 'no fields' } : `${plural(fields.length, 'field')}: ${listed(fields)}`;
}

/**
 * A ported list summary ("First 3 of ‹Search email›.results") with its list
 * named as the fields name it ("First 3 of ‹Search email ▸ Results›"): the
 * web function is left as it is, and the words it put in for the list are
 * swapped for ours.
 */
function namedList(summary: Summary, step: Step, ctx: SummaryContext): Summary {
    if (typeof summary !== 'string' || !step.arrayRef) return summary;
    const ported = humanizeExpression(step.arrayRef, labels(ctx)) || String(step.arrayRef);
    const readable = readablePath(step.arrayRef, labels(ctx), ctx.t);
    return readable ? summary.replace(ported, () => readable) : summary;
}

type Summariser = (step: Step, ctx: SummaryContext) => Summary;

const SUMMARIES: Record<string, Summariser> = {
    ai_step: aiSummary,
    integration_action: (s) => humanizeToolName(s.tool || 'unknown_tool'),
    condition: (s, ctx) => readableRule(s.expr, labels(ctx), ctx.t) || { muted: 'no expression' },
    switch: switchSummary,
    filter: filterSummary,
    loop: loopSummary,
    parallel: parallelSummary,
    set: (s) => {
        const text = summariseSetStep(s);
        return text === 'No fields yet' || text === 'Nothing to do yet' ? { muted: text } : text;
    },
    notification: (s, ctx) => readableText(s.body, labels(ctx)) || { muted: 'no message yet' },
    code: codeSummary,
    http_request: httpSummary,
    stop_error: (s) => str(s.message) || { muted: 'no message' },
    return_to_app: returnToAppSummary,
    guard: guardSummary,
    tokenize: (s, ctx) => privacySummary(s, ctx, 'nothing to hide yet'),
    untokenize: (s, ctx) => privacySummary(s, ctx, 'nothing to restore yet'),
    form_page: formPageSummary,
    call_layer: callLayerSummary,
    call_block: callLayerSummary,
    layer_output: (s) => (keysOf(s.fields).length ? `returns: ${listed(keysOf(s.fields))}` : { muted: 'no output fields' }),
    parse_json: fieldNames,
    note: (s) => str(s.text).split('\n')[0] || { muted: 'empty note' },
    limit: (s, ctx) => namedList(limitSummary(s, { stepLabelById: labels(ctx) }), s, ctx),
    dedupe: (s, ctx) => namedList(dedupeSummary(s, { stepLabelById: labels(ctx) }), s, ctx),
    aggregate: (s, ctx) => namedList(aggregateSummary(s, { stepLabelById: labels(ctx) }), s, ctx),
    summarize: (s, ctx) => namedList(summarizeSummary(s, { stepLabelById: labels(ctx) }), s, ctx),
    flatten: (s, ctx) => flattenSummary(s, { stepLabelById: labels(ctx), t: ctx.t }),
    datatable: (s, ctx) => datatableSummary(s, { tableNameById: ctx.tableNameById ?? null }),
    knowledge_write: (s, ctx) => knowledgeWriteSummary(s, { kbNameById: ctx.kbNameById ?? null }),
    datetime: (s) => dateTimeSummary(s),
    generate_document: (s) => generateDocumentSummary(s),
    fill_document: (s) => fillDocumentSummary(s),
    slide: (s) => slideSummary(s),
    presentation: (s) => presentationSummary(s),
    data_extraction: (s) => dataExtractionSummary(s),
    wait: (s) => waitSummary(s),
    // The question is cut at 60 characters: named first, so the cut never leaves half a `{{…`.
    approval: (s, ctx) => approvalSummary({ ...s, prompt: readableText(s.prompt, labels(ctx)) }),
};

/**
 * The card's one line under the name; `{ muted }` for "not answered yet".
 * Any `{{…}}` left in it (a prompt, a URL, a message) is named on the way out.
 */
export function stepSummary(node: AnyNode | null | undefined, ctx: SummaryContext): Summary {
    if (!node) return '';
    if (node.type === 'trigger') return readableSummary(triggerSummary(node, ctx.t), labels(ctx));
    const fn = Object.prototype.hasOwnProperty.call(SUMMARIES, node.type) ? SUMMARIES[node.type] : undefined;
    return fn ? readableSummary(fn(node as Step, ctx), labels(ctx)) : '';
}

/** What an unnamed card is called, per type, where the web card says more than the type's default. */
const UNNAMED: Record<string, (node: AnyNode, ctx: SummaryContext) => string> = {
    integration_action: (node) => humanizeToolName(node.tool || 'unknown_tool'),
    form_page: (node) => (node.mode === 'ending' ? 'Closing page' : 'Ask for more info'),
    call_layer: (node) => str(node.layerKey) || 'Flowlet',
    condition: () => ROUTE_STEP_NAME,
    switch: () => ROUTE_STEP_NAME,
    filter: () => ROUTE_STEP_NAME,
    set: () => SET_STEP_NAME,
};

/** What a step is called without a label of its own: what the web card falls back to. */
export function unnamedStepName(node: AnyNode, ctx: SummaryContext): string {
    if (node.type === 'trigger') return triggerName(node);
    const unnamed = Object.prototype.hasOwnProperty.call(UNNAMED, node.type) ? UNNAMED[node.type] : undefined;
    return unnamed?.(node, ctx) || nodeDefaultLabel(node.type, ctx.t) || node.type;
}

/** The card's name: the author's label, else what the web card falls back to. */
export function stepName(node: AnyNode | null | undefined, ctx: SummaryContext): string {
    if (!node) return '';
    if (node.type === 'trigger') return triggerName(node);
    const label = str(node.label).trim();
    // A notification is named by its title (NotificationNode).
    if (node.type === 'notification') return readableText(node.title, labels(ctx)) || label || nodeDefaultLabel('notification', ctx.t);
    return label || unnamedStepName(node, ctx);
}

/** A summary as the text it shows, and whether it is the muted "not yet" state. */
export function summaryText(summary: Summary): { text: string; muted: boolean } {
    return typeof summary === 'string' ? { text: summary, muted: false } : { text: summary.muted, muted: true };
}
