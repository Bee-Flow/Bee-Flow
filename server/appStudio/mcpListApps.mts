/** studio_list_apps: the apps the token's user owns (split out of mcpBuilder.js). */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type OwnedApp = {
    id: string; name: string; description?: string | null; icon?: string | null; definitionVersion: number;
    isPublished?: boolean; templateId?: string | null; updatedAt: unknown;
};

export async function runListApps(userId: string) {
    const rows = await nodeRequire('../stores/studioAppStore').getStudioAppsByUser(userId) as OwnedApp[] | null;
    return {
        apps: (rows || []).map((a) => ({
            appId: a.id,
            name: a.name,
            description: a.description || '',
            icon: a.icon || null,
            version: a.definitionVersion,
            published: !!a.isPublished,
            templateId: a.templateId || null,
            updatedAt: a.updatedAt,
        })),
    };
}
