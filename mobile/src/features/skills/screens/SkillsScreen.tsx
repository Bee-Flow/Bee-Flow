/**
 * The skill library — the web's "All skills" overview on a phone: each skill
 * with who uses it, what is in it and how its last test went, sorted by use,
 * by last use or by name (skillModel.sortSkills, the web's own order).
 *
 * The usage summary is a separate read. A skill it does not answer for shows
 * no usage subline at all — an unknown count is not "not linked yet".
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useHasPermission } from '@/core/access';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AddFab } from '@/features/knowledge';
import { QueryList } from '@/shared/patterns';
import { FilterPills, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { NewSkillSheet } from '../components/NewSkillSheet';
import { SkillDeleteSheets } from '../components/SkillDeleteSheets';
import { SkillRow } from '../components/SkillRow';
import { useCreateSkill } from '../hooks/mutations';
import { useSkills, useSkillUsageSummary } from '../hooks/queries';
import { capMessage, retainExistingSkills, useActiveSkills } from '../model/active';
import { canDeleteSkill } from '../model/permissions';
import { filterSkills, sortSkills, SORT_MODES, type SortMode } from '../model/skillModel';
import { ACTIVE_SKILL_CAP, type Skill } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        list: { paddingBottom: 96 },
        sort: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    });

const matches = (s: Skill, needle: string) => filterSkills([s], needle).length > 0;

function sortLabel(t: TranslateFn, mode: SortMode): string {
    if (mode === 'recent') return t('skills_studio.sort.recent', 'last used');
    if (mode === 'name') return t('skills_studio.sort.name', 'name');
    return t('skills_studio.sort.used', 'most used');
}

function subtitle(t: TranslateFn, active: number): string {
    return active > 0
        ? t('mobile.skills.active_count', '{active} of {cap} switched on for new chats', { active, cap: ACTIVE_SKILL_CAP })
        : t('mobile.skills.subtitle', 'Instruction packs you can switch on for a chat');
}

/** `startCreating` opens the New skill sheet at once: the Studio New menu's `/skills?new=1`. */
export function SkillsScreen({ startCreating }: { startCreating?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const { toast } = useToast();
    const { user } = useAuth();
    const canManage = useHasPermission('manage_skills');
    const [creating, setCreating] = useState(startCreating === true);
    // A new key per opening remounts the sheet with a clean draft.
    const [session, setSession] = useState(0);
    const openNew = () => {
        setSession((n) => n + 1);
        setCreating(true);
    };
    const [sort, setSort] = useState<SortMode>('used');
    const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
    const { activeSkillIds, isActive, toggle } = useActiveSkills();
    const query = useSkills();
    const summary = useSkillUsageSummary().data;
    const create = useCreateSkill({
        onSuccess: (skill) => {
            setCreating(false);
            if (skill?.id) router.push(`/skills/${skill.id}`);
        },
    });
    const sorted = { ...query, data: query.data ? sortSkills(query.data, sort, summary) : undefined };

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title={t('skills_studio.title', 'Skills')} subtitle={subtitle(t, activeSkillIds.length)} />
            <QueryList
                query={sorted}
                keyExtractor={(skill) => skill.id}
                separator="none"
                search={{ placeholder: t('skills_studio.filter', 'Filter…'), match: matches }}
                ListHeaderComponent={
                    <View style={styles.sort}>
                        <FilterPills
                            value={sort}
                            onChange={setSort}
                            accessibilityLabel={t('skills_studio.sort.aria', 'Sort skills')}
                            options={SORT_MODES.map((mode) => ({ value: mode, label: sortLabel(t, mode) }))}
                        />
                    </View>
                }
                contentContainerStyle={styles.list}
                renderItem={({ item }) => (
                    <SkillRow
                        skill={item}
                        summary={summary?.[item.id]}
                        active={isActive(item.id)}
                        onPress={() => router.push(`/skills/${item.id}`)}
                        onToggle={() => {
                            if (!toggle(item.id)) toast(capMessage(t), 'error');
                        }}
                        onLongPress={canDeleteSkill(item, user?.id, Boolean(user?.isAdmin)) ? () => setPendingDelete(item) : undefined}
                    />
                )}
                empty={{
                    icon: 'Zap',
                    title: t('skills_studio.empty_title', 'Create your first skill'),
                    message: canManage
                        ? t('skills_studio.empty_help', 'Skills are reusable instruction packs you can attach to any agent. Create one to define how an agent should behave in a specific situation.')
                        : t('mobile.skills.empty_cannot_create', 'Nobody has shared a skill with you yet, and your account cannot create them. An administrator can grant that.'),
                    actionLabel: canManage ? t('skills_studio.create', 'Create skill') : undefined,
                    onAction: canManage ? openNew : undefined,
                }}
                noMatch={{ title: t('mobile.skills.no_match', 'Nothing matches that'), message: t('mobile.skills.no_match_hint', 'Try a different word.') }}
            />
            {canManage ? <AddFab label={t('skills_studio.create', 'Create skill')} onPress={openNew} /> : null}

            <NewSkillSheet
                key={session}
                visible={creating}
                busy={create.isPending}
                error={create.error}
                onClose={() => setCreating(false)}
                onCreate={(draft) => create.mutate(draft)}
            />
            <SkillDeleteSheets
                skill={pendingDelete}
                onCancel={() => setPendingDelete(null)}
                onDeleted={(skill) => {
                    setPendingDelete(null);
                    // Gone from every agent that had it; it must not stay switched on either.
                    retainExistingSkills(activeSkillIds.filter((v) => v !== skill.id));
                }}
            />
        </Screen>
    );
}
