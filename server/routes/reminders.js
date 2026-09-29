/**
 * Reminder Routes — REST API for user-bound reminders.
 *
 * GET    /              → list user's reminders
 * POST   /              → create reminder
 * PUT    /:id           → update reminder
 * DELETE /:id           → delete reminder
 * POST   /:id/complete  → mark completed
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Every query and body is `.strict()`. The routes passed whatever arrived
 * straight to the store, and the store is not where a wrong value shows:
 *
 *   - `repeatInterval: "biweekly"` (or "hourly", "weekdays", "yearly" — the
 *     routine intervals the app offers elsewhere) was stored as given. The
 *     checker's advanceRemindAt knows daily, weekly and monthly only, so the
 *     reminder fired ONCE and was then marked completed: a repeating reminder
 *     silently turned into a one-off. The mobile sheet already refuses to
 *     offer those for exactly that reason; the server now says so too.
 *   - `?completed=1` listed the open reminders only — just 'true' counted.
 *   - `PUT /:id {"remind_at": …}` updated nothing and answered
 *     `{ success: false }` under a 200, and `{"title": ""}` blanked a title
 *     that POST would never have accepted.
 *   - `remindAt: "tomorrow"` and a numeric title were 500s from the database
 *     and from `.trim()`, not sentences.
 */

const express = require('express');
const router = express.Router();
const reminderStore = require('../stores/reminderStore');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const TITLE_TEXT = 'A reminder needs a title.';
const WHEN_TEXT = 'remindAt is a date and time with its zone, e.g. 2026-09-22T09:00:00.000Z.';
// Exactly the intervals reminderStore.advanceRemindAt can advance.
const INTERVAL_TEXT = 'repeatInterval is "daily", "weekly" or "monthly" — or null for once.';
const COMPLETED_TEXT = 'completed is "true" or "false".';

const title = worded(TITLE_TEXT).trim().min(1, TITLE_TEXT);
const message = worded('A reminder message must be text.').nullish();
const remindAt = worded(WHEN_TEXT).datetime({ offset: true, message: WHEN_TEXT });
const repeatInterval = z.enum(['daily', 'weekly', 'monthly'], { errorMap: () => ({ message: INTERVAL_TEXT }) }).nullish();

const ListQuery = z.object({
    completed: z.enum(['true', '1', 'false', '0'], { errorMap: () => ({ message: COMPLETED_TEXT }) }).optional(),
}).strict();

const CreateBody = z.object({ title, message, remindAt, repeatInterval }).strict();

const UpdateBody = z.object({ title: title.optional(), message, remindAt: remindAt.optional(), repeatInterval })
    .strict()
    .refine((b) => Object.keys(b).length > 0, 'Say what to change: title, message, remindAt or repeatInterval.');

/**
 * Every route here serves the caller's own reminders, so the session comes
 * first — an anonymous request is a 401 before its body is ever judged.
 */
function requireSignedIn(req, res, next) {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    return next();
}
router.use(requireSignedIn);

// GET / — list reminders
router.get('/', validate({ query: ListQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const includeCompleted = req.query.completed === 'true' || req.query.completed === '1';
    const reminders = await reminderStore.getReminders(userId, { includeCompleted });
    res.json(reminders);
});

// POST / — create reminder
router.post('/', validate({ body: CreateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { title, message, remindAt, repeatInterval } = req.body;
    const reminder = await reminderStore.createReminder({
        userId,
        title,
        message,
        remindAt,
        repeatInterval,
    });
    res.json(reminder);
});

// PUT /:id — update reminder
router.put('/:id', validate({ body: UpdateBody }), async (req, res) => {
    const userId = req.session.user.id;

    // Verify ownership
    const existing = await reminderStore.getReminder(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const { title, message, remindAt, repeatInterval } = req.body;
    const ok = await reminderStore.updateReminder(req.params.id, {
        title, message, remindAt, repeatInterval,
    });
    res.json({ success: ok });
});

// DELETE /:id — delete reminder
router.delete('/:id', async (req, res) => {
    const userId = req.session.user.id;

    const existing = await reminderStore.getReminder(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const ok = await reminderStore.deleteReminder(req.params.id);
    res.json({ success: ok });
});

// POST /:id/complete — mark completed
router.post('/:id/complete', async (req, res) => {
    const userId = req.session.user.id;

    const existing = await reminderStore.getReminder(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const ok = await reminderStore.markCompleted(req.params.id);
    res.json({ success: ok });
});

module.exports = router;
