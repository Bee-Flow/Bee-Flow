/**
 * A missing entitlement is not a broken screen.
 *
 * Whole routers 403 when a module or beta flag is off (templates, notebooks),
 * and React Query would otherwise surface that as an error state with a "Try
 * again" button that can never work. Screens use this to switch to an
 * explanation instead.
 */

import { ApiError } from '@/core/api/client';

export function isUnavailable(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 403 || error.status === 404);
}
