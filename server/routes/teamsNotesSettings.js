/**
 * Microsoft Teams → Meeting Notes settings API.
 *
 * Org-level (admin) and user-level (self) toggles for background import of
 * Teams recordings and Teams' own "record automatically". Storage and
 * resolution live in core/meetingNotes/teamsNotesSettings.js; auth and body
 * validation mirror routes/gmeetNotesSettings.js, whose header explains why
 * the body is strict.
 */

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { resolveUserOrgIds } = require('../auth');
const { requireAuth, isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const teamsNotes = require('../core/meetingNotes/teamsNotesSettings');

const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the settings as a JSON object.' }).strict(),
);
const onOff = (name) => z.boolean({ invalid_type_error: `${name} is true, false, or null for no opinion.` })
    .nullable().optional();
const LANGUAGE_TEXT = 'language is a language code, like nl or en.';

const SettingsBody = bodyOf({
    autoImport: onOff('autoImport'),
    autoRecordConfig: onOff('autoRecordConfig'),
    language: z.string({ invalid_type_error: LANGUAGE_TEXT }).trim().min(1, LANGUAGE_TEXT).max(35, LANGUAGE_TEXT).nullable().optional(),
    lookbackHours: z.number({ invalid_type_error: 'lookbackHours is a number of hours.' }).nullable().optional(),
    // The settings screens send back the GET they loaded; the stamp is rewritten on save.
    updatedAt: z.string().nullish(),
    updatedBy: z.string().nullish(),
});

// Declared before /:orgId so "user" is not read as an org id.
router.get('/user/me', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const config = await teamsNotes.getUserSettings(userId);
    let credential = null;
    try {
        credential = await require('../stores/automationCredentialStore').getCredential(userId, 'microsoft');
    } catch (_) { /* no stored credential */ }
    res.json({ ...config, connection: teamsNotes.deriveConnectionStatus({ session: req.session, credential }) });
});

router.put('/user/me', requireAuth, validate({ body: SettingsBody }), async (req, res) => {
    const config = await teamsNotes.saveUserSettings(req.session.user.id, req.body);
    res.json({ ok: true, config });
});

router.get('/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    const orgIds = await resolveUserOrgIds(req);
    if (!(orgIds === null || (orgIds && orgIds.has(orgId)))) {
        throw new HttpError(403, 'not_member', 'Not a member of this organization');
    }
    res.json(await teamsNotes.getOrgSettings(orgId));
});

router.put('/:orgId', requireAuth, validate({ body: SettingsBody }), async (req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdmin(req, orgId))) {
        throw new HttpError(403, 'not_org_admin', 'Only organization admins can manage these settings');
    }
    const config = await teamsNotes.saveOrgSettings(orgId, req.body, req.session.user.id);
    res.json({ ok: true, config });
});

module.exports = router;
