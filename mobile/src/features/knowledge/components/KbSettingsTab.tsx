/**
 * "Settings" — the web's KnowledgeDetail SettingsTab: name and description,
 * where it can be used, who may see it and its category, a copy (empty or
 * with its sources), a re-index, and the delete. Every change saves on its
 * own; a failure is said once, as a toast.
 *
 * Re-index re-reads and re-embeds every source. The web keeps it off the
 * Studio (it teaches that a base needs repairing); the phone offers it under
 * the copy, behind a confirmation, because an owner switching embedding
 * models on the road has no other way to do it.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { BlockList, useConfirm, type Block } from '@/shared/patterns';
import { Banner, Button, Section, Text, useToast } from '@/shared/ui';

import { KbAudience } from './KbAudience';
import { KbNameFields } from './KbNameFields';
import { KbSurfaces } from './KbSurfaces';
import { useDuplicateKnowledgeBase, useKbCategories, useKbUsage, usePublishKnowledgeBase, useReindexKnowledgeBase, useUpdateKnowledgeBase } from '../hooks/manage';
import { reindexOutcome } from '../model/settings';
import type { KnowledgeBase } from '../model/types';

function CopySection({ t, busy, onCopy, onReindex }: { t: TranslateFn; busy: boolean; onCopy: (withSources: boolean) => void; onReindex: () => void }) {
    return (
        <Section title={t('knowledge.settings.duplicate_title', 'Make a copy')} subtitle={t('knowledge.settings.duplicate_hint', 'Documents are never copied. A copied source reads its own files and pages again on its first refresh, so the copy gets what is there now.')}>
            <Button variant="secondary" label={t('knowledge.settings.duplicate_shell', 'Empty copy')} disabled={busy} onPress={() => onCopy(false)} testID="kb-duplicate-shell" />
            <Button variant="secondary" label={t('knowledge.settings.duplicate_sources', 'Copy with its sources')} disabled={busy} onPress={() => onCopy(true)} />
            <Button variant="ghost" iconName="RotateCw" label={t('mobile.knowledge.reindex', 'Re-index everything')} disabled={busy} onPress={onReindex} />
        </Section>
    );
}

export function KbSettingsTab({ kb, canManage, onDelete, refreshing, onRefresh }: {
    kb: KnowledgeBase; canManage: boolean; onDelete: () => void; refreshing: boolean; onRefresh: () => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const confirm = useConfirm();
    const { toast } = useToast();
    const fail = (e: Error) => toast(describeError(e).message || t('knowledge.settings.err_save', 'Could not save that change.'), 'error');
    const usage = useKbUsage(kb.id);
    const categories = useKbCategories();
    const update = useUpdateKnowledgeBase(kb.id, { onError: fail });
    const publish = usePublishKnowledgeBase(kb.id, { onError: fail });
    const duplicate = useDuplicateKnowledgeBase(kb.id, { onSuccess: (copy) => copy?.id && router.push(`/knowledge/${copy.id}`), onError: fail });
    const reindex = useReindexKnowledgeBase(kb.id, {
        onSuccess: (r) => {
            const outcome = reindexOutcome(t, r);
            toast(outcome.text, outcome.tone);
        },
        onError: fail,
    });
    const editable = canManage && kb.source_kind !== 'system_managed';
    const askReindex = async () => {
        const ok = await confirm({
            title: t('mobile.knowledge.reindex_title', 'Re-index “{name}”?', { name: kb.name }),
            message: t('mobile.knowledge.reindex_message', 'Every source is read again and every document re-embedded with the current model. This can take a while.'),
            confirmLabel: t('mobile.knowledge.reindex', 'Re-index everything'),
        });
        if (ok) reindex.mutate();
    };
    const blocks: Block[] = [];
    if (!editable) blocks.push({ key: 'ro', gap: 'section', render: () => <Banner tone="info" icon="Lock">{t('mobile.knowledge.settings_read_only', 'You can see these settings but not change them.')}</Banner> });
    blocks.push(
        { key: 'names', gap: 'section', render: () => <KbNameFields key={kb.id} kb={kb} disabled={!editable} onSave={(patch) => update.mutate(patch)} /> },
        { key: 'surfaces', gap: 'section', render: () => <KbSurfaces kb={kb} usage={usage.data?.usage} disabled={!editable || update.isPending} onChange={(usageContexts) => update.mutate({ usageContexts })} /> },
        { key: 'audience', gap: 'section', render: () => (
            <KbAudience kb={kb} canManage={editable} categories={categories.data ?? []} onPublish={(a) => publish.mutate({ isPublished: a.isShared, sharedGroups: a.sharedGroups })} onSave={(patch) => update.mutate(patch)} />
        ) },
    );
    if (editable) {
        blocks.push(
            { key: 'copy', gap: 'section', render: () => <CopySection t={t} busy={duplicate.isPending || reindex.isPending} onCopy={(w) => duplicate.mutate(w)} onReindex={() => void askReindex()} /> },
            { key: 'delete', gap: 'section', render: () => (
                <Section title={t('knowledge.settings.delete_open', 'Delete this knowledge base')}>
                    <Text variant="caption" tone="secondary">{t('knowledge.settings.delete_notice', 'Its documents go with it. The original files, pages and folders they were read from stay where they are.')}</Text>
                    <Button variant="danger" label={t('knowledge.settings.delete_open', 'Delete this knowledge base')} onPress={onDelete} />
                </Section>
            ) },
        );
    }
    return <BlockList blocks={blocks} refreshing={refreshing} onRefresh={onRefresh} testID="kb-settings" />;
}
