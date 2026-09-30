/**
 * Turn whatever was thrown into words a person can act on.
 *
 * Pure knowledge about the API's refusals: which status means what, which body
 * codes change the story, and when the server's own sentence is worth showing.
 * It lives next to the client that produces ApiError so the UI kit (ErrorState,
 * Banner call sites) only renders the answer.
 */

import { translate } from '@/core/i18n';

import { ApiError, OfflineError } from './client';

export interface DescribedError {
    title: string;
    message: string;
    /** False for a settled answer (402, 403, 404) that a retry would repeat. */
    retryable: boolean;
}

/**
 * The machine-readable code the server sent, or ''.
 *
 * `ApiError.code` reads it off the parsed body (client.ts): `body.code`, else a
 * code-shaped `body.error` such as `training_required`. A body that is a string,
 * an array, or absent answers '' and every caller falls through to the
 * status-only branch.
 */
export function errorCode(error: ApiError): string {
    return error.code ?? '';
}

/**
 * The sentence the SERVER wrote, or '' when it wrote none.
 *
 * The client synthesises `HTTP 404` as the message whenever the body carried no
 * `error`/`message`. That placeholder is not a sentence anybody should read, so
 * it is filtered out here, once. A bare code (`{ error: 'not_found' }`) is not
 * one either: a person is better served by the fallback.
 */
function serverSentence(error: ApiError): string {
    const message = (error.message || '').trim();
    if (message && message === error.code) return '';
    return /^HTTP \d{3}$/.test(message) ? '' : message;
}

/**
 * A 403 has three stories, told apart by the body's code: a required course
 * (server/learning/requireTraining.js) the phone cannot host, a row that is
 * visible but `not_editable` (server/routes/skills.js), and the plan refusal
 * everything else is.
 *
 * The course is taken "on a computer", not "on the web": the phone's own
 * browser gets the web at phone width, which hides the Learning Center.
 */
function describeForbidden(error: ApiError): DescribedError {
    if (errorCode(error) === 'training_required') {
        return {
            title: translate('mobile.error.training_required_title', 'Training required'),
            message: translate(
                'mobile.error.training_on_computer_message',
                'Your organisation requires a short training before you can do this. Complete it in Bee Flow on a computer.',
            ),
            retryable: false,
        };
    }
    if (errorCode(error) === 'not_editable') {
        return {
            title: translate('mobile.error.not_editable_title', 'Not yours to edit'),
            message:
                serverSentence(error) ||
                translate(
                    'mobile.error.not_editable_message',
                    'You can open this, but only its owner — or an administrator in the organisation it belongs to — can change it.',
                ),
            retryable: false,
        };
    }
    return {
        title: translate('mobile.error.plan_access_title', 'Not available on your plan'),
        message:
            serverSentence(error) ||
            translate('mobile.error.plan_access_message', 'Ask an administrator if you need access to this.'),
        retryable: false,
    };
}

/**
 * The rule everywhere below: when the server wrote a specific sentence, show it
 * and keep the generic one as the fallback. A status code is a category, not an
 * explanation — a 402 is a plan limit, not a crash, and a 404 is not always
 * "it is gone" (routes answer it for "not yours" and "wrong knowledge base").
 */
function describeApiError(error: ApiError): DescribedError {
    if (error.status === 402) {
        return {
            title: translate('mobile.error.plan_limit_title', 'Plan limit reached'),
            message:
                serverSentence(error) ||
                translate(
                    'mobile.error.plan_limit_message',
                    'Your organisation has used its allowance for this period.',
                ),
            retryable: false,
        };
    }
    if (error.status === 403) return describeForbidden(error);
    if (error.status === 404) {
        return {
            title: translate('error.not_found', 'Not found'),
            message:
                serverSentence(error) ||
                translate('mobile.error.not_found_message', 'This item no longer exists.'),
            retryable: false,
        };
    }
    if (error.status && error.status >= 500) {
        return {
            title: translate('mobile.error.server_title', 'The server had a problem'),
            message: translate(
                'mobile.error.server_message',
                'This is not something you did. Try again in a moment.',
            ),
            retryable: true,
        };
    }
    return {
        title: translate('mobile.error.generic_title', 'That did not work'),
        message: error.message,
        retryable: true,
    };
}

export function describeError(error: unknown): DescribedError {
    if (error instanceof OfflineError) {
        return {
            title: translate('mobile.error.offline_title', 'You are offline'),
            message: translate(
                'mobile.error.offline_message',
                'Bee Flow will pick up where you left off once you are back on a network.',
            ),
            retryable: true,
        };
    }
    if (error instanceof ApiError) return describeApiError(error);
    return {
        title: translate('mobile.error.unknown_title', 'Something went wrong'),
        message: (error as Error)?.message || translate('mobile.error.unknown_message', 'Try again.'),
        retryable: true,
    };
}
