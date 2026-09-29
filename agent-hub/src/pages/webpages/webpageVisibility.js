import { audienceModeOf } from '../../components/shared/VisibilityCapsule';

/**
 * Who can see a webpage — ONE derivation, shared by the overview card and
 * (from W2) the editor's capsule.
 *
 * Three of the four states are the audience pair every Studio object shares
 * (`audienceModeOf`: personal / entire organisation / groups). The fourth is
 * webpages-only and DERIVED: a page with a live public share is readable by
 * anyone holding the link, which no audience setting can express.
 *
 * "Public" is checked FIRST because it is the widest. A page that is
 * "Personal" and publicly shared is public, and painting "Personal" there
 * would be a lie of exactly the kind a visibility capsule exists to prevent.
 *
 * `publicShareCount` is the list row's count of non-revoked shares. Until the
 * list endpoint carries it, the state is simply never reached — which is the
 * safe direction: it under-claims reach, never over-claims privacy.
 */
export function isPubliclyShared(webpage) {
    return Number(webpage?.publicShareCount) > 0;
}

/** `{ isPublic, mode }` — `mode` is the audience underneath either way. */
export function visibilityOf(webpage) {
    return {
        isPublic: isPubliclyShared(webpage),
        mode: audienceModeOf({
            isPublished: webpage?.isPublished,
            sharedGroups: webpage?.sharedGroups,
        }),
    };
}
