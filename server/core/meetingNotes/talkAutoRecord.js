// @typecheck
/**
 * Talk auto-record engine.
 *
 * Polls (no connector changes — the connector forwards no call events) the
 * active Talk calls of users who enabled auto-record, and STARTS recording the
 * ones they moderate that match their scope/exclusions. Talk auto-stops the
 * recording when the call ends and uploads the file → the existing `file.new`
 * tap (`talkAutoIngest`) then transcribes it into a Meeting Note.
 *
 * `scanAndRecord()` is the per-tick body; the advisory-lock wrapper +
 * scheduling live in `automationRunner.js` (mirrors `processPollingAndRenewals`).
 *
 * Recording start requires: a configured recording backend, an ACTIVE call
 * (`hasCall`), and the user being owner/moderator (`participantType ∈ {1,2}`).
 * Status: 2 = audio, 1 = video.
 *
 * "Configured recording backend" is `capabilities.spreed.config.call.recording`,
 * NOT the `recording-v1` feature flag — that one is a static entry in spreed's
 * `Capabilities::FEATURES` and is advertised by every Talk >= 26 regardless of
 * whether an HPB and a recording server exist. See
 * `getTalkRecordingCapability` in nextcloudTalkTools.js.
 */

const configStore = require('../../stores/configStore');
const { resolveTalkNotesSettings } = require('./talkNotesSettings');
const log = require('../../telemetry/log');

const ARMED_KEY = (userId) => `talk_autorecord_armed_${userId}`;

// Guard: don't re-issue start for the same room within this window (the room's
// callRecording state is eventually consistent across a 60s tick).
const RECENT_TTL_MS = 5 * 60 * 1000;
const _recentStarts = new Map(); // token → ts
// Skip-cache for rooms we can't/shouldn't record (not a moderator, backend off).
const SKIP_TTL_MS = 10 * 60 * 1000;
const _skip = new Map(); // `${userId}:${token}` → ts

function recentlyStarted(token) {
    const ts = _recentStarts.get(token);
    return !!ts && (Date.now() - ts) < RECENT_TTL_MS;
}
function markStarted(token) { _recentStarts.set(token, Date.now()); }
function isSkipped(userId, token) {
    const ts = _skip.get(`${userId}:${token}`);
    return !!ts && (Date.now() - ts) < SKIP_TTL_MS;
}
function markSkip(userId, token) { _skip.set(`${userId}:${token}`, Date.now()); }

// ── Armed-token set (so auto-recorded calls transcribe even if autoTranscribe is off) ──
//
// An armed token says "this room's next recording came from auto-record, so
// transcribe it even though autoTranscribe is off". It is disarmed after that
// recording is ingested — but only on the success path, so a call that was
// recorded and then never produced a file (a crash, a failed upload, a user who
// deleted the recording) left the token armed forever. Every LATER manual
// recording in that room was then silently auto-transcribed against the user's
// setting. Entries therefore carry a timestamp and expire.
const ARMED_TTL_MS = 24 * 60 * 60 * 1000;

/** Read the stored list, tolerating the old bare-string format, and drop expired entries. */
async function readArmed(userId) {
    const cur = (await configStore.getConfig(ARMED_KEY(userId)).catch(() => null)) || [];
    if (!Array.isArray(cur)) return [];
    const now = Date.now();
    return cur
        // Pre-TTL rows were plain token strings; treat them as armed now so an
        // upgrade doesn't drop a call that is in flight.
        .map(e => (typeof e === 'string' ? { token: e, ts: now } : e))
        .filter(e => e && typeof e.token === 'string' && (now - (Number(e.ts) || 0)) < ARMED_TTL_MS);
}

async function armToken(userId, token) {
    const cur = await readArmed(userId);
    const next = cur.filter(e => e.token !== token);
    next.push({ token, ts: Date.now() });
    await configStore.setConfig(ARMED_KEY(userId), next);
}
async function isArmed(userId, token) {
    return (await readArmed(userId)).some(e => e.token === token);
}
async function disarmToken(userId, token) {
    const cur = await readArmed(userId);
    const next = cur.filter(e => e.token !== token);
    // Still write when only expired entries were pruned — that is the garbage
    // collection this list never had.
    await configStore.setConfig(ARMED_KEY(userId), next);
}

async function resolveOrgIdForUser(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        return (await getUser(userId))?.organizationId || null;
    } catch (_) { return null; }
}

/**
 * Build the candidate user set: everyone with a user_talk_notes_* doc, plus
 * members of any org whose org_talk_notes_* doc enabled autoRecord (so an org
 * can turn it on for members who never opened their own settings).
 */
