/**
 * Rules: what runs by itself once a meeting note is ready — the reader's own
 * automations with a Meeting Notes trigger, each as a sentence (agent-hub
 * RulesPanel.jsx). "Rule" makes a draft with that trigger already set and
 * opens it in the automation editor.
 *
 * Not here (yet): the web panel's "Suggest a rule" composer, which streams
 * ideas from the automation builder's suggestion scan; its home on the phone
 * is the automations builder, not a second copy in this screen.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { RuleCard } from '../components/RuleCard';
import { RulesEmpty, RulesListHeader } from '../components/RulesListParts';
import { useCreateMeetingRule, useMeetingRules, useRuleRunFacets } from '../hooks/queries';
import { facetsReadable } from '../model/rules';
import type { MeetingRule } from '../model/types';

const styles = StyleSheet.create({ list: { paddingHorizontal: 16, paddingBottom: 48, gap: 8 } });

const keyOf = (rule: MeetingRule) => rule.id;

export function MeetingRulesScreen() {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const { user } = useAuth();
    const rules = useMeetingRules();
    const runs = useRuleRunFacets();
    const refresh = useUserRefresh(() => Promise.all([rules.refetch(), runs.refetch()]));
    const create = useCreateMeetingRule();
    const readable = !runs.isLoading && !runs.isError && facetsReadable(runs.data?.facets);
    const openRule = (id: string) => router.push(`/automations/${id}`);

    const newRule = () =>
        create.mutate(
            {
                title: t('mobile.recording.new_rule_title', 'New meeting rule'),
                description: t('mobile.recording.new_rule_description', 'Runs when a meeting note is ready.'),
            },
            { onSuccess: (id) => id && openRule(id) },
        );


    return (
        <Screen edges={['top']}>
            <ScreenHeader
                title={t('mobile.recording.tools_rules', 'Rules')}
                actions={
                    <Button
                        label={create.isPending ? t('meetings.rules_new_busy', 'Making it…') : t('meetings.rules_new', 'Rule')}
                        iconName="Plus"
                        size="sm"
                        variant="secondary"
                        loading={create.isPending}
                        onPress={newRule}
                    />
                }
            />
            <FlatList<MeetingRule>
                data={rules.data ?? []}
                keyExtractor={keyOf}
                contentContainerStyle={styles.list}
                ListHeaderComponent={
                    <RulesListHeader
                        createError={create.error}
                        countsMissing={Boolean(rules.data?.length) && !runs.isLoading && !readable}
                    />
                }
                renderItem={({ item }) => (
                    <RuleCard
                        rule={item}
                        currentUserId={user?.id ?? null}
                        facets={runs.data?.facets}
                        facetsReadable={readable}
                        hours={runs.data?.hours ?? 24}
                        onOpen={openRule}
                    />
                )}
                ListEmptyComponent={<RulesEmpty query={rules} onRetry={refresh.onRefresh} />}
                refreshControl={
                    <RefreshControl
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            />
        </Screen>
    );
}
