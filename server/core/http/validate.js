// @typecheck strict
'use strict';
/**
 * Request validation as middleware, one zod schema per part of the request.
 *
 *   router.post('/', validate({ body: CreateAutomation }), async (req, res) => { … });
 *
 * On success the parsed value replaces req.body / req.query / req.params, so
 * the handler sees trimmed strings, coerced numbers and no unknown keys. On
 * failure the request ends as a 400 `invalid_request` through the terminal
 * error handler, with the first issue as the message and every issue under
 * `details`, each one pathed (`body.name`).
 *
 * Schema messages are what the client reads, so write them for a person —
 * including the one for a field that is simply absent, which zod otherwise
 * answers with the bare word "Required" (utils/zod.js keeps zod 3's wording
 * for every refusal a schema leaves unworded):
 *
 *   z.string({ error: 'A folder needs a name.' }).min(1, 'A folder needs a name.')
 *
 * An enum has a SECOND trap of the same shape: `typeError({ invalid: 'mine' })`
 * covers a wrong type only, never a wrong VALUE. `z.enum(['off','on'], { error:
 * typeError({ invalid: 'mine' }) })` still answers 'of' with "Invalid enum
 * value. Expected 'off' | 'on', received 'of'" — internals leaking to whoever
 * typed the value. Only an error function that answers every issue covers both:
 *
 *   z.enum(['off', 'on'], { error: () => 'Choose off or on.' })
 */

const { badRequest } = require('./errors');

/**
 * @param {string} part
 * @param {import('zod').core.$ZodIssue} issue
 */
function describe(part, issue) {
    const where = [part, ...issue.path].join('.');
    return { path: where, message: issue.message };
}

/** @typedef {'body' | 'query' | 'params'} RequestPart */
/** @type {readonly string[]} */
const REQUEST_PARTS = ['body', 'query', 'params'];

/**
 * @param {[string, import('zod').ZodType | undefined]} entry
 * @returns {entry is [RequestPart, import('zod').ZodType]}
 */
const isRequestPart = (entry) => REQUEST_PARTS.includes(entry[0]) && entry[1] !== undefined;

/**
 * @param {{ body?: import('zod').ZodType, query?: import('zod').ZodType, params?: import('zod').ZodType }} schemas
 */
function validate(schemas) {
    const parts = Object.entries(schemas).filter(isRequestPart);
    /**
     * Generic in the route parameters, so the handler after it keeps the `{ id: string }` Express
     * infers from the path.
     * @template P
     * @param {import('express').Request<P>} req
     * @param {unknown} _res
     * @param {import('express').NextFunction} next
     */

    return function validateRequest(req, _res, next) {

        for (const [part, schema] of parts) {
            const result = schema.safeParse(req[part]);
            if (!result.success) {
                const issues = result.error.issues.map((i) => describe(part, i));
                return next(badRequest('invalid_request', issues[0].message, issues));
            }
            // req.query is a getter in Express 5; an own property shadows it.
            Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true, enumerable: true });
        }
        return next();
    };
}

module.exports = { validate };
