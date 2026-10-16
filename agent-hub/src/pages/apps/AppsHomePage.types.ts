/** A published app as the directory lists it (studioAppsApi.listAccessible / listMine). */
export interface StudioAppRow {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    accentColor?: string;
    category?: unknown;
    publishedAt?: string;
    isPublished?: boolean;
    is_published?: boolean;
}
