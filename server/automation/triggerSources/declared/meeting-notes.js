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
 * ── WAAR EEN ABONNEMENT OP FILTERT ──────────────────────────────────
 * `filter: { tags?: string[]|string, reprocessed?: boolean }`, uitgevoerd door
 * `matchMeetingProcessedFilter` in automation/triggerBus/filters.js. Die
 * matcher hoort bij deze declaratie: zonder hem valt het event terug op de
 * ondiepe `matchFilter`, en dáár matcht een tagfilter nooit (die vergelijkt
 * een gevraagde lijst met de payload-array in plaats van te overlappen).
 *
 * Een LEGE of afwezige `tags` betekent ELKE afgeronde meeting, niet geen
 * enkele — de afweging staat voluit boven die matcher, en de UI
 * (Builder/flow/settings/triggerFilters.jsx) zegt het op het scherm.
 *
 * ── WAT DEZE DECLARATIE VANZELF MEELIFT, EN WAT NIET ────────────────
 * Mee, zonder extra code: de variabelenkiezer en trigger.output.*-samples
 * (builderTools/triggerCatalog.js), de bare-name-reparatie van bindings, de
 * prompt van de bouw-agent én daarmee de MCP-toolset (triggerSources/
 * describe.js → builderTools/schemas.js → automation/mcpBuilder.js), de
 * tenancy/fan-out (`scope: 'org'` → triggerBus/dispatch.js) en de
 * registry-regressietests.
 * NIET mee: (a) de provider-dropdown in de builder — `availability.check`
 * wordt pas waar als routes/automation/catalog.js de sleutel `meeting_notes`
 * in `checks` zet; (b) het filterformulier, dat per (provider, event) in de
 * frontend geregistreerd staat; (c) de suggestie-engine, die geen enkele
 * trigger-declaratie leest (automation/suggestions.js kent alleen de grove
 * `triggerKind` en de integratie-ids uit de scan) — een suggestie noemt deze
 * trigger dus alleen als het model haar in de builder-prompt tegenkomt.
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
