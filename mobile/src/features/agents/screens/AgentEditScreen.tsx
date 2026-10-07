/**
 * The manual agent editor at /agents/<id>/edit — the web's builder fields
 * that fit a phone, saved as a whole with a Save bar (PUT /agents/:id with
 * `baseVersion`). It opens the CONCEPT (`?draft=1`), which is what the web
 * edits, and says when saved changes still need publishing.
 *
 * Someone who may not edit sees the fields read-only with the reason; the
 * profile never offers them the way in, but a link can.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AiActComplianceGroup } from '@/features/ai-act';
import { QueryScreen, useConfirmLeave } from '@/shared/patterns';
import { Banner, Icon, IconButton, SaveBar, ScreenHeader } from '@/shared/ui';

import { EditorBanners } from '../components/editor/EditorBanners';
import { EditorForm } from '../components/editor/EditorForm';
import { SharingRow } from '../components/editor/SharingRow';
import { useAgentDraftDetail } from '../hooks/editor';
import { useAgentForm } from '../hooks/useAgentForm';
import { useEditorSave } from '../hooks/useEditorSave';
import { draftOf, type AgentDetail } from '../model/draft';
import { canEditAgent } from '../model/permissions';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl } });

function AgentEditor({ agent }: { agent: AgentDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const manage = useHasPermission('manage_agents');
    const form = useAgentForm(draftOf(agent));
    const save = useEditorSave(agent, form);
    const locked = !canEditAgent(agent, manage) || save.locked;
    useConfirmLeave(form.dirty && !locked);

    return (
        <>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                {locked && !save.error ? (
                    <Banner tone="info" icon="Lock">
                        {t('mobile.agents.editor.read_only', 'You can open this agent but not change it: that takes the permission to manage agents, and edit rights on this one.')}
                    </Banner>
                ) : null}
                <EditorBanners agent={agent} save={save} dirty={form.dirty} />
                <EditorForm form={form} disabled={locked || save.saving} extra={<SharingRow agent={agent} disabled={locked} />} />
                <AiActComplianceGroup kind="agent" id={agent.id} />
            </ScrollView>
            <SaveBar
                dirty={form.dirty && !locked}
                saving={save.saving}
                onSave={() => void save.save()}
                onDiscard={form.discard}
                blockedReason={form.errors.name ?? null}
            />
        </>
    );
}

function EditHeader({ id, agent }: { id: string; agent: AgentDetail | undefined }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const manage = useHasPermission('manage_agents');
    return (
        <ScreenHeader
            title={t('agent.edit_agent', 'Edit Agent')}
            subtitle={agent?.name}
            actions={
                agent && canEditAgent(agent, manage) ? (
                    <IconButton
                        icon={<Icon name="Sparkles" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel={t('mobile.agents.edit_with_ai', 'Edit with AI')}
                        // Replace, so unsaved edits here meet the leave guard first.
                        onPress={() => router.replace(`/agents/${id}/refine`)}
                    />
                ) : null
            }
        />
    );
}

export function AgentEditScreen({ id }: { id: string }) {
    const detail = useAgentDraftDetail(id);
    return (
        <QueryScreen query={detail} scroll={false} screen={{ avoidKeyboard: true }} header={(agent) => <EditHeader id={id} agent={agent} />}>
            {(agent) => <AgentEditor key={agent.id} agent={agent} />}
        </QueryScreen>
    );
}
