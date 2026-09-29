/**
 * The ONE error shape a mirror answers with, whoever asked — the Nextcloud
 * flavour of ../mirror/errors.SourceError, which explains the three callers
 * (status + code for the routes, errorClass for the runner, `safe` for the
 * App Studio refusal) every refusal has to satisfy.
 *
 * `ncTableId` stays a property of its own (the linking dialog marks the row
 * it is about by it) and is mirrored into the generic `ref` so a caller that
 * knows only SourceError finds it there too. The name is what
 * isNextcloudSourceError checks — kept, so the integration fake that sets
 * `e.name = 'NextcloudSourceError'` keeps passing for one.
 */

'use strict';

const { SourceError, registerErrorClasses, MAX_DETAIL } = require('../mirror/errors');

class NextcloudSourceError extends SourceError {
    constructor(status, code, message, { errorClass = null, ncTableId = null, detail = null } = {}) {
        super(status, code, message, {
            errorClass: errorClass || ERROR_CLASS[code] || null,
            detail,
            ref: ncTableId !== null ? { ncTableId } : null,
        });
        this.name = 'NextcloudSourceError';
        if (ncTableId !== null) this.ncTableId = ncTableId;
    }
}

const ERROR_CLASS = Object.freeze({
    nextcloud_forbidden: 'datatable_forbidden',
    nc_scope_denied: 'datatable_forbidden',
    nextcloud_integration_off: 'datatable_forbidden',
    not_nc_org: 'datatable_forbidden',
    nextcloud_not_found: 'datatable_not_found',
    nextcloud_rejected: 'datatable_source_rejected',
    nextcloud_unavailable: 'datatable_source_unavailable',
    linker_unavailable: 'datatable_source_unavailable',
    nc_instance_changed: 'datatable_source_unavailable',
    derived_column: 'datatable_source_rejected',
    nextcloud_write_unsupported: 'datatable_source_rejected',
});

registerErrorClasses(ERROR_CLASS);

/**
 * Translate what Nextcloud answered into the refusal a Bee Flow caller gets.
 * `what` names the thing being asked for ("row", "table 4") so the sentence
 * reads as one.
 */
function fromNcResponse(status, ncMessage, what = 'table', { ncTableId = null } = {}) {
    const detail = typeof ncMessage === 'string' ? ncMessage.trim().slice(0, MAX_DETAIL) : '';
    const tail = detail ? `: ${detail}` : '';
    if (status === 401) {
        return new NextcloudSourceError(503, 'nextcloud_unavailable',
            'The account that linked this table can no longer sign in to Nextcloud — ask an owner to re-link it.',
            { ncTableId });
    }
    if (status === 403) {
        return new NextcloudSourceError(403, 'nextcloud_forbidden',
            `Nextcloud refused: the account that linked this table may not use this ${what} there.`,
            { ncTableId });
    }
    if (status === 404) {
        return new NextcloudSourceError(404, 'nextcloud_not_found',
            `Nextcloud no longer has this ${what}.`, { ncTableId });
    }
    if (status === 400 || status === 422) {
        return new NextcloudSourceError(422, 'nextcloud_rejected',
            `Nextcloud did not accept this ${what}${tail}`, { ncTableId, detail });
    }
    if (status === 429 || status >= 500 || !status) {
        return new NextcloudSourceError(503, 'nextcloud_unavailable',
            `Nextcloud could not be reached (${status || 'no answer'})${tail}`, { ncTableId });
    }
    return new NextcloudSourceError(502, 'nextcloud_unavailable',
        `Nextcloud answered ${status} for this ${what}${tail}`, { ncTableId });
}

function isNextcloudSourceError(e) {
    return !!e && e.name === 'NextcloudSourceError';
}

module.exports = { NextcloudSourceError, ERROR_CLASS, fromNcResponse, isNextcloudSourceError, MAX_DETAIL };
