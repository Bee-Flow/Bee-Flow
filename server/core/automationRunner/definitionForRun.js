/**
 * Which definition does a run execute — the LIVE copy or the WORKING copy?
 *
 * Studio → Automations handoff 5 split the two (stores/automationStore/
 * lifecycle.js): editor saves land in the working copy (`definition`,
 * `version`); scheduled, event, webhook, form and agent runs
 * execute the live copy (`liveDefinition`, `liveVersion`) until the owner
 * publishes. This module is the ONE place that decides, so the runner and
 * every trigger surface (schedules, subscriptions, webhooks, forms, agent
 * tools, app buttons) cannot come to disagree about what "the automation" is.
 *
 * The rule:
 *   - a TEST run executes the working copy: a dry run (mode 'dry_run'), a
 *     partial builder run (triggerKind 'manual_step': ▶ Execute, retry-from,
 *     "Run up to here"), and a live-mode run the caller flags `isTest` (the
 *     builder's Test button);
 *   - every other run executes the live copy — when there is one. An automation
 *     that was never live has only its working copy, and runs it (today's
 *     behaviour, unchanged);
 *   - only automations take part: a Reusable Step (kind 'block') has its own
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
 * automationForRun's own result carries the live copy the same way, so a
 * later managed selection can still read the live settings from it.
 *
 * MANAGED automations (`opts.managed`, an automation in a Solution stage project,
 * design D17): during a deploy's prepare the working copy IS the incoming
 * release, so nothing may read it before the commit moves the live pointer.
 *   - every run, test runs included, executes the LIVE copy;
 *   - the settings come from the live copy too (withWorkingSettings is skipped);
 *   - an automation with no live copy cannot run: source 'not_deployed', and
 *     automationForRun throws managed_part_not_deployed (409);
 *   - a caller-built synthetic (a spread without the live copy) keeps the
 *     STEPS its caller chose only when they cannot be the incoming release:
 *     it carries `runsLiveVersion` (chosen from the live copy through this
 *     module: a partial run's synthetic, a spread of a live selection), or
 *     its `version` is at most the row's `liveVersion` (a resume pinned to
 *     the version it started on, test runs included). Any other spread (a
 *     raw row, a test-run selection: version above the live one) holds the
 *     working copy and is refused as not deployed;
 *   - such a synthetic gets the LIVE settings when the caller passes the
 *     store's live copy as `opts.liveDefinition` (execution.js re-reads the
 *     row for exactly this), so a spread of an unmanaged selection cannot
 *     carry the working settings into a managed run.
 * The caller decides `managed` (execution.js asks stores/lib/managedParts);
 * this module stays pure.
 *
 * Pure. No store access.
 */

'use strict';

const { HttpError } = require('../http/errors');

const TEST_TRIGGER_KINDS = new Set(['manual_step', 'dry_run']);

/** Definition keys that are automation SETTINGS: always read from the working copy. */
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

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The live copy of a row, or null when it has none (never live, or not carried). */
function liveCopyOf(automation) {
    const live = automation.liveDefinition;
    if (automation.liveVersion == null || !live || typeof live !== 'object') return null;
    return live;
}

/**
 * Did the caller of a spread (no live copy carried) choose something that
 * cannot be the incoming release? Either this module pointed it at the live
 * copy (`runsLiveVersion`), or its version is not above the live version (a
 * resume pinned to the version it started on). A version above the live one
 * is the working copy, which during a deploy's prepare IS the release.
 */
function spreadIsDeployed(automation) {
    const lv = automation.liveVersion;
    if (!Number.isFinite(lv)) return false; // no live copy (any more): nothing deployed to run
    if (automation.runsLiveVersion) return true;
    const v = automation.version;
    return Number.isFinite(v) && v <= lv;
}

/**
 * D17: a managed automation runs its live copy with the live settings, test runs
 * included, and does not run at all without one. `storeLive` is the store's
 * live copy (optional), whose settings a caller-built synthetic gets.
 */
