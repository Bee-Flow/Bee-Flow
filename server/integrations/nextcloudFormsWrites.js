// @typecheck strict
'use strict';
/**
 * The two multi-call Forms writes, apart from nextcloudFormsTools.js (which
 * only dispatches): adding a question with its options, and changing settings.
 */

/** @typedef {{ api: string, ncFetch: Function, authError: string, handle: Function, mapQuestion: Function, HEADERS: Record<string,string> }} FormsDeps */

/**
 * @param {FormsDeps} deps
 * @param {{ formId?: string, text?: string, type?: string, options?: unknown[], isRequired?: unknown, description?: string }} args
 */
async function addQuestion(deps, args) {
    const { api, ncFetch, authError, handle, mapQuestion, HEADERS } = deps;
    if (!args.formId) return { error: 'formId is required' };
    if (!args.text) return { error: 'text is required' };
    const type = args.type || 'short';
    const needsOptions = ['multiple', 'multiple_unique', 'dropdown'].includes(type);
    if (needsOptions && (!Array.isArray(args.options) || args.options.length === 0)) {
        return { error: `Question type "${type}" needs an "options" list.` };
    }

    const created = await handle(
        await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/questions`, {
            method: 'POST', headers: HEADERS, body: JSON.stringify({ type, text: args.text }),
        }),
        authError, 'question create',
    );
    if (created.error) return created;
    const question = created.data || {};
    if (!question.id) return { error: 'Nextcloud Forms did not return a question id' };

    const removeQuestion = async () => {
        // formId was checked at the top; the check does not reach into this closure.
        const url = `${api}/forms/${encodeURIComponent(/** @type {string} */ (args.formId))}/questions/${encodeURIComponent(question.id)}`;
        const cleaned = await ncFetch(url, { method: 'DELETE', headers: HEADERS });
        return cleaned.ok
            ? 'The half-built question was removed.'
            : `The half-built question (id ${question.id}) could not be removed; delete it in Forms.`;
    };

    // Properties that are not settable at create time.
    const keyValuePairs = {};
    if (args.isRequired !== undefined) keyValuePairs.isRequired = !!args.isRequired;
    if (args.description) keyValuePairs.description = args.description;
    if (Object.keys(keyValuePairs).length) {
        const patched = await handle(
            await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/questions/${encodeURIComponent(question.id)}`, {
                method: 'PATCH', headers: HEADERS, body: JSON.stringify({ keyValuePairs }),
            }),
            authError, 'question update',
        );
        if (patched.error) return { error: `${patched.error} ${await removeQuestion()}` };
    }

    const options = [];
    // needsOptions implies args.options is a non-empty array (refused above otherwise).
    for (const label of (needsOptions ? /** @type {unknown[]} */ (args.options) : [])) {
        const opt = await handle(
            await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}/questions/${encodeURIComponent(question.id)}/options`, {
                method: 'POST', headers: HEADERS, body: JSON.stringify({ optionTexts: [String(label)] }),
            }),
            authError, 'option create',
        );
        // Do not leave a question that looks finished but has no choices.
        if (opt.error) return { error: `${opt.error} ${await removeQuestion()}` };
        options.push(String(label));
    }

    return {
        success: true,
        question: mapQuestion({ ...question, ...keyValuePairs, text: args.text, type, options: options.map(text => ({ text })) }),
        options,
    };
}

/**
 * @param {FormsDeps} deps
 * @param {{ formId?: string, title?: string, description?: string, isAnonymous?: unknown, submitMultiple?: unknown,
 *   state?: unknown, submissionMessage?: string, expires?: string }} args
 */
async function updateSettings(deps, args) {
    const { api, ncFetch, authError, handle, HEADERS } = deps;
    if (!args.formId) return { error: 'formId is required' };
    const keyValuePairs = {};
    if (args.title !== undefined) keyValuePairs.title = args.title;
    if (args.description !== undefined) keyValuePairs.description = args.description;
    if (args.isAnonymous !== undefined) keyValuePairs.isAnonymous = !!args.isAnonymous;
    if (args.submitMultiple !== undefined) keyValuePairs.submitMultiple = !!args.submitMultiple;
    if (args.state !== undefined) keyValuePairs.state = Number(args.state);
    if (args.submissionMessage !== undefined) keyValuePairs.submissionMessage = args.submissionMessage;
    if (args.expires !== undefined) {
        if (args.expires === '') {
            keyValuePairs.expires = 0; // Forms stores "no expiry" as 0
        } else {
            const ts = Date.parse(args.expires);
            if (Number.isNaN(ts)) return { error: `Could not parse "expires" as a date: ${args.expires}` };
            keyValuePairs.expires = Math.floor(ts / 1000);
        }
    }
    if (!Object.keys(keyValuePairs).length) {
        return { error: 'Nothing to update — pass at least one setting.' };
    }
    // Forms refuses (403) a PATCH that mixes `state` with other keys, so
    // the state change is its own call. Reopening (state 0) goes first, so the
    // other edits are not refused by a closed form; closing goes last.
    const { state, ...rest } = keyValuePairs;
    const stateBatch = state !== undefined ? [{ state }] : [];
    const ordered = state === 0 ? [...stateBatch, rest] : [rest, ...stateBatch];
    const batches = ordered.filter(b => Object.keys(b).length);
    const updated = [];
    for (const batch of batches) {
        const out = await handle(
            await ncFetch(`${api}/forms/${encodeURIComponent(args.formId)}`, {
                method: 'PATCH', headers: HEADERS, body: JSON.stringify({ keyValuePairs: batch }),
            }),
            authError, 'settings update',
        );
        if (out.error) {
            return updated.length
                ? { error: `${out.error} Already saved: ${updated.join(', ')}.`, updated }
                : out;
        }
        updated.push(...Object.keys(batch));
    }
    return { success: true, formId: args.formId, updated };
}

module.exports = { addQuestion, updateSettings };
