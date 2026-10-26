// @typecheck strict
/**
 * The msgraph mail.new matcher (Outlook "New email"), next to filters.js
 * like filtersTables.js: pickMatcher hands it out.
 */

const { matchFilter } = require('../triggers/dslFilters');

/**
 * msgraph mail.new: `mailbox` is configuration (which inbox to watch), not a
 * payload field, with one guarantee on top: the own inbox's pushed
 * notification is fanned out to every msgraph mail.new row of that user
 * (dispatchEvent), and must never start an automation that watches a SHARED
 * mailbox. Every event names its mailbox ("me" from the webhook route, the
 * address from the poller), so a filter that names a mailbox only takes
 * events of that mailbox. A filter without one (the own inbox, or an any/none
 * entry of the DSL) leaves it open: a shared mailbox's events reach only its
 * own row anyway, the poller dispatches to that row alone.
 * The other keys keep the shallow exact-match semantics they always had.
 * @param {TriggerPayload} payload
 * @param {TriggerFilter} filter
 */
function matchMsGraphMailFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return matchFilter(payload, null);
    const { mailbox: _mailbox, ...rest } = filter;
    if (Object.prototype.hasOwnProperty.call(filter, 'mailbox')) {
        const { parseMailbox } = require('../../core/integrations/outlookMailbox.mts');
        let want;
        let got;
        try {
            want = parseMailbox(filter.mailbox);
            got = parseMailbox(payload?.mailbox);
        } catch {
            return false;
        }
        if (want.shared !== got.shared) return false;
        if (want.shared && got.shared && want.address !== got.address) return false;
    }
    return matchFilter(payload, Object.keys(rest).length ? rest : null);
}

module.exports = { matchMsGraphMailFilter };

/** @typedef {Record<string, any>} TriggerPayload  an event payload: loose provider JSON */
/** @typedef {Record<string, any>} TriggerFilter  a trigger's filter as authored */
