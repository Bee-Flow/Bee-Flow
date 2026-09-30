/**
 * Filing a chat into a project. NOT part of the conversation PATCH — that
 * route does not read `project_id`, and sending it looks like it worked — so
 * it goes through the projects router, and taking a chat back out has its own
 * route that needs no project role (the assign route requires `editor`).
 */

import React from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { Card, Divider, Icon, Section, SettingRow, Text } from '@/shared/ui';

import { ProjectShareRow } from './ProjectShareRow';

const makeStyles = (theme: Theme) => ({
    swatch: { width: 18, height: 18, borderRadius: theme.radii.sm },
});

export function ProjectSection({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { projectsQuery, conversation, moveToProject } = details;
    const projects = projectsQuery.data ?? [];
    const currentId = conversation?.project_id ?? null;
    const current = projects.find((p) => p.id === currentId) ?? null;

    return (
        <Section
            title={t('mobile.chat.details.project', 'Project')}
            subtitle={t('mobile.chat.details.project_subtitle', "Filing a chat into a project shares it with the project's members.")}
        >
            {projectsQuery.isError ? (
                // Projects are licence-gated at the mount point, so a 402/403
                // here is an answer about the plan, not a bug.
                <Text variant="caption" tone="tertiary">
                    {describeError(projectsQuery.error).message}
                </Text>
            ) : projects.length === 0 ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.chat.details.no_projects', 'You are not a member of any project yet.')}
                </Text>
            ) : (
                <Card padded={false}>
                    <SettingRow
                        label={t('mobile.chat.details.no_project', 'No project')}
                        value={current ? undefined : t('mobile.chat.details.project_current', 'Current')}
                        icon={<Icon name="CircleMinus" size={18} color={theme.colors.textMuted} />}
                        disabled={!current || moveToProject.isPending}
                        onPress={() => moveToProject.mutate(null)}
                    />
                    {projects.map((project) => (
                        <View key={project.id}>
                            <Divider inset={theme.spacing.lg} />
                            <SettingRow
                                label={project.name}
                                value={project.id === currentId ? t('mobile.chat.details.project_current', 'Current') : undefined}
                                icon={
                                    <View
                                        style={[styles.swatch, { backgroundColor: project.color || theme.colors.bgTertiary }]}
                                    />
                                }
                                disabled={project.id === currentId || moveToProject.isPending}
                                onPress={() => moveToProject.mutate(project.id)}
                            />
                        </View>
                    ))}
                    {current ? (
                        <>
                            <Divider inset={theme.spacing.lg} />
                            <ProjectShareRow details={details} projectId={current.id} />
                        </>
                    ) : null}
                </Card>
            )}
        </Section>
    );
}