async function listCandidateUsers() {
    const all = await configStore.getAllConfig().catch(() => ({}));
    const userIds = new Set();
    const orgIds = new Set();
    for (const key of Object.keys(all || {})) {
        if (key.startsWith('user_talk_notes_')) userIds.add(key.slice('user_talk_notes_'.length));
        else if (key.startsWith('org_talk_notes_')) orgIds.add(key.slice('org_talk_notes_'.length));
    }
    if (orgIds.size) {
        const enabledOrgs = [];
        for (const orgId of orgIds) {
            const s = await resolveTalkNotesSettings({ orgId }).catch(() => null);
            if (s?.autoRecord) enabledOrgs.push(orgId);
        }
        if (enabledOrgs.length) {
            try {
                const { getAllUsers } = require('../../stores/userStore');
                const users = await getAllUsers();
                for (const u of users) {
                    if (u.organizationId && enabledOrgs.includes(u.organizationId)) userIds.add(u.id);
                }
            } catch (_) { /* best-effort */ }
        }
    }
    return Array.from(userIds);
}

/**
 * Hoeveel mensen doen er mee? Antwoord NULL als het niet te weten is — die
 * onzekerheid VERSMALT in meetingPrefsStore.decideRecord (onbekend telt niet
 * als "meer dan twee").
 *
 * Drie bronnen, van beste naar laatste:
 *   1. de agenda-afspraak (namen + organisator),
 *   2. het conversatietype: een Talk-room van type 1 is per definitie een
 *      één-op-één,
 *   3. Talk zelf. Zonder deze derde stap zou élke groepsruimte zonder
 *      agenda-afspraak "onbekend" zijn en dus nooit meer automatisch opnemen —
 *      kijken is hier beter dan gokken. Lukt de vraag niet, dan blijft het
 *      onbekend (en wordt er dus niet opgenomen).
 */
async function countParticipants({ room, meeting, userId, orgId, session, talk, autoRecordScope = 'calendar' }) {
    // Stap 1 en 2 (agenda + conversatietype) staan in een GEDEELDE module,
    // zodat de Gepland-lijst exact hetzelfde antwoord geeft als deze engine op
    // alles wat zij allebei kunnen weten. Zij hadden hier uiteenlopende
    // antwoorden, met een toggle die UIT stond terwijl de opname liep.
    const { knownParticipantCount } = require('./talkParticipants');
    const known = knownParticipantCount({ room, meeting, autoRecordScope });
    if (known !== null) return known;

    const { guardedNcCall } = require('../integrations/ncScopeGuard');
    const args = { token: room.token };
    const res = await guardedNcCall('nextcloud_talk_list_participants', args, { userId, orgId, session },
        () => talk.executeNextcloudTalkTool('nextcloud_talk_list_participants', args, userId, session),
    ).catch(() => null);
    if (!res || res.error || res.nc_scope_denied || !Array.isArray(res.participants)) return null;
    // Tijdens een gesprek telt wie er IN het gesprek zit (inCall-bitmask, bit 1),
    // niet wie er ooit aan de conversatie is toegevoegd.
    //
    // GEEN TERUGVAL OP `res.count`. Dat veld is `participants.length` uit de
    // tool (integrations/nextcloudTalkTools.js) — IEDEREEN die ooit aan de
    // conversatie is toegevoegd. Een groepsconversatie met vijf leden waarvan
    // niemand in gesprek is, zou daarmee als "vijf deelnemers" tellen en dus
    // worden opgenomen; dat gebeurt echt, want de kamerlijst wordt één keer
    // bovenaan de scan opgehaald en een gesprek dat intussen eindigde levert
    // overal inCall 0. `inCall === 0` is geen bekende telling maar precies de
    // ONBEKENDE waarde, en onbekend versmalt: null → niet opnemen.
    const inCall = res.participants.filter(p => (Number(p?.inCall) || 0) & 1).length;
    return inCall > 0 ? inCall : null;
}

