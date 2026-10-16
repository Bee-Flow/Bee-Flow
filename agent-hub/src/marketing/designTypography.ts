import { displayTrackingEm } from './blockWrap';
import type { DesignTypography } from './ProductWebsite.types';

/**
 * Typography v2 -> custom properties on the marketing root: the display cap
 * (64/80/96px), the heading weight (500 to 900, the HEADING_WEIGHTS of
 * server/i18n/defaults/cmsDefaults.js), the display letter-spacing (an enum
 * name mapped to a fixed em value, never a stored string; 'default' keeps the
 * token's own value) and the body size.
 */
export function applyTypographyVars(style: CSSStyleDeclaration, ty: DesignTypography): void {
    const displayMax = ({ md: '4rem', lg: '5rem', xl: '6rem' } as Record<string, string | undefined>)[ty.displaySize as string];
    if (displayMax) style.setProperty('--display-max', displayMax);
    if ([500, 600, 700, 800, 900].includes(ty.headingWeight as number)) {
        style.setProperty('--heading-weight', String(ty.headingWeight));
    }
    const tracking = displayTrackingEm(ty.displayTracking);
    if (tracking) style.setProperty('--tracking-display', tracking);
    if ([16, 17, 18].includes(ty.bodySize as number)) {
        style.setProperty('--text-body', `${ty.bodySize}px`);
    }
}
