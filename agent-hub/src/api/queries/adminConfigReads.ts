// Admin configuration reads: the installed locales, the SSO providers and the
// four lists the skill editor's pickers share.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { getLanguages } from '../languages';
import { settled } from '../settled';
import { readOrNull } from './refusableRead';

const adminConfigKeys = {
    languages: () => ['admin-config', 'languages'] as const,
    sso: () => ['admin-config', 'sso-providers'] as const,
    serverUrl: () => ['admin-config', 'server-url'] as const,
    skillPickers: () => ['admin-config', 'skill-pickers'] as const,
};

/** The cache key of the languages answer, for the actions that write the new locale list into it. */
export const languagesKey = adminConfigKeys.languages();

export interface LanguagesAnswer<Locale, Catalog> { locales: Locale[]; catalog: Catalog[] }

/** GET /api/languages: the installed locales and the catalogue that can be added. */
export function useLanguagesQuery<Locale, Catalog>() {
    return useQuery<LanguagesAnswer<Locale, Catalog>, Error>({
        queryKey: languagesKey,
        queryFn: async () => {
            const data = await (await getLanguages()).json();
            return { locales: data.locales || [], catalog: data.catalog || [] };
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET /auth/providers: the SSO providers' configuration (a refusal reads as "keep the form's defaults"). */
export function useSsoProvidersQuery<P>() {
    return useQuery<P | null, Error>({
        queryKey: adminConfigKeys.sso(),
        queryFn: ({ signal }) => readOrNull<P>(`${API_BASE}/auth/providers`, signal),
        staleTime: 0,
        retry: false,
    });
}

/** The server's public URL for the redirect-URI instructions ('' until known). */
export function useServerUrlQuery() {
    return useQuery<string, Error>({
        queryKey: adminConfigKeys.serverUrl(),
        queryFn: async () => {
            const res = await settled(`${API_BASE}/auth/setup-status`, undefined, 'empty');
            if (!res.ok) return '';
            const data = await res.res.json();
            return data.serverUrl || '';
        },
        retry: false,
    });
}

/** One list of the skill editor's pickers: its rows, and whether it could be read. */
export interface PickerRead<T> { rows: T[]; ok: boolean }
const UNREAD: PickerRead<never> = Object.freeze({ rows: [], ok: false }) as PickerRead<never>;

async function readPickerList<T>(path: string, pick: (body: unknown) => unknown, signal?: AbortSignal): Promise<PickerRead<T>> {
    try {
        const body = await readOrNull<unknown>(`${API_BASE}${path}`, signal);
        const rows = body === null ? null : pick(body);
        return Array.isArray(rows) ? { rows: rows as T[], ok: true } : UNREAD;
    } catch {
        return UNREAD;
    }
}

export interface SkillPickerLists<Group, Automation, Kb, Table> {
    groups: PickerRead<Group>;
    automations: PickerRead<Automation>;
    kbs: PickerRead<Kb>;
    tables: PickerRead<Table>;
}

/**
 * The org's groups, the callable automations, the knowledge bases and the
 * datatables the skill editor's pickers offer. Each list is read on its own:
 * one that falls over must not take the editor down, and "could not be read"
 * stays a different answer from "there are none" (`ok`).
 */
export function useSkillPickerListsQuery<Group, Automation, Kb, Table>(enabled: boolean) {
    return useQuery<SkillPickerLists<Group, Automation, Kb, Table>, Error>({
        queryKey: adminConfigKeys.skillPickers(),
        enabled,
        queryFn: async ({ signal }) => {
            const [groups, automations, kbs, tables] = await Promise.all([
                readPickerList<Group>('/auth/groups', (b) => b, signal),
                readPickerList<Automation>('/api/automation', (b) => (b as { automations?: unknown } | null)?.automations, signal),
                readPickerList<Kb>('/api/kb?context=agent', (b) => (Array.isArray(b) ? b : (b as { knowledgeBases?: unknown } | null)?.knowledgeBases), signal),
                readPickerList<Table>('/api/datatables', (b) => (b as { datatables?: unknown } | null)?.datatables, signal),
            ]);
            return { groups, automations, kbs, tables };
        },
        staleTime: 0,
        retry: false,
    });
}
