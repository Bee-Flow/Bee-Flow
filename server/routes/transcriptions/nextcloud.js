/**
 * Transcriptions — Nextcloud ingest & Talk meetings.
 *
 * GET   /nextcloud-audio-files     — browse audio files in the user's NC Files
 * GET   /nextcloud-talk-recordings — Talk call recordings, grouped by room
 * POST  /from-nextcloud            — pull one NC recording into the pipeline
 * GET   /talk-meetings             — upcoming calendar-linked Talk meetings
 * PATCH /talk-meetings/:token      — per-meeting record toggle
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const path = require('path');
const transcriptionStore = require('../../stores/transcriptionStore');
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext, resolveUserOrgFromReq } = require('./shared');

// ── Nextcloud audio ingest ───────────────────────────────
//
// Two endpoints that let the user pull a recording from their Nextcloud
// Files into the meeting-notes pipeline without first downloading it
// manually. Notes themselves stay in Bee Flow — there is no writeback
// to NC. Auth uses the existing `nextcloudClient.resolveAuth` so OAuth,
// app-password and ExApp-connector sessions all work transparently.

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac'];
// Recording ingest helpers (single source of truth for accepted extensions +
// Talk room-token path parsing) live with the ingest pipeline.
const { ACCEPTED_RECORDING_EXTS, parseTalkRoomToken } = require('../../core/meetingNotes/ingestNextcloudRecording');
const { DEFAULT_RECORDING_FOLDER, talkRecordingRoots } = require('../../core/meetingNotes/talkRecordingPaths');
const ncClient = require('../../integrations/nextcloudClient');

/**
 * Resolve the configured Talk recordings folder (org+user scoped, default
 * /Talk/Recording).
 */
async function resolveRecordingFolder(orgId, userId) {
    try {
        const { resolveTalkNotesSettings } = require('../../core/meetingNotes/talkNotesSettings');
        const s = await resolveTalkNotesSettings({ orgId, userId });
        return s.recordingFolder || DEFAULT_RECORDING_FOLDER;
    } catch (_) { return DEFAULT_RECORDING_FOLDER; }
}

/**
 * The recording folder to actually scan for this user.
 *
 * Talk advertises the user's own attachment folder as
 * `capabilities.spreed.config.attachments.folder`, and stores recordings in its
 * `Recording` subfolder — so ask the server rather than assume. Falls back to
 * the Bee Flow setting when Talk doesn't answer (older Talk, no session, an
 * admin who pointed the `recording_folder` preference somewhere custom).
 */
async function resolveEffectiveRecordingFolder(session, userId, configuredFolder) {
    try {
        const talk = require('../../integrations/nextcloudTalkTools');
        const cap = await talk.getTalkRecordingCapability(session, userId);
        if (cap.recordingFolder) return cap.recordingFolder;
    } catch (err) { bestEffort('routes/transcriptions/nextcloud:resolveEffectiveRecordingFolder', err); /* fall through to the configured value */ }
    return configuredFolder;
}

const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded, bodyOf, bool, NO_QUERY } = require('./schemas'); const { bestEffort, fallback: fallbackSwallowed } = require('../../utils/bestEffort');

// ── What the Nextcloud routes may carry ────────────────────────────
//
// `record` is a REAL boolean, and that is the reason this file got a schema. The recording preference was written as `record: !!record`:
//
//   • `{"record": "false"}` is true — recording was switched ON for a meeting that someone had just switched it OFF for, and the answer confirmed it.
//   • `{"recrod": false}` was dropped — recording was switched OFF for a meeting that someone had just switched ON.
//
// In a product that records meetings, that is not a question of form.
const FOLDER_TEXT = 'folder is een pad in Nextcloud.';
const FolderQuery = z.object({
    folder: worded(FOLDER_TEXT).trim().min(1, FOLDER_TEXT).optional(),
}).strict();

const PATH_TEXT = 'nextcloud_path is required';
const FromNextcloudBody = bodyOf({
    nextcloud_path: worded(PATH_TEXT).trim().min(1, PATH_TEXT),
    // The language in which the transcript is made. It had a silent default: `{"languge":"en"}` let an English recording be transcribed in Dutch, and the result cannot be seen from the answer.
    language: worded('language is een taalcode.').trim().min(1).optional(),
    provider: worded('provider is de naam van een transcriptiedienst.').trim().min(1).optional(),
    title: worded('Een titel is tekst.').optional(),
    context_terms: worded('context_terms is tekst.').optional(),
});

