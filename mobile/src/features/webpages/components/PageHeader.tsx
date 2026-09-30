/**
 * The page's header: kind tile, name, whether colleagues can see it, and an
 * overflow menu with what the web keeps in its editor header's menu — make a
 * copy, export as PDF, delete — plus, while the page is public, its public
 * address in the browser. There is no Preview button: the page screen IS the
 * preview (components/PreviewTab.tsx).
 *
 * Export is offered only for a plain HTML page: the server refuses a React +
 * Material UI page (webpageExport.js), and a button that always fails is
 * worse than none. Delete is owner-only, like every write.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import {
    ActionMenu,
    Badge,
    Icon,
    IconButton,
    ObjectHeader,
    useToast,
    type ActionMenuItem,
    type TabBarItem,
} from '@/shared/ui';

import { useCloneWebpage } from '../hooks/mutations';
import { publicPagePath, useExportPdf, useOpenPublicPage } from '../hooks/usePageActions';
import type { WebpageTab } from '../model/tabs';
import type { Webpage } from '../model/types';

export interface PageHeaderProps {
    webpage: Webpage;
    readOnly: boolean;
    tabs: TabBarItem<WebpageTab>[];
    tab: WebpageTab;
    onTab: (tab: WebpageTab) => void;
    onDelete: () => void;
}

function useMenuItems(webpage: Webpage, readOnly: boolean, onDelete: () => void): ActionMenuItem[] {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const onError = (err: Error) => toast(describeError(err).message, 'error');
    const clone = useCloneWebpage(webpage.id, {
        onSuccess: (copy) => {
            toast(t('mobile.webpages.menu.cloned', 'Copy made'), 'success');
            if (copy) router.push(`/webpages/${encodeURIComponent(copy.id)}`);
        },
        onError,
    });
    const exportPdf = useExportPdf(webpage, { onError });
    const openPublic = useOpenPublicPage(webpage, { onError });
    const items: ActionMenuItem[] = [];
    if (publicPagePath(webpage)) {
        items.push({
            id: 'public',
            label: t('mobile.webpages.menu.open_public', 'Open public page in browser'),
            icon: 'ExternalLink',
            onPress: () => openPublic.mutate(),
        });
    }
    items.push({
        id: 'clone',
        label: t('mobile.webpages.menu.clone', 'Make a copy'),
        icon: 'Copy',
        onPress: () => clone.mutate(undefined),
    });
    if (!readOnly && webpage.framework === 'vanilla') {
        items.push({
            id: 'pdf',
            label: t('mobile.webpages.menu.export_pdf', 'Export as PDF'),
            icon: 'FileDown',
            onPress: () => exportPdf.mutate(),
        });
    }
    if (!readOnly) {
        items.push({
            id: 'delete',
            label: t('mobile.webpages.menu.delete', 'Delete page'),
            icon: 'Trash2',
            destructive: true,
            onPress: onDelete,
        });
    }
    return items;
}

export function PageHeader({ webpage, readOnly, tabs, tab, onTab, onDelete }: PageHeaderProps) {
    const t = useTranslation();
    const theme = useTheme();
    const [menuOpen, setMenuOpen] = useState(false);
    const items = useMenuItems(webpage, readOnly, onDelete);

    return (
        <>
            <ObjectHeader
                kind="webpage"
                icon={webpage.icon || null}
                title={webpage.name}
                backLabel={t('mobile.webpages.back', 'Back to Webpages')}
                status={
                    <Badge
                        label={
                            webpage.isPublished
                                ? t('studio.status.published', 'Published')
                                : t('studio.status.draft', 'Draft')
                        }
                        tone={webpage.isPublished ? 'success' : 'neutral'}
                    />
                }
                extras={
                    <IconButton
                        icon={<Icon name="EllipsisVertical" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.webpages.menu.more', 'More actions')}
                        onPress={() => setMenuOpen(true)}
                    />
                }
                tabs={tabs}
                activeTab={tab}
                onTab={onTab}
            />
            <ActionMenu visible={menuOpen} onClose={() => setMenuOpen(false)} title={webpage.name} items={items} />
        </>
    );
}
