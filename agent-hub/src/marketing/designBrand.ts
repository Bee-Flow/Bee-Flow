import { applyRoleVars, ROLE_VAR_PROPS, roleColor } from './designRoles';
import { applyTileVars, TILE_VAR_PROPS } from './designTiles';
import type { DesignColors, DesignComponents } from './ProductWebsite.types';

export { roleColor };

/** Every custom property the colour roles, label style and icon tiles can set. */
export const BRAND_VAR_PROPS: string[] = [...TILE_VAR_PROPS, ...ROLE_VAR_PROPS];

/** Apply the icon tile, colour role and label style properties (and the cta focus-ring class) to the root. */
export function applyBrandVars(root: HTMLElement, colors: DesignColors, components: DesignComponents): void {
    applyTileVars(root.style, components);
    applyRoleVars(root.style, colors, components.labelStyle);
    root.classList.toggle('cms-role-cta', roleColor(colors.cta) !== '');
}
