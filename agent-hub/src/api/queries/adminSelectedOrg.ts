// PUT /auth/admin/selected-org: the organisation a platform admin works on.
// The session setting binds a platform admin without a home organisation to
// the chosen organisation's access menu in their own entitlements.

import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '../typedRequest';

export function useSelectAdminOrgMutation() {
    return useMutation<Response, Error, string>({
        mutationFn: (orgId) => apiRequest('PUT /auth/admin/selected-org', { body: { orgId } }),
    });
}
