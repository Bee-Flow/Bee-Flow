/** @typedef {import('../automationModel/dslFilters').TriggerPayload} TriggerPayload */
// @typecheck
/**
 * The meeting-notes triggers on an automation definition, the payload a
 * `meeting.processed` dispatch would carry for a meeting, and whether a
 * trigger's stored filter fires on it. Extracted from ./meetingUsage.js,
 * which re-exports all of it; the header there explains why the provider is
 * spelled with a hyphen and why the scan is scoped to the meeting's owner.
 */

'use strict';

const log = require('../../telemetry/log');
// The trigger bus lives in automation/, a feature: injected (../automationRunner/featurePorts.js).
const { runnerPort } = require('../automationRunner/featurePorts');

/** The provider/event the meeting bus actually speaks. Hyphen — see the header. */
const MEETING_PROVIDER = 'meeting-notes';
const MEETING_EVENT = 'meeting.processed';

/**
 * Tags, exactly as every other tag consumer sees them.
 *
 * NOTHING in this product normalises a meeting tag. `PATCH /:id` writes
 * `req.body.tags` straight through with no validation, the chip editor only
 * `.trim()`s, `armMeetingSources` compares with `config->>'tag' = ANY($1)`
 * and `listByTag` with jsonb containment of `'["sales"]'` in `tags`. So `Sales`, `sales` and
 * `' sales'` are three different tags to the arming query, and they have to
 * be three different tags here too — lower-casing or trimming in this one
 * place would make the bar claim a knowledge base is fed by a meeting whose
 * tag that base's query will never match.
 *
 * Only non-empty strings survive: the column is unvalidated JSONB, so a
 * number, an object or `null` can be in there, and an empty string would
 * match a source whose tag was saved empty by the same absent validation.
 */
function tagsOf(meeting) {
    const raw = Array.isArray(meeting?.tags) ? meeting.tags : [];
    const seen = new Set();
    for (const t of raw) {
        if (typeof t !== 'string') continue;
        if (t === '') continue;
        seen.add(t);
    }
    return [...seen];
}

/** Every app_event trigger on a definition — the primary one and `triggers[]`. */
function appEventTriggersOf(definition) {
    const all = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])];
    return all.filter(t => t && t.kind === 'app_event' && t.appEvent?.provider && t.appEvent?.event);
}

/** The meeting-notes triggers on a definition, in definition order. */
function meetingTriggersOf(definition) {
    return appEventTriggersOf(definition)
        .filter(t => t.appEvent.provider === MEETING_PROVIDER && t.appEvent.event === MEETING_EVENT);
}

/**
 * The payload a dispatch would actually carry for this meeting.
 *
 * Byte-for-byte the shape `emitMeetingProcessed` builds, minus `reprocessed`:
 * a filter that only wants first ingests (`{reprocessed: false}` — whatever
 * a future matcher makes of that) must not be counted in because we invented
 * a re-run that is not happening. Deliberately NOT the summary, the title or
 * the attendees — this object is handed to tenant-written filter expressions
 * and BFSF-441 keeps personal data out of anything that leaves the note.
 */
function syntheticPayload(meeting) {
    return {
        transcriptionId: meeting?.id != null ? String(meeting.id) : null,
        tags: tagsOf(meeting),
        orgId: meeting?.organizationId || null,
    };
}

/**
 * Would this trigger's stored filter fire on this meeting?
 *
 * Runs the REAL dispatch path — `pickMatcher(provider, event)` wrapped in
 * `applyDslFilter`, the exact pair `dispatch.js` builds — so the list and the
 * bus cannot disagree. Returns `null` when the matcher could not decide,
 * which the caller records as `partial` rather than as "no".
 * @param {TriggerPayload} payload
 */
function triggerFires(trigger, payload) {
    try {
        const { pickMatcher } = runnerPort('triggerBus');
        const { applyDslFilter } = require('../automationModel/dslFilters');
        const base = pickMatcher(MEETING_PROVIDER, MEETING_EVENT);
        return applyDslFilter(payload, trigger?.appEvent?.filter ?? null, base) === true;
    } catch (e) {
        log.warn('[MeetingUsage] filter could not be evaluated:', /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * What a row says about WHEN an automation fires: `{ siteLabel?, unfiltered? }`.
 *
 * Describes what was CONFIGURED; `triggerFires` decides whether it matches.
 * Two deliberate restraints:
 *   - no English sentence is minted here. "on every meeting" is a phrase the
 *     screen owns and translates; the server says `unfiltered: true` and lets
 *     it. A server-built label arrives untranslated in every locale, and
 *     `UsedByTab` renders `siteLabel` verbatim.
 *   - the only text that travels is the tenant's OWN — the tags they typed,
 *     or their `expr` string — capped. Never a minted English sentence.
 *
 * A tag filter gets a label now that it really fires (M5): a row in Used-by
 * with no word about WHY it is there is the one row in that list nobody can
 * check, and `UsedByTab` renders nothing when `siteLabel` is absent. The tags
 * are the tenant's own strings, so the `expr` rule already covers them.
 */
function triggerLabel(trigger) {
    const f = trigger?.appEvent?.filter;
    if (!f || typeof f !== 'object' || Object.keys(f).length === 0) return { unfiltered: true };
    if (typeof f.expr === 'string' && f.expr.trim()) return { siteLabel: f.expr.trim().slice(0, 80) };
    const tags = Array.isArray(f.tags) ? f.tags : (typeof f.tags === 'string' ? [f.tags] : []);
    const clean = tags.filter((/** @type {string} */ t) => typeof t === 'string' && t.trim()).map((/** @type {string} */ t) => t.trim());
    if (clean.length) return { siteLabel: clean.join(', ').slice(0, 80) };
    return {};
}

module.exports = {
    MEETING_PROVIDER,
    MEETING_EVENT,
    tagsOf,
    appEventTriggersOf,
    meetingTriggersOf,
    syntheticPayload,
    triggerFires,
    triggerLabel,
};

/**
 * @typedef {{ kind?: string, appEvent?: { provider?: string, event?: string,
 *   filter?: Record<string, unknown> | null } }} AppEventTrigger
 */

/** @typedef {{ trigger?: AppEventTrigger, triggers?: AppEventTrigger[] }} TriggerDefinition */

/** @typedef {{ id?: string | number | null, tags?: unknown, organizationId?: string | null }} MeetingLike */
