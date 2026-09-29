/**
 * One skill, read in full.
 *
 * The point of this screen is that a person can see exactly what a pack will
 * add to their prompt before switching it on — including a colleague's shared
 * skill, which they can read but never edit. The four blocks are shown in the
 * order the server injects them (instructions, workflow, rules, examples; see
 * core/tools/skillInjection.js), and empty ones are omitted rather than shown
 * as empty headings.
 *
 * GET /api/skills/:id resolves against what the caller may actually see — own
 * personal skills, plus org skills that pass the share/group check — so a 404
 * here means "not yours to read", and describeError says so without inventing
 * a reason.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import { useActiveSkills } from '../../src/features/skills/active';
import {
    canDeleteSkill,
    canEditSkill,
    deleteSkill,
    getSkill,
    skillKeys,
    updateSkill,
} from '../../src/features/skills/api';
import { SkillFormSheet } from '../../src/features/skills/components/SkillFormSheet';
import {
    ACTIVE_SKILL_CAP,
    draftFromSkill,
    type Skill,
    type SkillDraft,
} from '../../src/features/skills/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { ToggleRow } from '../../src/ui/Controls';
import { ErrorState, LoadingState } from '../../src/ui/Feedback';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet } from '../../src/ui/Sheet';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function SkillDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user } = useAuth();

    const [editing, setEditing] = useState(false);
    // See the note on SkillFormSheet: a new key per opening re-seeds the form
    // from the skill as it stands now.
    const [formSession, setFormSession] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const { isActive, toggle } = useActiveSkills();

    const query = useQuery({
        queryKey: skillKeys.detail(id),
        queryFn: ({ signal }) => getSkill(id, signal),
        enabled: Boolean(id),
    });

    // The list already holds a row of exactly this shape, so the screen can
    // paint from it while the fetch confirms it — GET /:id returns the same
    // mapRow output the list does. Read straight from the cache rather than
    // through placeholderData so a stale row is never mistaken for a fetched
    // one by the query's own state.
    const cached = queryClient
        .getQueryData<Skill[]>(skillKeys.list)
        ?.find((s) => s.id === id);

    const openForm = (): void => {
        setFormSession((n) => n + 1);
        setEditing(true);
    };

    const save = useMutation({
        mutationFn: (draft: SkillDraft) => updateSkill(id, draft),
        onSuccess: () => {
            setEditing(false);
            toast('Saved', 'success');
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
        },
    });

    const remove = useMutation({
        mutationFn: () => deleteSkill(id),
        onSuccess: () => {
            toast('Skill deleted', 'success');
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
            router.back();
        },
        onError: (error) => toast(error instanceof Error ? error.message : 'Could not delete', 'error'),
    });

    const skill = query.data ?? cached ?? null;
    const active = Boolean(skill && isActive(skill.id));
    // The server's own verdict, carried on the row. `manage_skills` is not
    // consulted here any more: it is one half of the rule the server already
    // applied, and asking it again locally only reintroduces the drift.
    const editable = skill ? canEditSkill(skill) : false;
    const deletable = skill ? canDeleteSkill(skill, user?.id, Boolean(user?.isAdmin)) : false;
    const dynamic = Boolean(skill && (skill.dynamicActivation || skill.automationId));

    const header = (
        <ScreenHeader
            title={skill?.name ?? 'Skill'}
            actions={
                <>
                    {editable ? (
                        <IconButton
                            icon={<Feather name="edit-2" size={18} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Edit this skill"
                            onPress={openForm}
                        />
                    ) : null}
                </>
            }
        />
    );

    if (query.isLoading && !skill) {
        return (
            <Screen edges={['top', 'bottom']}>
                {header}
                <LoadingState label="Loading the skill" />
            </Screen>
        );
    }

    if (!skill) {
        return (
            <Screen edges={['top', 'bottom']}>
                {header}
                <ErrorState
                    error={query.error ?? new Error('This skill is not available to you.')}
                    onRetry={() => void query.refetch()}
                />
            </Screen>
        );
    }

    return (
        <Screen edges={['top', 'bottom']}>
            {header}

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={query.isRefetching}
                        onRefresh={() => void query.refetch()}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                <Card>
                    <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'center' }}>
                        <View
                            style={{
                                width: 48,
                                height: 48,
                                borderRadius: theme.radii.md,
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: theme.colors.bgTertiary,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: active ? theme.colors.accentPrimary : 'transparent',
                            }}
                        >
                            <Text variant="title" accessibilityElementsHidden>
                                {skill.icon}
                            </Text>
                        </View>
                        <View style={{ flex: 1, gap: 4 }}>
                            <Text variant="heading">{skill.name}</Text>
                            {skill.description ? (
                                <Text variant="caption" tone="tertiary">
                                    {skill.description}
                                </Text>
                            ) : null}
                        </View>
                    </View>

                    {skill.isShared || dynamic || skill.enabledIntegrations.length > 0 ? (
                        <View
                            style={{
                                flexDirection: 'row',
                                flexWrap: 'wrap',
                                gap: theme.spacing.xs,
                                marginTop: theme.spacing.md,
                            }}
                        >
                            {skill.isShared ? (
                                <Badge
                                    label={
                                        skill.sharedGroups.length > 0
                                            ? `Shared with ${skill.sharedGroups.length} group${skill.sharedGroups.length === 1 ? '' : 's'}`
                                            : 'Shared with the organisation'
                                    }
                                />
                            ) : (
                                <Badge label="Only you" />
                            )}
                            {dynamic ? <Badge label="Loaded when relevant" tone="accent" /> : null}
                            {skill.enabledIntegrations.length > 0 ? (
                                <Badge
                                    label={`${skill.enabledIntegrations.length} integration${skill.enabledIntegrations.length === 1 ? '' : 's'}`}
                                    tone="accent"
                                />
                            ) : null}
                        </View>
                    ) : null}
                </Card>

                <Card padded={false}>
                    <ToggleRow
                        label="Use in new chats"
                        description={
                            dynamic
                                ? 'Offered to the model, which pulls it in when it fits.'
                                : 'Added to every message until you switch it off.'
                        }
                        value={active}
                        // One handler for the row and the switch. They used to
                        // be two, and the switch's copy had dropped the cap
                        // message — so tapping the row explained why nothing
                        // happened and tapping the switch just did nothing.
                        onValueChange={() => {
                            if (!toggle(skill.id)) {
                                toast(
                                    `${ACTIVE_SKILL_CAP} skills at once is the limit — switch one off first`,
                                    'error',
                                );
                            }
                        }}
                        icon={
                            <Feather name="zap" size={18} color={theme.colors.textSecondary} />
                        }
                    />
                </Card>

                <Block title="Instructions" body={skill.instructions} />
                <Block title="Workflow" body={skill.workflow} />
                <Block title="Rules" body={skill.rules} />
                <Block title="Examples" body={skill.examples} />

                <Section title="About">
                    <Card padded={false}>
                        <MetaRow
                            label="Created"
                            value={relativeTime(skill.createdAt, { suffix: true }) || 'Unknown'}
                        />
                        <Divider inset={theme.spacing.lg} />
                        <MetaRow
                            label="Last changed"
                            value={relativeTime(skill.updatedAt, { suffix: true }) || 'Never'}
                        />
                        {skill.automationId ? (
                            <>
                                <Divider inset={theme.spacing.lg} />
                                <MetaRow label="Runs an automation" value="Yes" />
                            </>
                        ) : null}
                    </Card>
                </Section>

                {editable || deletable ? (
                    <View style={{ gap: theme.spacing.sm }}>
                        {editable ? (
                            <Button
                                label="Edit skill"
                                variant="secondary"
                                fullWidth
                                onPress={openForm}
                            />
                        ) : null}
                        {deletable ? (
                            <Button
                                label="Delete skill"
                                variant="destructive"
                                fullWidth
                                onPress={() => setConfirmDelete(true)}
                            />
                        ) : null}
                    </View>
                ) : (
                    <Text variant="caption" tone="tertiary">
                        Someone else owns this skill, so it is read-only here. You can still switch
                        it on for your own chats.
                    </Text>
                )}
            </ScrollView>

            <SkillFormSheet
                key={formSession}
                visible={editing}
                initial={draftFromSkill(skill)}
                busy={save.isPending}
                error={save.error}
                canShare={Boolean(user?.organizationId)}
                onClose={() => setEditing(false)}
                onSubmit={(draft) => save.mutate(draft)}
            />

            <ConfirmSheet
                visible={confirmDelete}
                title={`Delete “${skill.name}”?`}
                message="The skill is removed for everyone it was shared with, and detached from every agent that used it. Chats that already ran with it keep their answers. This cannot be undone."
                confirmLabel="Delete skill"
                busy={remove.isPending}
                onCancel={() => setConfirmDelete(false)}
                onConfirm={() => remove.mutate()}
            />
        </Screen>
    );
}

/** One of the four prompt blocks. Renders nothing when the block is empty. */
function Block({ title, body }: { title: string; body: string }) {
    const theme = useTheme();
    if (!body.trim()) return null;
    return (
        <Section title={title}>
            <Card>
                <Text variant="body" style={{ lineHeight: theme.type.body.lineHeight + 2 }}>
                    {body}
                </Text>
            </Card>
        </Section>
    );
}

function MetaRow({ label, value }: { label: string; value: string }) {
    const theme = useTheme();
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                minHeight: theme.minTouch,
            }}
        >
            <Text variant="body" style={{ flex: 1 }}>
                {label}
            </Text>
            <Text variant="caption" tone="tertiary">
                {value}
            </Text>
        </View>
    );
}
