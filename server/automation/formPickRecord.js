/**
 * Searching and reading the records an `app_pick` form question offers.
 *
 * formPickSources says WHAT may be picked; this module does it. Two entry
 * points, both of which run entirely as the person filling the form in:
 *
 *   searchRecords()  the picker's search box — a list of `{id,title,subtitle}`
 *   describePick()   the value one chosen record contributes to the run
 *
 * ── Why "as the filler" is the whole design ────────────────────────────────
 * The author of an automation declares "ask for a Fireflies transcript". They do
 * NOT declare which one, and they must not be able to see which ones exist for
 * anybody else. So every call here carries a `caller` — the signed-in person in
 * front of the form — and nothing in it comes from the automation's owner. A
 * tool source runs against that person's own connection and is refused unless
 * that person is entitled to the tool; the one internal source is answered by
 * the Meeting-notes read ACL, which is the same predicate the library itself
 * uses.
 *
 * `app_pick` therefore REQUIRES a signed-in filler. formPublic serves forms to
 * members only today (PUBLIC_FORMS_ENABLED is off), but that flag is meant to
 * be flippable, and an anonymous visitor has no connections to search. Rather
 * than silently falling back to the author's credentials — a data leak with a
 * search box on it — both entry points refuse without a caller id.
 *
 * ── Nothing here throws at the filler ──────────────────────────────────────
 * A search that fails is an empty list with a reason the picker can print. A
 * record that cannot be read is a descriptor carrying `textError`, exactly as
 * an unreadable upload is (formUploadText) — the submission still goes through,
 * and an automation can branch on it. Losing a form submission because Fireflies
 * was down would be a far worse failure than an unreadable attachment.
 */

'use strict';

const pickSources = require('./formPickSources');
const log = require('../telemetry/log');

const { MAX_TEXT_CHARS } = pickSources;

/**
 * Which integration tools may this caller actually run?
 *
 * The same resolver the automation builder and the runner use
 * (`automationStep: true`, so design time equals run time), which means a picker
 * can never offer an app the person's org, group, entitlement or credentials
 * have not granted them. A failure to resolve is NOT "you have nothing" — it is
 * "we do not know", and the caller below turns that into a refusal rather than
 * an empty result set.
 */
async function resolveCallerTools(caller) {
    const { getIntegrationTools } = require('../core/integrations/integrationTools');
    const r = await getIntegrationTools({
        userId: caller.userId,
        session: caller.session,
        isAdmin: !!caller.isAdmin,
        automationStep: true,
    });
    const names = new Set();
    for (const t of (r?.tools || [])) if (t?.function?.name) names.add(t.function.name);
    return names;
}

/**
 * `{ source }` when this caller may use it, `{ error }` otherwise.
 *
 * BOTH of a source's tools are checked, not just the one about to run: a person
 * who can search Gmail but not read a message would get a picker that lists
 * their mail and then attaches nothing, which is worse than an honest refusal
 * before they pick.
 */
async function authorizeSource(sourceId, caller) {
    if (!caller?.userId) {
        return { error: 'You have to be signed in to pick from an app.' };
    }
    const source = pickSources.getSource(sourceId);
    if (!source) return { error: 'That app is not available.' };
    if (source.internal) return { source };

    let allowed;
    try {
        allowed = await resolveCallerTools(caller);
    } catch (e) {
        log.warn(`[formPickRecord] could not resolve tools for ${caller.userId}: ${e.message}`);
        return { error: 'We could not check which apps you can use. Try again in a moment.' };
    }
    const missing = pickSources.toolsFor(source).filter(t => !allowed.has(t));
    if (missing.length) {
        return { error: `${source.app} is not connected for your account. Connect it under Integrations, then reopen this form.` };
    }
    return { source };
}

/** Run one of a source's declared tools as the caller. Never throws. */
async function runTool(toolName, args, caller) {
    const { executeTool } = require('../core/tools/toolDispatcher');
    try {
        const out = await executeTool(toolName, args, {
            userId: caller.userId,
            // MCP dispatch reads the caller id from userAuth only; harmless
            // here and correct if a bundled MCP server ever backs a source.
            userAuth: { ...(caller.userAuth || {}), userId: caller.userId },
            session: caller.session,
            orgId: caller.orgId || null,
            userOrgIds: caller.orgIds || [],
            userGroupIds: caller.userGroupIds || [],
            // A form's "pick from an app" field reading the filler's own data:
            // the dispatcher's chokepoint writes the egress row as them.
            egress: {
                source: 'form_pick',
                ids: { organization_id: caller.orgId || null, user_id: caller.userId || null },
            },
        });
        // Most integration tools report failure as `{ error }` rather than by
        // throwing, so the two have to be collapsed here or half of them would
        // sail past as a successful read of nothing.
        if (out && typeof out === 'object' && typeof out.error === 'string' && out.error) {
            return { error: out.error };
        }
        return { value: out };
    } catch (e) {
        log.warn(`[formPickRecord] ${toolName} failed for ${caller.userId}: ${e.message}`);
        return { error: e.message || 'That app could not be reached.' };
    }
}

