import { Home } from 'lucide-react';
import { lazy } from '../../../utils/lazyWithReload';

/**
 * STUDIO_START — the Studio rail's first row, and the section `/app/studio`
 * lands on with no segment (Track H1).
 *
 * DELIBERATELY NOT IN `STUDIO_APPS`. The registry is frozen by
 * studioApps.test.jsx along five axes at once — the id list, the urlSegment
 * map, "files every section under a declared category", "every nav section
 * carries a kindColors kind" and "every nav section has a create entry" —
 * and Start satisfies none of them: it is not a kind you make, it belongs to
 * no category, and there is nothing to create in it. Adding it there would
 * mean loosening five assertions that exist to catch exactly this, so the
 * one row that is not an app lives beside the registry instead of in it.
 *
 * Everything else treats it as an ordinary descriptor: studioRoutes.js maps
 * its segment like any other, Studio/index.jsx mounts its Component from the
 * same lazy() + getProps shape, and the rail renders it from the same row
 * renderer. Only `groupStudioApps`, the counts and the "New" menu never see
 * it, which is the point.
 *
 * Same import discipline as studioApps.jsx: studioRoutes.js imports this
 * module and studioRoutes.js is in the MAIN chunk, so the screen itself may
 * only be referenced inside the lazy() callback.
 */
export const STUDIO_START = Object.freeze({
    id: 'start',
    urlSegment: 'start',
    labelKey: 'studio.start.title',
    labelFallback: 'Start',
    descKey: 'studio.start.desc',
    descFallback: 'Everything you build, in one place',
    Icon: Home,
    // No kind, no category, no countKey, no create — see the note above.
    gate: () => true,
    Component: lazy(() => import('./StudioStart')),
    getProps: ({ user, onNavigate, hasPermission }) => ({ user, onNavigate, hasPermission }),
});

/** True for the one section id that is not in STUDIO_APPS. */
export const isStudioStart = (section) => section === STUDIO_START.id;

export default STUDIO_START;
