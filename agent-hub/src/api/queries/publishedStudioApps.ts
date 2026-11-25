import { useQuery } from '@tanstack/react-query';

/** One app as the directory lists it (studio apps API row). */
export interface DirectoryApp {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    accentColor?: string;
    category?: string;
    publishedAt?: string;
    isPublished?: boolean;
    is_published?: boolean;
    projectId?: string;
    updatedAt?: string;
}

export interface AppDirectoryScope {
    id?: string | null;
    organizationId?: string | null;
}

export function usePublishedStudioApps(
    listAccessible: () => Promise<{ apps: DirectoryApp[] }>,
    scope?: AppDirectoryScope | null,
    enabled = true,
) {
    return useQuery({
        queryKey: ['studio-apps', 'published', scope?.id, scope?.organizationId],
        queryFn: async () => {
            const { apps } = await listAccessible();
            return apps.filter(app => app?.id && (app.isPublished ?? app.is_published))
                .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
        },
        enabled,
        retry: false,
        staleTime: 0,
        gcTime: 0,
    });
}