// ── The internal source: Bee Flow meeting notes ────────────────────────────

/**
 * Meeting notes the caller can open, filtered by the words they typed.
 *
 * The store has no text search, so the filter runs here over the list payload's
 * title, summary snippet and transcript prefix. That is honest for a picker —
 * the person is looking for a meeting they remember — and it means the search
 * never widens the ACL: `getTranscriptions` has already decided what this
 * person may see before a single word is matched.
 */
async function searchMeetingNotes(query, limit, caller) {
    const store = require('../stores/transcriptionStore');
    // A wider read than the page of results we return, so a filter over the
    // list has something to filter. Bounded — a picker is not a library.
    const rows = await store.getTranscriptions(caller.userId, {
        limit: query ? 200 : limit,
        offset: 0,
        orgIds: caller.orgIds || [],
        userGroupIds: caller.userGroupIds || [],
        isSuperAdmin: !!caller.isSuperAdmin,
    });
    const needle = query.toLowerCase();
    const matches = query
        ? rows.filter(r => `${r.title || ''} ${r.summarySnippet || ''} ${r.transcriptSnippet || ''}`.toLowerCase().includes(needle))
        : rows;
    return matches.slice(0, limit).map(r => ({
        id: r.id,
        title: r.title || r.fileName || 'Meeting note',
        subtitle: [
            pickSources.humanDate(r.createdAt),
            r.durationSeconds ? `${Math.round(r.durationSeconds / 60)} min` : '',
            r.summarySnippet || '',
        ].filter(Boolean).join(' · ').slice(0, 300),
    }));
}

/** One meeting note, flattened the way every other source flattens a record. */
async function readMeetingNote(recordId, caller) {
    const store = require('../stores/transcriptionStore');
    const note = await store.getTranscription(recordId, caller.userId, {
        orgIds: caller.orgIds || [],
        userGroupIds: caller.userGroupIds || [],
        isSuperAdmin: !!caller.isSuperAdmin,
    });
    // Null is the ACL answering, not a missing row: `getTranscription` returns
    // nothing for a note this person may not open, and the two must read the
    // same to the filler.
    if (!note) return { error: 'That meeting note is no longer available to you.' };
    const body = [
        note.summary ? `Summary\n\n${note.summary}` : '',
        note.fullText || note.transcript ? `Transcript\n\n${note.fullText || note.transcript}` : '',
    ].filter(Boolean).join('\n\n');
    return {
        value: {
            title: note.title || note.fileName || 'Meeting note',
            subtitle: [pickSources.humanDate(note.createdAt), note.durationSeconds ? `${Math.round(note.durationSeconds / 60)} min` : ''].filter(Boolean).join(' · '),
            text: body,
            // The note's own structure, which it HAS — a Bee Flow note is
            // already summarised, already has its actions and decisions pulled
            // out. Handing an automation only the flattened text would make it ask
            // a model to re-derive what the platform already knows.
            data: pickSources.compact({
                date: pickSources.isoDate(note.createdAt),
                durationMinutes: note.durationSeconds ? Math.round(note.durationSeconds / 60) : null,
                language: note.language || '',
                summary: typeof note.summary === 'string' ? note.summary.slice(0, 20000) : '',
                speakers: pickSources.strList(note.speakers, 50),
                attendees: pickSources.strList(note.attendees, 100, 300),
                actionItems: pickSources.strList(note.actionItems, 100, 500),
                decisions: pickSources.strList(note.decisions, 100, 500),
                questions: pickSources.strList(note.questions, 100, 500),
                tags: pickSources.strList(note.tags, 50),
            }),
        },
    };
}

// ── Search ────────────────────────────────────────────────────────────────

/**
 * The picker's search. `{ results }`, or `{ error }` with something the filler
 * can act on. Never throws.
 *
 * @param {string} sourceId  the field's DECLARED source — never the browser's
 * @param {string} rawQuery  what the person typed
 * @param {object} caller    { userId, session, orgId, orgIds, userGroupIds, … }
 */
