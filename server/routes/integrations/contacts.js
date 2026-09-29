/**
 * Contacts API routes — execute contact actions after user approval
 * Handles both Google Contacts and Microsoft Contacts (via _provider field).
 */
const express = require('express');
const router = express.Router();
const { executeContactsAction } = require('../../integrations/contactsTools');
const { executeMsContactsAction } = require('../../integrations/msContactsTools');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// The body is the approval card's draft, posted back verbatim. `_provider`
// picks the address book and was read as `=== 'microsoft'`, so ANY other
// spelling fell through to Google — and the two executors do not read the
// same field names. A Microsoft draft that reached the Google executor
// (`_provider: 'Microsoft'`, one capital) created a contact from
// `action.firstName`, which a Graph-shaped draft does not have: an EMPTY
// contact in the wrong address book, answered 200 with
// `Contact "undefined" created!`.
//
// The key set is `.strict()` over the union of both draft builders —
// firstName/lastName/email/company/notes/resourceName from Google's,
// givenName/surname/emailAddress/companyName/contactId from Microsoft's — so
// one schema covers both cards. Which set belongs to which provider is left
// to the executors, exactly as before.
//
// The session gate stays AHEAD of the schema: an unauthenticated caller must
// still read 401, not a 400 about its body.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const text = (what) => worded(`${what} must be text.`).nullish();

const ACTION_TEXT = 'action is create or update.';
const PROVIDER_TEXT = '_provider is google or microsoft.';

const ContactsAction = z.object({
    action: z.enum(['create', 'update'], { errorMap: () => ({ message: ACTION_TEXT }) }),
    _provider: z.enum(['google', 'microsoft'], { errorMap: () => ({ message: PROVIDER_TEXT }) }).optional(),

    // Google (people API) shape
    resourceName: text('resourceName'),
    firstName: text('firstName'),
    lastName: text('lastName'),
    email: text('email'),
    company: text('company'),
    notes: text('notes'),

    // Microsoft (Graph) shape
    contactId: text('contactId'),
    givenName: text('givenName'),
    surname: text('surname'),
    emailAddress: text('emailAddress'),
    companyName: text('companyName'),

    // Spelled the same on both sides
    phone: text('phone'),
    jobTitle: text('jobTitle'),
}).strict();

const requireOAuthSession = (req, res, next) => {
    if (!req.session?.accessToken) return res.status(401).json({ error: 'Not authenticated' });
    next();
};

/**
 * POST /api/integrations/contacts/execute
 * Execute a contacts action (create/update) after user approval.
 * Routes to Google or Microsoft contacts based on _provider field.
 */
router.post('/execute', requireOAuthSession, validate({ body: ContactsAction }), async (req, res) => {
    const action = req.body;

    let result;
    if (action._provider === 'microsoft') {
        result = await executeMsContactsAction(action.action, action, req.session);
    } else {
        result = await executeContactsAction(action, req.session);
    }
    res.json(result);
});

module.exports = router;
