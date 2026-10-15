import { groupByWidth, attributeToBlocks, toScrollReach } from '../heatmap/model';
import { usePreviewBackdrop } from '../heatmap/usePreviewBackdrop';

export type Mode = 'click' | 'scroll';

/** The width groups, the reach curve and the backdrop, as the JS helpers return them. */
export type WidthGroup = ReturnType<typeof groupByWidth>[number];

export type ScrollReach = ReturnType<typeof toScrollReach> & { pageW?: number };

export type Backdrop = ReturnType<typeof usePreviewBackdrop> & { reload?: () => void };

export type Attribution = ReturnType<typeof attributeToBlocks>;

export interface IndexPage {
    urlPath: string;
    count?: number;
    sessions?: number;
}

export interface IndexPayload {
    pages?: IndexPage[];
}

export interface HeatmapDetail {
    scroll?: unknown;
}

export interface PageViewRow {
    x: string;
    y: number;
}

/** The part of a query hook's state the panels read. */
export interface QueryState {
    loading: boolean;
    error: string | null;
    reload: () => void;
}

export interface SiteInfo {
    name?: string;
    recording?: boolean;
}

export interface SettingsInfo {
    defaultLocale?: string;
    consentMode?: boolean;
}
