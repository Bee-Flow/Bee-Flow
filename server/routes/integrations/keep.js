/**
 * Google Keep API routes — execute Keep actions after user approval
 */
const express = require('express');
const router = express.Router();
const { executeKeepAction } = require('../../integrations/keepTools');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// The body is the approval card's draft, posted back verbatim. `type` is the
// key that decided what the note became, through
// `action.type === 'list' && action.listItems`: any other value — `'List'`,
// or `type` dropped by a client that only kept the fields it renders —
// silently took the text branch, so an approved checklist was created as a
// note reading `action.content || ''`, i.e. EMPTY, under a 200 saying
// `Note "…" created!`. The checklist is gone and nothing says so.
//
// `.strict()` covers the other half: `listItems` misspelled produced the same
// empty note.
//
// The session gate stays AHEAD of the schema: an unauthenticated caller must
// still read 401, not a 400 about its body.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const ACTION_TEXT = 'action is create or delete.';
const TYPE_TEXT = 'type is text or list.';

const KeepAction = z.object({
    action: z.enum(['create', 'delete'], { errorMap: () => ({ message: ACTION_TEXT }) }),
    type: z.enum(['text', 'list'], { errorMap: () => ({ message: TYPE_TEXT }) }).optional(),
    title: worded('title must be text.').nullish(),
    content: worded('content must be text.').nullish(),
    listItems: z.array(z.object({
        text: worded('A list item needs text.'),
        checked: z.boolean({ invalid_type_error: 'checked is true or false.' }).optional(),
    }).strict()).nullish(),
    noteId: worded('noteId must be text.').nullish(),
}).strict().superRefine((v, ctx) => {
    if (v.action === 'delete' && !v.noteId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['noteId'], message: 'noteId says which note to delete.' });
    }
    if (v.type === 'list' && !v.listItems) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['listItems'], message: 'A checklist needs its items.' });
    }
});

const requireOAuthSession = (req, res, next) => {
    if (!req.session?.accessToken) return res.status(401).json({ error: 'Not authenticated with Google' });
    next();
};

/**
 * POST /api/integrations/keep/execute
 * Execute a Keep action (create/delete) after user approval.
 */
router.post('/execute', requireOAuthSession, validate({ body: KeepAction }), async (req, res) => {
    const result = await executeKeepAction(req.body, req.session);
    res.json(result);
});

module.exports = router;
