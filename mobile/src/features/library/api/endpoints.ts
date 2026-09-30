/**
 * House styles, under /api/house-styles — the org's Word templates that
 * notebook exports are dressed in. Any org member may list them; changing
 * the default needs org admin.
 */

import { api } from '@/core/api/client';

import { readHouseStyles } from './readers';
import type { HouseStyle } from '../model/types';

const orgPath = (orgId: string) => `/api/house-styles/${encodeURIComponent(orgId)}`;

export async function listHouseStyles(orgId: string, signal?: AbortSignal): Promise<HouseStyle[]> {
    return readHouseStyles(await api.get<unknown>(orgPath(orgId), { signal }));
}

/** Org admins only — a member gets 403, which the caller renders as a hint. */
export async function setDefaultHouseStyle(orgId: string, id: string): Promise<void> {
    await api.patch(`${orgPath(orgId)}/${encodeURIComponent(id)}`, { isDefault: true });
}
