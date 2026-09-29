/**
 * One URL builder for the monitoring endpoints. The timeline requests used to
 * append `&interval=…` to a query string that is EMPTY for the "all time"
 * range, producing `/timeline&interval=day` — a path the server does not
 * route, so both timeline charts stayed empty for that range.
 */
export function monitoringUrl(path: string, params: Record<string, string | number | undefined | null> = {}): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
    }
    const query = qs.toString();
    return query ? `${path}?${query}` : path;
}
