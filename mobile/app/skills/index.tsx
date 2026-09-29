/**
 * The skill library.
 *
 * A skill is a reusable instruction pack. Switching one on here is what puts
 * its id into `activeSkillIds` on the next chat turn — the same field the web
 * composer sends — so this screen is the phone's equivalent of the composer's
 * skills popover, not a settings page. That is why the switch is on the row
 * itself and not two taps deep.
 *
 * Three separate permissions decide what this screen offers, all of them
 * enforced server-side and none of them guessed at:
 *   - the workspace's plan must include Skills at all (requireCapability in
 *     server/index.js), which is a 403 on the list itself;
 *   - creating and editing need `manage_skills`;
 *   - editing additionally needs ownership — skillStore pins the UPDATE to the
 *     creator, so a colleague's shared skill is read-only here.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import { useHasAnyPermission } from '../../src/features/settings/permissions';
import { retainExistingSkills, useActiveSkills } from '../../src/features/skills/active';
import {
    canDeleteSkill,
    createSkill,
    deleteSkill,
    listSkills,
    skillKeys,
} from '../../src/features/skills/api';
import { SkillFormSheet } from '../../src/features/skills/components/SkillFormSheet';
import { SkillRow } from '../../src/features/skills/components/SkillRow';
import { ACTIVE_SKILL_CAP, type Skill, type SkillDraft } from '../../src/features/skills/types';
import { useTheme } from '../../src/theme/ThemeProvider';
import { EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { SearchField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet } from '../../src/ui/Sheet';
import { useToast } from '../../src/ui/Toast';

export default function SkillsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user } = useAuth();
    const canManage = useHasAnyPermission('manage_skills');

    const [search, setSearch] = useState('');
    const [creating, setCreating] = useState(false);
    // Bumped on every open so the form sheet remounts with a clean draft; see
    // the note on SkillFormSheet.
    const [formSession, setFormSession] = useState(0);
    const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);

    const { activeSkillIds, isActive, toggle } = useActiveSkills();

    const query = useQuery({
        queryKey: skillKeys.list,
        queryFn: ({ signal }) => listSkills(signal),
    });

    // Forget switched-on skills the library no longer returns — deleted on the
    // web, or shared with a group this person has left. Only on a successful
    // load: a failed fetch is not evidence that anything is gone.
    useEffect(() => {
        if (!query.isSuccess || !query.data) return;
        retainExistingSkills(query.data.map((s) => s.id));
    }, [query.isSuccess, query.data]);

    const create = useMutation({
        mutationFn: (draft: SkillDraft) => createSkill(draft),
        onSuccess: (skill) => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
            if (skill?.id) router.push(`/skills/${skill.id}`);
        },
    });

    const remove = useMutation({
        mutationFn: (id: string) => deleteSkill(id),
        onSuccess: (_result, id) => {
            toast('Skill deleted', 'success');
            setPendingDelete(null);
            // The skill is gone from every agent that had it attached, and it
            // must not stay switched on for the next message either.
            retainExistingSkills(activeSkillIds.filter((v) => v !== id));
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
        },
        onError: (error) => toast(error instanceof Error ? error.message : 'Could not delete', 'error'),
    });

    const skills = useMemo(() => {
        const all = query.data ?? [];
        const needle = search.trim().toLowerCase();
        if (!needle) return all;
        return all.filter(
            (s) =>
                s.name.toLowerCase().includes(needle) ||
                s.description.toLowerCase().includes(needle) ||
                s.instructions.toLowerCase().includes(needle),
        );
    }, [query.data, search]);

    const openForm = (): void => {
        setFormSession((n) => n + 1);
        setCreating(true);
    };

    const onToggle = (skill: Skill): void => {
        if (toggle(skill.id)) return;
        toast(`${ACTIVE_SKILL_CAP} skills at once is the limit — switch one off first`, 'error');
    };

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title="Skills"
                subtitle={activeSkillIds.length > 0 ? `${activeSkillIds.length} of ${ACTIVE_SKILL_CAP} switched on for new chats` : 'Instruction packs you can switch on for a chat'}
            />

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Filter skills" />
            </View>

            {query.isLoading ? (
                <ListSkeleton />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : skills.length === 0 ? (
                <EmptyState
                    icon="zap"
                    title={search ? 'Nothing matches that' : 'No skills yet'}
                    message={
                        search
                            ? 'Try a different word.'
                            : canManage
                              ? 'A skill is a set of instructions you write once — a tone of voice, a checklist, a house format — and switch on when you need it.'
                              : 'Nobody has shared a skill with you yet, and your account cannot create them. An administrator can grant that.'
                    }
                    actionLabel={!search && canManage ? 'New skill' : undefined}
                    onAction={!search && canManage ? openForm : undefined}
                />
            ) : (
                <FlatList
                    data={skills}
                    keyExtractor={(skill) => skill.id}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    contentContainerStyle={{ paddingBottom: 96 }}
                    renderItem={({ item }) => (
                        <SkillRow
                            skill={item}
                            active={isActive(item.id)}
                            onPress={() => router.push(`/skills/${item.id}`)}
                            onToggle={() => onToggle(item)}
                            onLongPress={
                                canDeleteSkill(item, user?.id, Boolean(user?.isAdmin))
                                    ? () => setPendingDelete(item)
                                    : undefined
                            }
                        />
                    )}
                />
            )}

            {canManage ? (
                <Pressable
                    onPress={openForm}
                    accessibilityRole="button"
                    accessibilityLabel="New skill"
                    style={{
                        position: 'absolute',
                        right: theme.spacing.lg,
                        bottom: theme.spacing.xl,
                        width: 56,
                        height: 56,
                        borderRadius: 28,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.colors.accentPrimary,
                        ...theme.elevation.raised,
                    }}
                >
                    <Feather name="plus" size={24} color={theme.colors.accentPrimaryFg} />
                </Pressable>
            ) : null}

            <SkillFormSheet
                key={formSession}
                visible={creating}
                busy={create.isPending}
                error={create.error}
                // No organisation means nobody to share with, and the server's
                // group validation would reject it anyway.
                canShare={Boolean(user?.organizationId)}
                onClose={() => setCreating(false)}
                onSubmit={(draft) => create.mutate(draft)}
            />

            <ConfirmSheet
                visible={Boolean(pendingDelete)}
                title={`Delete “${pendingDelete?.name ?? ''}”?`}
                message="The skill is removed for everyone it was shared with, and detached from every agent that used it. Chats that already ran with it keep their answers. This cannot be undone."
                confirmLabel="Delete skill"
                busy={remove.isPending}
                onCancel={() => setPendingDelete(null)}
                onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
            />
        </Screen>
    );
}
