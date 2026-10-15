// The shapes helpers.ts works with, kept apart so that file stays under its size ceiling.

/** The options authFetch takes: fetch's, except that `headers` is a plain object (it is spread). */
export type AuthFetchOptions = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/** A stand-in for the network: gets the request, answers a Response. */
export type FetchTransport = (url: string, options: AuthFetchOptions) => Promise<Response> | Response;

/** What parseSaveError makes of a failed save. */
export interface SaveErrorInfo {
    message: string;
    code: string | undefined;
    resource: string | undefined;
    isLimit: boolean;
}

export interface SaveErrorBody {
    error?: string;
    message?: string;
    code?: string;
    resource?: string;
}
