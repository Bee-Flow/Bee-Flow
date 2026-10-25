/**
 * Transcriptions — single-note actions.
 *
 * PATCH  /:id                    — rename / edit action items / tags
 * POST   /:id/regenerate-summary — re-run summary + artifacts with a template
 * GET    /:id/export             — markdown / plain-text export
 * DELETE /:id                    — delete a transcription
 * PATCH  /:id/publish            — publish to org / groups
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const transcriptionStore = require('../../stores/transcriptionStore');
const llmClient = require('../../core/llm/llmClient');
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext, resolveUserOrgFromReq } = require('./shared');
const {
    resolveSmartModel,
    extractMeetingArtifacts,
    artifactsUsable,
    generateChapters,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    SUMMARY_MAX_TOKENS,
} = require('../../core/meetingNotes/summaryHelpers');
// The write contract for the three artifact lists (M3) — validation on the way
// in, and the rule that a regenerate replaces only what the AI produced.
const {
    validateActionItems,
    validateDecisions,
    validateQuestions,
    mergeRegeneratedActionItems,
    mergeRegeneratedNotes,
    normalizeActionItems,
} = require('../../core/meetingNotes/actionItems');

// Built-in summary templates + the shared prompt builder live in
// core/meetingNotes/summaryTemplates.js so the /api/summary-templates CRUD and
// this route share one source. Custom (saved) templates come from the store.
const summaryTemplateStore = require("../../stores/summaryTemplateStore");
const { builtinPrompt, buildSummarySystemPrompt, canAccessTemplate } = require("../../core/meetingNotes/summaryTemplates");
// Welke stempel de notitie krijgt: welk sjabloon, welke versie ervan.
const { stampForBuiltin, stampForTemplate, EMPTY_STAMP } = require("../../core/meetingNotes/summaryStamp");
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded, bodyOf, choice, flag, idList, bool, NOTHING, NO_QUERY } = require('./schemas');

// ── What a note action may carry ────────────────────────────────────
//
// Every schema below is `.strict()`, and on the publish route that is the whole
// point. `{"isPublished":true,"sharedGrous":["g-hr"]}` fell back to an EMPTY group
// list, and an empty list on a published note means THE WHOLE ORGANISATION — that
// is how the route's own header describes it. Whoever chose one group shared the
// meeting with everyone, under `{success:true}` and with `sharedGroups: []` as
// the answer.
//
// `tags`, `actionItems`, `decisions` and `questions` keep their own checks:
// core/meetingNotes/actionItems.js builds each item from an allow-list and refuses
// what it does not understand. What the schemas add is that a misspelled key next
// to them no longer drops out silently.

const PatchBody = bodyOf({
    title: worded('Een titel is tekst.').trim().max(300, 'Een titel is hoogstens 300 tekens.').optional(),
    // The same sentence that core/meetingNotes/actionItems.js itself uses for
    // "this is not a list" — one message for one fact, regardless of who
    // encounters it first.
    actionItems: z.array(z.unknown(), { error: typeError({ invalid: 'actionItems must be an array' }) }).optional(),
    decisions: z.array(z.unknown(), { error: typeError({ invalid: 'decisions must be an array' }) }).optional(),
    questions: z.array(z.unknown(), { error: typeError({ invalid: 'questions must be an array' }) }).optional(),
    tags: z.array(z.unknown(), { error: typeError({ invalid: 'tags must be an array' }) }).optional(),
});

// Which prompt writes the summary. `{"templatId":"tpl_1"}` fell back to the
// built-in 'general' template and REWROTE the summary with it — a button that
// promises to write the summary again, which does so with the wrong template and
// stamps that template's name under it.
const RegenerateBody = bodyOf({
    template: worded('template is de sleutel van een ingebouwd sjabloon.').trim().min(1).optional(),
    templateId: worded('templateId is het id van een opgeslagen sjabloon.').trim().min(1).nullish(),
    customPrompt: worded('customPrompt is tekst.').nullish(),
});

const FORMAT_TEXT = 'Unsupported format. Use: md, txt';
const ExportQuery = z.object({ format: choice(['md', 'txt'], FORMAT_TEXT).optional() }).strict();

const CONFIRM_TEXT = 'confirm is true of false.';
const DeleteQuery = z.object({ confirm: flag(CONFIRM_TEXT) }).strict();

const PUBLISHED_TEXT = 'isPublished must be a boolean';
const GROUPS_TEXT = 'sharedGroups must be an array';
const PublishBody = bodyOf({
    isPublished: bool(PUBLISHED_TEXT),
    sharedGroups: idList(GROUPS_TEXT).optional(),
});

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ── Rename / update transcription ────────────────────────

/**
 * ── WHAT THIS ROUTE MAY WRITE, AND IN WHAT SHAPE (M3) ───────────────
 * `actionItems` used to reach the column raw: the handler read the key and
 * handed it to the store, which only asked "is it an array" (a JSON scalar
 * became `[]`, and every element could be anything at all). Everything
 * downstream — the library rail's open-action count, the export, the meeting
 * knowledge source, the report — reads these objects; routes/transcriptions/
 * tags.js:54-60 names this route as the reason it defends itself in SQL.
 *
 * M3 needs the items to carry a `destination`, a `source` and a
 * `segmentIndex`, which is exactly the moment to stop taking the client's word
 * for their shape. core/meetingNotes/actionItems.js rebuilds every item from an
 * allow-list and refuses what it cannot understand — an unknown destination
 * kind is a 400, never a chip on the card that no code can resolve.
 *
 * `decisions` and `questions` are accepted here for the first time. The store
 * has been able to write them since the artifacts landed; only this route could
 * not say so, so a corrected decision had no way home short of a regenerate.
 *
 * OWNERSHIP is the store's: `updateTranscription` is `WHERE id = $ AND user_id
 * = $`, so a reader who is not the owner gets rowCount 0 → 404 here. That is
 * also why a `destination.ref` is not resolved against the automation /
 * datatable / knowledge-base it names: the writes to those destinations happen
 * over their own gated routes, and what is recorded here is provenance the
 * owner wrote onto their own note.
 */
