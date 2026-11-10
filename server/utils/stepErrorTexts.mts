/**
 * stepErrorTexts.mts: the English title and cause of every step-error code
 * (utils/stepErrorInfo.js builds the card from these; the i18n keys are
 * `automations.step_error.<code>.title|cause|cause_generic`).
 *
 * `cause` uses every param it names; `causeGeneric` is the variant for when
 * the param in `need` is unknown (no path in the step's settings, no field in
 * the message). {service} and {app} are always filled.
 *
 * A text added or reworded here changes server/i18n/defaults/en/automations.js
 * and its Dutch (migrations/data/builder-handoff5-nl.json) with it; the test
 * next to stepErrorInfo.js compares this table with the English dictionary.
 */

export interface StepErrorText {
    title: string;
    cause: string;
    causeGeneric?: string;
    /** The param `cause` cannot do without; `causeGeneric` is used when it is missing. */
    need?: string;
}

export const TEXTS: Readonly<Record<string, StepErrorText>> = Object.freeze({
    nextcloud_no_access: {
        title: 'Bee may not open this folder',
        cause: 'The account this step uses cannot open or change {folder}. Share the folder with that account, or pick an account that can. A read-only share, a team folder permission or an access rule in Nextcloud can also block it.',
        causeGeneric: 'The account this step uses cannot open or change this file or folder. Share it with that account, or pick an account that can. A read-only share, a team folder permission or an access rule in Nextcloud can also block it.',
        need: 'folder',
    },
    nextcloud_not_found: {
        title: 'Bee cannot find this file or folder',
        cause: 'Nothing was found at {target}. It may have been moved, renamed or deleted.',
        causeGeneric: 'The file or folder this step points at was not found. It may have been moved, renamed or deleted.',
        need: 'target',
    },
    nextcloud_parent_missing: {
        title: 'The folder to save in does not exist',
        cause: 'The folder that should hold {target} does not exist yet. Create it first, or pick another location.',
        causeGeneric: 'The folder this step saves into does not exist yet. Create it first, or pick another location.',
        need: 'target',
    },
    nextcloud_already_exists: {
        title: 'Something with this name already exists',
        cause: '{target} already exists. Pick another name or location.',
        causeGeneric: 'A file or folder with this name already exists. Pick another name or location.',
        need: 'target',
    },
    nextcloud_not_connected: {
        title: 'Nextcloud is not connected',
        cause: 'The account this step runs as has no Nextcloud connection. Connect Nextcloud and try again.',
    },
    nextcloud_session_expired: {
        title: 'The Nextcloud sign-in has expired',
        cause: 'Bee can no longer sign in to Nextcloud for the account this step uses. Reconnect Nextcloud and try again.',
    },
    nextcloud_app_disabled: {
        title: '{app} is not available in Nextcloud',
        cause: '{app} is not enabled for the account this step uses, or it needs an app password. Ask your Nextcloud admin to enable it.',
    },
    nextcloud_unreachable: {
        title: 'Bee could not reach Nextcloud',
        cause: 'Nextcloud or the Bee Flow connector did not respond. Check that Nextcloud is up, then try again.',
    },
    nextcloud_maintenance: {
        title: 'Nextcloud is in maintenance mode',
        cause: 'Nextcloud is being maintained or upgraded and handles no requests for now. Try again when that is finished.',
    },
    nextcloud_unavailable: {
        title: 'Nextcloud is temporarily unavailable',
        cause: 'Nextcloud cannot handle requests right now. That can be maintenance, an upgrade or a busy server. Try again in a moment.',
    },
    nextcloud_proxy_answered: {
        title: 'A proxy in front of Nextcloud stopped this step',
        cause: 'The answer came from a proxy or CDN in front of Nextcloud, not from Nextcloud itself. Ask your Nextcloud admin to check its firewall rules and upload limit for the Bee Flow calls.',
    },
    nextcloud_file_locked: {
        title: 'This file is locked in Nextcloud',
        cause: '{target} is open in an editor or locked by someone else. Try again later, or ask them to unlock it.',
        causeGeneric: 'The file is open in an editor or locked by someone else. Try again later, or ask them to unlock it.',
        need: 'target',
    },
    nextcloud_quota_exceeded: {
        title: 'Nextcloud has no room for this file',
        cause: 'There is not enough storage left in Nextcloud to save {target}. Free up space, or ask your Nextcloud admin for a larger quota.',
        causeGeneric: 'There is not enough storage left in Nextcloud for this file. Free up space, or ask your Nextcloud admin for a larger quota.',
        need: 'target',
    },
    not_connected: {
        title: '{service} is not connected',
        cause: 'The account this step runs as has no {service} connection. Connect it and try again.',
    },
    auth_expired: {
        title: 'The {service} sign-in has expired',
        cause: 'Bee can no longer sign in to {service} for the account this step uses. Reconnect and try again.',
    },
    permission_denied: {
        title: 'Bee may not do this in {service}',
        cause: 'The account this step uses has no permission for this action. Pick an account that has, or ask for access.',
    },
    not_found: {
        title: 'Bee cannot find what this step points at',
        cause: '{service} could not find {target}. It may have been moved or deleted.',
        causeGeneric: '{service} could not find the item this step points at. It may have been moved or deleted.',
        need: 'target',
    },
    missing_field: {
        title: 'A required setting is empty',
        cause: 'The setting "{field}" needs a value before this step can run.',
        causeGeneric: 'A setting this step needs is empty. Fill in the highlighted setting.',
        need: 'field',
    },
    validation: {
        title: 'A setting has a value this step cannot use',
        cause: '{service} did not accept the value of "{field}". Check that setting and try again.',
        causeGeneric: '{service} did not accept a value from this step. Check the step settings and try again.',
        need: 'field',
    },
    http_query_invalid: {
        title: 'The query parameters of this step cannot be used',
        cause: 'The "Query parameters" setting cannot be sent: {reason}',
        causeGeneric: 'The "Query parameters" setting of this step cannot be sent. Open the step and check it.',
        need: 'reason',
    },
    http_url_invalid: {
        title: 'The address of this step is not a valid web address',
        cause: 'The "URL" setting cannot be used: {reason}',
        causeGeneric: 'The "URL" setting of this step is not a valid web address. Open the step and check it.',
        need: 'reason',
    },
    rate_limited: {
        title: 'Too many requests right now',
        cause: '{service} is limiting how often Bee may call it. Wait a moment, then try again.',
    },
    timeout: {
        title: 'This step took too long',
        cause: '{service} did not answer in time. Try again; if it keeps happening the service may be busy.',
    },
    provider_error: {
        title: '{service} had a problem',
        cause: '{service} answered with an error on its side. This is usually temporary, so try again in a moment.',
    },
    model_unavailable: {
        title: 'The AI model is not available',
        cause: 'The model this step uses cannot be found or is not set up. Pick another model for this step.',
    },
    model_quota: {
        title: 'The AI provider refused the request',
        cause: 'The account behind this model is out of credit or over its limit. Ask your admin to check the AI provider.',
    },
    model_context_too_long: {
        title: 'Too much text for the AI model',
        cause: 'This step sent more text than the model can read at once. Send less text, or use a model that reads more.',
    },
    model_refused: {
        title: 'The AI model declined this request',
        cause: 'The model would not answer this instruction. Rephrase the instruction and try again.',
    },
    guardrail_blocked: {
        title: 'The privacy shield stopped this step',
        cause: 'This step would have sent data that your organisation\'s privacy policy blocks.',
    },
    tool_not_permitted: {
        title: 'You may no longer use this app',
        cause: 'This step uses an app your organisation no longer allows for you. Pick another action, or ask your admin.',
    },
    unknown: {
        title: 'This step stopped with an error',
        cause: 'Bee got an error it does not recognise. The technical message has the details.',
    },
});
