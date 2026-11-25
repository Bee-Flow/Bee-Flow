import { studioAppsApi } from '@/components/admin/Studio/AppStudio/studioAppsApi';
import type { DirectoryApp } from '@/pages/apps/AppsHomePage.types';

/** The audience list includes the caller's own drafts as well as published apps. */
export async function loadPublishedStudioApps(): Promise<DirectoryApp[]> {
    const result = await studioAppsApi.listAccessible();
    const apps: DirectoryApp[] = result.apps;
    return apps.filter(app => app?.id && (app.isPublished ?? app.is_published))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
}
