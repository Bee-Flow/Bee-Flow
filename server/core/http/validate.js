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

/** @typedef {{ body?: import('zod').ZodType, query?: import('zod').ZodType, params?: import('zod').ZodType }} Schemas */

/**
 * What a handler after `validate(schemas)` reads in one part of the request: the schema's
 * output when the part has one, otherwise what Express gives it without (`D`).
 * @template S
 * @template {keyof Schemas} K
 * @template D
 * @typedef {S extends { [k in K]: infer T extends import('zod').ZodType } ? import('zod').output<T> : D} PartOf
 */

/**
 * The middleware `validate` returns. Express types every handler of one route with the same
 * `ReqBody` / `ReqQuery`, inferred from the handlers it is given, so the handler after this
 * one reads `req.body` and `req.query` as the schemas produce them, without a cast.
 *
 * It is deliberately NOT generic: TypeScript leaves a generic function argument out of the first
 * inference pass, and the handler's parameter types are fixed in that pass, so a generic
 * middleware here would leave the handler with `any`. The price is the route parameters: without
 * a `params` schema they are `any` here (Express's path inference cannot reach a non-generic
 * argument); pass a `params` schema for typed ones.
 *
 * Two things still win over the schema types: a middleware earlier in the chain typed with a
 * plain `import('express').Request` (its `any` body and `ParsedQs` query join the inference), and
 * a helper that takes a plain `Request`, which cannot accept a typed query. Type such middleware
 * and helpers `Request<any, any, any, any>` when they read only the session or the path.
 * @template S
 * @typedef {(
 *   req: import('express').Request<PartOf<S, 'params', any>, any, PartOf<S, 'body', any>, PartOf<S, 'query', import('qs').ParsedQs>>,
 *   res: import('express').Response,
 *   next: import('express').NextFunction,
 * ) => void} ValidatedHandler
 */

/**
 * @template {Schemas} S
 * @param {S} schemas
 * @returns {ValidatedHandler<S>}
 */
function validate(schemas) {
    const parts = Object.entries(schemas).filter(isRequestPart);
    /**
     * @param {import('express').Request<any, any, any, any>} req
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
