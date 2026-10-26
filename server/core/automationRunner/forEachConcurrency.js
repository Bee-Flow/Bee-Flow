// @typecheck
/**
 * How many items of a "run once per item" step may be in flight at once, and
 * the worker pool that runs them (execForEachStep).
 *
 * Serial is the default, because a step body may depend on item order or have
 * side effects. Three kinds of step opt in:
 *   - read-only integration fetches (PARALLEL_READ_TOOLS), a few at a time;
 *   - `data_extraction`: one model call per item, no side effects;
 *   - `ai_step` while NO tool can be offered to the model: a plain chat call.
 *     With tools the model may write (send, create, delete), so the items stay
 *     in order. Skills and agent start-rights count as tools here for the same
 *     reason.
 * The two model-backed kinds are bounded by AUTOMATION_FOREACH_MAX_CONCURRENCY
 * (default 4, 0 = no cap beyond the item count) and, below it, by the provider
 * limiter (core/llm/providerLimiter.js), which queues the calls per provider
 * connection and waits out a 429.
 *
 * Identical items started at the same moment may each call the model before
 * the first answer is stored for reuse (askOnce); the second run of a list, or
 * a later item, does reuse it.
 */

const { aiStepCanCallTools } = require('../automationModel/aiStepReliability');

// Read-only fetches a per-item step may run a few at a time (see
// execForEachStep). Attachments get fewer: each one is also parsed / OCR'd in
// this process, and five large PDFs at once is a memory spike for nothing.
const PARALLEL_READ_TOOLS = new Map([['gmail_read', 5], ['gmail_read_attachment', 3]]);

const DEFAULT_MAX_CONCURRENCY = 4;
/** The most items one forEach ever runs (maxIterations is capped at 1000). */
const FOREACH_CONCURRENCY_CEILING = 1000;

/** The platform cap for model-backed items. 0 means no cap beyond the item count. */
function forEachMaxConcurrency() {
    const raw = process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY;
    if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_CONCURRENCY;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_CONCURRENCY;
}

/** The step's own `forEach.concurrency` when it is a usable integer, else null. */
function stepConcurrency(step) {
    const v = Number(step && step.forEach && step.forEach.concurrency);
    if (!Number.isFinite(v) || v < 1) return null;
    return Math.min(Math.floor(v), FOREACH_CONCURRENCY_CEILING);
}

/**
 * Items in flight at once for this step.
 * @param {any} step
 * @param {string} mode 'live' | 'dry_run'
 * @returns {number} integer >= 1
 */
function forEachConcurrencyFor(step, mode) {
    if (!step) return 1;
    if (step.type === 'integration_action') {
        return mode === 'live' && PARALLEL_READ_TOOLS.has(step.tool) && !step.askOnce
            ? (PARALLEL_READ_TOOLS.get(step.tool) ?? 1) : 1;
    }
    if (step.type !== 'ai_step' && step.type !== 'data_extraction') return 1;
    if (step.type === 'ai_step' && aiStepCanCallTools(step)) return 1;
    const cap = forEachMaxConcurrency();
    const own = stepConcurrency(step);
    if (cap === 0) return own ?? FOREACH_CONCURRENCY_CEILING;
    return Math.max(1, Math.min(own ?? cap, cap));
}

/**
 * Run `runItem(0..count-1)` with at most `concurrency` in flight. Results stay
 * addressed by index (the caller writes them into its own array). After the
 * first rejection no new item starts; the items already running settle, then
 * that first rejection is rethrown, so nothing keeps running once the step is
 * recorded as stopped (a pause, a cancellation).
 *
 * @param {number} count
 * @param {number} concurrency
 * @param {(index: number) => Promise<void>} runItem
 * @returns {Promise<void>}
 */
async function runIndexedPool(count, concurrency, runItem) {
    const workers = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, count));
    let next = 0;
    let stopped = false;
    let firstError;
    const worker = async () => {
        while (!stopped && next < count) {
            const i = next++;
            try {
                await runItem(i);
            } catch (e) {
                if (!stopped) { stopped = true; firstError = e; }
                return;
            }
        }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    if (stopped) throw firstError;
}

module.exports = { PARALLEL_READ_TOOLS, forEachMaxConcurrency, forEachConcurrencyFor, runIndexedPool };
