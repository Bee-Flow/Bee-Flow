/**
 * The open knowledge base's header — the web's KnowledgeDetail
 * StudioSectionHeader: the kb tile, the name, "Updated …" (or "Nothing in it
 * yet"), "Add a source" as the primary on the tabs where material goes in,
 * and the five sections. Chatting with it, starring, sharing and deleting sit
 * behind the overflow button.
 */

import React, { useState } from 'react';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Button, Icon, IconButton, ObjectHeader, type ActionMenuItem, type TabBarItem } from '@/shared/ui';

import type { KnowledgeBase } from '../model/types';

export type KbTab = 'sources' | 'documents' | 'ask' | 'settings' | 'usage';

const KB_TABS: readonly KbTab[] = ['sources', 'documents', 'ask', 'settings', 'usage'];

/** A `?tab=` value from a link, or the Sources tab for anything else. */
export const kbTabFrom = (raw: string | undefined): KbTab => KB_TABS.find((t) => t === raw) ?? 'sources';

export interface KbHeaderProps {
    kb: KnowledgeBase | null | undefined;
    tab: KbTab;
    onTab: (tab: KbTab) => void;
    counts: { sources?: number; documents?: number; usage?: number };
    favorite: boolean;
    canManage: boolean;
    onAdd: () => void;
    onChat: () => void;
    onFavorite: () => void;
    onShare: () => void;
    onDelete: () => void;
}

function tabsOf(t: TranslateFn, counts: KbHeaderProps['counts']): TabBarItem<KbTab>[] {
    return [
        { id: 'sources', label: t('knowledge.tab_sources', 'Sources'), count: counts.sources },
        { id: 'documents', label: t('mobile.knowledge.tab_documents', 'Documents'), count: counts.documents },
        { id: 'ask', label: t('knowledge.tab_ask', 'Test question') },
        { id: 'settings', label: t('knowledge.tab_settings', 'Settings') },
        { id: 'usage', label: t('usage.table_label', 'Used by'), count: counts.usage },
    ];
}

function menuOf(t: TranslateFn, p: KbHeaderProps): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
        { id: 'chat', label: t('mobile.knowledge.chat', 'Chat with this knowledge base'), icon: 'MessageSquare', onPress: p.onChat },
        {
            id: 'favorite',
            label: p.favorite ? t('mobile.knowledge.unfavorite', 'Remove from favourites') : t('mobile.knowledge.favorite', 'Add to favourites'),
            icon: 'Star',
            onPress: p.onFavorite,
        },
    ];
    if (p.canManage) {
        items.push(
            { id: 'share', label: t('visibility.title', 'Publish to…'), icon: 'Users', onPress: p.onShare },
            { id: 'delete', label: t('knowledge.settings.delete_open', 'Delete this knowledge base'), icon: 'Trash2', destructive: true, onPress: p.onDelete },
        );
    }
    return items;
}

export function KbHeader(p: KbHeaderProps) {
    const t = useTranslation();
    const theme = useTheme();
    const [menu, setMenu] = useState(false);
    const at = p.kb?.last_content_at;
    const status = at ? t('knowledge.updated_chip', 'Updated {when}', { when: timeAgo(at, { suffix: true }) }) : t('knowledge.never_filled', 'Nothing in it yet');
    const adds = p.canManage && (p.tab === 'sources' || p.tab === 'documents');
    return (
        <>
            <ObjectHeader
                kind="kb"
                title={p.kb?.name ?? ''}
                status={p.kb ? status : undefined}
                backLabel={t('knowledge.back', 'Back to Knowledge')}
                primary={adds ? <Button size="sm" iconName="Plus" label={t('knowledge.add_source', 'Add a source')} onPress={p.onAdd} testID="kb-add" /> : null}
                extras={
                    p.kb ? (
                        <IconButton icon={<Icon name="MoreVertical" size={20} color={theme.colors.textSecondary} />}
                            accessibilityLabel={t('mobile.knowledge.more', 'More for this knowledge base')} onPress={() => setMenu(true)} />
                    ) : null
                }
                tabs={tabsOf(t, p.counts)}
                activeTab={p.tab}
                onTab={p.onTab}
            />
            <ActionMenu visible={menu} onClose={() => setMenu(false)} items={menuOf(t, p)} />
        </>
    );
}
