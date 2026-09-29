/**
 * App Studio builder — the health of one build, read off its SSE transcript.
 *
 * The rehearsal harness (scripts/drive-app-builder.js) records every event a
 * turn emits; this turns that list into the handful of numbers that decide
 * whether a build is healthy — rounds, finalized, failed calls, rounds that
 * hit the length limit, the linked tables and their live counts — so three
 * rehearsals can be compared at a glance. Pure; colocated test.
 */

'use strict';

function summariseBuilderRun(events, { iterationCap = 24 } = {}) {
    const list = Array.isArray(events) ? events : [];
    const of = (name) => list.filter((e) => e && e.event === name);
    const toolCalls = of('tool_call');
    const usage = of('usage');
    const rounds = of('round_start');
    const done = of('done')[0];
    const errors = of('error').map((e) => e.data);
    const lastDataModel = [...of('data_model')].pop();
    const lastValidation = [...of('validation_errors')].pop();
    const lastPlan = [...of('plan')].filter((e) => e.data && Array.isArray(e.data.todos)).pop();
    const firstNonPing = list.find((e) => e && e.event !== 'ping' && e.event !== 'builder_session' && e.event !== 'model_selected' && e.event !== 'round_start' && e.event !== 'prompt_progress' && e.event !== 'plan');

    // Tool calls per round: bucket by round_start (or usage, for old transcripts).
    const perRound = [];
    let bucket = null;
    for (const e of list) {
        if (!e) continue;
        if (e.event === 'round_start') { if (bucket) perRound.push(bucket); bucket = []; continue; }
        if (e.event === 'tool_call') { (bucket = bucket || []).push(e.data && e.data.name); }
    }
    if (bucket) perRound.push(bucket);

    // A round that ended without a tool call and whose usage says the reply
    // was cut off — or, for adapters that report it, a finish reason of length.
    const lengthRounds = usage.filter((u) => u.data && (u.data.finish_reason === 'length' || u.data.stop_reason === 'max_tokens' || (u.data.timings && u.data.timings.truncated))).length;

    const callsByName = {};
    for (const tc of toolCalls) { const n = tc.data && tc.data.name; if (n) callsByName[n] = (callsByName[n] || 0) + 1; }
    const failedCalls = toolCalls.filter((tc) => tc.data && tc.data.ok === false).map((tc) => ({ name: tc.data.name, error: String(tc.data.error || tc.data.summary || '').slice(0, 300), repeated: tc.data.result && /"_repeated":(\d+)/.test(String(tc.data.result)) ? Number(/"_repeated":(\d+)/.exec(String(tc.data.result))[1]) : undefined }));
    const repeatedMax = failedCalls.reduce((m, f) => Math.max(m, f.repeated || 0), 0);

    const dataModel = lastDataModel && lastDataModel.data && Array.isArray(lastDataModel.data.tables)
        ? lastDataModel.data.tables.map((t) => ({ id: t.id, key: t.key, rowCount: t.rowCount, linked: t.linked ? t.linked.kind : null, mode: t.linked ? t.linked.mode : null }))
        : [];
    const lastRound = [...rounds].pop();
    return {
        rounds: rounds.length || usage.length,
        hitIterationCap: (rounds.length || usage.length) >= iterationCap,
        finalized: !!(done && done.data && done.data.finalized),
        awaitingPlan: !!(done && done.data && done.data.awaitingPlan),
        toolCallTotal: toolCalls.length,
        toolCallsPerRound: perRound.map((b) => b.length),
        callsByName,
        failedCalls,
        repeatedMax,
        lengthRounds,
        errors,
        validation: lastValidation && lastValidation.data ? { errors: (lastValidation.data.errors || []).map((e) => e.code), warnings: (lastValidation.data.warnings || []).length } : null,
        plan: lastPlan ? { done: lastPlan.data.todos.filter((t) => t.done).length, total: lastPlan.data.todos.length } : null,
        dataModel,
        promptCharsMax: rounds.reduce((m, r) => Math.max(m, (r.data && r.data.promptChars) || 0), 0),
        local: lastRound && lastRound.data ? !!lastRound.data.local : null,
        modelId: lastRound && lastRound.data ? lastRound.data.modelId || null : null,
        ttfbMs: firstNonPing ? firstNonPing.at ?? null : null,
        wallClockMs: list.length ? (list[list.length - 1].at ?? null) : null,
        toolDraftEvents: of('tool_draft').length,
        promptProgressEvents: of('prompt_progress').length,
    };
}

/** The one-line verdict the rehearsal recipe asks for. */
function isHealthyRun(summary) {
    return !!summary && summary.finalized && summary.failedCalls.length <= 2 && summary.lengthRounds === 0
        && summary.rounds <= 8 && summary.repeatedMax < 3 && summary.errors.length === 0;
}

module.exports = { summariseBuilderRun, isHealthyRun };
