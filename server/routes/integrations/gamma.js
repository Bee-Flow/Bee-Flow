/**
 * Gamma Integration Routes
 *
 * Small authenticated helpers for frontend previews. Generation itself still
 * happens through the AI tool dispatcher; this route only lets the UI poll
 * a known generationId without exposing the user's Gamma API key.
 */

const express = require('express');
const { executeGammaTool } = require('../../integrations/gammaTools');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');

// ── What a caller may send ──────────────────────────────────────────
//
// Only the path id, and it is concatenated into the Gamma API path. Gamma
// mints it as an opaque token, so the schema pins the CHARACTER SET rather
// than a format: an id with a slash or a dot segment in it would walk the
// upstream path even though gammaTools encodeURIComponent's it, and an empty
// one would ask Gamma for the whole collection.
const ID_TEXT = 'A Gamma generation id is required.';
const GenerationParams = z.object({
    generationId: z.string({ required_error: ID_TEXT, invalid_type_error: ID_TEXT })
        .regex(/^[A-Za-z0-9_-]{1,128}$/, 'That is not a Gamma generation id.'),
}).strict();

router.get('/generations/:generationId', requireAuth, validate({ params: GenerationParams }), async (req, res) => {
    const result = await executeGammaTool(
        'gamma_get_generation_status',
        { generationId: req.params.generationId },
        req.session.user.id,
    );

    if (result?.error) {
        return res.status(502).json(result);
    }

    res.json(result);
});

module.exports = router;
