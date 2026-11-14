// @typecheck strict
/**
 * The two refusal texts the cowork request schemas and the event-trigger use
 * case both answer with.
 */

'use strict';

const TRIGGER_TEXT = "trigger is { provider: 'gmail' | 'msgraph', event: 'mail.new', filter?: object }, or null.";
const NEXT_RUN_TEXT = 'nextRunAt is required: an ISO timestamp with a time zone, like 2026-09-23T07:00:00.000Z.';

module.exports = { TRIGGER_TEXT, NEXT_RUN_TEXT };
