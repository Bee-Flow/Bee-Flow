// @typecheck strict
/**
 * Turning an ai_step's raw reply into its output (moved verbatim out of
 * execAi.js): when the step has a schema, the JSON is pulled out of the
 * reply (repaired when it is only mis-escaped), prose is wrapped under the
 * first inferred field, and a declared schema the model did not honour
 * fails the step loudly. Without a schema the reply text is the output.
 */

const log = require('../../telemetry/log');

/**
 * What the tool loop of this answer did, for the error messages.
 * @typedef {{ tally: Array<{ name: string, error: string|null }>, hitIterationCap: boolean }} AiToolInfo
 */

/** @type {AiToolInfo} */
const NO_TOOLS = { tally: [], hitIterationCap: false };

/** @param {string} message */
function validationError(message) {
    return Object.assign(new Error(message), { errorClass: 'ValidationError' });
}

/**
 * "tool calls: N, failed: M, iteration cap hit: yes/no"
 * @param {AiToolInfo} info
 */
function toolSummary(info) {
    const failed = info.tally.filter((t) => t.error !== null).length;
    return `tool calls: ${info.tally.length}, failed: ${failed}, iteration cap hit: ${info.hitIterationCap ? 'yes' : 'no'}`;
}

/**
 * The failed tool calls in one phrase: "All 4 web searches failed (timeout
 * after 30 s)", or "2 of 5 tool calls failed (…)". Empty when none failed.
 * @param {AiToolInfo} info
 */
function failedToolsText(info) {
    const failed = info.tally.filter((t) => t.error !== null);
    if (!failed.length) return '';
    const first = String(failed[0].error);
    const why = first.startsWith('Search failed: ') ? first.slice('Search failed: '.length) : first;
    const searches = info.tally.filter((t) => t.name === 'agent_search');
    const allSearches = failed.length === searches.length && failed.every((t) => t.name === 'agent_search');
    if (allSearches) {
        const n = failed.length;
        return `${n === 1 ? 'The web search' : `All ${n} web searches`} failed (${why})`;
    }
    return `${failed.length} of ${info.tally.length} tool calls failed (${why})`;
}

/**
 * The model gave nothing at all: never a successful step, with or without a schema.
 * @param {AiToolInfo} info
 */
function noAnswerError(info) {
    return validationError(`The model returned no answer (${toolSummary(info)}).`);
}

/**
 * True when every leaf of the value is empty: '' (or only whitespace), null,
 * an empty list or an empty object. A number or a boolean is an answer.
 * @param {unknown} v
 * @returns {boolean}
 */
function allLeavesEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.every(allLeavesEmpty);
    if (typeof v === 'object') return Object.values(v).every(allLeavesEmpty);
    return false;
}

/**
 * What breaks a DECLARED output contract, before any checks of the step:
 * an object with no fields, a required field that is missing or a top-level
 * field of the wrong type, and an answer with nothing in it while a tool
 * call failed (an empty answer after working tools can be the real answer).
 * @param {unknown} output the restored answer
 * @param {unknown} schema the schema as tool parameters (toToolParameters)
 * @param {AiToolInfo} info
 * @returns {Array<{ code: string, path: string, message: string }>}
 */
function declaredContractErrors(output, schema, info) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
    if (!Object.keys(output).length) {
        return [{ code: 'no_answer', path: '', message: `the answer is an empty object (${toolSummary(info)})` }];
    }
    /** @type {Array<{ code: string, path: string, message: string }>} */
    const errors = [];
    const { schemaTypeErrors } = require('./aiStepChecks');
    // null in an optional field means "not found", which models write for an
    // unknown value; only a required field must hold its declared type.
    const s = /** @type {{ required?: unknown }} */ (schema || {});
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const typed = Object.fromEntries(Object.entries(output).filter(([k, v]) => v !== null || required.has(k)));
    schemaTypeErrors(typed, schema, (code, path, message) => { errors.push({ code, path, message }); });
    const failed = failedToolsText(info);
    if (!errors.length && failed && allLeavesEmpty(output)) {
        errors.push({ code: 'no_data', path: '', message: `${failed}; the model returned no data` });
    }
    return errors;
}

/**
 * The step error for a broken declared contract (a step without checks or a
 * fallback): the fields and what is wrong with them, or the failed tools.
 * @param {Array<{ code: string, path: string, message: string }>} errors
 * @param {string} stepId
 */
function contractError(errors, stepId) {
    const only = errors.length === 1 && !errors[0].path ? errors[0] : null;
    if (only && only.code === 'no_data') return validationError(`${only.message.charAt(0).toUpperCase()}${only.message.slice(1)}.`);
    const list = errors.slice(0, 5).map((e) => `${e.path || 'answer'}: ${e.message}`).join('; ');
    return validationError(`This step's answer does not match its declared output schema, so "steps.${stepId}.output.…" references downstream would be wrong: ${list}.`);
}

