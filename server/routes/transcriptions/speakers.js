/**
 * Transcriptions — speaker editing.
 *
 * PATCH /:id/speakers            — rename + merge speakers (atomic)
 * POST  /:id/reidentify-speakers — re-run AI speaker naming on the stored
 *                                  transcript (no audio needed)
 */

const express = require('express');
const router = express.Router();
const transcriptionStore = require('../../stores/transcriptionStore');
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext, resolveUserOrgFromReq, withInsightsPolicy } = require('./shared');
const { toContextBias, identifySpeakerNames, applySpeakerNames } = require('../../core/meetingNotes/summaryHelpers');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded, bodyOf, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

// ── What a speaker edit may carry ───────────────────────────────────
//
// `.strict()` on both. `{"rename": {...}}` left `renames` at `{}`, after which the
// route wrote the segments, the speaker list and the transcript back UNCHANGED and
// returned the entire note: exactly what a successful rename looks like too. And
// `{"attendes": "Tom, Anna"}` on the re-identification dropped the name list just
// typed, ran the model without those names, and OVERWROTE the speaker labels with
// what came out without them.
const RENAMES_TEXT = 'renames must be an object';
const MERGES_TEXT = 'merges must be an array';
const SpeakersBody = bodyOf({
    renames: z.record(z.string(), z.unknown(), { error: typeError({ invalid: RENAMES_TEXT }) }).optional(),
    merges: z.array(z.unknown(), { error: typeError({ invalid: MERGES_TEXT }) }).optional(),
});

// A comma- or newline-separated list, or a real list — toContextBias reads both,
// and that is what both the screen and the mobile app send.
const ATTENDEES_TEXT = 'attendees is een lijst met namen, of namen gescheiden door komma\'s.';
const ReidentifyBody = bodyOf({
    attendees: z.union([
        worded(ATTENDEES_TEXT),
        z.array(worded(ATTENDEES_TEXT)),
    ], { error: () => ATTENDEES_TEXT }).optional(),
});

// ── Edit speakers (rename + merge) ───────────────────────
//
// Atomic edit operation. Payload:
//   { renames: { "Charles": "Sjoerd" },
//     merges:  [{ from: ["Sjoerd", "Charles"], into: "Sjoerd" }] }
//
// Merges run first (collapse multiple speaker IDs into one), then renames
// (straight rename across all remaining speaker IDs). The transcript
// string is rebuilt from segments so it stays in sync with the labels.
// Owner-only.

