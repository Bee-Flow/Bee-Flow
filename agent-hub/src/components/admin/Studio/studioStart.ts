import { lazy } from '../../../utils/lazyWithReload';
import { STUDIO_START_SECTION, isStudioStart, type StudioStartDescriptor } from './studioSections';

/**
 * STUDIO_START: the Start section with its screen. The data half (and why Start
 * is deliberately not in STUDIO_APPS) lives in studioSections.ts, so the nav and
 * route helpers can know about Start without importing the screen, which itself
 * reads the nav helpers.
 *
 * Same import discipline as studioRegistry.tsx: the screen may only be
 * referenced inside the lazy() callback.
 */
export const STUDIO_START: Readonly<StudioStartDescriptor & { Component: ReturnType<typeof lazy> }> = Object.freeze({
    ...STUDIO_START_SECTION,
    Component: lazy(() => import('./StudioStart')),
});

export { isStudioStart };

export default STUDIO_START;
