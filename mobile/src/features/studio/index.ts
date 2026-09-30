/**
 * Studio: the registry of what can be built (a port of the web's STUDIO_APPS),
 * its gate resolution, the hub (the Studio tab) and Studio search. Import
 * from '@/features/studio'.
 *
 * Nothing here imports another feature: the shell (features/shell) composes
 * the hub with Cowork, Apps, Forms and Notebooks (its Workspace group), and
 * the deep-link table
 * (features/notifications) is pinned to this registry by a test rather than
 * by an import, so neither can close a cycle through Studio.
 */

export { useStudioCounts } from './hooks/queries';
export { useOpenTarget } from './hooks/useOpenTarget';
export { useStudioNav, type StudioNav } from './hooks/useStudioNav';
export { plainTarget, sectionTarget, studioLinkTarget, type OpenTarget } from './model/links';
export { studioMenuGroups, type StudioMenuGroup, type StudioMenuRow } from './model/menu';
export { STUDIO_CATEGORIES, STUDIO_SECTIONS, sectionForSegment, studioSection } from './model/registry';
export { canSeeStudio, firstOpenSection, groupSections, passesGate, resolveSections, studioNavSections } from './model/resolve';
export type { HubLink, ResolvedSection, StudioGroup, StudioSection, StudioSectionId } from './model/types';
export { AppStudioSoonScreen } from './screens/AppStudioSoonScreen';
export { AttentionScreen } from './screens/AttentionScreen';
export { StudioScreen, type StudioScreenProps } from './screens/StudioScreen';
export { StudioSearchScreen } from './screens/StudioSearchScreen';
