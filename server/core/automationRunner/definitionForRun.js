/**
 * Which definition does a run execute — the LIVE copy or the WORKING copy?
 *
 * Studio → Automations handoff 5 split the two (stores/automationStore/
 * lifecycle.js): editor saves land in the working copy (`definition`,
 * `version`); scheduled, event, webhook, form and agent runs
 * execute the live copy (`liveDefinition`, `liveVersion`) until the owner
 * publishes. This module is the ONE place that decides, so the runner and
 * every trigger surface (schedules, subscriptions, webhooks, forms, agent
 * tools, app buttons) cannot come to disagree about what "the routine" is.
 *
 * The rule:
 *   - a TEST run executes the working copy: a dry run (mode 'dry_run'), a
 *     partial builder run (triggerKind 'manual_step': ▶ Execute, retry-from,
 *     "Run up to here"), and a live-mode run the caller flags `isTest` (the
 *     builder's Test button);
 *   - every other run executes the live copy — when there is one. A routine
 *     that was never live has only its working copy, and runs it (today's
 *     behaviour, unchanged);
 *   - only routines take part: a Reusable Step (kind 'block') has its own
 *     published_version and is resolved by its own callers.
 *
 * SETTINGS apply immediately (owner decision, handoff 5): the keys in
 * SETTINGS_KEYS (notificationSettings, runPolicy) are settings,
 * not steps. A live run executes the live copy's steps with the WORKING
 * copy's values for these keys, so a changed retry policy, notification or
 * app button takes effect without a publish. A key the working copy lacks is
 * absent from the result too. The version writer (automation/diffSummary.js
 * planVersionWrite) treats a save that only changed these keys as not
 * pending, for the same reason.
 *
 * `liveDefinition` is carried NON-ENUMERABLE by rowToAutomation, so only a row
 * fresh from the store has it. A caller that spreads a row and swaps in a
 * definition of its own (a partial run, a Step run, a resume pinned to the
 * version it started on) drops it, and gets exactly the definition it chose.
 *
 * Pure. No store access.
 */

'use strict';

const TEST_TRIGGER_KINDS = new Set(['manual_step', 'dry_run']);

/** Definition keys that are routine SETTINGS: always read from the working copy. */
const SETTINGS_KEYS = Object.freeze(['notificationSettings', 'runPolicy']);

/**
 * The live definition with the working copy's settings laid over it. Returns
 * the live object itself when the settings already agree (nothing to copy).
 */
function withWorkingSettings(live, working) {
    const w = working && typeof working === 'object' ? working : {};
    const same = SETTINGS_KEYS.every((k) => live[k] === w[k]
        || JSON.stringify(live[k]) === JSON.stringify(w[k]));
    if (same) return live;
    const out = { ...live };
    for (const k of SETTINGS_KEYS) {
        if (w[k] === undefined) delete out[k];
        else out[k] = w[k];
    }
    return out;
}

/** True when this run executes the working copy. */
function isTestRun({ mode = 'live', triggerKind = null, isTest = false } = {}) {
    return !!isTest || mode === 'dry_run' || TEST_TRIGGER_KINDS.has(triggerKind);
}

/**
 * @param {object|null} automation a row from the store (or a synthetic one)
 * @param {{ mode?: string, triggerKind?: string|null, isTest?: boolean }} [opts]
 * @returns {{ definition: object, version: number|null, source: 'live'|'working' }}
 */
function definitionForRun(automation, opts = {}) {
    const working = { definition: automation?.definition || {}, version: automation?.version ?? null, source: 'working' };
    if (!automation) return working;
    if (isTestRun(opts)) return working;
    if ((automation.kind || 'automation') !== 'automation') return working;
    const live = automation.liveDefinition;
    if (automation.liveVersion == null || !live || typeof live !== 'object') return working;
    return { definition: withWorkingSettings(live, automation.definition), version: automation.liveVersion, source: 'live' };
}

/**
 * The automation as this run should see it: `definition` and `version` are
 * the chosen copy. `workingVersion` keeps the working version number for
 * whoever needs to say "you are editing vN". Returns the SAME object when
 * nothing changes, so an unchanged caller pays nothing.
 */
function automationForRun(automation, opts = {}) {
    if (!automation) return automation;
    const chosen = definitionForRun(automation, opts);
    if (chosen.source === 'working') return automation;
    return {
        ...automation,
        definition: chosen.definition,
        version: chosen.version,
        workingVersion: automation.version ?? null,
        runsLiveVersion: true,
    };
}

/** Every trigger node of a definition: the primary and the extras. */
function triggersOf(definition) {
    return [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])].filter(Boolean);
}

/**
 * Does the definition a live run would execute contain this trigger? A webhook
 * or form minted for a trigger that so far exists only in the working copy is
 * not live yet, and firing it would enter the live flow at its PRIMARY trigger
 * instead — the wrong entry point, silently. Null/empty id = the primary.
 */
function liveHasTrigger(automation, triggerStepId) {
    const { definition } = definitionForRun(automation, { mode: 'live' });
    if (!triggerStepId) return !!definition?.trigger;
    return triggersOf(definition).some((t) => t && t.id === triggerStepId);
}

module.exports = { definitionForRun, automationForRun, isTestRun, liveHasTrigger, triggersOf, withWorkingSettings, TEST_TRIGGER_KINDS, SETTINGS_KEYS };
