/**
 * What "Suggest outputs" would do, before it does it — the web's
 * SuggestionPreview (RouteAssist.jsx): every output read back as a sentence
 * (never the expression), how many of the sample rows each takes, what an
 * accept replaces and which wired connections it costs, then the accept.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { readableRule } from '@/features/flow-editor/components/outline/readableText';
import { useVariablePicker } from '@/features/flow-editor/components/variables';
import type { MatchCounts, Suggestion } from '@/features/flow-editor/formState';
import { Button, Text } from '@/shared/ui';

import { previewHeading } from './assistModel';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

export interface SuggestionPreviewProps {
    suggestion: Suggestion;
    counts: MatchCounts | null;
    unit: string;
    existing: number;
    losing: readonly string[];
    onApply: () => void;
    onReset: () => void;
    disabled: boolean;
}

function CountLine({ counts, unit, several }: { counts: MatchCounts | null; unit: string; several: boolean }) {
    const t = useTranslation();
    if (!counts) {
        return (
            <Note>
                {t('mobile.flow.route.assist.no_samples', 'There are no sample {unit} here yet, so none of this can be counted — the lines above are what will be checked, not what has matched.', { unit })}
            </Note>
        );
    }
    const none = t('mobile.flow.route.assist.match_none', '{unmatched} of {total} sample {unit} match none of these', { unmatched: counts.unmatched, total: counts.total, unit });
    const then = several
        ? t('mobile.flow.route.assist.take_otherwise', 'and would take the otherwise output.')
        : t('mobile.flow.route.assist.stop_here', 'and would stop here.');
    return <Note>{`${none} ${then}`}</Note>;
}

export function SuggestionPreview({ suggestion, counts, unit, existing, losing, onApply, onReset, disabled }: SuggestionPreviewProps) {
    const t = useTranslation();
    // Each rule in the step names' words, as the cards say it ("‹Gmail Search ▸ Total› > 100").
    const known = useVariablePicker().stepLabelById;
    const labels = known instanceof Map ? known : null;
    const styles = useThemedStyles(makeStyles);
    const rules = suggestion.rules;
    const outputs = existing === 1 ? t('automations.ndv.output_word', 'output') : t('mobile.flow.route.assist.n_outputs', '{n} outputs', { n: existing });
    return (
        <View style={styles.box} testID="route-assist-preview">
            <Note>{previewHeading(suggestion, t)}</Note>
            {rules.map((r, i) => (
                <Text key={r.name} variant="caption" tone="secondary">
                    <Text variant="caption" weight="medium">
                        {r.name}
                    </Text>
                    {` — ${readableRule(r.expr, labels)}`}
                    {counts ? ` · ${t('mobile.flow.route.assist.matched', '{matched} of {total} sample {unit}', { matched: counts.perRule[i]?.matched ?? 0, total: counts.total, unit })}` : ''}
                </Text>
            ))}
            <CountLine counts={counts} unit={unit} several={rules.length > 1} />
            {existing > 0 ? <Warn>{t('mobile.flow.route.assist.replaces', 'Accepting replaces the {what} already set up below.', { what: outputs })}</Warn> : null}
            {losing.length ? (
                <Warn>
                    {losing.length === 1
                        ? t('mobile.flow.route.assist.losing_one', '{names} is wired on the canvas and is not in this suggestion, so its connection goes too.', { names: losing[0] ?? '' })
                        : t('mobile.flow.route.assist.losing_many', '{names} are wired on the canvas and are not in this suggestion, so their connections go too.', { names: losing.join(', ') })}
                </Warn>
            ) : null}
            <View style={styles.actions}>
                <Button
                    size="sm"
                    label={rules.length === 1 ? t('mobile.flow.route.assist.use_one', 'Use this output') : t('mobile.flow.route.assist.use_n', 'Use these {n} outputs', { n: rules.length })}
                    onPress={onApply}
                    disabled={disabled}
                    testID="route-assist-apply"
                />
                <Button size="sm" variant="ghost" label={t('mobile.flow.route.assist.start_over', 'Start over')} onPress={onReset} />
            </View>
            {suggestion.truncated ? (
                <Warn>
                    {t('mobile.flow.route.assist.truncated', 'Only the first {n} are shown — more outputs than that is a lookup table rather than a routing decision, and every one of them is a port someone has to wire.', { n: rules.length })}
                </Warn>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing[1.5] } satisfies ViewStyle,
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
});
