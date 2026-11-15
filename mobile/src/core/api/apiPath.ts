/**
 * The path of a server operation, typed from the server's own contract.
 *
 * The key is an operation of apiTypes.generated.ts (`'<METHOD> <path template>'`,
 * generated from docs/static/openapi.json by scripts/gen-api-types.mjs, the
 * same text agent-hub gets), so a path the server does not mount, a missing
 * path parameter and a misspelled one are compile errors here instead of a 404
 * on someone's phone. `npm run lint:api-types` fails when the file is stale.
 *
 * It builds the path only: `api.get/post/…` in ./client add the server address
 * and the query, as they do for a hand-written path. The port of `apiUrl` in
 * agent-hub/src/api/typedRequest.ts, which returns the same path behind its
 * API_BASE.
 *
 * The spec describes no responses, so this says nothing about what comes back:
 * a response is still read through a contract reader (./contract).
 */

import type { ApiOperationKey, ApiOperations, NoParams } from './apiTypes.generated';

type Operation<K extends ApiOperationKey> = ApiOperations[K];

/** The JSON body an operation declares, from the route's zod body schema. */
export type ApiBody<K extends ApiOperationKey> = NonNullable<Operation<K>['body']>;

/** The params argument: required exactly when the path has parameters. */
type ParamsArg<K extends ApiOperationKey> = Operation<K>['params'] extends NoParams
    ? [params?: NoParams]
    : [params: Operation<K>['params']];

/**
 * The operation's path with each `{name}` replaced by its encodeURIComponent'd
 * value. Plain string operations: the template is ours, but a path is the kind
 * of text this repository does not run a regular expression over.
 */
export function apiPath<K extends ApiOperationKey>(key: K, ...[params]: ParamsArg<K>): string {
    const values = (params ?? {}) as Record<string, string | number | boolean>;
    // '/api/x/{id}/y' splits into '/api/x/' and 'id}/y': every piece after the first starts with a name.
    const [head = '', ...pieces] = key.slice(key.indexOf(' ') + 1).split('{');
    let path = head;
    for (const piece of pieces) {
        const close = piece.indexOf('}');
        const name = piece.slice(0, close);
        if (!(name in values)) throw new Error(`apiPath: ${key} needs the path parameter "${name}"`);
        path += encodeURIComponent(String(values[name])) + piece.slice(close + 1);
    }
    return path;
}
