/**
 * One query parameter of a web link, as the server wrote it. Never decoded:
 * a value goes into an href, which keeps the server's own encoding (the ids in
 * these links are passed on as they arrived, see routeStudio.ts).
 */
export function queryValue(query: string, name: string): string | null {
    for (const pair of query.split('&')) {
        const eq = pair.indexOf('=');
        if ((eq < 0 ? pair : pair.slice(0, eq)) === name) return eq < 0 ? '' : pair.slice(eq + 1);
    }
    return null;
}
