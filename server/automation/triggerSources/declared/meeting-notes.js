// @typecheck strict
/**
 * Meeting Notes. Dispatched in-process the moment a note is ready to be read.
 *
 * ── ONE EVENT, THREE WAYS TO GET IT ─────────────────────────────────
 * A note becomes readable when it is ingested, when it is reprocessed, or
 * when its summary is regenerated. All three emit this same event from the
 * one place that builds its payload
 * (`core/meetingNotes/ingestRecordingCore.emitMeetingProcessed`), because a
 * subscriber that heard about ingests and not about regenerates would act on
 * a summary that had since been rewritten — and there would be nothing in the
 * run to say so.
 *
 * `reprocessed` distinguishes the later two. A subscription that only wants
 * genuinely new meetings filters on it; the default is to react to all three,
 * because "the summary changed" is usually the point.
 *
 * ── WHAT IS AND IS NOT IN THE PAYLOAD ───────────────────────────────
 * The id and the tags, and nothing else. Not the summary, not the title, not
 * the attendees. A meeting note is among the most personal things in the
 * product — it is a transcript of colleagues talking — and this payload is
 * handed to whatever a subscription is wired to, which may be an outbound
 * integration. A subscriber that is entitled to the content fetches it by id,
 * through the store's own read ACL; one that is not gets an id it cannot
 * resolve. That is the same rule the rest of the product follows for outbound
 * destinations (BFSF-441).
 *
 * The tags ARE included, deliberately: they are what a subscription filters
 * on ("only meetings tagged sales"), and filtering after a fetch would mean
 * every subscriber reading every note to decide it was not interested.
 *
 * ── WHERE A SUBSCRIPTION FILTERS ────────────────────────────────────
 * `filter: { tags?: string[]|string, reprocessed?: boolean }`, executed by
 * `matchMeetingProcessedFilter` in automation/triggerBus/filters.js. That
 * matcher belongs to this declaration: without it the event falls back to the
 * shallow `matchFilter`, and there a tag filter never matches (it compares a
 * requested list with the payload array instead of checking for overlap).
 *
 * An EMPTY or absent `tags` means EVERY completed meeting, not none at all —
 * the trade-off is stated in full above that matcher, and the UI
 * (Builder/flow/settings/triggerFilters.jsx) says it on screen.
 *
 * ── WHAT THIS DECLARATION CARRIES ALONG BY ITSELF, AND WHAT NOT ─────
 * Carried along, without extra code: the variable picker and trigger.output.*
 * samples (builderTools/triggerCatalog.js), the bare-name repair of bindings,
 * the prompt of the build agent and with it the MCP toolset (triggerSources/
 * describe.js → builderTools/schemas.js → automation/mcpBuilder.js), the
 * tenancy/fan-out (`scope: 'org'` → triggerBus/dispatch.js) and the registry
 * regression tests.
 * NOT carried along: (a) the provider dropdown in the builder — `availability.check`
 * only becomes true when routes/automation/catalog.js puts the key `meeting_notes`
 * in `checks`; (b) the filter form, which is registered per (provider, event) in
 * the frontend; (c) the suggestion engine, which reads no trigger declaration at
 * all (automation/suggestions.js knows only the coarse `triggerKind` and the
 * integration ids from the scan) — so a suggestion names this trigger only if the
 * model came across it in the builder prompt.
 */
module.exports = { TRIGGER_SOURCES: [{
    // KEBAB-CASE, like every other provider id — `meeting_notes` was
    // rejected outright by triggerSources/validate (PROVIDER_ID_RE), so
    // the source never registered and the trigger never appeared. The
    // underscore form survives where it belongs: `availability.check`
    // below names the CAPABILITY, which is a different namespace.
    id: 'meeting-notes',
    label: 'Meeting Notes',
    order: 62,
    defaultEvent: 'meeting.processed',
    availability: {
        kind: 'check',
        check: 'meeting_notes',
    },
    events: [
        {
            id: 'meeting.processed',
            label: 'Meeting note ready',
            fields: ['transcriptionId', 'tags', 'orgId', 'reprocessed'],
            sample: {
                transcriptionId: '7c1f9a20-4d3e-4b1a-9c8f-2e6d5a4b3c21',
                tags: ['sales', 'klant-van-dijk'],
                orgId: 'org_9f2c41',
                // Absent on a first ingest; true when a summary was
                // regenerated or the recording reprocessed.
                reprocessed: true,
            },
            scope: 'org',
            source: {
                kind: 'push',
            },
        },
    ],
}] };
