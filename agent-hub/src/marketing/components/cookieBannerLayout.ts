import type { CSSProperties } from 'react';
import { COOKIE_BANNER_LAYOUTS } from '../../components/admin/product-website/blockEditors/blockData.generated.mjs';

export type CookieLayout = 'card' | 'bar' | 'corner';

/** A stored layout, or 'card' (today's look) for anything missing or unknown. */
export function normalizeCookieLayout(value: unknown): CookieLayout {
    return typeof value === 'string' && (COOKIE_BANNER_LAYOUTS as string[]).includes(value)
        ? (value as CookieLayout)
        : 'card';
}

// Placement and surface per layout. Colours, font and the z-index stay in
// CookieBanner.tsx; only what differs between the three shapes lives here.
const PLACEMENT: Record<CookieLayout, CSSProperties> = {
    card: {
        left: '1rem', right: '1rem', bottom: '1rem',
        maxWidth: 720, margin: '0 auto',
        padding: '0.875rem 1.125rem',
        borderRadius: 'var(--radius-lg, 16px)',
    },
    // Full width, flush with the bottom edge: message left, buttons right on a
    // wide screen; the flex-wrap makes it two short lines on a phone.
    bar: {
        left: 0, right: 0, bottom: 0,
        maxWidth: 'none', margin: 0,
        padding: '0.5rem 1rem',
        borderRadius: 0,
        borderWidth: '1px 0 0 0',
        boxShadow: '0 -2px 10px rgba(15, 23, 42, 0.08)',
        gap: '0.5rem 1rem',
    },
    corner: {
        left: '1rem', right: 'auto', bottom: '1rem',
        maxWidth: 360, margin: 0,
        padding: '0.75rem 1rem',
        borderRadius: 'var(--radius-lg, 16px)',
    },
};

/** The placement part of the banner's inline style. */
export function cookieLayoutStyle(layout: CookieLayout): CSSProperties {
    return PLACEMENT[layout];
}

/** Buttons in the bar are smaller so the bar stays about one line tall. */
export function cookieButtonStyle(layout: CookieLayout): CSSProperties {
    return layout === 'bar' ? { padding: '0.35rem 0.8rem' } : {};
}

/** Pixels of page bottom to keep clear while the banner is open (its height plus the gap it floats at). */
export function cookieReserve(layout: CookieLayout, height: number): number {
    return Math.ceil(height) + (layout === 'bar' ? 0 : 16);
}