function managedDefinitionForRun(automation, storeLive) {
    if ((automation.kind || 'automation') !== 'automation') {
        return { definition: automation.definition || {}, version: automation.version ?? null, source: 'working' };
    }
    if (!hasOwn(automation, 'liveDefinition')) {
        if (!spreadIsDeployed(automation)) return { definition: {}, version: null, source: 'not_deployed' };
        const chosen = automation.definition || {};
        const definition = storeLive && typeof storeLive === 'object' ? withWorkingSettings(chosen, storeLive) : chosen;
        return { definition, version: automation.version ?? null, source: 'live' };
    }
    const live = liveCopyOf(automation);
    if (!live) return { definition: {}, version: null, source: 'not_deployed' };
    return { definition: live, version: automation.liveVersion, source: 'live' };
}

/**
 * @param {object|null} automation a row from the store (or a synthetic one)
 * @param {{ mode?: string, triggerKind?: string|null, isTest?: boolean, managed?: boolean, liveDefinition?: object|null }} [opts]
 *   `liveDefinition`: the store's live copy, read only by a managed selection
 *   of a caller-built synthetic (its live settings).
 * @returns {{ definition: object, version: number|null, source: 'live'|'working'|'not_deployed' }}
 */
function definitionForRun(automation, opts = {}) {
    const working = { definition: automation?.definition || {}, version: automation?.version ?? null, source: 'working' };
    if (!automation) return working;
    if (opts.managed) return managedDefinitionForRun(automation, opts.liveDefinition);
    if (isTestRun(opts)) return working;
    if ((automation.kind || 'automation') !== 'automation') return working;
    const live = liveCopyOf(automation);
    if (!live) return working;
    return { definition: withWorkingSettings(live, automation.definition), version: automation.liveVersion, source: 'live' };
}

/** The refusal of a run of a managed automation that has no live copy (D17). */
function managedNotDeployedError(automation) {
    const err = new HttpError(409, 'managed_part_not_deployed',
        'This automation is managed by a Solution stage and has not been deployed yet. Deploy it before running it.',
        { automationId: automation?.id ?? null });
    return Object.assign(err, { errorClass: 'managed_part_not_deployed' });
}

/**
 * The automation as this run should see it: `definition` and `version` are
 * the chosen copy. `workingVersion` keeps the working version number for
 * whoever needs to say "you are editing vN". Returns the SAME object when
 * nothing changes, so an unchanged caller pays nothing.
 *
 * The result carries the live copy non-enumerably, as a store row does, so a
 * managed selection (execution.js) can still take the live settings from it;
 * an unmanaged selection on it returns it unchanged. With `opts.managed` and
 * no live copy it throws managed_part_not_deployed (409).
 */
function automationForRun(automation, opts = {}) {
    if (!automation) return automation;
    // Already chosen: selecting again changes nothing (unless managed, which
    // re-reads the live copy for its live settings).
    if (automation.runsLiveVersion && !opts.managed) return automation;
    const chosen = definitionForRun(automation, opts);
    if (chosen.source === 'not_deployed') throw managedNotDeployedError(automation);
    if (chosen.source === 'working') return automation;
    if (chosen.definition === automation.definition && chosen.version === automation.version && automation.runsLiveVersion) return automation;
    const out = {
        ...automation,
        definition: chosen.definition,
        version: chosen.version,
        // A spread already chosen (or pinned) by its caller: its version is
        // not the working one, so keep what it says about that.
        workingVersion: automation.runsLiveVersion || !hasOwn(automation, 'liveDefinition')
            ? (automation.workingVersion ?? null) : (automation.version ?? null),
        runsLiveVersion: true,
    };
    if (hasOwn(automation, 'liveDefinition')) {
        Object.defineProperty(out, 'liveDefinition', {
            value: automation.liveDefinition, enumerable: false, writable: true, configurable: true,
        });
    }
    return out;
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

module.exports = { definitionForRun, automationForRun, isTestRun, liveHasTrigger, triggersOf, withWorkingSettings, managedNotDeployedError, TEST_TRIGGER_KINDS, SETTINGS_KEYS };
