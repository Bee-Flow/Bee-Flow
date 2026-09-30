/**
 * The fixed colours the web's rich renderers paint with (ResearchRenderer,
 * TestReportRenderer, PageRenderer). They are literals on the web too — the
 * brand gradient, the dark hero, the status and category hues — rather than
 * theme tokens, so a report looks the same in every theme there and here.
 * richPalette.test.ts finds each one in the web file it comes from.
 */

/** The violet → indigo brand gradient: title underlines, stat figures, primary buttons. */
export const BRAND_GRADIENT = ['#8b5cf6', '#6366f1'] as const;

/** A card's accent line: violet → indigo → blue. */
export const CARD_ACCENT = ['#8b5cf6', '#6366f1', '#3b82f6'] as const;

/** The research hero with no picture: a deep navy gradient. */
export const HERO_GRADIENT = ['#1a1a2e', '#16213e', '#0f3460'] as const;

/** Callouts, as the research renderer tints them: background, border, ink. */
export const CALLOUT = {
    info: { bg: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.3)', color: '#60a5fa' },
    warning: { bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.3)', color: '#fbbf24' },
    success: { bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.3)', color: '#34d399' },
    tip: { bg: 'rgba(139, 92, 246, 0.1)', border: 'rgba(139, 92, 246, 0.3)', color: '#a78bfa' },
} as const;

/** A test's status: its colour and the tint behind an expanded row. */
export const TEST_STATUS = {
    passed: { color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' },
    failed: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' },
    warning: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
    skipped: { color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)' },
} as const;

export const TEST_CATEGORY = {
    functionality: '#818cf8',
    ui: '#38bdf8',
    performance: '#fb923c',
    accessibility: '#a78bfa',
    security: '#f472b6',
} as const;

export const TEST_SEVERITY = {
    critical: '#ef4444',
    major: '#f97316',
    minor: '#eab308',
    cosmetic: '#6b7280',
} as const;

/** The first colour in a CSS colour or gradient string, for a figure the model tinted. */
export function firstColor(css: string): string | null {
    return /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/.exec(css)?.[0] ?? null;
}
