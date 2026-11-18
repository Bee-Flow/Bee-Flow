/**
 * The filter a matcher sees. `includeColleagues` is a delivery switch read by
 * dispatchEvent, not a payload condition: a matcher that compares unknown
 * keys (the shallow matchFilter) would otherwise never match.
 * A Cowork item's Outlook sender / subject filter is the same kind of key: a
 * Graph notification carries only the message id, so the shallow match would
 * refuse every mail. core/cowork/mailTriggerRun.mts checks those two on the
 * fetched message instead.
 */

type Filter = Record<string, unknown>;

export function matchableFilter(provider: string, sub: { filter?: Filter | null; coworkScheduleId?: string | null }): Filter | null | undefined {
    const filter = sub.filter;
    if (!filter || typeof filter !== 'object') return filter;
    if (provider === 'msgraph' && sub.coworkScheduleId) {
        const { from: _from, subjectContains: _subject, ...rest } = filter;
        return rest;
    }
    if (provider !== 'nextcloud' || !Object.hasOwn(filter, 'includeColleagues')) return filter;
    const { includeColleagues: _switch, ...rest } = filter;
    return rest;
}
