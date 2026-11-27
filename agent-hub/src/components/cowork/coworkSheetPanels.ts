/**
 * The pages of Cowork besides its home, and the ONE place that knows which component shows each.
 *
 *   task       one of the owner's tasks (`id`; `focus: 'steps'` opens it at its steps)
 *   shared     a task a colleague shared with the owner, read only (`id`)
 *   settings   Cowork preferences: what holds for the owner only (the morning e-mail, suggestions)
 *   teamwork   the desks the owner is on, and setting one up
 *   templates  the organisation's templates, and adding a task from a file
 *   org        Admin rules: the organisation's Cowork policy; only its administrators are offered it
 *
 * A page is a full page in the Cowork content area that replaces the home, under a "Tasks" link back to it
 * (./CoworkPage.tsx). There is no sheet any more: the names here (`CoworkSheetPanel`, `CoworkSheetPanelProps`) are
 * from when these opened in one, and stay because every page component is typed by them.
 *
 * The page keeps one `CoworkSheetPanel` and renders the entry's lazy `component` with `CoworkSheetPanelProps`. Each
 * page has an address: `/app/cowork/<segment>`, where a task's segment is its id and the others are the words below
 * (`pageSegment`, `pageOfSegment`). So Back and Forward of the browser move between the home and the pages, and a
 * page can be linked to. Swapping what a kind shows is changing its `component` here: the page and the home never
 * name a page's component.
 */
import type { TeamworkTurn } from './coworkTeamworkRequest';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { TaskFocus } from './CoworkNeedFrame';
import type { CoworkViewer } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

export type CoworkSheetPanel =
    | { kind: 'task'; id: string; focus?: TaskFocus; takeQuestion?: () => string }
    | { kind: 'shared'; id: string; takeQuestion?: () => string }
    | { kind: 'settings'; section?: string }
    | { kind: 'teamwork'; request?: TeamworkTurn }
    | { kind: 'templates'; section?: string }
    | { kind: 'org'; section?: string };

export type CoworkSheetKind = CoworkSheetPanel['kind'];

export type HomeTransfer = 'ask' | 'create' | 'attention' | 'shared';
export type ComposerSeed = {text: string; n: number; takeAction?: () => HomeTransfer | undefined};

/** What every page receives. */
export interface CoworkSheetPanelProps {
    /** The page being shown; a page reads its own `id` from it. */
    panel: CoworkSheetPanel;
    /** The signed-in user, as the Cowork page has it (an admin check, the home organisation). */
    user: CoworkViewer | null;
    /** Go back to the home; the focus goes back to what opened the page. */
    close: () => void;
    /** Show another page instead (a task just added from a template, a task of a desk). */
    open: (panel: CoworkSheetPanel) => void;
    /** Put a sentence in the home's composer, and go back to the home (a template's sentence). */
    fillComposer: (text: string, action?: HomeTransfer) => void;
}

interface PageEntry {
    component: LazyExoticComponent<ComponentType<CoworkSheetPanelProps>>;
    /** The page's name for a screen reader, until its own heading is there (a task gives its title). */
    label: readonly [string, string];
}

export const COWORK_SHEET_PANELS: Readonly<Record<CoworkSheetKind, PageEntry>> = {
    task: { component: lazy(() => import('./task/CoworkTaskView')), label: ['cowork_pages.name.task', 'Task'] },
    shared: { component: lazy(() => import('./task/CoworkTaskShared')), label: ['cowork_pages.name.shared', 'Shared task'] },
    settings: { component: lazy(() => import('./panels/CoworkSettingsPanel')), label: ['cowork_pages.name.settings', 'Cowork preferences'] },
    teamwork: { component: lazy(() => import('./panels/CoworkTeamworkPanel')), label: ['cowork_pages.name.teamwork', 'Teamwork'] },
    templates: { component: lazy(() => import('./panels/CoworkTemplatesPanel')), label: ['cowork_pages.name.templates', 'Start from a template'] },
    org: { component: lazy(() => import('./panels/CoworkOrgPanel')), label: ['cowork_pages.name.org', 'Admin rules'] },
};

/** What a kind of page is called: on what opens it, and for a screen reader until the page's own heading is there. */
export function pageName(kind: CoworkSheetKind, t: TranslateFn): string {
    const [key, en] = COWORK_SHEET_PANELS[kind].label;
    return t(key, en);
}

// The words in the address of the pages that are no task. A task's id is never one of them (ids are generated).
const WORD_OF = { settings: 'preferences', teamwork: 'teamwork', templates: 'templates', org: 'admin-rules' } as const;
const SHARED = 'shared-';

type WordKind = keyof typeof WORD_OF;
const isWordKind = (kind: string): kind is WordKind => kind in WORD_OF;

/** The last part of a page's address: `/app/cowork/<segment>`. */
export function pageSegment(page: CoworkSheetPanel): string {
    if (page.kind === 'task') return page.id;
    if (page.kind === 'shared') return `${SHARED}${page.id}`;
    return WORD_OF[page.kind];
}

/** The page an address names; none (the home) without a segment. */
export function pageOfSegment(segment: string | null | undefined): CoworkSheetPanel | null {
    if (!segment) return null;
    const word = Object.keys(WORD_OF).filter(isWordKind).find((kind) => WORD_OF[kind] === segment);
    if (word) return { kind: word };
    if (segment.startsWith(SHARED) && segment.length > SHARED.length) return { kind: 'shared', id: segment.slice(SHARED.length) };
    return { kind: 'task', id: segment };
}

/** Whether two pages are the same page (the same kind, and the same task). */
export function samePage(a: CoworkSheetPanel | null, b: CoworkSheetPanel | null): boolean {
    if (!a || !b) return a === b;
    return pageSegment(a) === pageSegment(b);
}
