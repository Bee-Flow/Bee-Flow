/** Contract readers for the integration settings (model/types.ts names each route). */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { ActiveFeatures, NcIntegrationGroup, NcIntegrations } from '../model/types';

const readNcFields = shapeOf({
    ncCatalog: shapeListOf({ id: field.str(''), name: field.str(''), description: field.str('') }),
    enabled: field.strArray,
    usingDefaults: field.bool(false),
});

export function readNcIntegrations(raw: unknown): NcIntegrations {
    const r = readNcFields(raw);
    return { catalog: r.ncCatalog.filter((item) => item.id), enabled: r.enabled, usingDefaults: r.usingDefaults };
}

const readGroupRows = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    disabledIntegrations: field.strArray,
    userCount: field.num(0),
});

/** `{ groups }`; a group without an id cannot be changed and is dropped. */
export function readNcIntegrationGroups(raw: unknown): NcIntegrationGroup[] {
    return readGroupRows(pick(raw, 'groups')).filter((g) => g.id);
}

export const readActiveFeatures: (raw: unknown) => ActiveFeatures = shapeOf({
    orgId: field.strOrNull,
    allowedBetaFeatures: field.strArray,
    enabledBetaFeatures: field.strArray,
    betaGoverned: field.bool(true),
});

/** `GET /ai/config`: only whether a Google Maps key is stored. */
export const readHasMapsKey: (raw: unknown) => boolean = (raw) => field.bool(false)(pick(raw, 'hasGoogleMapsKey'));

/** `GET /auth/beta-features`: the allow-list the super admin set for one organisation. */
export function readBetaAllowList(raw: unknown, orgId: string): string[] {
    return field.strArray(pick(pick(raw, 'assignments'), orgId));
}
