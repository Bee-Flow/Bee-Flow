/**
 * What the Cowork sheet (./CoworkSheet.tsx) can show, and the ONE place that knows which component shows it.
 *
 *   task       one of the owner's tasks (`id`; `focus: 'steps'` opens it at its steps)
 *   shared     a task a colleague shared with the owner, read only (`id`)
 *   settings   the owner's own Cowork settings (the morning mail, "notice what I repeat")
 *   teamwork   the desks the owner is on, and setting one up
 *   templates  the organisation's templates, and adding a task from a file
 *   org        the organisation's Cowork policy; only for its administrators (`adminOnly`)
 *
 * The page (./CoworkPage.tsx) keeps one `CoworkSheetPanel` in state, opens the sheet on it, and renders the entry's
 * lazy `component` with `CoworkSheetPanelProps`. Swapping what a kind shows is changing its `component` here: the
 * page, the menu and the home never name a panel's component.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { focusCowork } from './coworkView';
import type { TaskFocus } from './CoworkNeedFrame';
import type { CoworkViewer } from '@/api/cowork.types';

export type CoworkSheetPanel =
    | { kind: 'task'; id: string; focus?: TaskFocus }
    | { kind: 'shared'; id: string }
    | { kind: 'settings' }
    | { kind: 'teamwork' }
    | { kind: 'templates' }
    | { kind: 'org' };

export type CoworkSheetKind = CoworkSheetPanel['kind'];

/** What every panel receives. */
export interface CoworkSheetPanelProps {
    /** The panel being shown; a panel reads its own `id` from it. */
    panel: CoworkSheetPanel;
    /** The signed-in user, as the page has it (an admin check, the home organisation). */
    user: CoworkViewer | null;
    /** Close the sheet; the focus goes back to what opened it. */
    close: () => void;
    /** Show another panel in the same sheet (a task just added from a template). */
    open: (panel: CoworkSheetPanel) => void;
    /** Put a sentence in the home's composer, and close the sheet (a template's sentence). */
    fillComposer: (text: string) => void;
}

interface PanelEntry {
    component: LazyExoticComponent<ComponentType<CoworkSheetPanelProps>>;
    /** The sheet's name for a screen reader, when the panel gives none of its own (a task gives its title). */
    label: readonly [string, string];
    /** Offered to the organisation's administrators only. */
    adminOnly?: boolean;
    /** Runs before the sheet opens on it: a task asked at its steps opens its Plan tab. */
    prepare?: (panel: CoworkSheetPanel) => void;
}

export const COWORK_SHEET_PANELS: Readonly<Record<CoworkSheetKind, PanelEntry>> = {
    task: {
        component: lazy(() => import('./CoworkTaskPanel')),
        label: ['cowork_home.sheet.task', 'Task'],
        prepare: (panel) => { if (panel.kind === 'task' && panel.focus === 'steps') focusCowork({ itemId: panel.id, tab: 'plan' }); },
    },
    shared: { component: lazy(() => import('./CoworkSharedPanel')), label: ['cowork_home.sheet.shared', 'Shared task'] },
    settings: { component: lazy(() => import('./CoworkSettingsPanel')), label: ['cowork_home.menu.settings', 'Settings'] },
    teamwork: { component: lazy(() => import('./CoworkTeamworkPanel')), label: ['cowork_home.menu.teamwork', 'Teamwork'] },
    templates: { component: lazy(() => import('./CoworkTemplatesPanel')), label: ['cowork_home.menu.templates', 'Templates'] },
    org: { component: lazy(() => import('./CoworkOrgPanel')), label: ['cowork_home.menu.org', 'Organisation'], adminOnly: true },
};

/** The kinds the page's menu offers, in its order; Organisation only to an administrator of their organisation. */
export const MENU_KINDS: readonly Exclude<CoworkSheetKind, 'task' | 'shared'>[] = ['settings', 'teamwork', 'templates', 'org'];
