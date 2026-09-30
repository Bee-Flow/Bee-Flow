/** Contract readers for /api/house-styles (server/stores/houseStyleStore.js mapRow). */

import { field, shapeListOf } from '@/core/api/contract';

import type { HouseStyle } from '../model/types';

export const readHouseStyles: (raw: unknown) => HouseStyle[] = shapeListOf({
    id: field.str(''),
    orgId: field.str(''),
    name: field.str(''),
    description: field.str(''),
    styleMeta: field.record<Record<string, unknown>>({}),
    isDefault: field.bool(false),
    createdBy: field.strOrNull,
    createdAt: field.str(''),
    updatedAt: field.str(''),
});