router.patch('/:id/speakers', requireAuth, validate({ body: SpeakersBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { renames = {}, merges = [] } = req.body;

    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    if (!transcription) return res.status(404).json({ error: 'Not found' });
    if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can edit speakers' });

    // Resolve merges and renames as ONE simultaneous substitution over the
    // ORIGINAL names — never as a chain.
    //
    // The previous version rewrote existing mapping VALUES whenever a
    // rename mentioned them, which made the result order-dependent and
    // destroyed a swap: renaming A→"B" and B→"A" in one save resolved to
    // {A→A, B→A}, so every segment of B was relabelled A and the two
    // speakers merged permanently — `/reidentify-speakers` rebuilds from
    // the already-collapsed list, so the split could never be restored.
    //
    // Merges still apply first (they collapse ids), then a rename is looked
    // up on the merge target, but both lookups read the ORIGINAL name so no
    // substitution can feed itself.
    const mergeOf = new Map();
    for (const merge of merges) {
        const into = String(merge?.into || '').trim();
        const from = Array.isArray(merge?.from) ? merge.from : [];
        if (!into || from.length === 0) continue;
        for (const name of from) {
            if (typeof name === 'string' && name.trim()) mergeOf.set(name, into);
        }
    }
    const renameOf = new Map();
    for (const [oldName, newName] of Object.entries(renames)) {
        if (typeof newName !== 'string' || !newName.trim()) continue;
        renameOf.set(oldName, newName.trim());
    }

    const remap = (name) => {
        const merged = mergeOf.get(name) ?? name;
        // A rename keyed on the original name wins; otherwise a rename that
        // targets the merge result still applies (merge A,B→B then rename
        // B→C gives C), which is what the UI's two-step edit expects.
        return renameOf.get(name) ?? renameOf.get(merged) ?? merged;
    };

    // Two distinct surviving speakers must not resolve to one name. The UI
    // guards this too, but a collapse here is irreversible, so refuse it
    // rather than silently fusing two people's turns.
    const survivors = new Map();
    for (const s of (transcription.speakers || [])) {
        if (!s?.id) continue;
        if (mergeOf.has(s.id)) continue;        // deliberately being merged away
        const to = remap(s.id);
        if (survivors.has(to) && survivors.get(to) !== s.id) {
            return res.status(400).json({
                error: `"${survivors.get(to)}" and "${s.id}" would both become "${to}". Rename them to different names, or merge them explicitly.`,
                code: 'speaker_name_collision',
            });
        }
        survivors.set(to, s.id);
    }

    // Rewrite segments.
    const segments = (transcription.segments || []).map(seg => ({
        ...seg,
        speaker: remap(seg.speaker || seg.speakerId),
    }));

    // Rebuild speakers list — collapse duplicates that now share a name.
    // A row the user touched becomes `manual`: their correction is the most
    // authoritative signal there is, and must survive a later reprocess or
    // auto re-identify. Untouched rows keep whatever named them.
    const collected = {};
    for (const s of (transcription.speakers || [])) {
        const newId = remap(s.id);
        const edited = newId !== s.id;
        if (!collected[newId]) {
            collected[newId] = { id: newId, speakingSeconds: 0, segments: 0, ...(s.source ? { source: s.source } : {}) };
        }
        if (edited) collected[newId].source = 'manual';
        collected[newId].speakingSeconds += Number(s.speakingSeconds || 0);
        collected[newId].segments += Number(s.segments || 0);
    }
    const fmtTime = (secs) => {
        if (secs == null) return '00:00';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    const speakers = Object.values(collected).map(s => ({
        ...s,
        speakingTime: fmtTime(s.speakingSeconds),
    }));

    // Rebuild the transcript string from segments so it stays in sync
    // with the new labels. Matches the format used at create time.
    const transcript = segments
        .map(s => `[${s.speaker}] ${fmtTime(s.start)} - ${fmtTime(s.end)}: ${s.text || ''}`)
        .join('\n');

    await transcriptionStore.updateTranscription(req.params.id, userId, {
        segments,
        speakers,
        transcript,
    });

    const updated = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    // The client replaces its whole note object with this — carry the org's
    // Insights policy along or a disabled org silently gets it back.
    res.json(await withInsightsPolicy(updated));
});

// ── Auto re-identify speakers ────────────────────────────
//
// Re-runs the AI speaker-naming step on the STORED transcript — no
// re-transcription, no audio needed — so a note stuck on "Guest-1/2/3" can be
// mapped to real names. Diarizer IDs alone are hard to name; the single
// strongest signal is a roster, so an optional `attendees` list (names of who
// was in the room) is accepted and, when given, drives the mapping. Owner-only.

router.post('/:id/reidentify-speakers', requireAuth, validate({ body: ReidentifyBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);
    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    if (!transcription) return res.status(404).json({ error: 'Not found' });
    if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can re-identify speakers' });

    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (!segments.length) return res.status(400).json({ error: 'No transcript segments to work from' });

    const language = transcription.language || 'nl';
    // A roster supplied now takes precedence; otherwise reuse whatever was
    // captured at upload. `attendees` may be a comma/newline string or array.
    const suppliedRoster = toContextBias(
        Array.isArray(req.body.attendees) ? req.body.attendees.join(',') : (req.body.attendees || '')
    );
    const roster = suppliedRoster.length ? suppliedRoster : (transcription.attendees || []);

    let userName = null;
    try { const { getUser } = require('../../stores/userStore'); const u = await getUser(userId); userName = u?.firstName || u?.displayName || null; } catch (_) { log.debug('user lookup failed, the user name is omitted', _); }

    // The stored speakers rows carry the speaking-time stats the model uses
    // to tell real participants from short diarization fragments.
    const speakerRows = Array.isArray(transcription.speakers) && transcription.speakers.length
        ? transcription.speakers
        : segments.map(s => ({ id: s.speaker || s.speakerId }));

    // This route works from STORED TEXT — there is no audio, so it can never
    // run voice identification. What it must not do is undo it: rows already
    // settled by a voiceprint (or corrected by hand) are locked, and their
    // names are handed to the model as roster context so the remaining
    // speakers are resolved with that knowledge rather than against it.
    const lockedNames = {};
    for (const s of speakerRows) {
        if (s && s.id && (s.source === 'voiceprint' || s.source === 'manual')) lockedNames[s.id] = s.id;
    }
    const lockedList = Object.keys(lockedNames);

    // The negative half, carried across without needing the audio. The raw
    // diarizer ids are long gone by now — these rows are display names — but
    // the invariant survives the rename: if a voiceprint positively placed
    // Tom on one row, then every OTHER row is, by construction, not Tom.
    // Without this a cheap text-only re-run could merge them back together.
    const voiceprintNames = speakerRows.filter(s => s?.source === 'voiceprint').map(s => s.id);
    const ruledOutNames = {};
    if (voiceprintNames.length) {
        for (const s of speakerRows) {
            if (!s?.id || s.source === 'voiceprint') continue;
            const banned = voiceprintNames.filter(n => n !== s.id);
            if (banned.length) ruledOutNames[s.id] = banned;
        }
    }

    const nameMapping = await identifySpeakerNames(
        segments, speakerRows, language, userName, userOrgId,
        [...new Set([...roster, ...lockedList])],
        {
            lockedNames: lockedList.length ? lockedNames : null,
            ruledOutNames: Object.keys(ruledOutNames).length ? ruledOutNames : null,
            expectedSpeakers: transcription.numSpeakers || null,
        },
    );
    if (!nameMapping || Object.keys(nameMapping).length === 0) {
        return res.status(422).json({ error: 'Could not confidently identify names. Add who was in the meeting and try again.' });
    }
    const { merged, transcript, speakers } = applySpeakerNames(segments, nameMapping);

    // applySpeakerNames rebuilds the stat rows from the segments, so it
    // drops `source`. Carry the old provenance across for the rows that
    // kept their name — those are exactly the locked ones, and losing the
    // marker would let the NEXT re-identify overwrite them.
    const priorSource = new Map(speakerRows.filter(s => s?.id && s.source).map(s => [s.id, s.source]));
    const finalSpeakers = speakers.map(s => (priorSource.has(s.id) ? { ...s, source: priorSource.get(s.id) } : s));

    await transcriptionStore.updateTranscription(req.params.id, userId, {
        segments: merged,
        speakers: finalSpeakers,
        transcript,
        // Persist the roster used so it's remembered for next time.
        ...(suppliedRoster.length ? { attendees: roster } : {}),
    });
    const updated = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    // The client replaces its whole note object with this — carry the org's
    // Insights policy along or a disabled org silently gets it back.
    res.json(await withInsightsPolicy(updated));
});

module.exports = router;
