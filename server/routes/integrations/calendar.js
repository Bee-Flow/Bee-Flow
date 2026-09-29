/**
 * Calendar API routes — execute calendar actions after user approval
 * Handles both Google Calendar and Microsoft Calendar (via _provider field).
 */
const express = require('express');
const router = express.Router();
const { executeCalendarAction } = require('../../integrations/calendarTools');
const { executeMsCalendarAction } = require('../../integrations/msCalendarTools');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// The body is the approval card's draft, posted back verbatim — the object
// integrations/calendarTools.js or msCalendarTools.js built and the chat
// streamed to the browser. Two of its keys decide what actually happens, and
// both were read with a bare `===` against one spelling:
//
//   - `_provider` picks the calendar. ANYTHING that was not exactly
//     'microsoft' fell through to Google, so `_provider: 'Microsoft'` ran the
//     Google executor over a Microsoft draft: a delete went looking for
//     `eventId` in the wrong calendar, and a create landed a Google event the
//     user had approved in Outlook — both under a 200.
//   - `action` reached the executor unchecked, where an unknown value threw a
//     bare Error and surfaced as a generic 500.
//
// The key set is `.strict()` over the union of both providers' draft
// builders — `addGoogleMeet` only ever comes from Google, `isOnlineMeeting`
// only from Microsoft — so one schema covers both cards.
//
// The session gate stays AHEAD of the schema: an unauthenticated caller must
// still read 401, not a 400 about its body.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const text = (what) => worded(`${what} must be text.`).nullish();

const ACTION_TEXT = 'action is create, update or delete.';
const PROVIDER_TEXT = '_provider is google or microsoft.';

const CalendarAction = z.object({
    action: z.enum(['create', 'update', 'delete'], { errorMap: () => ({ message: ACTION_TEXT }) }),
    _provider: z.enum(['google', 'microsoft'], { errorMap: () => ({ message: PROVIDER_TEXT }) }).optional(),

    eventId: text('eventId'),
    title: text('title'),
    startTime: text('startTime'),
    endTime: text('endTime'),
    timeZone: text('timeZone'),
    description: text('description'),
    location: text('location'),
    attendees: text('attendees'),
    allDay: z.boolean({ invalid_type_error: 'allDay is true or false.' }).nullish(),
    addGoogleMeet: z.boolean({ invalid_type_error: 'addGoogleMeet is true or false.' }).nullish(),
    isOnlineMeeting: z.boolean({ invalid_type_error: 'isOnlineMeeting is true or false.' }).nullish(),
}).strict().superRefine((v, ctx) => {
    if (v.action === 'create' && !v.startTime) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'A new event needs a start time.' });
    }
    if (v.action !== 'create' && !v.eventId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['eventId'], message: 'eventId says which event to change.' });
    }
});

const requireOAuthSession = (req, res, next) => {
    if (!req.session?.accessToken) return res.status(401).json({ error: 'Not authenticated' });
    next();
};

/**
 * POST /api/integrations/calendar/execute
 * Execute a calendar action (create/update/delete) after user approval.
 * Routes to Google or Microsoft calendar based on _provider field.
 */
router.post('/execute', requireOAuthSession, validate({ body: CalendarAction }), async (req, res) => {
    const action = req.body;

    let result;
    if (action._provider === 'microsoft') {
        result = await executeMsCalendarAction(action.action, action, req.session);
    } else {
        result = await executeCalendarAction(action, req.session);
    }
    res.json(result);
});

module.exports = router;