const RECORD_TEXT = 'record is true of false.';
const TalkPrefBody = bodyOf({
    record: bool(RECORD_TEXT),
    eventUid: worded('eventUid is het id van een agendapunt.').trim().min(1).nullish(),
});

router.get('/nextcloud-audio-files', requireAuth, validate({ query: FolderQuery }), async (req, res, next) => {
    const userId = req.session.user.id;
    const folder = req.query.folder || '/Recordings';
    try {
        const ctx = await ncClient.resolveAuth(req.session, userId);
        const root = ncClient.webdavRoot(ctx.baseUrl, ctx.uid);
        // Encode each path segment so spaces / unicode survive WebDAV.
        const segs = folder.split('/').filter(Boolean).map(encodeURIComponent);
        const url = `${root}/${segs.join('/')}${segs.length ? '/' : ''}`;
        const propfind = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/><oc:fileid/></d:prop>
</d:propfind>`;
        const r = await ctx.fetch(url, {
            method: 'PROPFIND',
            headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
            body: propfind,
        });
        if (r.status === 404) return res.status(404).json({ error: `Folder not found: ${folder}` });
        if (r.status === 401) return res.status(401).json({ error: ctx.authError || 'Nextcloud auth failed' });
        if (!r.ok) throw new HttpError(502, 'nextcloud_propfind_failed', `Nextcloud PROPFIND failed (${r.status})`);

        const xml = await r.text();
        // Naive but sufficient parse — pull <d:response> blocks and extract href + props.
        const items = [];
        const blocks = xml.split(/<d:response[^>]*>/i).slice(1);
        for (const block of blocks) {
            const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
            if (!hrefMatch) continue;
            const href = decodeURIComponent(hrefMatch[1]);
            // Skip the folder itself (its href ends with the folder path)
            const folderHrefSuffix = (`/${segs.join('/')}/`).replace(/\/+$/, '/');
            if (href.endsWith(folderHrefSuffix)) continue;
            // Drop folders
            if (/<d:resourcetype>\s*<d:collection\s*\/>\s*<\/d:resourcetype>/i.test(block)) continue;

            const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
            const ext = path.extname(name).toLowerCase();
            if (!AUDIO_EXTS.includes(ext)) continue;

            const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
            const ctMatch   = block.match(/<d:getcontenttype>([^<]+)<\/d:getcontenttype>/i);
            const lmMatch   = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);

            // Reconstruct the path within the user's Files root from the href.
            // href example: /remote.php/dav/files/<uid>/Recordings/foo.mp3
            const filesRoot = `/remote.php/dav/files/${ctx.uid}/`;
            const idx = href.indexOf(filesRoot);
            const filePath = idx !== -1 ? '/' + href.slice(idx + filesRoot.length) : href;

            items.push({
                name,
                path: filePath,
                size: sizeMatch ? Number(sizeMatch[1]) : null,
                contentType: ctMatch ? ctMatch[1] : null,
                lastModified: lmMatch ? lmMatch[1] : null,
            });
        }
        items.sort(byNewestFirst);
        res.json({ folder, count: items.length, items });
    } catch (err) {
        log.error('[Transcriptions] NC list error:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(400).json({ error: 'Nextcloud not connected for this account' });
        }
        next(err);
    }
});

const VIDEO_EXTS = ['.mp4', '.webm', '.ogv', '.mkv', '.mpeg'];

const TALK_PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/></d:prop>
</d:propfind>`;

// A room that has recorded a lot of calls still only has one folder; this caps
// the fan-out if a misconfigured folder points somewhere huge.
const TALK_MAX_ROOM_FOLDERS = 150;
const TALK_PROPFIND_CONCURRENCY = 6;

/**
 * Depth-1 PROPFIND of one folder → its direct children.
 *
 * Depth 1, not infinity: SabreDAV ships `enablePropfindDepthInfinity = false`
 * and Nextcloud never turns it on, so `Depth: infinity` is silently clamped
 * (`Server::getPropertiesIteratorForPath` rewrites any non-zero depth to 1).
 * The old single "recursive" request therefore only ever saw the recordings
 * folder's immediate children — all of which are per-room FOLDERS — so it
 * matched zero files and the Talk import panel was always empty.
 *
 * @returns {Promise<{status:number, entries:Array<{path:string,name:string,isCollection:boolean,size:number|null,lastModified:string|null}>}>}
 */
async function propfindChildren(ctx, folderPath) {
    const davRoot = ncClient.webdavRoot(ctx.baseUrl, ctx.uid);
    const segs = folderPath.split('/').filter(Boolean).map(encodeURIComponent);
    const url = `${davRoot}/${segs.join('/')}${segs.length ? '/' : ''}`;
    const r = await ctx.fetch(url, {
        method: 'PROPFIND',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: TALK_PROPFIND_BODY,
    });
    if (!r.ok) return { status: r.status, entries: [] };

    const xml = await r.text();
    const filesRoot = `/remote.php/dav/files/${ctx.uid}/`;
    const selfPath = '/' + folderPath.split('/').filter(Boolean).join('/');
    const entries = [];
    for (const block of xml.split(/<d:response[^>]*>/i).slice(1)) {
        const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
        if (!hrefMatch) continue;
        const href = decodeURIComponent(hrefMatch[1]);
        const idx = href.indexOf(filesRoot);
        const raw = idx !== -1 ? '/' + href.slice(idx + filesRoot.length) : href;
        const entryPath = '/' + raw.split('/').filter(Boolean).join('/');
        // Depth 1 includes the folder itself.
        if (entryPath.toLowerCase() === selfPath.toLowerCase()) continue;

        const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
        const lmMatch = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);
        entries.push({
            path: entryPath,
            name: entryPath.split('/').filter(Boolean).pop() || '',
            isCollection: /<d:resourcetype>\s*<d:collection\s*\/>\s*<\/d:resourcetype>/i.test(block),
            size: sizeMatch ? Number(sizeMatch[1]) : null,
            lastModified: lmMatch ? lmMatch[1] : null,
        });
    }
    return { status: r.status, entries };
}

/**
 * WebDAV `getlastmodified` is an RFC 1123 HTTP-date ("Thu, 13 Aug 2026 …"), so
 * comparing the strings sorts by weekday NAME — "Thu" before "Wed" — not by
 * time. Sort on the parsed instant instead; unparseable values sink to the end.
 */
function davTime(v) {
    const t = Date.parse(v || '');
    return Number.isFinite(t) ? t : -Infinity;
}
function byNewestFirst(a, b) { return davTime(b.lastModified) - davTime(a.lastModified); }

/** Run `fn` over `items` with a small concurrency cap, preserving order. */
async function mapCapped(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

// List Nextcloud Talk call recordings, grouped by conversation (room token).
// Talk stores each call's recording at <recordingFolder>/<roomToken>/<file>
// (default `/Talk/Recording/<token>/<file>`), so this walks two levels: the
// recordings root for its per-room folders, then each room folder for files.
router.get('/nextcloud-talk-recordings', requireAuth, validate({ query: FolderQuery }), async (req, res, next) => {
    const userId = req.session.user.id;
    try {
        const userOrgId = await resolveUserOrgFromReq(req);
        const configured = req.query.folder || await resolveRecordingFolder(userOrgId, userId);
        // An explicit ?folder= is taken at face value; otherwise ask Talk where
        // this user's recordings actually live.
        const folder = req.query.folder
            ? configured
            : await resolveEffectiveRecordingFolder(req.session, userId, configured);

        const ctx = await ncClient.resolveAuth(req.session, userId);

        // Deepest-first, and deduped: `/Talk` also yields `/Talk/Recording`, so
        // a tenant whose stored setting predates the folder fix still resolves.
        const roots = Array.from(new Set([
            ...talkRecordingRoots(folder),
            ...talkRecordingRoots(configured),
        ]));
        const rootSet = new Set(roots.map(r => r.toLowerCase()));

        // ── Level 1: the per-room folders under each root ──
        const roomFolders = [];
        const seenFolders = new Set();
        let authFailed = false;
        let reached = false;
        for (const root of roots) {
            const { status, entries } = await propfindChildren(ctx, root);
            if (status === 401) { authFailed = true; continue; }
            if (status === 404) continue;          // folder doesn't exist yet
            if (status < 200 || status >= 300) continue;
            reached = true;
            for (const e of entries) {
                if (!e.isCollection) continue;
                // Don't descend into a folder that is itself one of the roots
                // (`/Talk` → `/Talk/Recording`) — it is scanned as a root.
                if (rootSet.has(e.path.toLowerCase())) continue;
                // Room tokens are alphanumeric; this also skips Talk's
                // per-conversation ATTACHMENT folders (`<name>-<token>`).
                if (!/^[A-Za-z0-9]+$/.test(e.name)) continue;
                if (seenFolders.has(e.path.toLowerCase())) continue;
                seenFolders.add(e.path.toLowerCase());
                roomFolders.push({ root, path: e.path });
            }
        }
        if (!reached && authFailed) {
            return res.status(401).json({ error: ctx.authError || 'Nextcloud auth failed' });
        }
        if (!roomFolders.length) return res.json({ folder, count: 0, rooms: [] });

        const truncated = roomFolders.length > TALK_MAX_ROOM_FOLDERS;
        if (truncated) {
            log.warn(`[Transcriptions] Talk recordings: ${roomFolders.length} room folders under ${folder}, scanning the first ${TALK_MAX_ROOM_FOLDERS}`);
        }

        // ── Level 2: the recordings inside each room folder ──
        const roomsMap = new Map();
        const listings = await mapCapped(
            roomFolders.slice(0, TALK_MAX_ROOM_FOLDERS),
            TALK_PROPFIND_CONCURRENCY,
            async (rf) => ({ rf, ...(await propfindChildren(ctx, rf.path).catch(() => ({ status: 0, entries: [] }))) }),
        );
        for (const { rf, entries } of listings) {
            for (const e of entries) {
                if (e.isCollection) continue;
                const ext = path.extname(e.name).toLowerCase();
                if (!ACCEPTED_RECORDING_EXTS.includes(ext)) continue;
                const token = parseTalkRoomToken(e.path, rf.root);
                if (!token) continue;
                if (!roomsMap.has(token)) roomsMap.set(token, []);
                roomsMap.get(token).push({
                    name: e.name,
                    path: e.path,
                    size: e.size,
                    lastModified: e.lastModified,
                    kind: VIDEO_EXTS.includes(ext) ? 'video' : 'audio',
                });
            }
        }

        const rooms = Array.from(roomsMap.entries()).map(([token, recordings]) => {
            recordings.sort(byNewestFirst);
            return { token, recordings, lastModified: recordings[0]?.lastModified || null };
        });
        rooms.sort(byNewestFirst);

        // Name the conversations — a bare token tells the user nothing about
        // which meeting they are importing.
        await decorateRoomNames(rooms, req.session, userId);

        res.json({
            folder,
            count: rooms.reduce((n, rm) => n + rm.recordings.length, 0),
            rooms,
            ...(truncated ? { truncated: true } : {}),
        });
    } catch (err) {
        log.error('[Transcriptions] Talk recordings list error:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(400).json({ error: 'Nextcloud not connected for this account' });
        }
        next(err);
    }
});

/**
 * Best-effort: attach the Talk conversation display name to each room. One
 * room-list call covers every token; a room the user has since left simply
 * keeps its token. Never throws — a missing name must not fail the listing.
 */
async function decorateRoomNames(rooms, session, userId) {
    if (!rooms.length) return;
    try {
        const talk = require('../../integrations/nextcloudTalkTools');
        const { guardedNcCall } = require('../../core/integrations/ncScopeGuard');
        const res = await guardedNcCall('nextcloud_talk_list_rooms', {}, { userId, session },
            () => talk.executeNextcloudTalkTool('nextcloud_talk_list_rooms', {}, userId, session));
        if (!res || res.error || !Array.isArray(res.rooms)) return;
        const nameByToken = new Map(res.rooms.map(r => [r.token, r.name]));
        for (const room of rooms) {
            const name = nameByToken.get(room.token);
            if (name) room.name = name;
        }
    } catch (err) { bestEffort('routes/transcriptions/nextcloud:decorateRoomNames', err); /* names are a nicety, the paths are the payload */ }
}

router.post('/from-nextcloud', requireAuth, validate({ body: FromNextcloudBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);
    const { nextcloud_path, language = 'nl', provider: requestedProvider, title: titleHint, context_terms } = req.body;

    req.setTimeout(600000); res.setTimeout(600000);

    try {
        // A recording living under the Talk recordings folder carries its room
        // token as the first path segment; resolve write-back settings for it.
        const talkRoomToken = parseTalkRoomToken(nextcloud_path, await resolveRecordingFolder(userOrgId, userId));
        let postSummaryBack = false;
        if (talkRoomToken) {
            const { resolveTalkNotesSettings } = require('../../core/meetingNotes/talkNotesSettings');
            const settings = await resolveTalkNotesSettings({ orgId: userOrgId, userId });
            postSummaryBack = !!settings.postSummaryBack;
        }

        const { ingestNextcloudRecording } = require('../../core/meetingNotes/ingestNextcloudRecording');
        const out = await ingestNextcloudRecording({
            userId, session: req.session, orgId: userOrgId,
            ncPath: nextcloud_path, language,
            provider: requestedProvider, contextTerms: context_terms || '',
            titleHint,
            source: talkRoomToken ? 'talk' : 'nextcloud',
            talkRoomToken, postSummaryBack,
            // So a dedup hit on a colleague's note is refused with a clear 409
            // instead of returning an id this caller cannot open.
            accessCtx: await resolveAccessContext(req),
        });
        res.json(out);
    } catch (err) {
        log.error('[Transcriptions] from-nextcloud failed:', err.message);
        // The ingest pipeline classifies what the caller should hear as an
        // IngestError (status, code, sentence), and so does anything that set a
        // 4xx. Everything else — a database or filesystem failure — used to echo
        // its own text to the client; it now gets the terminal handler's generic
        // 500 with a correlationId.
        const status = Number(err?.status) || 0;
        if (err?.expose !== true && (err?.name === 'IngestError' || (status >= 400 && status < 500))) {
            throw new HttpError(status || 500, typeof err.code === 'string' ? err.code : undefined, err.message);
        }
        throw err;
    }
});

// ── Upcoming Talk meetings (calendar-linked) ─────────────
//
// Powers the Meeting Notes "Upcoming" view: the user's calendar Talk meetings,
// each enriched with whether they moderate it, live call/recording state, the
// per-meeting record toggle (exclusion), and a status chip.

router.get('/talk-meetings', requireAuth, validate({ query: NO_QUERY }), async (req, res, next) => {
    const userId = req.session.user.id;
    try {
        const userOrgId = await resolveUserOrgFromReq(req);
        const talk = require('../../integrations/nextcloudTalkTools');
        const { listUpcomingTalkMeetings } = require('../../core/meetingNotes/talkCalendar');
        const { resolveTalkNotesSettings } = require('../../core/meetingNotes/talkNotesSettings');

        const cap = await talk.getTalkRecordingCapability(req.session, userId);
        const settings = await resolveTalkNotesSettings({ orgId: userOrgId, userId });
        const meetings = await listUpcomingTalkMeetings({ session: req.session, userId, windowHours: 48 });

        // One room list to enrich moderator + call/recording state by token.
        const roomsByToken = {};
        try {
            const { guardedNcCall } = require('../../core/integrations/ncScopeGuard');
            const roomsRes = await guardedNcCall('nextcloud_talk_list_rooms', {}, { userId, orgId: userOrgId, session: req.session },
                () => talk.executeNextcloudTalkTool('nextcloud_talk_list_rooms', {}, userId, req.session));
            if (roomsRes && Array.isArray(roomsRes.rooms)) for (const r of roomsRes.rooms) roomsByToken[r.token] = r;
        } catch (err) { fallbackSwallowed('routes/transcriptions/nextcloud:anon', err); /* best-effort enrichment */ }

        // The per-meeting choice comes from meeting_prefs (M5). `excluded` is
        // here the EFFECTIVE state of the switch that the Scheduled list shows
        // — so including the 1-on-1 default, because a conversation that is not
        // recorded must not show as "on" in the list either. The global
        // autoRecord switch deliberately does not count in there (fallback: true):
        // that is a separate setting and is already in the status chip.
        //
        // ── THE SAME DATA AS THE ENGINE, AND HOW WE SAY SO ───────────────
        // The participant count comes from `knownParticipantCount` — exactly the
        // steps that talkAutoRecord also has (calendar + conversation type), and
        // in scope 'all' also without a calendar, because the engine does not look
        // at it there. What the engine additionally does and this route cannot do
        // (a LIVE count with Talk at the moment the conversation runs) does not
        // make the outcome here "out" but UNDECIDED: that travels along as
        // `recordDecided: false`, so that the screen does not claim the opposite
        // of what will happen later.
        const meetingPrefs = require('../../stores/meetingPrefsStore');
        const { knownParticipantCount } = require('../../core/meetingNotes/talkParticipants');
        const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'talk', userId, orgId: userOrgId });

        const out = [];
        for (const m of meetings) {
            const room = roomsByToken[m.talkToken] || null;
            const isModerator = room ? [1, 2].includes(room.participantType) : null;
            const recordingNow = !!(room && room.callRecording && room.callRecording !== 0);
            const ids = meetingPrefs.talkIds({ eventUid: m.uid, roomToken: m.talkToken });
            const decision = prefs.decide({
                ids,
                participantCount: knownParticipantCount({ room, meeting: m, autoRecordScope: settings.autoRecordScope }),
                fallback: true,
            });
            // The tags that are on the APPOINTMENT (meeting_prefs) — something other than
            // the tags on an existing note. The Scheduled row shows them read-only;
            // without this line that row had a source that did not exist and could
            // therefore never show anything.
            const tags = prefs.tagsFor(ids);
            const excluded = !decision.record;
            // Undecided = the outcome hangs on a count that can only be made at the
            // start of the conversation. Only meaningful as long as the engine actually
            // does that: if auto-record is off, or the recording back-end is missing,
            // or the user does not moderate, then nothing happens in any case and
            // "undecided" itself is the lie.
            const engineWillLook = settings.autoRecord && cap.recordingEnabled && isModerator === true;
            const recordDecided = decision.reason !== 'unknown_size' || !engineWillLook;
            let recordedNoteId = null;
            try {
                const t = await transcriptionStore.getTranscriptionByTalkRoomToken(m.talkToken, userId);
                if (t) recordedNoteId = t.id;
            } catch (err) { fallbackSwallowed('routes/transcriptions/nextcloud:anon#2', err); /* ignore */ }

            let status;
            if (recordingNow) status = 'recording_now';
            else if (recordedNoteId) status = 'recorded';
            else if (isModerator === false) status = 'not_moderator';
            else if (settings.autoRecord && cap.recordingEnabled && !excluded && isModerator) status = 'will_record';
            else if (!recordDecided) status = 'decides_at_start';
            else status = 'upcoming';

            out.push({
                ...m, isModerator, recordingNow, excluded, tags,
                recordReason: decision.reason, recordDecided,
                recordedNoteId, status,
            });
        }

        res.json({
            recordingEnabled: cap.recordingEnabled,
            autoRecord: settings.autoRecord,
            autoRecordScope: settings.autoRecordScope,
            recordingMode: settings.recordingMode,
            // The footer line about what happens to the OTHER participants hangs on
            // this: only with `true` does Bee Flow post the summary back into the
            // conversation. Without this field the screen had to stay silent — and it
            // did, which made the sentence unreachable.
            postSummaryBack: settings.postSummaryBack,
            count: out.length,
            meetings: out,
        });
    } catch (err) {
        log.error('[Transcriptions] talk-meetings error:', err.message);
        if (err.message === 'NOT_CONNECTED') return res.status(400).json({ error: 'Nextcloud not connected for this account' });
        next(err);
    }
});

// Toggle a single meeting's auto-record on/off (writes the user's exclusions).
router.patch('/talk-meetings/:token', requireAuth, validate({ body: TalkPrefBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const token = req.params.token;
    const { record, eventUid } = req.body;
    // Writes the preference of THIS user (meeting_prefs), not that of the org: a
    // second participant in the same meeting keeps their own row. Both the space
    // and the occurrence get the value — the same scope the old exclusion lists had.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const ids = meetingPrefs.talkIds({ eventUid: eventUid || null, roomToken: token });
    await meetingPrefs.setRecord({ provider: 'talk', ids, userId, record });

    // ── WHAT ACTUALLY APPLIES AFTER THE WRITE ───────────────────────
    // Do not echo the question back. `resolvePrefs` always lets one FALSE win —
    // also an ORG-wide row, and also a row on the space while you switched the
    // occurrence on. If this route answered `record: true` because `true` was in
    // the request, the row would optimistically jump to "Record", stand on "Skip"
    // again at the next load, and the screen would have said nowhere why. Now the
    // route reads back what is stored and says that.
    const userOrgId = await resolveUserOrgFromReq(req);
    const after = await meetingPrefs.loadMeetingPrefs({ provider: 'talk', userId, orgId: userOrgId });
    const opinion = after.opinionFor(ids);
    res.json({
        ok: true, token,
        record,
        // The state that actually applies. NULL cannot happen here: an explicit row
        // was just written, so there is always an opinion.
        effectiveRecord: opinion === true,
        // Why it deviates, if it does. Only these two cases exist: an org-wide
        // exclusion, or an exclusion on the other id space (the space next to the
        // occurrence).
        overridden: opinion !== record,
    });
});

module.exports = router;
