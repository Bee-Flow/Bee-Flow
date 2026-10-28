/**
 * The editor header's pure parts: the app row it reads, the publish state it
 * derives from it, and the path resolver behind "Show me" on a save notice.
 */
import statusOf from '@/components/shared/statusOf';
import type { AppDefinition } from '../../inspector/appDefinition';

/** The app row as the header reads it (studioAppsApi.getApp, plus legacy snake_case). */
export interface HeaderApp {
    id: string;
    name?: string;
    icon?: string;
    definition?: AppDefinition | null;
    version?: number | string | null;
    definitionVersion?: number | string | null;
    publishedVersion?: number | string | null;
    published_version?: number | string | null;
    isPublished?: boolean | null;
    is_published?: boolean | null;
    publishedAt?: string | null;
    published_at?: string | null;
    nextcloudMenu?: boolean | null;
    managed?: unknown;
    [key: string]: unknown;
}

/** The views a header segment can open in place of the canvas. */
export const PANEL_VIEWS = Object.freeze(['data', 'logic', 'roles'] as const);
export type PanelView = typeof PANEL_VIEWS[number];
/** Edit/Preview are the canvas's two modes; the rest replace the canvas. */
export type HeaderView = 'edit' | 'preview' | PanelView;

/** Where "Show me" / a reveal goes: a screen, and optionally one component on it. */
export interface RevealTarget {
    screenId: string;
    nodeId: string | null;
}

/** Focus the AI builder composer (the chat pane tags its textarea). No-op if absent. */
export function focusAiComposer(): void {
    if (typeof document === 'undefined') return;
    const el = document.querySelector<HTMLElement>('[data-app-ai-composer]');
    if (el && typeof el.focus === 'function') el.focus();
}

const PATH_STEP_RE = /(screens|sections|children)\[(\d+)\]/g;

interface PathCursor {
    id?: string;
    sections?: PathCursor[];
    children?: PathCursor[];
}

/**
 * Resolve a server path ("screens[0].sections[1].children[2].props.text") to the
 * screen and component it points at, so "Show me" can go there. Returns null
 * when the path names neither (a stale index, or app-level paths like meta.name).
 */
export function resolvePathTarget(definition: AppDefinition | null | undefined, path: string | null | undefined): RevealTarget | null {
    if (!definition || !path) return null;
    const screens = definition.screens as PathCursor[] | undefined;
    let screen = null as PathCursor | null;
    let node = null as PathCursor | null;
    let cursor = null as PathCursor | null;
    for (const [, kind, index] of path.matchAll(PATH_STEP_RE)) {
        const i = Number(index);
        if (kind === 'screens') {
            screen = screens?.[i] || null;
            cursor = screen;
        } else if (kind === 'sections') {
            cursor = screen?.sections?.[i] || null;
        } else {
            node = cursor?.children?.[i] || null;
            cursor = node;
        }
        if (!cursor) return null;
    }
    if (!screen?.id) return null;
    return { screenId: screen.id, nodeId: node?.id || null };
}

/**
 * 'behind'  — live app is on an older version than this canvas
 * 'current' — live app matches this canvas
 * 'unknown' — never published, or the row predates publishedVersion; claiming
 *             "up to date" on a guess would be worse than saying nothing.
 */
export type PublishState = 'behind' | 'current' | 'unknown';

export function publishStateOf(app: HeaderApp | null | undefined, version: unknown): { publishState: PublishState; pillStatus: string } {
    const publishedVersion = app?.publishedVersion ?? app?.published_version ?? null;
    const isPublishedFlag = !!(app?.isPublished ?? app?.is_published);
    const publishState: PublishState = (!isPublishedFlag || publishedVersion == null)
        ? 'unknown'
        : (Number(publishedVersion) === Number(version) ? 'current' : 'behind');
    // The pill's word: statusOf.app folds "never published" and "row predates
    // publishedVersion" into `unknown`; the first is a plain draft and says so.
    const pillStatus = isPublishedFlag ? statusOf.app({ ...app, version }) : 'draft';
    return { publishState, pillStatus };
}
