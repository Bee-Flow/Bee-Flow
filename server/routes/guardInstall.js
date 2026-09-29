/**
 * Admin routes for installing / uninstalling the optional PII guard service.
 * Mounted at /api/admin/guard.
 *
 * All endpoints require the `admin_security` permission (same bar as the
 * Guardrails panel that hosts the install card in the UI).
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { requirePermission } = require('../auth/permissions');
const installer = require('../services/guardInstaller');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// Both bodies are `.strict()`: the installer is fire-and-forget (202, then
// the work happens in the background), so a request it misread could only
// ever be discovered afterwards, in the containers.
//
//   - `removeVolume: "false"` is a truthy string, so the uninstall DELETED the
//     Redis cache volume the caller had just asked it to keep;
//   - a misspelled `modle` installed the default model, answered 202;
//   - a model or key with whitespace in it went into the container's env and
//     the X-API-Key header as-is, where it can only fail later.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the request as a JSON object.' }).strict(),
);

const KEY_TEXT = 'apiKey is the key the guard service will require: text without spaces.';
const MODEL_TEXT = 'model is a model id, like E3-JSI/gliner-multi-pii-domains-v1.';
const InstallBody = bodyOf({
    apiKey: worded(KEY_TEXT).trim().regex(/^\S*$/, KEY_TEXT).max(512, KEY_TEXT).optional(),
    model: worded(MODEL_TEXT).trim().regex(/^\S+$/, MODEL_TEXT).max(200, MODEL_TEXT).optional(),
});
const UninstallBody = bodyOf({
    removeVolume: z.boolean({ invalid_type_error: 'removeVolume is true or false.' }).optional(),
});

router.use(requirePermission('admin_security'));

router.get('/status', async (_req, res) => {
    const status = await installer.getStatus();
    res.json(status);
});

router.post('/install', express.json(), validate({ body: InstallBody }), async (req, res, next) => {
    const { apiKey, model } = req.body;
    try {
        installer.install({ apiKey, model });
        res.status(202).json({ status: 'installing' });
    } catch (err) {
        if (err.code === 'UNSUPPORTED_ENV') return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === 'IN_PROGRESS') return res.status(409).json({ error: err.message, code: err.code });
        log.error('[guardInstall] install error:', err);
        next(err);
    }
});

router.post('/uninstall', express.json(), validate({ body: UninstallBody }), async (req, res, next) => {
    const { removeVolume = false } = req.body;
    try {
        installer.uninstall({ removeVolume });
        res.status(202).json({ status: 'uninstalling' });
    } catch (err) {
        if (err.code === 'UNSUPPORTED_ENV') return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === 'IN_PROGRESS') return res.status(409).json({ error: err.message, code: err.code });
        log.error('[guardInstall] uninstall error:', err);
        next(err);
    }
});

module.exports = router;
