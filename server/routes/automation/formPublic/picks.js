/**
 * `app_pick` questions on a hosted form: who is searching (always the
 * signed-in FILLER, never the automation's owner), which declared question a
 * request is about, and turning picked references into the records the run
 * reads. The search route itself is in page.js.
 */

const { describePick } = require('../../../automation/formPickRecord');
const log = require('../../../telemetry/log');

/**
 * Replace every `app_pick` answer with the record it points at, read as the
 * FILLER right now.
 *
 * Runs at both claim sites through this one function, for the same reason
 * describeClaimedUpload does: a record picked on page two must read exactly
 * like one picked on page one.
 *
 * Reads are made in sequence rather than in parallel — a form asking for five
 * transcripts should not open five upstream calls at once while the filler's
 * browser holds the submit request open.
 *
 * Never fails the submission. A record that cannot be read arrives carrying
 * `textError`, and the automation decides what that means.
 */
async function resolvePicks(picks, values, req) {
    if (!picks.length) return;
    const caller = await pickCaller(req);
    for (const { field, index, multiple, withText, pick } of picks) {
        const described = caller
            ? await describePick(pick, { withText, caller })
            // No signed-in filler (only reachable if PUBLIC_FORMS_ENABLED is
            // flipped back on): keep the reference, refuse the read. Falling
            // back to the author's credentials here would hand an anonymous
            // visitor a window on the author's mailbox.
            : { ...pick, textError: 'Records can only be read for a signed-in person.' };
        if (multiple) {
            if (Array.isArray(values[field])) values[field][index] = described;
        } else {
            values[field] = described;
        }
    }
}

/**
 * Who is searching. Everything in here is the SIGNED-IN FILLER — never the
 * automation's owner. An `app_pick` question shows the person in front of the form
 * the records THEY can open; building this context from the automation would
 * turn a form into a window on a colleague's mailbox.
 */
async function pickCaller(req) {
    const user = req.session?.user;
    if (!user?.id) return null;
    // The same org/group read the Meeting-notes library does, so the internal
    // source's ACL is answered with exactly the context it expects.
    const { resolveAccessContext } = require('../../transcriptions/shared');
    let access = { orgIds: [], userGroupIds: [], isSuperAdmin: false };
    try { access = await resolveAccessContext(req); } catch (err) { log.debug('narrower, never wider', err); }
    return {
        userId: user.id,
        session: req.session,
        isAdmin: !!req.session?.isAdmin,
        orgId: user.organizationId || null,
        orgIds: access.orgIds,
        userGroupIds: access.userGroupIds,
        isSuperAdmin: access.isSuperAdmin,
    };
}

/**
 * The declared `app_pick` field this request is about, resolved from the page
 * the filler is actually on.
 *
 * The browser sends a FIELD NAME, never a source and never a tool. The source
 * comes from the declaration, so the picker cannot be steered at an app the
 * question does not ask for — which is what makes this endpoint a picker rather
 * than "run an integration tool as me".
 */
function declaredPickField(fields, name) {
    return fields.find(f => f.type === 'app_pick' && f.name === String(name || '')) || null;
}

module.exports = { resolvePicks, pickCaller, declaredPickField };
