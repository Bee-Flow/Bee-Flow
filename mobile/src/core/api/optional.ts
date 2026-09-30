/**
 * Run a request that is allowed to be refused, and turn the refusal into
 * `null` instead of an error.
 *
 * Half the settings-side surfaces are gated — the licence health probe is
 * org-admin only, the module list is super-admin only, DSR needs
 * `admin_compliance`, and usage monitoring can 402 on a community licence. A
 * member opening the admin screen should see "not available to you", rendered
 * by the screen, rather than a red error state; and a partially-visible
 * screen should not fail whole because one of its five cards was refused.
 * 404 is folded too: an optional module (support, the changelog) that is not
 * installed answers it.
 */

import { ApiError } from './client';

export async function optional<T>(run: () => Promise<T | null>): Promise<T | null> {
    try {
        return await run();
    } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 402 || err.status === 404)) {
            return null;
        }
        throw err;
    }
}
