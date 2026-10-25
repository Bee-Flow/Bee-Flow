// The UI locales the person can pick from (GET /api/languages/user/locales).
// A failure or a non-array answer is an empty list: Preferences then shows no
// language row (it only renders with more than one locale).

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export function useUiLocales<L>() {
    return useQuery<L[], Error>({
        queryKey: ['settings', 'ui-locales'] as const,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/languages/user/locales`);
                const data: unknown = await res.json();
                return Array.isArray(data) ? data : [];
            } catch (e) {
                console.warn('[Preferences] load locales failed', e);
                return [];
            }
        },
        staleTime: 0,
        retry: false,
    });
}
