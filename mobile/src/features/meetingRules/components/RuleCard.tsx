/**
 * One rule as a sentence (agent-hub RulesPanel.jsx RuleCard): "When <tag
 * filter> is finished → <what it does>", what narrows it further, how often it
 * ran for the reader, and a way into the automation — only when the reader
 * owns it, because anyone else gets a 403 there.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Badge, Button, Card, KindTile, Text, type BadgeTone } from '@/shared/ui';

import { consequencesOf, openability, triggerConditionOf } from '../model/rules';
import { conditionSentence, consequenceParts, narrowingParts, ruleState, runLabel, type RuleState } from '../model/sentences';
import type { MeetingRule } from '../model/types';

const styles = StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    main: { flex: 1, gap: 4 },
    titleLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 },
    runs: { flex: 1 },
});

function stateBadge(state: RuleState, t: TranslateFn): { label: string; tone: BadgeTone } {
    if (state === 'live') return { label: t('meetings.rules_active', 'Active'), tone: 'success' };
    if (state === 'draft') return { label: t('meetings.rules_draft', 'Draft'), tone: 'warning' };
    return { label: t('meetings.rules_paused', 'Paused'), tone: 'neutral' };
}

export interface RuleCardProps {
    rule: MeetingRule;
    currentUserId: string | null;
    facets: unknown;
    /** False when the counts could not be read: then no card claims a number. */
    facetsReadable: boolean;
    hours: number;
    onOpen: (id: string) => void;
}

export function RuleCard({ rule, currentUserId, facets, facetsReadable, hours, onOpen }: RuleCardProps) {
    const t = useTranslation();
    const condition = triggerConditionOf(rule.definition);
    const narrowing = narrowingParts(condition, t);
    const state = ruleState(rule);
    const badge = state ? stateBadge(state, t) : null;
    const runs = facetsReadable ? runLabel(facets, rule.id, hours, t) : null;
    const open = openability(rule, currentUserId);

    return (
        <Card>
            <View style={styles.head}>
                <KindTile kind="automation" size={28} />
                <View style={styles.main}>
                    <View style={styles.titleLine}>
                        <Text variant="body" weight="medium">
                            {rule.title || t('meetings.rules_untitled', 'Untitled rule')}
                        </Text>
                        {badge ? <Badge label={badge.label} tone={badge.tone} /> : null}
                    </View>
                    <Text variant="caption" tone="secondary">
                        {`${conditionSentence(condition, t)} → ${consequenceParts(consequencesOf(rule.definition), t).join(' · ')}`}
                    </Text>
                    {narrowing.length ? (
                        <Text variant="caption" tone="tertiary">
                            {narrowing.join(' · ')}
                        </Text>
                    ) : null}
                    {state === 'draft' ? (
                        <Text variant="caption" tone="warning">
                            {t('meetings.rules_draft_hint', 'Still a draft, so it does not run yet — open it and activate it.')}
                        </Text>
                    ) : null}
                </View>
            </View>
            <View style={styles.footer}>
                <Text variant="caption" tone="tertiary" style={styles.runs} numberOfLines={1}>
                    {runs ?? ''}
                </Text>
                {open === 'ok' ? (
                    <Button
                        label={t('meetings.rules_open', 'Open automation')}
                        variant="ghost"
                        size="sm"
                        iconName="ArrowRight"
                        onPress={() => onOpen(rule.id)}
                    />
                ) : null}
                {open === 'foreign' ? (
                    <Text variant="caption" tone="tertiary">
                        {t('meetings.rules_someone_elses', 'Someone else’s rule')}
                    </Text>
                ) : null}
            </View>
        </Card>
    );
}
