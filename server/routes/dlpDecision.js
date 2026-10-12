/**
 * DLP decision endpoint — receives the user's choice (redact / block / allow)
 * from the client modal and unblocks the paused chat stream.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `{ decisionId, choice, rememberForConversation?, manualAdditions? }`,
 * `.strict()`, and every field typed. Two of them used to be read in a way
 * that let personal data out:
 *
 *   - `rememberForConversation` was read as `!!value`, so the STRING "false"
 *     meant yes. Remembering an 'allow' makes dlpRunner skip the question for
 *     every later message in the conversation, so a client that serialised
 *     its checkbox as text sent everything that followed raw, without asking.
 *   - a manual mark whose offset or length was not a whole number was dropped
 *     from `manualAdditions` without a word, and the redaction then went ahead
 *     WITHOUT it — the text the person had marked left unredacted, under a
 *     200 `{ ok: true }`. A list over the cap lost its tail the same way.
 *
 * Refusing is the safe answer here: the stream keeps waiting, and a decision
 * that never arrives times out as a block (dlpPreflight, fail-closed).
 */

const express = require('express');
const router = express.Router();
const decisionQueue = require('../core/dlp/decisionQueue');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// Cap: this is UI-driven text selection, not a bulk API — a legitimate
// review never produces hundreds of manual marks in one message.
const MAX_MANUAL_ADDITIONS = 200;

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A whole number with one sentence for every way it can be wrong. */
const whole = (message, min) => z.number({ required_error: message, invalid_type_error: message })
    .int(message).min(min, message);

const BODY_TEXT = 'Send the decision as { decisionId, choice }.';
const DECISION_TEXT = 'decisionId is the id of the decision the chat is waiting on.';
const CHOICE_TEXT = 'choice is "redact", "block" or "allow".';
const REMEMBER_TEXT = 'rememberForConversation is true or false.';
const MARKS_TEXT = `manualAdditions is a list of at most ${MAX_MANUAL_ADDITIONS} marks, each { offset, length }.`;

// Only offset/length ever leave the client's selection and reach here — the
// actual substring is re-sliced server-side from the text this decision was
// raised against (see dlpPreflight.js), so a forged `text` field can't smuggle
// something into the redaction that wasn't actually in the message.
const ManualMark = z.object({
    offset: whole('A mark\'s offset is a whole number, 0 or more.', 0),
    length: whole('A mark\'s length is a whole number, 1 or more.', 1),
}, { invalid_type_error: MARKS_TEXT }).strict();

const DecisionBody = z.object({
    decisionId: worded(DECISION_TEXT).trim().min(1, DECISION_TEXT),
    choice: z.enum(['redact', 'block', 'allow'], { errorMap: () => ({ message: CHOICE_TEXT }) }),
    rememberForConversation: z.boolean({ invalid_type_error: REMEMBER_TEXT }).optional(),
    manualAdditions: z.array(ManualMark, { invalid_type_error: MARKS_TEXT })
        .max(MAX_MANUAL_ADDITIONS, MARKS_TEXT).optional(),
}, { required_error: BODY_TEXT, invalid_type_error: BODY_TEXT }).strict();

router.post('/', requireAuth, validate({ body: DecisionBody }), async (req, res) => {
    const { decisionId, choice, rememberForConversation, manualAdditions } = req.body;
    const ok = decisionQueue.resolve(decisionId, {
        choice,
        rememberForConversation: rememberForConversation === true,
        manualAdditions: manualAdditions || [],
    }, req.session.user.id);
    if (!ok) {
        return res.status(404).json({ error: 'Decision not found, expired, or not owned by this user.' });
    }
    res.json({ ok: true });
});

const TouchBody = z.object({
    decisionId: worded(DECISION_TEXT).trim().min(1, DECISION_TEXT),
}, { required_error: BODY_TEXT, invalid_type_error: BODY_TEXT }).strict();

// Heartbeat: the review UI POSTs here while it is open so a person editing
// their redaction is never expired mid-review (see decisionQueue.touch).
router.post('/touch', requireAuth, validate({ body: TouchBody }), async (req, res) => {
    const ok = decisionQueue.touch(req.body.decisionId, req.session.user.id);
    if (!ok) {
        return res.status(404).json({ error: 'Decision not found, expired, or not owned by this user.' });
    }
    res.json({ ok: true });
});

module.exports = router;
