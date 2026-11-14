// The CMS editor's own reads: the site list and the editor payload of the
// active site. The caller names the endpoint (its URL helpers live next to the
// panel, which api/ may not import) and the payload type. Not kept once the
// editor lets go of a site (gcTime 0): switching back reads the site afresh,
// as the editor always did.

import { useQuery } from '@tanstack/react-query';
import { settled } from '../settled';
import { READ_ONCE } from './readOnce';

/** GET `url` once per key; a non-ok answer is an error `<failText> (<status>)`. Off while `url` is null. */
export function useCmsEditorRead<T>(key: readonly unknown[], url: string | null, failText: string) {
    return useQuery<T, Error>({
        queryKey: ['cms', 'editor', ...key],
        enabled: !!url,
        ...READ_ONCE,
        gcTime: 0,
        queryFn: async () => {
            const res = await settled(url as string, undefined, 'empty');
            if (!res.ok) throw new Error(`${failText} (${res.status})`);
            return (await res.res.json()) as T;
        },
    });
}
