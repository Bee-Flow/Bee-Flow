import type { TranslateParams } from '../../hooks/useTranslation';
import type React from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * AppsHomePage — the consumer directory at /app/apps.
 *
 * A gallery of every PUBLISHED app the signed-in user can open: the apps shared
 * with them (studioAppsApi.listAccessible, which the server already filters to
 * published + audience-matched) plus their own published apps
 * (studioAppsApi.listMine, filtered to published here). Tiles link to the
 * standalone run view at /app/apps/:id (AppRunPage). This is the end-user
 * surface — no editor chrome, no create/rename/delete.
 *
 * The card visual mirrors AppList's shared-card style (soft accent tile + name
 * + description) so an app looks the same wherever it is listed.
 *
 * A directory of twenty tools needs a way in, so the tiles sit under a row of
 * category pills (All / Sales / Service / …) and a search box in the header.
 * The vocabulary of the pills is CLOSED — see APP_CATEGORIES below — and the
 * row only appears once at least one app in view carries one of those
 * categories.
 *
 * Above that grid sits "Recently used" — the handful of apps THIS reader has
 * actually opened. See the appRecents block below for where that signal comes
 * from and, just as importantly, where it deliberately does not.
 */

/** One app as the directory lists it (studio apps API row). */
export interface DirectoryApp {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    accentColor?: string;
    category?: string;
    publishedAt?: string;
    isPublished?: boolean;
    is_published?: boolean;
    projectId?: string;
    updatedAt?: string;
}

export type TFn = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

export interface CategoryFilterProps {
    categories: string[];
    value: string;
    onChange: Dispatch<SetStateAction<string>>;
    t: TFn;
}

export interface AppCardProps {
    app: DirectoryApp;
    now: number;
}

export interface ErrorBannerProps {
    message: string | symbol | null;
    onRetry: () => Promise<void>;
}

/**
 * The little uppercase rule over a section. It only ever renders when there
 * are TWO sections to tell apart — a lone grid with "All apps" written over it
 * is a label for nothing.
 */
export interface SectionLabelProps {
    children?: React.ReactNode;
}

/**
 * The 48px header: the app-kind mark, the title, how many apps are in the
 * directory, the search box, and — for a reader who may build — the way to
 * the Studio side. `count` is null while there is nothing to count, which is
 * also what hides the search box: a box that can only ever filter zero apps
 * is a control that lies about having something to do.
 */
export interface ToolbarProps {
    count: number | null;
    query: string;
    onQuery: Dispatch<SetStateAction<string>>;
    canBuild: boolean;
}

/**
 * Everything below the filter row: the recents shortcut, the directory grid,
 * and the footnote under both. Split out of the page so the page reads as
 * "fetch, filter, hand over" and this reads as the layout it is.
 */
export interface DirectoryProps {
    recentlyUsed: DirectoryApp[];
    apps: DirectoryApp[];
    now: number;
    noMatches: boolean;
}
