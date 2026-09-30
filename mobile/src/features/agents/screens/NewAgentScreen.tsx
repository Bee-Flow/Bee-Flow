/**
 * A new agent at /agents/new — the Agents list's New action, in its two
 * shapes (the web's "Create with AI" and "Create empty agent"):
 *
 *   /agents/new?ai=1   describe it, and the builder AI writes it
 *   /agents/new        the manual editor, empty; POST /agents on save
 *
 * Creating takes `manage_agents`, as on the web.
 */

import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useHasPermission } from '@/core/access';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirmLeave } from '@/shared/patterns';
import { Banner, SaveBar, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { CreateWithAi } from '../components/CreateWithAi';
import { EditorForm } from '../components/editor/EditorForm';
import { useCreateAgent } from '../hooks/editor';
import { useAgentForm } from '../hooks/useAgentForm';
import { emptyDraft } from '../model/draft';
import { canCreateAgents } from '../model/permissions';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl } });

function ManualCreate() {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const styles = useThemedStyles(makeStyles);
    const form = useAgentForm(emptyDraft(''));
    const create = useCreateAgent();
    const dirty = form.dirty && !create.isSuccess;
    useConfirmLeave(dirty);

    // Navigate once the render after the save has dropped the leave guard;
    // replacing from inside onSuccess would be held by it.
    const createdId = create.data?.id;
    useEffect(() => {
        if (!createdId) return;
        toast(t('agent_wizard.builder.save_saved', 'Saved'), 'success');
        router.replace(`/agents/${createdId}`);
    }, [createdId, router, t, toast]);

    const save = () => {
        if (form.check()) create.mutate(form.draft);
    };

    return (
        <>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                {create.error ? <Banner tone="error">{describeError(create.error).message}</Banner> : null}
                <EditorForm form={form} disabled={create.isPending} />
            </ScrollView>
            <SaveBar dirty={dirty} saving={create.isPending} onSave={save} onDiscard={form.discard} blockedReason={form.errors.name ?? null} />
        </>
    );
}

export function NewAgentScreen({ ai }: { ai: boolean }) {
    const t = useTranslation();
    const allowed = canCreateAgents(useHasPermission('manage_agents'));
    const title = ai ? t('agent_studio.create_with_ai', 'Create with AI') : t('agent_studio.new_agent', 'New agent');
    let body = ai ? <CreateWithAi /> : <ManualCreate />;
    if (!allowed) {
        body = (
            <Banner tone="info" icon="Lock">
                {t('mobile.agents.create_not_allowed', 'Creating agents takes the permission to manage agents. Ask an administrator if you need it.')}
            </Banner>
        );
    }
    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <ScreenHeader title={title} />
            {body}
        </Screen>
    );
}
