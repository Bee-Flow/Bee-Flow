// @typecheck strict
/**
 * Cowork store: how a row becomes an object and a new item becomes INSERT
 * parameters. Pure functions, split from coworkStore.js, which re-exports
 * deriveProducedOutput.
 */

/** What starts an event-triggered item: the provider event and the filter of the automation app-event trigger. */
/** @typedef {{ provider: string, event: string, filter?: Record<string, unknown> | null }} EventTrigger */

/**
 * A JSON column back to a value; `fallback` when it does not parse. The caller
 * names the shape through the type of `fallback`.
 * @template T
 * @param {string | T} str
 * @param {T} fallback
 * @returns {T}
 */
function safeParseJSON(str, fallback) {
    if (Array.isArray(str)) return /** @type {T} */ (str);
    try { return JSON.parse(/** @type {string} */ (str)); } catch (_) { return fallback; }
}

/** @type {string[] | null} */
const NO_LIST = null;
/** @type {EventTrigger | null} */
const NO_TRIGGER = null;

/** @param {DbRow.CoworkSchedules | null} r */
function rowToSchedule(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        title: r.title,
        prompt: r.prompt,
        repeatInterval: r.repeat_interval,
        daysOfWeek: r.days_of_week ? safeParseJSON(r.days_of_week, NO_LIST) : null,
        timeOfDay: r.time_of_day || null,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastResult: r.last_result,
        lastStatus: r.last_status,
        isActive: r.is_active,
        modelTier: r.model_tier,
        toolsEnabled: safeParseJSON(r.tools_enabled, ['agent_search']),
        // null = no per-item restriction; fall back to the user's workspace list.
        enabledApps: r.enabled_apps ? safeParseJSON(r.enabled_apps, NO_LIST) : null,
        maxResultLength: r.max_result_length,
        runCount: r.run_count,
        timezone: r.timezone,
        agentId: r.agent_id || null,
        conversationId: r.conversation_id || null,
        // What starts it: 'schedule' (the clock) or 'app_event' (a new mail ...);
        // `trigger` is { provider, event, filter? } for the latter, else null.
        triggerKind: r.trigger_kind || 'schedule',
        trigger: r.trigger_json ? safeParseJSON(r.trigger_json, NO_TRIGGER) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/** @param {DbRow.CoworkRuns | null} r */
function rowToRun(r) {
    if (!r) return null;
    return {
        id: r.id,
        scheduleId: r.schedule_id,
        userId: r.user_id,
        status: r.status,
        triggerKind: r.trigger_kind,
        triggerRef: r.trigger_ref ?? null,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms,
        result: r.result,
        error: r.error,
        // CW-13. Three values, not two: true (something came out), false
        // (successful, nothing to report) and null (row from before the column — not
        // measured). null must NEVER be read as false.
        producedOutput: (r.produced_output === null || r.produced_output === undefined)
            ? null
            : !!r.produced_output,
    };
}

/**
 * Did this successful run have anything to report? (CW-13)
 *
 * The runner never supplies an empty string to markCompleted: if the model produced
 * no text, aiTaskRunner puts its own marker in its place — one italic line in brackets,
 * `_( … )_`, and nothing more. That is the shape that is recognised here, not the Dutch sentence
 * in it: that text is copy and may change (and be translated) without breaking
 * this inference.
 *
 * Deliberately NO substantive judgement on real results — "short text" or
 * "contains no figures" is an opinion, and that does not belong in a column that is read as
 * a fact. Only empty and the marker count as "nothing".
 *
 * Callers that know for certain (the runner knows whether there was tool output)
 * pass `producedOutput` explicitly; this inference is the answer for whoever does not.
 */
function deriveProducedOutput(/** @type {unknown} */ result) {
    if (result === null || result === undefined) return false;
    const text = String(result).trim();
    if (text === '') return false;
    // Exactly one `_( … )_` block and nothing around it: the "no text result"
    // marker of aiTaskRunner. A real answer that happens to start in italics
    // has text around it and therefore counts as normal.
    if (/^_\([\s\S]*\)_$/.test(text)) return false;
    return true;
}

/**
 * repeat_interval, next_run_at, trigger_kind and trigger_json of a new item. An
 * event-triggered item has no clock: next_run_at and the repeat spec are NULL,
 * which keeps it out of getDueSchedules.
 * @param {NewItem} item
 * @returns {Array<string | null | undefined>}
 */
function clockValues({ repeatInterval, nextRunAt, triggerKind = 'schedule', trigger = null }) {
    if (triggerKind !== 'app_event') return [repeatInterval || null, nextRunAt, 'schedule', null];
    return [null, null, 'app_event', trigger ? JSON.stringify(trigger) : null];
}

/**
 * @typedef {{ title: string, prompt: string, repeatInterval?: string | null, nextRunAt?: string | null, modelTier?: string | null,
 *   timezone?: string | null, toolsEnabled?: string[] | null, agentId?: string | null, daysOfWeek?: string[] | null, timeOfDay?: string | null,
 *   enabledApps?: string[] | null, triggerKind?: string, trigger?: EventTrigger | null }} NewItem
 */

/**
 * The INSERT parameters of a new item, after its id and user id.
 * @param {NewItem} f
 */
function insertValues(f) {
    const [repeatInterval, nextRunAt, triggerKind, triggerJson] = clockValues(f);
    const daysJson = Array.isArray(f.daysOfWeek) && f.daysOfWeek.length > 0 ? JSON.stringify(f.daysOfWeek) : null;
    return [
        f.title, f.prompt, repeatInterval, nextRunAt,
        f.modelTier || 'fast',
        f.timezone || 'Europe/Amsterdam',
        JSON.stringify(f.toolsEnabled || ['agent_search']),
        f.agentId || null,
        daysJson,
        f.timeOfDay || null,
        Array.isArray(f.enabledApps) ? JSON.stringify(f.enabledApps) : null,
        triggerKind, triggerJson,
    ];
}

module.exports = { rowToSchedule, rowToRun, deriveProducedOutput, insertValues, safeParseJSON };
