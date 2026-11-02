/**
 * logUrl.mts: a URL as a log line may carry it.
 */

/**
 * Origin and path, without a query string or credentials (a token can sit in
 * either). A value that is not a URL is logged as `[invalid url]`.
 */
export function urlWithoutQuery(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return '[invalid url]';
    }
}
