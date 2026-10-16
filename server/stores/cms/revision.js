// @typecheck
// Optimistic concurrency for CMS documents (PageDoc, SiteDoc): every stored
// document carries an integer `rev`. A write that names the rev it was based on
// is refused with 409 when somebody else saved in between, instead of silently
// replacing their work. The check and the write share one locked transaction
// (configStore.mutateConfig), so two writers can never both pass it.

const { HttpError } = require('../../shared/httpErrors');
const log = require('../../telemetry/log');
const { isPlainObject } = require('./shared');

const CONFLICT_CODE = 'cms_conflict';
const REV_REQUIRED_CODE = 'cms_rev_required';

/**
 * @param {any} doc a stored document (or null)
 * @returns {number} its revision; 0 for documents saved before revisions existed
 */
function revOf(doc) {
    return isPlainObject(doc) && Number.isInteger(doc.rev) && doc.rev >= 0 ? doc.rev : 0;
}

/** @param {string} what e.g. "page" or "site" */
function conflictError(what) {
    return new HttpError(
        409,
        CONFLICT_CODE,
        `This ${what} was changed elsewhere since you opened it. Reload to get the latest version, then make your change again.`,
    );
}

/** @param {string} what */
function revRequiredError(what) {
    return new HttpError(
        428,
        REV_REQUIRED_CODE,
        `Saving this ${what} needs the revision you based it on. Reload and try again.`,
    );
}

/**
 * The revision a client says its edit is based on.
 *
 * Soft path for ONE release (an editor tab opened before the deploy runs the
 * old bundle and sends none): a missing revision writes without the check and
 * logs a warning (route and site id only). TODO(next release): make this a hard
 * 428 again (`throw revRequiredError(what)`), see the release note.
 * @param {unknown} raw
 * @param {string} what
 * @param {{ route: string, siteId: string }} ctx
 * @returns {number | undefined} undefined = unchecked write
 */
function clientRev(raw, what, ctx) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
    log.warn(`[CMS] ${what} saved without a revision (old editor bundle): ${ctx.route} site=${ctx.siteId}`);
    return undefined;
}

/**
 * The revision check of a versioned write, for use INSIDE the locked
 * transaction that also writes (configStore.withConfigGroup or mutateConfig).
 * With no `expectedRev` nothing is checked. With one, the stored document must
 * still exist (a write must never recreate a document deleted meanwhile) and
 * be at that revision.
 * @param {any} stored the document as read under the lock
 * @param {number | undefined} expectedRev
 * @param {string} what e.g. "page" or "site"
 */
function assertRevMatches(stored, expectedRev, what) {
    if (expectedRev === undefined) return;
    if (!isPlainObject(stored)) {
        throw new HttpError(404, 'cms_gone', `This ${what} was deleted while you were editing it. Reload to see the current state.`);
    }
    if (revOf(stored) !== expectedRev) throw conflictError(what);
}

module.exports = {
    CONFLICT_CODE, REV_REQUIRED_CODE, revOf, conflictError, clientRev, revRequiredError, assertRevMatches,
};