async function scanUser(userId) {
    const orgId = await resolveOrgIdForUser(userId);
    const settings = await resolveTalkNotesSettings({ orgId, userId });
    if (!settings.autoRecord) return;

    const triggerBus = require('../../automation/triggerBus');
    const session = await triggerBus.loadSession(userId);
    if (!session) return;

    const talk = require('../../integrations/nextcloudTalkTools');
    const cap = await talk.getTalkRecordingCapability(session, userId);
    if (!cap.recordingEnabled) return;

    // The per-user Nextcloud scope is enforced in toolDispatcher, which this
    // background scan does not go through — so it applies the same guard here
    // by hand. Without it a user who narrowed Talk to two conversations was
    // still scanned across every room they are in, and recording could start
    // in one they deliberately left out. The settings screen promises
    // "Enforced on the server for chats, automations and apps alike"; this is
    // one of the "apps".
    const { guardedNcCall } = require('../integrations/ncScopeGuard');
    const roomsRes = await guardedNcCall('nextcloud_talk_list_rooms', {}, { userId, orgId, session },
        () => talk.executeNextcloudTalkTool('nextcloud_talk_list_rooms', {}, userId, session));
    if (!roomsRes || roomsRes.error || !Array.isArray(roomsRes.rooms)) return;
    const active = roomsRes.rooms.filter(r =>
        r.hasCall && [1, 2].includes(r.participantType) && (!r.callRecording || r.callRecording === 0));
    if (!active.length) return;

    // De per-vergadering keuze komt uit meeting_prefs (M5), niet meer uit de
    // exclusielijsten in de instellingen: één query voor deze gebruiker, daarna
    // per ruimte beslissen.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'talk', userId, orgId });

    // Agenda-afspraken per token — levert zowel de occurrence-uid (een eigen
    // id-ruimte in meeting_prefs) als de deelnemerslijst voor de
    // 1-op-1-standaard.
    let calendarByToken = null;
    if (settings.autoRecordScope === 'calendar') {
        const { listUpcomingTalkMeetings } = require('./talkCalendar');
        const meetings = await listUpcomingTalkMeetings({ session, userId, orgId, windowHours: 4 });
        calendarByToken = new Map();
        for (const m of meetings) if (m.talkToken) calendarByToken.set(m.talkToken, m);
    }

    for (const room of active) {
        const token = room.token;
        if (!token || recentlyStarted(token) || isSkipped(userId, token)) continue;
        const meeting = calendarByToken ? (calendarByToken.get(token) || null) : null;
        if (settings.autoRecordScope === 'calendar') {
            const isMeeting = room.objectType === 'event' || !!meeting;
            if (!isMeeting) continue;
        }

        const decision = prefs.decide({
            ids: meetingPrefs.talkIds({ eventUid: meeting?.uid || null, roomToken: token }),
            participantCount: await countParticipants({
                room, meeting, userId, orgId, session, talk,
                autoRecordScope: settings.autoRecordScope,
            }),
            // autoRecord is hierboven al gecontroleerd; binnen die schakelaar
            // beslist de voorkeur.
            fallback: true,
        });
        if (!decision.record) {
            // Bewust GEEN markSkip: een gesprek dat nu nog met z'n tweeën is kan
            // over een tick een vergadering zijn, en dan hoort hij alsnog mee te
            // draaien. Een uitsluiting wordt elke tick opnieuw gelezen.
            continue;
        }

        const status = settings.recordingMode === 'video' ? 1 : 2;
        // Re-checked per room, not just on the listing: the scope may name
        // rooms the filter above could not drop (a conversation that entered
        // the list by another path), and starting a recording is the act the
        // user would least expect in a room they excluded.
        const res = await guardedNcCall('nextcloud_talk_start_recording', { token, status }, { userId, orgId, session },
            () => talk.executeNextcloudTalkTool('nextcloud_talk_start_recording', { token, status }, userId, session));
        if (res?.nc_scope_denied) { markSkip(userId, token); continue; }
        if (res && res.success) {
            markStarted(token);
            await armToken(userId, token).catch(() => {});
            log.info(`[TalkAutoRecord] started ${status === 2 ? 'audio' : 'video'} recording for room ${token} (user ${userId})`);
        } else if (res && (res.error === 'not_moderator' || res.error === 'recording_backend_unavailable' || res.error === 'room_not_found')) {
            markSkip(userId, token);
        } else if (res && res.error === 'no_active_call') {
            // Call ended between list and start — ignore (will re-evaluate next tick).
        } else {
            markSkip(userId, token);
            log.warn(`[TalkAutoRecord] start failed for ${token}: ${res?.error || 'unknown'}`);
        }
    }
}

/**
 * One auto-record pass. Caller wraps this in the Postgres advisory lock so only
 * one pod runs it per tick.
 */
async function scanAndRecord() {
    let users;
    try { users = await listCandidateUsers(); } catch (e) { log.error('[TalkAutoRecord] candidate scan failed:', e.message); return; }
    for (const userId of users) {
        try { await scanUser(userId); }
        catch (e) { log.error(`[TalkAutoRecord] scan failed for user ${userId}: ${e.message}`); }
    }
}

module.exports = { scanAndRecord, isArmed, armToken, disarmToken };
