// @typecheck
/**
 * A form whose automation runs on the submitter's OWN connections
 * (runPolicy.connections = 'caller') cannot show the one-time notice to a
 * visitor: the dialog and its acknowledgement belong to people who may run the
 * automation. Public forms are system starts (a visitor, signed in or not, runs
 * like an anonymous one, on the owner's connections); a members-only form has
 * its signed-in submitter as the starter, and until that person has confirmed
 * the notice the submission is refused here, with a sentence that says what to
 * do, before anything is recorded.
 */

'use strict';

const { HttpError } = require('../core/http/errors');
const { describeNoticeFor } = require('../core/automationRunner/callerNotice');

/**
 * @param {{ automation: { id: string, userId?: string, definition?: object }, submitterId: string|null,
 *           store: { getCallerNoticeAck: (u: string, a: string) => Promise<string[]|null> } }} args
 */
async function assertFormStartAllowed({ automation, submitterId, store }) {
    if (!submitterId) return;
    const notice = await describeNoticeFor({ automation: /** @type {any} */ (automation), userId: submitterId, store });
    if (notice.applies && !notice.seen) {
        throw new HttpError(409, 'caller_notice_required',
            'This form runs with your own connections, and you have not confirmed which ones yet. Ask the owner to give you the Run right on the automation, open it once and confirm, then fill in the form again.');
    }
}

module.exports = { assertFormStartAllowed };
