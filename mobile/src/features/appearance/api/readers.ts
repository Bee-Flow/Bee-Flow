/** Contract readers for the branding payloads. */

import { field, nullable, shapeOf } from '@/core/api/contract';

import type {
    EffectiveBranding,
    PublicBranding,
    UserBrandingResponse,
} from '../model/types';

const publicSpec = {
    preset: field.strOrNull,
    accent: field.strOrNull,
    radiusScale: field.numOrNull,
    font: field.str(''),
    wallpaperUrl: field.strOrNull,
};

const readEffective: (raw: unknown) => EffectiveBranding = shapeOf({
    ...publicSpec,
    // The server's own default: users may choose unless an admin said not.
    allowUserOverride: field.bool(true),
    source: field.str('default'),
});

export const readEffectiveBranding: (raw: unknown) => EffectiveBranding | null =
    nullable(readEffective);

export const readPublicBranding: (raw: unknown) => PublicBranding | null = nullable(
    shapeOf(publicSpec),
);

export const readUserBrandingResponse: (raw: unknown) => UserBrandingResponse | null = nullable(
    shapeOf({
        override: nullable(
            shapeOf({ preset: field.optStr, accent: field.optStr, wallpaperPreset: field.optStr }),
        ),
        effective: readEffective,
    }),
);
