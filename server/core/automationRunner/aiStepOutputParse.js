// @typecheck
/**
 * Turning an ai_step's raw reply into its output (moved verbatim out of
 * execAi.js): when the step has a schema, the JSON is pulled out of the
 * reply (repaired when it is only mis-escaped), prose is wrapped under the
 * first inferred field, and a declared schema the model did not honour
 * fails the step loudly. Without a schema the reply text is the output.
 */

const log = require('../../telemetry/log');

/**
 * @param {string} content the model's reply text
 * @param {{ step: any, effectiveSchema: any, inferred: any, inferredFields: string[]|null, outputContract: any }} shape
 * @returns {any} the step output (a parsed object, a wrapped object or the text)
 */
function parseAiStepOutput(content, { step, effectiveSchema, inferred, inferredFields, outputContract }) {
    /** @type {any} */
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
            // The author (or the leading skill) DECLARED a schema and the
            // model did not honour it.
            //
            // What used to happen here was nothing: `output` stayed the raw
            // string, the step reported SUCCESS, and every downstream
            // `steps.<id>.output.<field>` silently resolved to undefined. A
            // automation could render an empty document, mail an empty summary or
            // write empty rows, with a green run behind it and no line anywhere
            // saying why. That is the worst failure this file can produce, so it
            // fails loudly instead.
            //
            // The two causes read very differently to whoever has to fix it, so
            // they get different messages: a reply that starts like JSON and
            // stops mid-structure ran out of output budget (raise the step's
            // tier, or ask for fewer/shorter fields); anything else means the
            // model answered in prose.
            const text = String(output).trim();
            // Truncation is decided on the SHAPE of the reply, not on whether
            // the greedy match above found anything: a reply that ran out of
            // budget has no closing brace at all, so that match is null exactly
            // when truncation is most likely. Strip the fence first — a fenced
            // block that was cut off never got its closing ``` either.
            const body = text.replace(/^```[A-Za-z]*\s*/, '').replace(/\s*```$/, '').trim();
            const looksTruncated = (body.startsWith('{') || body.startsWith('['))
                && !/[}\]]$/.test(body);
            const err = new Error(looksTruncated
                ? `This step's answer was cut off before the JSON was complete (${text.length} characters). Raise the step's model tier, or ask for fewer or shorter fields in its output schema.`
                : `This step was asked for JSON matching its output schema but answered with something else, so every "steps.${step.id}.output.…" reference downstream would have been empty. First 200 characters: ${text.slice(0, 200)}`);
            Object.assign(err, { errorClass: 'ValidationError' });
            throw err;
        }
    }
    return output;
}

module.exports = { parseAiStepOutput };
