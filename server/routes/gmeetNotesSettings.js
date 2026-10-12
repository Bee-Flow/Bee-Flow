/**
 * Google Meet → Meeting Notes settings API.
 *
 * Org-level (admin-managed) and user-level (self-managed) toggles that gate
 * background import of Google Meet recordings and pre-configured
 * auto-recording. Storage + resolution live in
 * `server/core/meetingNotes/gmeetNotesSettings.js`. Auth mirrors
 * `server/routes/talkNotesSettings.js`.
 */

const express = require('express');
const router = express.Router();
const { resolveUserOrgIds } = require('../auth');
const gmeetNotes = require('../core/meetingNotes/gmeetNotesSettings');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

const { isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// Both saves take the same document, and it is `.strict()` because every
// field decides whether somebody's meetings are imported or RECORDED, and
// the core's coercion turned each wrong value into a different setting:
//
//   - `autoRecordConfig: "false"` is a truthy string, so it pre-enabled
//     auto-recording of every meeting the person organizes — the opposite of
//     what was asked, under "Saved". `autoImport: "false"` did the same for
//     background import of their recordings;
//   - a misspelled key (`autoimport`) was dropped, and since the save
//     replaces the whole document, the real field was written as its default;
//   - `importScope: "calender"` became 'organizer', so "every meeting on my
//     calendar" quietly meant only the ones they organize.
//
// `null` stays meaningful — on the org document it is "no opinion, let each
// member decide" (see core/meetingNotes/gmeetNotesSettings.js) — and a field
// that is ABSENT keeps the core's documented default. `lookbackHours` stays
// CLAMPED by the core, as before; a value that is not a number is refused.
//
// The settings screens send back the GET they loaded, so the two legacy
// exclusion lists (moved to meetingPrefsStore, still round-tripped for a
// rollback) and the server's own `updatedAt`/`updatedBy` stamp arrive too.
// They are accepted; the stamp is ignored and rewritten on save.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the settings as a JSON object.' }).strict(),
);

/** An enum whose refusal is one sentence, for a wrong value as well as a wrong type. */
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

const onOff = (name) => z.boolean({ invalid_type_error: `${name} is true, false, or null for no opinion.` })
    .nullable().optional();

const LANGUAGE_TEXT = 'language is a language code, like nl or en.';
const legacyList = (name) => z.array(
    worded(`${name} is a list of ids.`).min(1, `${name} is a list of ids.`),
    { invalid_type_error: `${name} is a list of ids.` },
).optional();

const SettingsBody = bodyOf({
    autoImport: onOff('autoImport'),
    autoRecordConfig: onOff('autoRecordConfig'),
    importScope: choice(['organizer', 'calendar'], "importScope is 'organizer' or 'calendar', or null for no opinion.")
        .nullable().optional(),
    language: worded(LANGUAGE_TEXT).trim().min(1, LANGUAGE_TEXT).max(35, LANGUAGE_TEXT).nullable().optional(),
    lookbackHours: z.number({ invalid_type_error: 'lookbackHours is a number of hours.' }).nullable().optional(),
    excludedEventIds: legacyList('excludedEventIds'),
    excludedMeetingCodes: legacyList('excludedMeetingCodes'),
    updatedAt: z.string().nullish(),
    updatedBy: z.string().nullish(),
});

// ── User-level (consumer / self) ─────────────────────────
// Declared before /:orgId so "user" isn't captured as an orgId param.
router.get('/user/me', requireAuth, async (req, res) => {
    const config = await gmeetNotes.getUserSettings(req.session.user.id);
    // Surface the Google connection state (live session or vault credential)
    // plus whether the Meet scopes were granted, so the UI can show the
    // connect / reconnect prompts instead of a dead settings section.
    let credential = null;
    try {
        const credStore = require('../stores/automationCredentialStore');
        credential = await credStore.getCredential(req.session.user.id, 'google');
    } catch (_) { /* treat as no stored credential */ }
    const connection = gmeetNotes.deriveConnectionStatus({ session: req.session, credential });
    res.json({ ...config, connection });
});

router.put('/user/me', requireAuth, validate({ body: SettingsBody }), async (req, res) => {
    const config = await gmeetNotes.saveUserSettings(req.session.user.id, req.body);
    res.json({ ok: true, config });
});

// ── Org-level (admin) ────────────────────────────────────
router.get('/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    const orgIds = await resolveUserOrgIds(req);
    const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
    if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });
    const config = await gmeetNotes.getOrgSettings(orgId);
    res.json(config);
});

router.put('/:orgId', requireAuth, validate({ body: SettingsBody }), async (req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdmin(req, orgId))) {
        return res.status(403).json({ error: 'Only organization admins can manage these settings' });
    }
    const config = await gmeetNotes.saveOrgSettings(orgId, req.body, req.session.user.id);
    res.json({ ok: true, config });
});

module.exports = router;
