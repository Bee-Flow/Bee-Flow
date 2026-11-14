// Requests typed from the server's own contract. The key of every call is an
// operation of apiTypes.generated.ts ('<METHOD> <path template>', generated from
// docs/static/openapi.json), so the path, its parameters, the query and the
// request body are checked against the route's zod schemas at compile time.
//
// No transport of its own: apiRequest/apiJson go through mutate() (a non-2xx
// throws a RefusedError with the server's error text), apiFetch through
// authFetch (the caller reads `res.ok` itself). Both add the session, CSRF and
// client headers as they always do. The init sent is the one a hand-written
// call would send: no `method` for a GET, and a JSON body is
// `JSON.stringify(body)` with `Content-Type: application/json`.
//
// The spec describes no responses: apiJson resolves to the type the caller
// declares (`const rows: Row[] = await apiJson(...)`), unknown otherwise.

import type { ApiOperationKey, ApiOperations, NoParams } from './apiTypes.generated';
import type { AuthFetchOptions } from '../utils/helpers';
// Through mutate.ts, which re-exports API_BASE and authFetch: a test that swaps either
// module (utils/helpers or api/mutate) reaches the typed calls as it reached the hand-written ones.
import { API_BASE, authFetch, mutate } from './mutate';

type Operation<K extends ApiOperationKey> = ApiOperations[K];

/**
 * The request body an operation declares. A caller whose value is typed wider than the
 * schema (a `string` state the UI only ever fills with one of the enum values) names the
 * field it narrows: `mode as ApiBody<'PATCH /api/x/{id}'>['mode']`.
 */
export type ApiBody<K extends ApiOperationKey> = NonNullable<Operation<K>['body']>;

/** The fetch init a call may add: headers, signal, keepalive, or a raw body (FormData, Blob). */
type ApiInit = Omit<AuthFetchOptions, 'method'>;

interface CallParts<K extends ApiOperationKey> {
    /** The query string, from the route's query schema (a URLSearchParams is sent as it is). */
    query?: Operation<K>['query'] | URLSearchParams;
    /** A JSON body, checked against the route's body schema. */
    body?: Operation<K>['body'];
    init?: ApiInit;
}

/** The options of one call: `params` is required exactly when the path has parameters. */
type ApiCallOptions<K extends ApiOperationKey> = CallParts<K>
    & (Operation<K>['params'] extends NoParams ? { params?: NoParams } : { params: Operation<K>['params'] });

/** The options argument, optional when the path has no parameters. */
type OptionsArg<K extends ApiOperationKey> = Operation<K>['params'] extends NoParams
    ? [options?: ApiCallOptions<K>]
    : [options: ApiCallOptions<K>];

type PathValue = string | number | boolean;

function splitKey(key: string): { method: string; template: string } {
    const space = key.indexOf(' ');
    return { method: key.slice(0, space), template: key.slice(space + 1) };
}

function queryString(query: CallParts<ApiOperationKey>['query']): string {
    if (!query) return '';
    if (query instanceof URLSearchParams) return query.toString();
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.join('&');
}

/**
 * The URL of an operation: API_BASE, the path with each `{name}` replaced by its
 * encodeURIComponent'd value, and the query (undefined and null values left out).
 */
export function apiUrl<K extends ApiOperationKey>(key: K, ...[options]: OptionsArg<K>): string {
    const { template } = splitKey(key);
    const params = (options?.params ?? {}) as Record<string, PathValue>;
    const path = template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        if (!(name in params)) throw new Error(`apiUrl: ${key} needs the path parameter "${name}"`);
        return encodeURIComponent(String(params[name]));
    });
    const qs = queryString(options?.query);
    return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

/** The init a hand-written call sends: undefined for a bare GET, else method, headers and body. */
function initOf(method: string, options: CallParts<ApiOperationKey> | undefined): AuthFetchOptions | undefined {
    const extra = options?.init;
    const hasBody = options !== undefined && 'body' in options && options.body !== undefined;
    if (method === 'GET' && !extra && !hasBody) return undefined;
    const init: AuthFetchOptions = method === 'GET' ? { ...extra } : { method, ...extra };
    if (hasBody) {
        init.headers = { 'Content-Type': 'application/json', ...(extra?.headers as Record<string, string> | undefined) };
        init.body = JSON.stringify(options.body);
    }
    return init;
}

function send<K extends ApiOperationKey>(
    transport: (url: string, init?: AuthFetchOptions) => Promise<Response>,
    key: K,
    args: OptionsArg<K>,
): Promise<Response> {
    const url = apiUrl(key, ...args);
    const init = initOf(splitKey(key).method, args[0] as CallParts<ApiOperationKey> | undefined);
    return init === undefined ? transport(url) : transport(url, init);
}

/** The checked request (mutate): the Response on a 2xx, a RefusedError on anything else. */
export function apiRequest<K extends ApiOperationKey>(key: K, ...args: OptionsArg<K>): Promise<Response> {
    return send(mutate, key, args);
}

/** The unchecked request (authFetch): the Response whatever its status; the caller reads `res.ok`. */
export function apiFetch<K extends ApiOperationKey>(key: K, ...args: OptionsArg<K>): Promise<Response> {
    return send(authFetch, key, args);
}

/** The checked request's parsed JSON body, as the type the caller declares. */
export async function apiJson<K extends ApiOperationKey, T = unknown>(key: K, ...args: OptionsArg<K>): Promise<T> {
    const res = await send(mutate, key, args);
    return (await res.json()) as T;
}
