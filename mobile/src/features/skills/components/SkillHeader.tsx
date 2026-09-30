/**
 * The open skill's header — the web's SkillDetail StudioSectionHeader: the
 * skill tile, the name (tap to rename), the save chip, "Improve with AI" as
 * the one primary action, and the four sections as tabs. Sharing and delete
 * sit behind the overflow button.
 */

import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Button, Icon, IconButton, ObjectHeader, type ActionMenuItem, type TabBarItem } from '@/shared/ui';

import type { SaveState } from '../hooks/useSkillEditor';

export type SkillTab = 'method' | 'examples' | 'test' | 'usage';

export interface SkillHeaderProps {
    name: string;
    saveState: SaveState;
    readOnly: boolean;
    tab: SkillTab;
    onTab: (tab: SkillTab) => void;
    exampleCount: number;
    usageCount: number | undefined;
    improving: boolean;
    onImprove: () => void;
    onRename: () => void;
    onShare: () => void;
    /** Absent when this viewer may not delete. */
    onDelete?: () => void;
}

function saveChip(t: TranslateFn, state: SaveState, readOnly: boolean): string {
    if (readOnly) return t('mobile.skills.read_only_chip', 'Read-only');
    if (state === 'saving') return t('common.saving', 'Saving…');
    if (state === 'error') return t('mobile.skills.save_failed', 'Not saved');
    return t('common.saved', 'Saved');
}

function tabsOf(t: TranslateFn, p: SkillHeaderProps): TabBarItem<SkillTab>[] {
    return [
        { id: 'method', label: t('skills_studio.tab.method', 'Method') },
        { id: 'examples', label: t('skills_studio.tab.examples', 'Examples'), count: p.exampleCount || undefined },
        { id: 'test', label: t('skills_studio.tab.test', 'Test') },
        { id: 'usage', label: t('skills_studio.tab.usage', 'Used by'), count: p.usageCount },
    ];
}

function menuOf(t: TranslateFn, p: SkillHeaderProps): ActionMenuItem[] {
    const items: ActionMenuItem[] = [];
    if (!p.readOnly) {
        items.push({ id: 'rename', label: t('studio.header.rename', 'Rename'), icon: 'PenLine', onPress: p.onRename });
        items.push({ id: 'share', label: t('visibility.title', 'Publish to…'), icon: 'Users', onPress: p.onShare });
    }
    if (p.onDelete) {
        items.push({ id: 'delete', label: t('skills_studio.delete_title', 'Delete skill'), icon: 'Trash2', destructive: true, onPress: p.onDelete });
    }
    return items;
}

export function SkillHeader(p: SkillHeaderProps) {
    const t = useTranslation();
    const theme = useTheme();
    const [menuOpen, setMenuOpen] = useState(false);
    const items = menuOf(t, p);
    return (
        <>
            <ObjectHeader
                kind="skill"
                title={p.name}
                status={saveChip(t, p.saveState, p.readOnly)}
                backLabel={t('skills_studio.back', 'All skills')}
                onTitlePress={p.readOnly ? undefined : p.onRename}
                titleHint={t('mobile.skills.rename_hint', 'Renames this skill')}
                primary={
                    p.readOnly ? null : (
                        <Button
                            size="sm"
                            iconName="Sparkles"
                            label={p.improving ? t('skills_studio.improving', 'Improving…') : t('skills_studio.improve', 'Improve with AI')}
                            loading={p.improving}
                            onPress={p.onImprove}
                            testID="skill-improve"
                        />
                    )
                }
                extras={
                    items.length > 0 ? (
                        <IconButton
                            icon={<Icon name="MoreVertical" size={20} color={theme.colors.textSecondary} />}
                            accessibilityLabel={t('mobile.skills.more', 'More for this skill')}
                            onPress={() => setMenuOpen(true)}
                        />
                    ) : null
                }
                tabs={tabsOf(t, p)}
                activeTab={p.tab}
                onTab={p.onTab}
            />
            <ActionMenu visible={menuOpen} onClose={() => setMenuOpen(false)} items={items} />
        </>
    );
}
