// @typecheck
'use strict';

/**
 * What a dry run feeds the trigger, and whether the trigger's filter would
 * have let it through. Without this an app_event dry run ran on `{}` (every
 * binding missing, still `ok`) and never looked at the filter, so a filter
 * that cannot match passed unnoticed.
 */

const { fallback } = require('../../utils/bestEffort');

/**
 * @param {{ kind?: string, appEvent?: { provider?: string|null, event?: string|null, filter?: unknown } } | null | undefined} trigger
 * @param {Record<string, unknown> | null | undefined} givenPayload
 * @returns {{ payload: Record<string, unknown> | null, source: 'declared_sample' | 'given' | 'none', filterMatched: boolean | null, warnings: string[] }}
 */
function prepareDryRunPayload(trigger, givenPayload) {
    const given = givenPayload && typeof givenPayload === 'object' ? givenPayload : null;
    if (!trigger || trigger.kind !== 'app_event' || !trigger.appEvent?.provider || !trigger.appEvent?.event) {
        return { payload: given, source: given ? 'given' : 'none', filterMatched: null, warnings: [] };
    }
    const { provider, event, filter } = trigger.appEvent;
    let payload = given;
    /** @type {'declared_sample' | 'given' | 'none'} */
    let source = given && Object.keys(given).length ? 'given' : 'none';
    const warnings = [];
    if (!payload || Object.keys(payload).length === 0) {
        /** @type {{ sample?: Record<string, unknown> } | null} */
        let def = null;
        try { def = require('../triggerSources').getEventDef(provider, event); } catch (e) { fallback('automation/builderTools/dryRunTrigger:prepareDryRunPayload', e); /* [dryRun] no declared sample: */ }
        if (def?.sample && typeof def.sample === 'object') {
            payload = { ...def.sample };
            source = 'declared_sample';
            warnings.push(`No triggerPayload was given, so the declared sample for ${provider}.${event} fed the trigger. Pass triggerPayload to test real values.`);
        } else {
            warnings.push(`No triggerPayload was given and ${provider}.${event} declares no sample: trigger.output is empty, so bindings to it resolve to nothing.`);
        }
    }
    /** @type {boolean | null} */
    let filterMatched = null;
    if (payload && filter && typeof filter === 'object') {
        try {
            const { pickMatcher } = require('../triggerBus/filters');
            const { applyDslFilter } = require('../triggers/dslFilters');
            const base = pickMatcher(provider, event);
            filterMatched = !!applyDslFilter(payload, filter, base);
        } catch (e) { fallback('automation/builderTools/dryRunTrigger:prepareDryRunPayload#2', e); /* [dryRun] trigger filter not evaluated: */ }
        if (source === 'declared_sample') {
            // The sample is a generic example, not the person's data: a narrow
            // filter missing it says nothing about the filter. Report it as advice only.
            if (filterMatched === false) {
                warnings.push('the declared sample does not pass your filter (expected for a narrow filter); pass a triggerPayload that should match to test it.');
            }
            filterMatched = null;
        } else if (filterMatched === false) {
            warnings.push('The trigger filter would NOT let this payload through, so a real event like it would not start the automation. Adjust the filter or the triggerPayload.');
        }
    }
    return { payload, source, filterMatched, warnings };
}

module.exports = { prepareDryRunPayload };
