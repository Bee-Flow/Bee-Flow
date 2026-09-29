/**
 * Nextcloud Talk → Meeting Notes settings API.
 *
 * Org-level (admin-managed) and user-level (self-managed) toggles that gate
 * auto-transcription of Talk recordings and write-back of the summary into the
 * Talk conversation. Storage + resolution live in
 * `server/core/meetingNotes/talkNotesSettings.js`. Auth mirrors
 * `server/routes/orgPrivacyShield.js`.
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Both PUT bodies are `.strict()`. The save functions coerce every field —
 * `!!patch.autoRecord`, `asScope()`, `asMode()`, `!== false` — and on a router
 * that switches RECORDING on and off, each coercion was a way to get the
 * opposite of what was asked, answered `{ ok: true }`:
 *
 *   - `{"autoRecord": "false"}` switched auto-recording ON (the text "false"
 *     is true), on both the personal and the organisation settings;
 *   - `{"insightsPerPersonStats": "false"}` (or `0`) left per-person talk-time
 *     statistics ON for everyone — the org policy about what OTHERS may see;
 *   - `{"autoRecordScope": "All"}` recorded calendar meetings only, and
 *     `{"recordingMode": "Video"}` recorded audio only.
 *
 * The screens PUT back what they GOT, so the body also carries the GET's own
 * echoes — `updatedAt`, `updatedBy` and, on the personal route,
 * `nextcloudConnected` / `recordingEnabled`. Those are declared and ignored:
 * the save functions build the document from an explicit list of fields, so
 * an echo can never become a setting. The two legacy exclusion lists
 * round-trip untouched (see the core module's header), filtered there.
 *
 * `null` on the org route is "no opinion — inherit" (resolveTalkNotesSettings),
 * so the org fields accept it; a personal setting has no one to inherit from.
 */

const express = require('express');
const router = express.Router();
require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const talkNotes = require('../core/meetingNotes/talkNotesSettings');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** A real boolean, never the text "false" — which is true. */
const bool = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` });
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

const SCOPE_TEXT = 'autoRecordScope is "calendar" (scheduled meetings) or "all" (any moderated call).';
const MODE_TEXT = 'recordingMode is "audio" or "video".';
const LANGUAGE_TEXT = 'language is a language code, e.g. "nl" or "en".';
const FOLDER_TEXT = 'recordingFolder is a Nextcloud folder path, e.g. /Talk/Recording.';

const language = z.string({ invalid_type_error: LANGUAGE_TEXT })
    .trim().regex(/^([a-z]{2,3}(-[a-z0-9]{2,8})?|auto)$/i, LANGUAGE_TEXT);

/** The fields both scopes store. `nullable` is the org's "inherit". */
function settingsShape({ nullable }) {
    const maybe = (schema) => (nullable ? schema.nullable() : schema).optional();
    return {
        autoTranscribe: maybe(bool('autoTranscribe')),
        postSummaryBack: maybe(bool('postSummaryBack')),
        recordingFolder: maybe(z.string({ invalid_type_error: FOLDER_TEXT }).max(1024, FOLDER_TEXT)),
        language: maybe(language),
        autoRecord: maybe(bool('autoRecord')),
        autoRecordScope: maybe(choice(['calendar', 'all'], SCOPE_TEXT)),
        recordingMode: maybe(choice(['audio', 'video'], MODE_TEXT)),
        // LEGACY — round-tripped for a rollback, filtered by asStrArray.
        excludedEventUids: z.array(z.unknown(), { invalid_type_error: 'excludedEventUids is a list.' }).optional(),
        excludedRoomTokens: z.array(z.unknown(), { invalid_type_error: 'excludedRoomTokens is a list.' }).optional(),
        // Echoes of the GET, declared so a round-trip save is not refused.
        updatedAt: z.unknown(),
        updatedBy: z.unknown(),
    };
}

const UserSettingsBody = z.object({
    ...settingsShape({ nullable: false }),
    nextcloudConnected: z.unknown(),
    recordingEnabled: z.unknown(),
}).strict();

const OrgSettingsBody = z.object({
    ...settingsShape({ nullable: true }),
    defaultOwnerUserId: z.string({ invalid_type_error: 'defaultOwnerUserId is a user id.' }).nullish(),
    insightsPerPersonStats: bool('insightsPerPersonStats').optional(),
}).strict();

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

const { isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');

// ── User-level (consumer / self) ─────────────────────────
// Declared before /:orgId so "user" isn't captured as an orgId param.
router.get('/user/me', requireAuth, async (req, res) => {
    const config = await talkNotes.getUserSettings(req.session.user.id);
    // Surface whether the user has a Nextcloud connection at all (to hide the
    // section for non-NC accounts) and whether the Talk recording backend is
    // available (to gate the auto-record toggle).
    let nextcloudConnected = false;
    let recordingEnabled = false;
    try {
        const ncClient = require('../integrations/nextcloudClient');
        nextcloudConnected = await ncClient.isConnected(req.session, req.session.user.id);
        if (nextcloudConnected) {
            const talk = require('../integrations/nextcloudTalkTools');
            recordingEnabled = (await talk.getTalkRecordingCapability(req.session, req.session.user.id)).recordingEnabled;
        }
    } catch (_) { /* treat as not connected */ }
    res.json({ ...config, nextcloudConnected, recordingEnabled });
});

router.put('/user/me', requireAuth, validate({ body: UserSettingsBody }), async (req, res) => {
    const config = await talkNotes.saveUserSettings(req.session.user.id, req.body);
    res.json({ ok: true, config });
});

// ── Org-level (admin) ────────────────────────────────────
router.get('/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    const orgIds = await resolveUserOrgIds(req);
    const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
    if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });
    const config = await talkNotes.getOrgSettings(orgId);
    res.json(config);
});

router.put('/:orgId', requireAuth, validate({ body: OrgSettingsBody }), async (req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdmin(req, orgId))) {
        return res.status(403).json({ error: 'Only organization admins can manage these settings' });
    }
    const config = await talkNotes.saveOrgSettings(orgId, req.body, req.session.user.id);
    res.json({ ok: true, config });
});

module.exports = router;
