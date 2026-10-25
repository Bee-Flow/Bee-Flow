// The redirect manager of the website CMS (server/routes/cmsRedirects.js):
// the draft list of old address -> new address per site, and the external
// hosts a redirect may point at. Edits land in the draft; the public site
// follows them at the next publish.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

/** One row of the list (server/stores/cms/redirectRules.js). */
export interface CmsRedirect {
    id: string;
    from: string;
    to: string;
    status: 301 | 302;
    external: boolean;
    /** Created by a slug change, not by hand. */
    auto: boolean;
}

export interface CmsRedirectDoc {
    redirects: CmsRedirect[];
    allowedHosts: string[];
}

export interface CmsRedirectInput {
    from: string;
    to: string;
    status: 301 | 302;
    external: boolean;
}

const base = (siteId: string) => `/api/cms/sites/${encodeURIComponent(siteId)}/redirects`;

const cmsRedirectKeys = {
    site: (siteId: string) => ['cmsRedirects', siteId] as const,
};

export function useCmsRedirects(siteId: string | null) {
    return useQuery<CmsRedirectDoc, Error>({
        queryKey: cmsRedirectKeys.site(siteId || ''),
        enabled: !!siteId,
        queryFn: async ({ signal }) => {
            const doc = await apiClient.get<Partial<CmsRedirectDoc>>(base(siteId || ''), { signal });
            return { redirects: doc?.redirects ?? [], allowedHosts: doc?.allowedHosts ?? [] };
        },
    });
}

/** Add, remove and the allow-list in one place; each refreshes the list and tells the panel a publish is due. */
export function useCmsRedirectActions(siteId: string | null, onSaved?: () => void) {
    const qc = useQueryClient();
    const done = async () => {
        await qc.invalidateQueries({ queryKey: cmsRedirectKeys.site(siteId || '') });
        onSaved?.();
    };
    const add = useMutation<unknown, Error, CmsRedirectInput>({
        mutationFn: (input) => apiClient.post(base(siteId || ''), input, { retry: false }),
        onSuccess: done,
    });
    const remove = useMutation<unknown, Error, string>({
        mutationFn: (id) => apiClient.delete(`${base(siteId || '')}/${encodeURIComponent(id)}`, { retry: false }),
        onSuccess: done,
    });
    const saveHosts = useMutation<unknown, Error, string[]>({
        mutationFn: (hosts) => apiClient.put(`${base(siteId || '')}/hosts`, { hosts }, { retry: false }),
        onSuccess: done,
    });
    return { add, remove, saveHosts };
}