async function searchRecords(sourceId, rawQuery, caller, { limit } = {}) {
    const authorized = await authorizeSource(sourceId, caller);
    if (authorized.error) return { error: authorized.error };
    const source = authorized.source;
    const query = pickSources.clampQuery(rawQuery);
    const max = pickSources.clampLimit(limit);

    try {
        if (source.internal === 'transcriptions') {
            return { results: pickSources.usableResults(await searchMeetingNotes(query, max, caller)) };
        }
        const ran = await runTool(source.searchTool, source.searchArgs(query, max), caller);
        if (ran.error) return { error: ran.error };
        return { results: pickSources.usableResults(source.mapResults(ran.value)) };
    } catch (e) {
        log.warn(`[formPickRecord] search failed for ${sourceId}: ${e.message}`);
        return { error: `${source.app} could not be searched right now.` };
    }
}

// ── Read ──────────────────────────────────────────────────────────────────

/** Cap the text a record contributes, and SAY SO when it was cut. */
function boundText(text) {
    const t = typeof text === 'string' ? text : '';
    if (!t.trim()) return {};
    if (t.length > MAX_TEXT_CHARS) {
        return {
            text: t.slice(0, MAX_TEXT_CHARS),
            textChars: MAX_TEXT_CHARS,
            // Announced, never silent: a model handed the first 60k characters
            // of a two-hour call must not believe it heard the call.
            textTruncated: true,
            textTotalChars: t.length,
        };
    }
    return { text: t, textChars: t.length, textTruncated: false };
}

/**
 * The complete value one picked record contributes to a run.
 *
 * Always returns a descriptor — `{ kind:'app_pick', source, app, recordId,
 * title, url, text, data, … }` — and merges the record's own title, link, text
 * and STRUCTURED FIELDS onto it when the read worked. `data` is what each
 * source knows about its own records (a call's date, duration and speakers; an
 * email's sender and attachments; a note's summary and action items), so a
 * automation can branch or fill a table without sending the body to a model. A failed read leaves `textError` and keeps the title the
 * picker showed, so the automation still knows what the person chose.
 *
 * `withText: false` is the author saying "a reference is enough": no read is
 * made at all, which is both faster and the smaller privacy footprint.
 */
async function describePick(pick, { withText = true, caller } = {}) {
    const base = {
        kind: 'app_pick',
        source: pick.source,
        app: pick.app || '',
        recordId: pick.recordId,
        title: pick.title || '',
    };
    if (!withText) return base;

    const authorized = await authorizeSource(pick.source, caller);
    if (authorized.error) return { ...base, textError: authorized.error };
    const source = authorized.source;

    try {
        let read;
        if (source.internal === 'transcriptions') {
            read = await readMeetingNote(pick.recordId, caller);
        } else {
            const ran = await runTool(source.fetchTool, source.fetchArgs(pick.recordId), caller);
            read = ran.error ? ran : { value: source.mapRecord(ran.value) };
        }
        if (read.error) return { ...base, textError: read.error };

        const record = read.value || {};
        const bounded = boundText(record.text);
        return {
            ...base,
            // The record's own title wins over the one the picker showed: it is
            // the fresher of the two, and the only one that was read under the
            // filler's ACL just now.
            title: record.title || base.title,
            ...(record.subtitle ? { subtitle: record.subtitle } : {}),
            ...(record.url ? { url: record.url } : {}),
            // The record's own fields, beside its text. `.text` is what a model
            // reads; `.data.*` is what a condition, a datatable write or a
            // template binds without a model in the loop at all.
            ...(record.data && Object.keys(record.data).length ? { data: record.data } : {}),
            ...bounded,
            // A source that told us it clipped the record (Fireflies stops at
            // 500 sentences) is truncated even when our own cap did not fire —
            // so this goes AFTER the spread, which carries `textTruncated:
            // false` and would otherwise erase it.
            ...(record.partial && bounded.text !== undefined ? { textTruncated: true } : {}),
            ...(bounded.text === undefined ? { textError: `Nothing could be read from this ${source.app} record.` } : {}),
        };
    } catch (e) {
        // describePick is written not to throw; this is the belt to its braces,
        // because the one thing that must not happen is losing a submission
        // over a picked record.
        log.warn(`[formPickRecord] read failed for ${pick.source}/${pick.recordId}: ${e.message}`);
        return { ...base, textError: 'This record could not be read.' };
    }
}

module.exports = {
    authorizeSource,
    searchRecords,
    describePick,
    boundText,
};
