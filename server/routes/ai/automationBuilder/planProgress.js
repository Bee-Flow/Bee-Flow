/**
 * Tick the builder's plan checklist from what the tool calls actually did.
 *
 * WHY. The lean prompt tells the model to send `builder_set_plan({markDone})`
 * with every build call, and the owner watches the checklist live. The
 * small local models do not do it: a measured build (2026-09-11, Qwen3.8-27B)
 * had listed files, read them, extracted, written the spreadsheet, wired three
 * error branches and passed a dry-run — with the plan still at 0/9. A plan
 * that only ticks at the end is not a progress view, and more prompt prose
 * has not moved these models. So the ROUTE infers progress, deterministically,
 * from the tool results it already has; the model's own markDone still works
 * and only ever adds to it.
 *
 * HOW. Three kinds of evidence, all cheap:
 *   1. Lifecycle tools: propose_trigger ticks the trigger item; a CLEAN
 *      dry-run ticks the dry-run/test item; summarise ticks a review item;
 *      finalize ticks everything (the build is over).
 *   2. Added steps: a step's label, tool name and type are tokenised and
 *      matched against each open item's tokens. Models label steps in the
 *      plan's own words ("List files in /Invoices", "Read each file"), so
 *      label overlap is the strong signal; tool-name parts (nextcloud_
 *      list_files → list, file) cover the rest.
 *   3. Wiring tools (wire_error_branch, a branch:"error" add) tick an
 *      error-handling item.
 * Two shared significant tokens are required, always: one shared word
 * ("file") would let the LIST step tick the READ item, and "Read each file"
 * has only two significant words to begin with — so an item that short must
 * match on both. Light stemming (trailing s) so "files" meets "file". Items a
 * step cannot evidence ("Finalize", "Dry run") are covered by the lifecycle
 * rules instead. Never un-ticks.
 */

const STOP = new Set([
    'the', 'and', 'for', 'each', 'with', 'into', 'from', 'via', 'per', 'all', 'then', 'that', 'this', 'its',
    'step', 'steps', 'add', 'added', 'create', 'set', 'use', 'using', 'new', 'one', 'run', 'runs',
    'nextcloud', 'already', 'chained', 'foreach', 'forEach',
]);

// The arithmetic (tokens/overlap/two-shared-tokens rule) is the shared
// core/llm/planChecklist tokenizer; the STOP list above is this builder's.
const { tokens, overlap, matchesItem } = require('../../../core/llm/planChecklist').makeTokenizer(STOP);
void overlap;

/** Tokens that describe an added step: label + tool name parts + type. */
function stepTokens(step) {
    const parts = [step && step.label, step && step.tool && String(step.tool).replace(/_/g, ' '), step && step.type && String(step.type).replace(/_/g, ' ')];
    // Type words that mean something to a plan item.
    if (step && step.type === 'ai_step') parts.push('ai extract');
    if (step && step.type === 'condition') parts.push('condition check if');
    if (step && step.type === 'loop') parts.push('loop');
    if (step && step.forEach) parts.push('each');
    return tokens(parts.filter(Boolean).join(' '));
}

const RX = {
    trigger: /\btrigger\b/i,
    dryRun: /dry.?run|\btest(ing|ed)?\b/i,
    finalize: /finali[sz]e|activate|save (the )?routine/i,
    review: /\b(review|summar)/i,
    error: /\b(error|fail|fallback|on.?error)/i,
};

/**
 * @param {Array<{text:string, done?:boolean}>} todos
 * @param {{name:string, args?:object, result?:any}} call  a SUCCESSFUL tool call
 * @returns {number[]} indices newly considered done (never already-done ones)
 */
function inferPlanProgress(todos, { name, args, result } = {}) {
    if (!Array.isArray(todos) || !todos.length || !name) return [];
    if (!result || typeof result !== 'object' || result.error) return [];
    const open = todos.map((t, i) => ({ i, text: t && t.text })).filter(t => t.text && !todos[t.i].done);
    if (!open.length) return [];
    const hit = new Set();
    const tick = (pred) => { for (const o of open) if (pred(o.text)) hit.add(o.i); };

    switch (name) {
        case 'builder_propose_trigger':
        case 'builder_add_trigger':
        case 'builder_update_trigger':
            if (result.trigger || result.added) tick(t => RX.trigger.test(t));
            break;
        case 'builder_request_dry_run': {
            const run = result.run;
            const failed = !run || /fail|error/i.test(String(run.status || '')) || (result.steps || []).some(s => s && s.error);
            if (!failed) tick(t => RX.dryRun.test(t));
            break;
        }
        case 'builder_summarise':
            if (result.summary) tick(t => RX.review.test(t));
            break;
        case 'builder_finalize':
            if (result.automation) for (const o of open) hit.add(o.i);
            break;
        case 'builder_wire_error_branch':
            if (result.wired) tick(t => RX.error.test(t));
            break;
        default: {
            const added = Array.isArray(result.added) ? result.added : (result.added ? [result.added] : []);
            const replaced = result.replaced ? [result.replaced] : [];
            // builder_add_steps echoes only {id,type,tool?} per entry
            // (addSteps.js) — no label, no forEach — so a batch-built
            // data_extraction / datatable / ai_step step has only its type
            // word to match on, and 'data extraction' never meets 'Extract
            // invoice details'. Measured: the default batch build of the
            // invoice routine left 2 of 4 step items open. The entry's own
            // spec (args.steps[i].spec, index-aligned with added[i]: every
            // entry either lands in `added` or ends the call, and chatStream
            // slices args.steps to failedIndex for a partial batch) has the
            // label and the forEach.
            const specs = name === 'builder_add_steps' && Array.isArray(args && args.steps) ? args.steps : null;
            added.forEach((step, i) => {
                const entry = specs && specs[i] && typeof specs[i] === 'object' ? specs[i] : null;
                // An entry that put its fields NEXT to spec (normaliseEntry
                // hoists them) still carries the label at the entry level.
                const spec = entry ? (entry.spec && typeof entry.spec === 'object' ? { ...entry, ...entry.spec } : entry) : null;
                const ev = stepTokens(spec ? { ...step, label: step.label || spec.label, forEach: step.forEach || spec.forEach } : step);
                tick(t => matchesItem(t, ev));
            });
            for (const step of replaced) tick(t => matchesItem(t, stepTokens(step)));
            // A step appended onto an error branch is the error handling.
            if (added.length && args && args.branch === 'error') tick(t => RX.error.test(t));
            // A batch entry may carry branch:"error" inside its spec.
            if (name === 'builder_add_steps' && Array.isArray(args && args.steps) && args.steps.some(e => e && e.spec && e.spec.branch === 'error')) {
                tick(t => RX.error.test(t));
            }
        }
    }
    return [...hit].sort((a, b) => a - b);
}

module.exports = { inferPlanProgress, _internals: { tokens, stepTokens, matchesItem } };
