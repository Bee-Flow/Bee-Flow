/**
 * Who may see a knowledge base, and its category (the web's SettingsTab
 * audience and CategoryField).
 *
 * A PERSONAL base cannot be shared — publishing needs an organisation — so it
 * offers the one-way move into the owner's organisation instead, and says
 * what that changes (admins may manage it) before the button. Sharing goes
 * through its own route (PATCH /:id/publish).
 */

import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { AudienceSheet, useConfirm, useOrgGroups, type Audience } from '@/shared/patterns';
import { ActionMenu, Card, Divider, ListRow, Section, type ActionMenuItem } from '@/shared/ui';

import type { KbCategory, KnowledgeBase } from '../model/types';

function audienceLine(t: TranslateFn, kb: KnowledgeBase): string {
    if (!kb.is_published) return t('visibility.personal', 'Personal');
    const n = kb.shared_groups?.length ?? 0;
    if (n === 0) return t('visibility.entire_org', 'Entire organisation');
    return n === 1 ? t('visibility.one_group', '1 group') : t('visibility.n_groups', '{count} groups', { count: n });
}

function categoryItems(t: TranslateFn, kb: KnowledgeBase, categories: readonly KbCategory[], onPick: (id: string | null) => void): ActionMenuItem[] {
    return [
        { id: '', label: t('knowledge.filter_uncategorised', 'Uncategorised'), selected: !kb.category_id, onPress: () => onPick(null) },
        ...categories.map((c) => ({ id: c.id, label: c.name, selected: c.id === kb.category_id, onPress: () => onPick(c.id) })),
    ];
}

export interface KbAudienceProps {
    kb: KnowledgeBase;
    canManage: boolean;
    categories: readonly KbCategory[];
    onPublish: (next: Audience) => void;
    onSave: (patch: { categoryId?: string | null; organizationId?: string }) => void;
}

export function KbAudience({ kb, canManage, categories, onPublish, onSave }: KbAudienceProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { user } = useAuth();
    const [sheet, setSheet] = useState<'audience' | 'category' | null>(null);
    const groups = useOrgGroups(sheet === 'audience');
    const personal = !kb.organization_id;
    const orgId = user?.organizationId;
    const category = categories.find((c) => c.id === kb.category_id)?.name ?? t('knowledge.filter_uncategorised', 'Uncategorised');
    const move = async () => {
        const ok = await confirm({
            title: t('knowledge.settings.move_to_org', 'Move to my organisation'),
            message: t('knowledge.settings.move_consequence', 'It stays unshared until you pick an audience — but administrators will be able to see and manage it, and this cannot be undone.'),
            confirmLabel: t('knowledge.settings.move_to_org', 'Move to my organisation'),
        });
        if (ok && orgId) onSave({ organizationId: orgId });
    };
    return (
        <Section title={t('knowledge.settings.who_title', 'Who may see and use it')} subtitle={personal ? t('knowledge.settings.personal_hint', 'A personal knowledge base cannot be shared. Move it into your organisation to choose an audience.') : t('knowledge.settings.who_hint', 'An agent can only answer from this knowledge base for someone who may see it. Everyone else gets the same answer with this left out — never an error.')}>
            <Card padded={false}>
                {personal ? (
                    <ListRow title={t('knowledge.settings.personal_title', 'Personal — only you can see this')}
                        subtitle={canManage && orgId ? t('knowledge.settings.move_to_org', 'Move to my organisation') : undefined}
                        chevron={canManage && Boolean(orgId)} onPress={canManage && orgId ? () => void move() : undefined} />
                ) : (
                    <ListRow title={t('visibility.title', 'Publish to…')} subtitle={audienceLine(t, kb)} chevron={canManage}
                        onPress={canManage ? () => setSheet('audience') : undefined} testID="kb-audience" />
                )}
                <Divider />
                <ListRow title={t('mobile.knowledge.category', 'Category')} subtitle={category} chevron={canManage}
                    onPress={canManage ? () => setSheet('category') : undefined} />
            </Card>
            <AudienceSheet visible={sheet === 'audience'} onClose={() => setSheet(null)} name={kb.name}
                value={{ isShared: kb.is_published, sharedGroups: kb.shared_groups ?? [] }} groups={groups.data ?? null} groupsLoading={groups.isLoading}
                onRetryGroups={() => void groups.refetch()} canShare={!personal} onChange={onPublish} />
            <ActionMenu visible={sheet === 'category'} onClose={() => setSheet(null)} title={t('mobile.knowledge.category', 'Category')}
                items={categoryItems(t, kb, categories, (categoryId) => onSave({ categoryId }))} />
        </Section>
    );
}
