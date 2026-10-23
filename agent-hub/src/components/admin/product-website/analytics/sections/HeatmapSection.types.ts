import type { usePreviewBackdrop } from '../heatmap/usePreviewBackdrop';
import type { toPoints, toScrollReach, ScrollReach, groupByWidth, attributeToBlocks } from '../heatmap/model';
import type { AnalyticsScope, AnalyticsSite } from '../../analyticsApi';
import type React from 'react';

/** The site's analytics settings, as far as the heatmap reads them. */
export type SiteSettings = { defaultLocale?: string; consentMode?: string };

/** A row of the heatmap page index: every path with recorded clicks. */
export type PageIndexRow = { urlPath: string; count: number; sessions: number };

/** The backdrop's measured block, as the stage and the ranking read it. */
export type PreviewBlock = ReturnType<typeof usePreviewBackdrop>['blocks'][number];

/** One heatmap report: click points (or none in scroll mode) and the scroll buckets. */
export type HeatmapPayload = NonNullable<Parameters<typeof toPoints>[0]> & { scroll?: Parameters<typeof toScrollReach>[0] };

export interface HeatmapSectionProps {
    scope: AnalyticsScope;
    site: AnalyticsSite | null;
    settings?: SiteSettings | null;
    onOpenSettings: React.MouseEventHandler<HTMLButtonElement>;
}

/**
 * The stage.
 *
 * The iframe is mounted as soon as there is a page to show and stays mounted —
 * it CANNOT be hidden behind a loading state. The backdrop hook completes its
 * handshake by posting into `frameRef.current.contentWindow`, so gating the
 * frame on "loading" meant the frame never existed, the handshake never
 * arrived, and the hook timed out with "the page preview did not load". The
 * loading and empty states are drawn as overlays on top of it instead.
 */
export interface StageBodyProps {
    detail: { error: string | null; reload: () => void };
    backdrop: ReturnType<typeof usePreviewBackdrop>;
    loading: boolean;
    mode: string;
    points: { x: number; y: number; count: number }[];
    scrollReach: ScrollReach;
    width: number;
    height: number;
    highlightId: string | null;
    onHighlight: React.Dispatch<React.SetStateAction<string | null>>;
}

/** Page picker, mode switch, capture-width tabs and the headline figures. */
export interface PageRailProps {
    index: { error: string | null; loading: boolean; reload: () => void };
    pages: PageIndexRow[];
    urlPath: string;
    onSelectPath: React.Dispatch<React.SetStateAction<string>>;
    mode: string;
    onSelectMode: React.Dispatch<React.SetStateAction<string>>;
    widthGroups: ReturnType<typeof groupByWidth>;
    activeWidth?: number;
    onSelectWidth: (width: number) => void;
    clicks: number;
    sessions: number;
    views: number;
}

/**
 * The page we draw on is TODAY's page. If it is a different height from the one
 * the clicks were recorded against it has been edited since, and positions
 * below the first screen cannot be trusted. Saying so is cheap; letting someone
 * redesign a block based on misplaced dots is not.
 */
export interface StaleNoticeProps {
    liveH: number;
    recordedH: number;
}

/**
 * The part that turns pixels into a decision. Ranked by share of clicks, with
 * clicks-per-100-views alongside — a block near the bottom of the page gets
 * fewer clicks simply because fewer people reach it, so raw counts would always
 * flatter whatever sits at the top.
 */
export interface BlockRankingProps {
    attribution: ReturnType<typeof attributeToBlocks>;
    views: number;
    highlightId: string | null;
    onHighlight: React.Dispatch<React.SetStateAction<string | null>>;
    ready: boolean;
}

/** Scroll reach at the depths people actually talk about. */
export interface ReachMilestonesProps {
    reach: ScrollReach;
    blocks: PreviewBlock[];
    pageHeight: number;
}

export interface ScrollLegendProps {
    reach: ScrollReach;
}

export interface RecordingOffProps {
    site: AnalyticsSite | null;
    settings?: SiteSettings | null;
    onOpenSettings: React.MouseEventHandler<HTMLButtonElement>;
}

export interface FigureProps {
    label: string;
    value: string;
}
