// The read behind the organisation's single-setting editors (conversation
// memory, integration answers kept between runs, the encryption tier): GET the org's row; a refusal
// is an error carrying the server's text. After a failed load `server` is null,
// so Save stays disabled — saving on top of a failed load would write a guess.

import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '@/utils/caughtError';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

type OrgSettingKey = 'GET /api/org-ai-context/{orgId}' | 'GET /api/org-integration-cache/{orgId}' | 'GET /auth/organizations/{id}/encryption';

function send(key: OrgSettingKey, orgId: string): Promise<Response> {
    return key === 'GET /auth/organizations/{id}/encryption'
        ? apiRequest(key, { params: { id: orgId } })
        : apiRequest(key, { params: { orgId } });
}

async function readOrgSetting<T>(key: OrgSettingKey, orgId: string): Promise<T> {
    try {
        return await (await send(key, orgId)).json();
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        const body = errorBody(err) ?? {};
        throw new Error(body.error || `HTTP ${err.status}`, { cause: err });
    }
}

export function useOrgSettingRead<T>(key: OrgSettingKey, orgId: string | null | undefined) {
    const query = useQuery<T>({
        queryKey: ['orgAdmin', 'setting', key, orgId],
        enabled: !!orgId,
        staleTime: 0,
        retry: false,
        queryFn: () => readOrgSetting<T>(key, String(orgId)),
    });
    return {
        server: query.isError ? null : query.data ?? null,
        loading: query.isFetching || (!!orgId && query.isPending),
        loadError: query.error ? errorMessage(query.error) : null,
        refetch: query.refetch,
    };
}
