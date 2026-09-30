/**
 * Studio's Workspace group — the things a member opens rather than builds,
 * which used to be the drawer's Cowork, Apps, Forms and Notebooks rows (and a
 * Cowork tab and a Chat | Cowork pill). Each row is offered on the terms the
 * drawer row had (model/gates.ts):
 *
 *   Cowork     everyone, with how many schedules are active
 *   Apps       app_studio and use_apps, and at least one published app — the
 *              directory of nothing is a dead end
 *   Forms      the automations licence and programme and use_forms — unless
 *              Studio's own Forms section already lists them for this builder
 *   Notebooks  the notebooks licence, switches and use_notebooks
 *
 * Decided here rather than in features/studio because it reads four other
 * features, and Studio imports none (a cycle through notifications).
 */

import { useAccess } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useStudioApps } from '@/features/apps';
import { useSchedules } from '@/features/cowork';
import { useStudioNav, type HubLink } from '@/features/studio';

import { offersApps, offersForms, offersNotebooks } from '../model/gates';
import { publishedApps } from '../model/nav';

export function useWorkspaceLinks(): HubLink[] {
    const t = useTranslation();
    const access = useAccess();
    const nav = useStudioNav();
    const wantsApps = offersApps(access);
    const apps = useStudioApps({ enabled: wantsApps });
    const schedules = useSchedules();
    const published = wantsApps ? publishedApps(apps.data ?? []) : [];
    const formsInStudio = nav.canSee && nav.sections.some((s) => s.id === 'forms' && !s.locked);

    const links: HubLink[] = [
        {
            id: 'cowork',
            icon: 'Handshake',
            label: t('sidebar.cowork', 'Cowork'),
            description: t('mobile.studio.workspace_cowork', 'Schedules, tasks and reminders that run without you'),
            count: (schedules.data ?? []).filter((s) => s.isActive).length,
            href: '/cowork',
        },
    ];
    if (published.length > 0) {
        links.push({
            id: 'apps',
            icon: 'AppWindow',
            label: t('sidebar.apps', 'Apps'),
            description: t('sidebar.all_apps_desc', 'Browse everything published for you'),
            count: published.length,
            href: '/apps',
        });
    }
    if (offersForms(access) && !formsInStudio) {
        links.push({
            id: 'forms',
            icon: 'ClipboardList',
            label: t('sidebar.forms', 'Forms'),
            description: t('studio.tab.forms_desc', 'Published forms, and what they start'),
            href: '/forms',
        });
    }
    if (offersNotebooks(access)) {
        links.push({
            id: 'notebooks',
            icon: 'FileText',
            label: t('sidebar.notebooks', 'Notebooks'),
            description: t('mobile.studio.workspace_notebooks', 'Your notes, with the AI beside them'),
            href: '/notebooks',
        });
    }
    return links;
}