/**
 * The author (or the leading skill) DECLARED a schema and the model did not
 * honour it.
 *
 * Doing nothing here is not an option: `output` would stay the raw string,
 * the step would report SUCCESS, and every downstream
 * `steps.<id>.output.<field>` would silently resolve to undefined. An
 * automation could render an empty document, mail an empty summary or write
 * empty rows, with a green run behind it and no line anywhere saying why.
 * That is the worst failure this file can produce, so it fails loudly instead.
 *
 * The two causes read very differently to whoever has to fix it, so they get
 * different messages: a reply that starts like JSON and stops mid-structure
 * ran out of output budget (raise the step's tier, or ask for fewer/shorter
 * fields); anything else means the model answered in prose. A tool loop that
 * hit its cap says so, since that is then the likelier cause.
 * @param {string} reply
 * @param {string} stepId
 * @param {AiToolInfo} toolInfo
 */
function declaredMismatchError(reply, stepId, toolInfo) {
    const text = reply.trim();
    // Truncation is decided on the SHAPE of the reply, not on whether the
    // greedy match found anything: a reply that ran out of budget has no
    // closing brace at all, so that match is null exactly when truncation is
    // most likely. Strip the fence first — a fenced block that was cut off
    // never got its closing ``` either.
    const body = text.replace(/^```[A-Za-z]*\s*/, '').replace(/\s*```$/, '').trim();
    const looksTruncated = (body.startsWith('{') || body.startsWith('['))
        && !/[}\]]$/.test(body);
    if (looksTruncated) {
        return validationError(`This step's answer was cut off before the JSON was complete (${text.length} characters). Raise the step's model tier, or ask for fewer or shorter fields in its output schema.`);
    }
    const capNote = toolInfo.hitIterationCap
        ? ` The tool loop hit its cap before the model gave a final answer (${toolSummary(toolInfo)}).`
        : '';
    return validationError(`This step was asked for JSON matching its output schema but answered with something else, so every "steps.${stepId}.output.…" reference downstream would have been empty.${capNote} First 200 characters: ${text.slice(0, 200)}`);
}

/**
 * Nothing at all is not an answer: not wrapped under an inferred field, not
 * passed on as ''. The one exception is a step without a schema
 * whose work was its tool calls ("send this mail"): when they all succeeded,
 * no closing text is fine.
 * @param {unknown} effectiveSchema
 * @param {AiToolInfo} toolInfo
 * @returns {string}
 */
function emptyReply(effectiveSchema, toolInfo) {
    const actedOk = !effectiveSchema && toolInfo.tally.length > 0 && !failedToolsText(toolInfo);
    if (!actedOk) throw noAnswerError(toolInfo);
    return '';
}

/**
 * @param {string} content the model's reply text
 * @param {{ step: any, effectiveSchema: any, inferred: any, inferredFields: string[]|null, outputContract: any, toolInfo?: AiToolInfo }} shape
 * @returns {string | Record<string, unknown>} the step output (a parsed object, a wrapped object or the text)
 */
function parseAiStepOutput(content, { step, effectiveSchema, inferred, inferredFields, outputContract, toolInfo = NO_TOOLS }) {
    if (!String(content ?? '').trim()) return emptyReply(effectiveSchema, toolInfo);
    /** @type {string | Record<string, unknown>} */
    let output = content;
    if (effectiveSchema) {
        // Attempt JSON parse anywhere in the response. A model asked for JSON
        // routinely wraps it in a ```json fence or writes a sentence first;
        // the greedy match spans from the first brace to the last, which
        // handles both.
        const m = output.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        let parsed = null;
        if (m) {
            // parseJsonish, not JSON.parse: a step whose schema asks for a long
            // markdown document gets back a structurally perfect object whose
            // string values contain LITERAL newlines, because the model is
            // writing a document. That is not a broken answer, it is a
            // mis-escaped one, and throwing it away loses a page of work that
            // was already paid for.
            const { parseJsonish } = require('../automationModel/jsonRepair');
            const r = parseJsonish(m[0]);
            if (r.ok) {
                parsed = r.value;
                if (r.repaired) {
                    log.warn(`[AutomationRunner] ai_step ${step.id}: model returned malformed JSON (raw control characters or a trailing comma) — repaired.`);
                }
            }
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            output = parsed;
        } else if (inferredFields && inferredFields.length) {
            // Fallback: model gave us prose despite asking for JSON. Wrap
            // it under the first inferred field so downstream bindings
            // still resolve. Better a slightly off-shape than a silent
            // undefined that breaks the next step ("body is required").
            output = { [inferred.textField || inferredFields[0]]: String(output).trim() };
        } else if (outputContract.declared) {
            throw declaredMismatchError(String(output), step.id, toolInfo);
        }
    }
    return output;
}

module.exports = { parseAiStepOutput, declaredContractErrors, contractError, noAnswerError, failedToolsText, allLeavesEmpty };
