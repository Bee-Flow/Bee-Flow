import type { ComponentType } from 'react';
import { lazy } from '../../../utils/lazyWithReload';
import { STUDIO_SECTIONS, STUDIO_ICONS, type StudioSectionDescriptor } from './studioSections';

export { STUDIO_ICONS };
export type { StudioPropsCtx, StudioCreateEntry } from './studioSections';

// Studio app registry — the sections of studioSections.ts with their lazy
// components. This is the ONLY module that imports the section screens, and
// only inside the lazy() callbacks, so each stays a separate on-demand chunk.
// Everything that does not need a component (nav, routes, labels, kind lookup)
// reads studioSections.ts instead; a section that imported THIS file would
// close a cycle through every lazy() below (studioRegistry.boundary.test.ts).
//
// IMPORT DISCIPLINE: this module is imported (via studioApps.tsx) from the main
// chunk. Top-level imports stay limited to react, utils/lazyWithReload and
// studioSections (plus `import type`).

export interface StudioAppDescriptor extends StudioSectionDescriptor {
    Component: ComponentType<any>;
}

const COMPONENTS: Record<string, ComponentType<any>> = {
    agents: lazy(() => import('../../agents/AgentStudio/index')),
    skills: lazy(() => import('./SkillsStudio')),
    knowledge: lazy(() => import('./KnowledgeStudio')),
    aiTasks: lazy(() => import('../../automation/index')),
    approvals: lazy(() => import('./Approvals/ApprovalsStudio')),
    datatables: lazy(() => import('./Datatables/DatatablesStudio')),
    webpages: lazy(() => import('../../../pages/WebpagesPage')),
    documents: lazy(() => import('../../../pages/documents/DocumentsPage')),
    apps: lazy(() => import('./AppStudio')),
    forms: lazy(() => import('./Forms/FormsStudio')),
    playbooks: lazy(() => import('./Playbooks/PlaybooksStudio')),
    solutions: lazy(() => import('./Solutions/SolutionsStudio')),
    runs: lazy(() => import('./Runs/RunsStudio')),
    meetingNotes: lazy(() => import('../../../pages/meeting-notes/MeetingNotesPage')),
};

export const STUDIO_APPS: StudioAppDescriptor[] = STUDIO_SECTIONS.map((section) => ({ ...section, Component: COMPONENTS[section.id] }));

export default STUDIO_APPS;
