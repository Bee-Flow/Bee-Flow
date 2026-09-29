/**
 * GET /api/compliance/calendar[?all=1] — the regulatory calendar.
 *
 *   → { milestones:[{ id, date|null, framework_id, kind, label_key, detail_key,
 *                     relevant, affects|null, expected }], today_hint: null }
 *
 * Default: relevant + uncertain milestones; `all=1` returns every milestone
 * with its `relevant` flag. The today marker is drawn client-side. Read from
 * compliance/calendar.js (60 s memo per org). Org-strict.
 */

'use strict';

const express = require('express');
const router = express.Router();

const calendar = require('../../compliance/calendar');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const ALL_TEXT = 'all is one of: 1, 0, true, false.';
/** `?all=yes` used to read as "only the relevant ones", quietly. */
const CalendarQuery = z.object({
    all: z.enum(['1', '0', 'true', 'false'], { errorMap: () => ({ message: ALL_TEXT }) }).optional(),
}).strict();

router.get('/calendar', requireAuth, requirePermission('admin_compliance'), validate({ query: CalendarQuery }), async (req, res) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    res.set('Cache-Control', 'private, no-store');
    const all = req.query.all === '1' || req.query.all === 'true';
    const milestones = await calendar.list(orgId, { all, req });
    res.json({ milestones, today_hint: null });
});

module.exports = router;