router.patch('/:id', requireAuth, validate({ body: PatchBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { title, actionItems, tags, decisions, questions } = req.body;
    if (!title && actionItems === undefined && tags === undefined
        && decisions === undefined && questions === undefined) {
        return res.status(400).json({ error: 'Nothing to update' });
    }
    const updates = {};
    if (title) updates.title = title;
    if (actionItems !== undefined) {
        const v = validateActionItems(actionItems);
        if (!v.ok) return res.status(400).json({ error: v.error });
        updates.actionItems = v.items;
    }
    if (decisions !== undefined) {
        const v = validateDecisions(decisions);
        if (!v.ok) return res.status(400).json({ error: v.error });
        updates.decisions = v.items;
    }
    if (questions !== undefined) {
        const v = validateQuestions(questions);
        if (!v.ok) return res.status(400).json({ error: v.error });
        updates.questions = v.items;
    }
    if (tags !== undefined) {
        // The filter chips and the meeting-tag knowledge source both match
        // on these as strings; a nested object here is what made a single
        // bad row able to throw the whole library list.
        const cleaned = tags
            .map((t) => (typeof t === 'string' ? t.trim().slice(0, 80) : ''))
            .filter(Boolean);
        updates.tags = [...new Set(cleaned)].slice(0, 50);
    }
    const updated = await transcriptionStore.updateTranscription(req.params.id, userId, updates);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    // Give the cleaned lists back: the client's optimistic copy holds items
    // it minted itself (no id yet, a destination it just picked), and
    // without the server's version it would keep rendering them until the
    // next full refetch — then watch its ids change under it.
    res.json({ success: true, ...updates });
});

// ── Regenerate summary with template ─────────────────────

router.post('/:id/regenerate-summary', requireAuth, validate({ body: RegenerateBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);
    const { template = 'general', templateId = null, customPrompt = null } = req.body;
    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    if (!transcription) return res.status(404).json({ error: 'Not found' });
    if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can regenerate the summary' });
    if (!transcription.transcript) return res.status(400).json({ error: 'No transcript available' });

    // Which prompt drives the summary, in precedence order:
    //   templateId  — a saved custom template (visibility-checked)
    //   customPrompt — an ephemeral "try before saving" prompt (owner-only, already gated above)
    //   template     — a built-in key (default 'general'; unknown keys fall back to general)
    //
    // ── WHICH STAMP THAT YIELDS (M4 step 3) ─────────────────────────
    // Every branch sets `stamp`, including the one-off prompt — which sets it
    // EMPTY. The summary is overwritten here; leaving a stamp of the previous
    // template in place would paste a template name onto text that template never
    // wrote. An empty stamp is therefore not a "forgotten field" but the answer.
    let templatePrompt;
    let stamp;
    if (templateId) {
        const tpl = await summaryTemplateStore.getById(templateId);
        if (!tpl || !canAccessTemplate(tpl, { userId, orgIds, groupIds: userGroupIds })) {
            return res.status(404).json({ error: 'Template not found' });
        }
        templatePrompt = tpl.prompt;
        // The version of THIS moment, not that of the moment when someone later
        // opens the note.
        stamp = stampForTemplate(tpl);
    } else if (typeof customPrompt === 'string' && customPrompt.trim()) {
        templatePrompt = customPrompt.trim().slice(0, 20000);
        stamp = { ...EMPTY_STAMP };
    } else {
        templatePrompt = builtinPrompt(template);
        // The same fallback as builtinPrompt: an unknown key stamps 'general',
        // because that prompt wrote it.
        stamp = stampForBuiltin(template);
    }

    const modelId = await resolveSmartModel(userOrgId);
    const result = await llmClient.chat(modelId, [
        { role: 'system', content: buildSummarySystemPrompt(templatePrompt, transcription.language) },
        { role: 'user', content: transcription.transcript },
        // Same budget as the original generateMeetingSummary pass — 4096
        // used to make REgenerating a long meeting truncate harder than the
        // first generation did.
    ], { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3 });

    const summary = (result.content || '').trim();
    // Also re-extract the structured artifacts and timeline chapters.
    // Chapters here is deliberate: it's the upgrade path that gives meetings
    // recorded before the chapter strip existed a timeline without
    // re-transcribing audio — and the same now goes for decisions/questions
    // on notes that predate those columns.
    const artifacts = await extractMeetingArtifacts(transcription.transcript, transcription.language, userOrgId, {
        meetingDateIso: (transcription.createdAt || '').slice(0, 10) || null,
        personNames: [...(transcription.speakers || []).map((s) => s.id), ...(transcription.attendees || [])],
    });
    const chapters = await generateChapters(transcription.transcript, transcription.language, userOrgId);

    // Per-speaker prose too — this is also the upgrade path for notes that
    // predate it, and the repair after a speaker rename dropped them.
    const storedSpeakers = Array.isArray(transcription.speakers) ? transcription.speakers : [];
    const speakerSummaries = await generateSpeakerSummaries(
        transcription.transcript, storedSpeakers.map((s) => s.id), transcription.language, userOrgId,
    );
    const speakers = applySpeakerSummaries(storedSpeakers, speakerSummaries);

    // ── "Opnieuw" REPLACES THE AI'S ITEMS, NOT THE PERSON'S ───────────
    // This write used to be `actionItems: artifacts.actionItems` — a total
    // replacement. Anything the owner had added themselves (M3 lets them add one,
    // and give it a destination) was gone, with no undo and no warning, from a
    // button whose whole promise is "write the summary again". The merge keeps
    // every `source:'user'` item, in front of the freshly extracted ones.
    // A FAILED EXTRACTION IS NOT AN EMPTY MEETING.
    //
    // extractMeetingArtifacts used to answer four empty arrays for three different
    // outcomes: a meeting with nothing in it, a reply it could not parse, and a call
    // that threw. Merging that third case wrote the emptiness over everything the
    // last good pass had found — the action items, the decisions and the questions
    // all gone, from a button that promises to write the summary AGAIN. A failed
    // pass now has no lists at all, and `artifactsUsable` narrows down on everything
    // that does not look like a completed pass — the previous gate (`ok !== false`)
    // still let an answer WITHOUT lists through as "successful".
    const usable = artifactsUsable(artifacts);
    const mergedActionItems = usable
        ? mergeRegeneratedActionItems(transcription.actionItems, artifacts.actionItems)
        : normalizeActionItems(transcription.actionItems);
    // ── AND THE SAME FOR THE OTHER TWO LISTS (M4) ───────────────────
    // This used to be `decisions: artifacts.decisions` — a total
    // replacement, which was defensible only while the extractor was the
    // ONLY writer. The transcript tab's per-line popover writes a decision
    // a person picked off a line, so the total replacement became the same
    // silent deletion the action items already had fixed, one column over.
    // `null` on a failed pass, not an empty list and not a re-shaped copy
    // of what is in the column: nothing is written to these two then, so
    // the answer below has to carry the rows exactly as they are STORED.
    const mergedDecisions = usable
        ? mergeRegeneratedNotes(transcription.decisions, artifacts.decisions, { field: 'decisions' })
        : null;
    const mergedQuestions = usable
        ? mergeRegeneratedNotes(transcription.questions, artifacts.questions, { field: 'questions' })
        : null;
    if (!usable) {
        log.warn(`[Transcriptions] Regenerate ${req.params.id}: artifact extraction failed — keeping the existing action items, decisions and questions.`);
    }

    // ── AND WHAT CAME IN DURING THE RUN ITSELF ──────────────────────
    // Everything above merges against the SNAPSHOT of r.136 — and between that read
    // and this write there are four LLM calls (three of them cut off at 540 s). The
    // "Opnieuw" banner sits above the tab, so whoever stays in the transcript and
    // records a line such as a decision writes exactly into that window. For the
    // merge that row is invisible; this update wiped it, without notice and without
    // undo.
    //
    // The route cannot repair that itself: it knows nothing of what happened after
    // its read. What it CAN do is pass along its starting point — the moment it read
    // its input — so that the store, in the same statement, only replaces what
    // already stood there before that moment.
    //
    // ONE CLOCK: `readAt` comes from the database clock, from the same read, and is
    // compared there with stamps of that same clock. `updatedAt` is the fallback
    // (also a database value, and by definition from before our read, so at most
    // more conservative). Never Date.now() of this node: that would be the second
    // clock that such a window breaks down on.
    const artifactsSince = transcription.readAt || transcription.updatedAt || null;
    const written = await transcriptionStore.updateTranscription(req.params.id, userId, {
        summary,
        actionItems: mergedActionItems,
        ...(usable ? { decisions: mergedDecisions, questions: mergedQuestions } : {}),
        ...(usable && artifacts.tags.length ? { tagsIfEmpty: artifacts.tags } : {}),
        ...(artifactsSince ? { artifactsSince } : {}),
        chapters,
        ...(Object.keys(speakerSummaries).length ? { speakers } : {}),
        ...stamp,
    });
    // What is ACTUALLY in the column after that write. That can differ from what
    // we sent — a row that came into being during the run stays — and then the
    // answer below is the only place where the client sees it. If it is missing (an
    // older store), each field falls back to what it always was.
    const stored = written && typeof written === 'object' ? written : {};

    // The summary IS what a meeting-tag knowledge source stores, so a
    // regenerate has to reach the same subscribers an ingest does — one
    // that missed this would hold the old summary for ever, and nobody
    // would be able to say why the answer was stale.
    require('../../core/meetingNotes/ingestRecordingCore').emitMeetingProcessed({
        transcriptionId: req.params.id,
        tags: Array.isArray(transcription.tags) ? transcription.tags : [],
        userId,
        orgId: userOrgId,
        reprocessed: true,
    });

    res.json({
        success: true,
        summary,
        // The MERGED list, not the extractor's: the client replaces its
        // copy with this one, and answering with the AI's half would make
        // the surviving user items vanish from the screen until a refetch —
        // indistinguishable, to the person watching, from having lost them.
        actionItems: stored.actionItems || mergedActionItems,
        // What was STORED, not what the extractor handed back: on a failed pass those
        // are two different lists, and answering with the extractor's would empty the
        // screen for a write that never happened. On a SUCCESSFUL pass they differ too,
        // now that the merge carries a person's decisions across — answering with the
        // extractor's half would make those vanish from the card until a refetch,
        // which to the person watching is losing them.
        // And since the window above, "what was stored" is literally what the UPDATE
        // returned: that is the only list that also contains the rows that came into
        // being during the run.
        decisions: stored.decisions || (usable ? mergedDecisions : (transcription.decisions || [])),
        questions: stored.questions || (usable ? mergedQuestions : (transcription.questions || [])),
        // The screen must be ABLE to say so: without this field, a failed pass is
        // indistinguishable from "nothing new came out", and nobody presses Again once more.
        artifactsRegenerated: usable,
        chapters,
        speakers,
        // The stamp goes back too, so that the card can show it immediately. Without
        // this, the screen would keep naming the PREVIOUS template until the next fetch
        // round, for a summary that was just written by a different template.
        ...stamp,
    });
});

// ── Export transcription ─────────────────────────────────

router.get('/:id/export', requireAuth, validate({ query: ExportQuery }),
    require('../../compliance/dataPortability/stampExport')('meeting_notes'), async (req, res) => {
    const userId = req.session.user.id;
    // `?fromat=txt` produced a markdown file: the parameter was dropped and the
    // default took over. Now the name of the parameter is as strictly closed as its
    // value already was.
    const format = req.query.format || 'md';
    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    if (!transcription) return res.status(404).json({ error: 'Not found' });

    const title = transcription.title || 'Meeting Notes';
    const date = transcription.createdAt ? new Date(transcription.createdAt).toLocaleDateString('en-US', { dateStyle: 'long' }) : '';
    const duration = formatDuration(transcription.durationSeconds);
    const speakers = (transcription.speakers || []).map(s => s.id).join(', ');

    // Build action items section
    const actionItemsText = (transcription.actionItems || []).length > 0
        ? '## 📌 Action Items\n' + transcription.actionItems.map(ai => `- [${ai.done ? 'x' : ' '}] ${ai.text} (${ai.assignee})${ai.timestamp ? ` — ${ai.timestamp}` : ''}`).join('\n')
        : '';

    if (format === 'md') {
        const md = `# ${title}\n\n**Date:** ${date}  \n**Duration:** ${duration}  \n**Speakers:** ${speakers}\n\n---\n\n${transcription.summary || ''}\n\n${actionItemsText}\n\n---\n\n## Transcript\n\n${transcription.transcript || transcription.fullText || ''}`;
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-zA-Z0-9 ]/g, '')}.md"`);
        res.send(md);
    } else if (format === 'txt') {
        const txt = `${title}\nDate: ${date}\nDuration: ${duration}\nSpeakers: ${speakers}\n\n${'='.repeat(50)}\n\n${(transcription.summary || '').replace(/[#*]/g, '')}\n\n${'='.repeat(50)}\n\n${(transcription.actionItems || []).length > 0 ? 'ACTION ITEMS:\n' + transcription.actionItems.map(ai => `[${ai.done ? 'X' : ' '}] ${ai.text} (${ai.assignee})`).join('\n') + '\n\n' + '='.repeat(50) + '\n\n' : ''}TRANSCRIPT:\n\n${transcription.transcript || transcription.fullText || ''}`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-zA-Z0-9 ]/g, '')}.txt"`);
        res.send(txt);
    } else {
        res.status(400).json({ error: 'Unsupported format. Use: md, txt' });
    }
});

