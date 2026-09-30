/**
 * What the editor has to tell the person above the fields: a save the server
 * refused, a save someone else made in between, and saved changes that are
 * not live yet.
 *
 * NOT LIVE YET. Once an agent has a published version (the concept/live
 * split, POST /agents/:id/publish-version) a save only writes the concept;
 * people keep chatting with the published one until the next publish. The
 * web says so in its header ("Publish new version"); this is that button.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { usePublishVersion } from '@/features/agents/hooks/editor';
import type { EditorSave } from '@/features/agents/hooks/useEditorSave';
import type { AgentDetail } from '@/features/agents/model/draft';
import { Banner, Button, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ stack: { gap: theme.spacing.sm } });

/** Saved concept edits that the runtime does not serve yet. */
export function hasUnpublishedChanges(agent: AgentDetail): boolean {
    return (agent.published_version ?? 0) > 0 && (agent.unpublishedChanges ?? 0) > 0;
}

function PublishBanner({ agent, dirty }: { agent: AgentDetail; dirty: boolean }) {
    const t = useTranslation();
    const { toast } = useToast();
    const publish = usePublishVersion(agent.id);
    if (!hasUnpublishedChanges(agent)) return null;
    return (
        <Banner
            tone="info"
            icon="Rocket"
            action={
                <Button
                    label={t('agent_studio.header.publish_new_version', 'Publish new version')}
                    size="sm"
                    loading={publish.isPending}
                    // Only what is saved can be published: the server copies its concept.
                    disabled={dirty || publish.isPending}
                    onPress={() => publish.mutate(undefined, { onError: (e) => toast(describeError(e).message, 'error') })}
                />
            }
        >
            {t('mobile.agents.editor.not_live', 'Your saved changes are not live yet: people keep chatting with the published version until you publish this one.')}
        </Banner>
    );
}

export function EditorBanners({ agent, save, dirty }: { agent: AgentDetail; save: EditorSave; dirty: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.stack}>
            {save.conflict ? (
                <Banner
                    tone="warning"
                    action={<Button label={t('agent_wizard.conflict.load_latest', 'Load latest')} size="sm" variant="secondary" onPress={save.loadLatest} />}
                >
                    {t('agent_wizard.conflict.load_latest_hint', 'Load latest — take the other version. Your unsaved changes in this tab are discarded.')}
                </Banner>
            ) : null}
            {save.error ? (
                <Banner tone="error" icon={save.locked ? 'Lock' : undefined}>
                    {save.error}
                </Banner>
            ) : null}
            <PublishBanner agent={agent} dirty={dirty} />
        </View>
    );
}
