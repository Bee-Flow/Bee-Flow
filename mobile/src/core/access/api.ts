/**
 * The two access answers core/access fetches. /auth/my-permissions is not
 * here: core/auth fetches it whenever a session enters the signed-in stage,
 * and the access snapshot reads that copy rather than asking twice.
 */

import { api } from '@/core/api/client';

import type { Entitlements, LicenseInfo } from './model/types';
import { readEntitlements, readLicenseInfo } from './readers';

/** The unified entitlement snapshot: capabilities, ceiling, lock reasons, registry. */
export async function fetchEntitlements(signal?: AbortSignal): Promise<Entitlements | null> {
    return readEntitlements(await api.get<unknown>('/auth/my-entitlements', { signal }));
}

/** The licence governing this session: tier and licence features. */
export async function fetchLicenseInfo(signal?: AbortSignal): Promise<LicenseInfo | null> {
    return readLicenseInfo(await api.get<unknown>('/api/license/status', { signal }));
}
