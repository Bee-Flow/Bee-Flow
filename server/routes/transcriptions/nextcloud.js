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
    } catch (_) { /* fall through to the configured value */ }
    return configuredFolder;
}

const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, bool, NO_QUERY } = require('./schemas');

// ── Wat de Nextcloud-routes mogen dragen ────────────────────────────
//
// `record` is een ECHTE boolean, en dat is de reden dat dit bestand een
// schema kreeg. De opnamevoorkeur werd geschreven als `record: !!record`:
//
//   • `{"record": "false"}` is waar — de opname ging AAN voor een vergadering
//     waarvan iemand hem net had uitgezet, en het antwoord bevestigde dat.
//   • `{"recrod": false}` viel weg — de opname ging UIT voor een vergadering
//     waarvan iemand hem net had aangezet.
//
// In een product dat vergaderingen opneemt is dat geen vormkwestie.
const FOLDER_TEXT = 'folder is een pad in Nextcloud.';
const FolderQuery = z.object({
    folder: worded(FOLDER_TEXT).trim().min(1, FOLDER_TEXT).optional(),
}).strict();

const PATH_TEXT = 'nextcloud_path is required';
const FromNextcloudBody = bodyOf({
    nextcloud_path: worded(PATH_TEXT).trim().min(1, PATH_TEXT),
    // De taal waarin het transcript wordt gemaakt. Stond er met een stille
    // standaard: `{"languge":"en"}` liet een Engelse opname in het Nederlands
    // transcriberen, en het resultaat is niet aan het antwoord te zien.
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
        if (!r.ok) return res.status(502).json({ error: `Nextcloud PROPFIND failed (${r.status})` });

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
    } catch (_) { /* names are a nicety, the paths are the payload */ }
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
        res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
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
        } catch (_) { /* best-effort enrichment */ }

        // De per-vergadering keuze komt uit meeting_prefs (M5). `excluded` is
        // hier de EFFECTIEVE stand van de schakelaar die de Gepland-lijst toont
        // — dus inclusief de 1-op-1-standaard, want een gesprek dat niet wordt
        // opgenomen moet ook niet als "aan" in de lijst staan. De globale
        // autoRecord-schakelaar telt daar bewust niet in mee (fallback: true):
        // die is een aparte instelling en staat al in de statuschip.
        //
        // ── DEZELFDE GEGEVENS ALS DE ENGINE, EN ANDERS ZEGGEN WE HET ─────
        // Het deelnemersaantal komt uit `knownParticipantCount` — precies de
        // stappen die talkAutoRecord óók heeft (agenda + conversatietype), en
        // in scope 'all' óók zonder agenda, want daar kijkt de engine er niet
        // naar. Wat de engine daarnaast doet en deze route niet kan (een LIVE
        // telling bij Talk op het moment dat het gesprek loopt) maakt de
        // uitkomst hier niet "uit" maar ONBESLIST: dat reist mee als
        // `recordDecided: false`, zodat het scherm niet het tegenovergestelde
        // beweert van wat er straks gebeurt.
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
            // De tags die op de AFSPRAAK staan (meeting_prefs) — iets anders dan
            // de tags op een bestaande notitie. De Gepland-rij toont ze
            // read-only; zonder deze regel had die rij een bron die er niet was
            // en kon hij dus nooit iets tonen.
            const tags = prefs.tagsFor(ids);
            const excluded = !decision.record;
            // Onbeslist = de uitkomst hangt aan een telling die pas bij de
            // start van het gesprek te maken is. Alleen zinnig zolang de engine
            // dat werkelijk gaat doen: staat auto-record uit, ontbreekt de
            // opnameback-end of modereert de gebruiker niet, dan gebeurt er
            // hoe dan ook niets en is "onbeslist" zelf de leugen.
            const engineWillLook = settings.autoRecord && cap.recordingEnabled && isModerator === true;
            const recordDecided = decision.reason !== 'unknown_size' || !engineWillLook;
            let recordedNoteId = null;
            try {
                const t = await transcriptionStore.getTranscriptionByTalkRoomToken(m.talkToken, userId);
                if (t) recordedNoteId = t.id;
            } catch (_) { /* ignore */ }

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
            // De voetregel over wat er met de ANDERE deelnemers gebeurt hangt
            // hieraan: alleen bij `true` post Bee Flow de samenvatting terug in
            // het gesprek. Zonder dit veld moest het scherm zwijgen — en dat
            // deed het ook, wat de zin onbereikbaar maakte.
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
    // Schrijft de voorkeur van DEZE gebruiker (meeting_prefs), niet die van
    // de org: een tweede deelnemer aan dezelfde vergadering houdt zijn eigen
    // rij. Zowel de ruimte als de occurrence krijgen de waarde — hetzelfde
    // bereik als de oude exclusielijsten hadden.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const ids = meetingPrefs.talkIds({ eventUid: eventUid || null, roomToken: token });
    await meetingPrefs.setRecord({ provider: 'talk', ids, userId, record });

    // ── WAT ER NA DE SCHRIJF ECHT STAAT ─────────────────────────────
    // Niet de vraag terugkaatsen. `resolvePrefs` laat één FALSE altijd
    // winnen — óók een ORG-brede rij, en óók een rij op de ruimte terwijl
    // je de occurrence aanzette. Antwoordde deze route `record: true`
    // omdat er `true` in het verzoek stond, dan sprong de rij optimistisch
    // op "Record", stond hij bij de volgende load weer op "Skip", en had
    // het scherm nergens gezegd waarom. Nu leest de route terug wat er
    // staat en zegt hij dát.
    const userOrgId = await resolveUserOrgFromReq(req);
    const after = await meetingPrefs.loadMeetingPrefs({ provider: 'talk', userId, orgId: userOrgId });
    const opinion = after.opinionFor(ids);
    res.json({
        ok: true, token,
        record,
        // De stand die daadwerkelijk geldt. NULL kan hier niet: er is net
        // een expliciete rij geschreven, dus er is altijd een mening.
        effectiveRecord: opinion === true,
        // Waarom hij afwijkt, als hij afwijkt. Alleen deze twee gevallen
        // bestaan: een org-brede uitsluiting of een uitsluiting op de
        // andere id-ruimte (de ruimte naast de occurrence).
        overridden: opinion !== record,
    });
});

module.exports = router;
