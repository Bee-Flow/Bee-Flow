import { studioAppForKind } from '../studioNav';

/**
 * Where an attention row's "show me" goes.
 *
 * Its own module, with no JSX in it, so the rule is a pure function the tests
 * can call directly and the list component stays a component.
 */

/**
 * kind → the section's URL segment, DERIVED from the registry, not written.
 *
 * The kind → section walk itself lives in studioNav.js: the map (map/studioMap.js)
 * needs the same answer, and two walks over STUDIO_APPS are two answers to
 * "where does Show me go".
 */
const segmentForKind = (kind) => studioAppForKind(kind)?.urlSegment || null;

/** The prefix of an in-app Studio link; anything else is not ours to open. */
const IN_APP_PREFIX = '/app/studio/';

/**
 * The in-app page for one row, or null.
 *
 * The server's own `deepLink` first — projects/completeness.js builds it, and
 * it is the same link the Solution's "To check" list opens. It is an absolute
 * path while `navigateToPage` wants a page ("studio/apps/x"), so the /app/
 * head comes off; anything that is not an in-app Studio path is refused rather
 * than handed to the router.
 *
 * The registry is the FALLBACK, and today it is only that. Every one of the
 * six sources sends a `deepLink` — including Solutions, whose source builds it
 * itself (routes/studio/attentionChecks.js solutionDeepLink) precisely because
 * completeness.js's shared map may not. So this path is reached only when the
 * server sends no link, or one this client refuses (anything outside
 * /app/studio/). Of the ten kinds only `form` has no entry at all, and no
 * source produces a form row — which is exactly why this fallback is small,
 * and why it must never be mistaken for the normal route.
 *
 * Null when there is no id either: a row that navigates to `studio/apps/null`
 * is worse than a row that does not navigate, which is the rule deepLinkFor
 * keeps too.
 */
export function attentionPath(item) {
    const link = item?.deepLink;
    if (typeof link === 'string' && link.startsWith(IN_APP_PREFIX)) return link.slice('/app/'.length);
    const segment = segmentForKind(item?.kind);
    const id = item?.finding?.targetId;
    if (!segment || !id) return null;
    return `studio/${segment}/${encodeURIComponent(id)}`;
}

export default attentionPath;