// ── Delete transcription ─────────────────────────────────

/**
 * ── WHAT BREAKS, BEFORE IT BREAKS (M2) ──────────────────────────────
 * A meeting is not a local object. A knowledge base collects it by tag and
 * will answer questions from it; an automation runs on it; a notebook holds a
 * copy. None of those failures name this meeting when they happen, and none
 * of them is recoverable, so the first DELETE answers 409 with the list and
 * only a second one carrying `?confirm=1` proceeds — the same two-step the
 * knowledge-base and datatable deletes use, and the same list the Used-by tab
 * and the outputs bar show.
 *
 * `unchecked` COUNTS AS IN USE. A scan that could not run is not a consumer
 * that is absent, and this is the one moment where guessing wrong cannot be
 * undone. That does mean a meeting can sit permanently behind a 409 while
 * some kind is unanswerable (an older notebook meeting source written before
 * `notebook_sources.source_ref_id` existed keeps notebooks unanswerable): the client's danger zone names what
 * could not be checked, makes the person type the meeting's title against
 * that warning, and then sends `?confirm=1`. The escape hatch is deliberate
 * and it is a CONFIRMED one — never a silent retry.
 */
router.delete('/:id', requireAuth, validate({ body: NOTHING, query: DeleteQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const confirmed = req.query.confirm === true;

    if (!confirmed) {
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const note = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        // Not readable → not deletable, and the store would have said 404
        // anyway. Answering here keeps the two paths on one story.
        if (!note) return res.status(404).json({ error: 'Not found' });

        const { usageForMeeting, redactForeign } = require('../../core/meetingNotes/meetingUsage');
        const { rows, partial } = await usageForMeeting(note);
        if (rows.length > 0 || partial.length > 0) {
            return res.status(409).json({
                error: 'This meeting is still in use',
                code: 'in_use',
                usage: redactForeign(rows, userId),
                unchecked: partial,
            });
        }
    }

    const deleted = await transcriptionStore.deleteTranscription(req.params.id, userId);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    // A task that linked this meeting keeps existing; the link goes (in every project).
    try { await require('../../stores/projectTaskStore').dropLinksTo(null, 'meeting', req.params.id); }
    catch (err) { log.warn(`[Transcriptions] task links to meeting ${req.params.id} not dropped: ${err.message}`); }
    res.json({ success: true });
});

// ── Publish to org / groups ──────────────────────────────
//
// Mirrors the publish model used by Knowledge Bases:
//   - `isPublished: false`            → Personal (only the owner)
//   - `isPublished: true, []`         → Entire organisation
//   - `isPublished: true, [gid…]`     → Specific org groups
//
// Owner-only. Validates that supplied group IDs belong to the owner's org.

router.patch('/:id/publish', requireAuth, validate({ body: PublishBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { isPublished, sharedGroups } = req.body;

    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    if (!transcription) return res.status(404).json({ error: 'Not found' });
    if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can change publish status' });
    // A note in a project is open to the members of that project, and to nobody else: who can read it is
    // the project's to say. Take it out of the project first to share it another way.
    if (transcription.projectId) {
        return res.status(409).json({
            error: 'This meeting note is in a project, so it is open to the whole project and cannot be shared another way. Take it out of the project first.',
            code: 'MEETING_IN_PROJECT',
        });
    }

    // Validate the supplied group IDs against the transcription's org so
    // a user can't accidentally publish to another org's groups.
    const orgIdForValidation = transcription.organizationId || await resolveUserOrgFromReq(req);
    // Hoisted out of the sharedGroups branch. Publishing to the ENTIRE org
    // (empty sharedGroups) needs an org just as much as publishing to
    // specific groups does; without this check it returned 200 and shared
    // the note with nobody.
    if (isPublished && !orgIdForValidation) {
        return res.status(400).json({ error: 'Cannot publish: no organization context for this transcription.' });
    }
    let cleanedGroups = [];
    if (isPublished && Array.isArray(sharedGroups) && sharedGroups.length > 0) {
        const { validateSharedGroupsForOrg } = require('../../auth');
        try {
            cleanedGroups = await validateSharedGroupsForOrg(orgIdForValidation, sharedGroups);
        } catch (err) {
            return res.status(400).json({ error: err.message || 'Invalid shared groups' });
        }
    }

    await transcriptionStore.setPublished(req.params.id, userId, isPublished, cleanedGroups, orgIdForValidation);
    res.json({ success: true, isPublished, sharedGroups: cleanedGroups });
});

module.exports = router;

/** @typedef {{ actionItems: object[], decisions: object[], questions: object[], tags: string[] }} UsableArtifacts  what `artifactsUsable` lets through */
