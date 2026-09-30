/**
 * PageRenderer's own colours (agent-hub/src/components/renderers/
 * PageRenderer.jsx): button gradients, stat tints and badge tints, which the
 * web writes as literals. `null` stands for the web's theme-variable entries
 * (`var(--bg-tertiary)` and friends), filled from the theme where drawn.
 * pagePalette.test.ts finds each literal in the web file.
 */

export const BUTTON_GRADIENTS: Record<string, readonly [string, string] | null> = {
    primary: ['#8b5cf6', '#6366f1'],
    secondary: null,
    success: ['#10b981', '#059669'],
    danger: ['#ef4444', '#dc2626'],
    warning: ['#f59e0b', '#d97706'],
};

export const STAT_COLORS: Record<string, { bg: string; color: string } | null> = {
    blue: { bg: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6' },
    green: { bg: 'rgba(16, 185, 129, 0.1)', color: '#10b981' },
    red: { bg: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' },
    yellow: { bg: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' },
    purple: { bg: 'rgba(139, 92, 246, 0.1)', color: '#8b5cf6' },
    default: null,
};

export const BADGE_COLORS: Record<string, { bg: string; color: string } | null> = {
    success: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981' },
    warning: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
    error: { bg: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' },
    info: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' },
    default: null,
};

/** The stat's change arrow: up green, down red. */
export const CHANGE_UP = '#10b981';
export const CHANGE_DOWN = '#ef4444';
