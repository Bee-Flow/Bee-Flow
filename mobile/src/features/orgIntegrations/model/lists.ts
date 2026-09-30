/**
 * Switching one id in a list of ids — a tool on for the organisation, a tool
 * off for a group, a Nextcloud group mirrored or excluded — kept in a stable
 * order, so switching something off and on again is no change at all.
 */

export function toggleIn(list: readonly string[], id: string, order: readonly string[] = []): string[] {
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    const rank = (x: string) => {
        const i = order.indexOf(x);
        return i === -1 ? order.length : i;
    };
    return next.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}
