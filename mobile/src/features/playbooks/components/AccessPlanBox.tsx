/**
 * The access phase's two ways in: say it in a sentence (the assistant turns
 * it into a PROPOSAL, names resolved against the real directory, nothing
 * written), or pick the audience by hand. Either way the result is one plan,
 * shown in full by the gate below before anything is applied.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Chip, Segmented, Text, TextField } from '@/shared/ui';

import { useProposeAccess } from '../hooks/mutations';
import { ASK_EXAMPLES } from '../model/accessView';
import type { AccessPlan } from '../model/types';

export const EMPTY_PLAN: AccessPlan = Object.freeze({
    note: '',
    audience: null,
    roles: [],
    tableRules: [],
    defaultRole: null,
    byGroup: {},
    members: [],
    unresolved: [],
    empty: true,
}) as AccessPlan;

type ByHand = 'private' | 'organisation';

export function AccessPlanBox({
    playbookId,
    phaseKey,
    plan,
    onPlan,
}: {
    playbookId: string;
    phaseKey: string;
    plan: AccessPlan;
    onPlan: (plan: AccessPlan) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [said, setSaid] = useState('');
    const propose = useProposeAccess(playbookId, phaseKey);
    const ask = async () => {
        const message = said.trim();
        if (!message || propose.isPending) return;
        const next = await propose.mutateAsync(message).catch(() => null);
        if (next) {
            onPlan(next);
            setSaid('');
        }
    };
    const byHand = plan.audience?.kind === 'private' || plan.audience?.kind === 'organisation' ? plan.audience.kind : null;
    return (
        <View style={styles.box}>
            <TextField
                label={t('mobile.playbooks.access.say_it', 'Say who should use it')}
                value={said}
                onChangeText={setSaid}
                multiline
                maxLength={1200}
                editable={!propose.isPending}
                placeholder={t(ASK_EXAMPLES[0]!.key, ASK_EXAMPLES[0]!.en)}
                error={propose.error ? describeError(propose.error).message || t('playbooks.access.ask_failed', 'The assistant could not read that — say it in other words.') : null}
                testID="playbook-access-say"
            />
            <View style={styles.examples}>
                {ASK_EXAMPLES.map((eg) => (
                    <Chip key={eg.key} label={t(eg.key, eg.en)} onPress={() => setSaid(t(eg.key, eg.en))} />
                ))}
            </View>
            <Button size="sm" variant="secondary" iconName="Sparkles" label={t('mobile.playbooks.access.propose', 'Propose it')} loading={propose.isPending} disabled={!said.trim()} onPress={() => void ask()} testID="playbook-access-ask" />
            <Text variant="label" tone="secondary">
                {t('mobile.playbooks.access.by_hand', 'Or choose who can open it')}
            </Text>
            <Segmented<ByHand>
                value={byHand ?? ('' as ByHand)}
                onChange={(kind) => onPlan({ ...plan, empty: false, audience: { kind, groupIds: [], groupNames: [] } })}
                accessibilityLabel={t('mobile.playbooks.access.by_hand', 'Or choose who can open it')}
                options={[
                    { value: 'private', label: t('playbooks.access.sum_private', 'nobody but you') },
                    { value: 'organisation', label: t('playbooks.access.sum_org', 'the whole organisation') },
                ]}
            />
            {plan.note ? (
                <Text variant="caption" tone="secondary">
                    {plan.note}
                </Text>
            ) : null}
            {plan.unresolved.length ? (
                <Text variant="caption" tone="warning">
                    {t('mobile.playbooks.access.unresolved', 'Not found in your organisation: {names}', { names: plan.unresolved.join(', ') })}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing[2.5] },
    examples: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing[1.5] },
});
