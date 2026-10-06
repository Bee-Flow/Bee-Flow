/**
 * What "Suggest outputs" would do, before it does it — the web's
 * SuggestionPreview (RouteAssist.jsx): every output read back as the
 * sentence the canvas shows (S3; "a custom rule" for a formula the rule rows
 * cannot show, never the expression), how many of the sample rows each
 * takes, where the rest goes (S5: “Otherwise”, or nowhere for one output
 * without keep-rest), what an accept replaces and which wired
 * connections it costs, then the accept.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useVariablePicker } from '@/features/flow-editor/components/variables';
import type { MatchCounts, Suggestion } from '@/features/flow-editor/formState';
import { ruleSentence } from '@/features/flow-editor/model';
import { Button, Text } from '@/shared/ui';

import { previewHeading } from './assistModel';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

export interface SuggestionPreviewProps {
    suggestion: Suggestion;
    counts: MatchCounts | null;
    unit: string;
    existing: number;
    /** One list output whose rest goes to “Otherwise”: the unmatched rows go there, not nowhere. */
    keepRest?: boolean;
    losing: readonly string[];
    onApply: () => void;
    onReset: () => void;
    disabled: boolean;
}

function CountLine({ counts, unit, several, keepRest }: { counts: MatchCounts | null; unit: string; several: boolean; keepRest: boolean }) {
    const t = useTranslation();
    if (!counts) {
        return (
            <Note>
                {t('mobile.flow.route.assist.no_samples', 'There are no sample {unit} here yet, so none of this can be counted — the lines above are what will be checked, not what has matched.', { unit })}
            </Note>
        );
    }
    // S5: "0 of 4 … match none of these" says nothing: with every sample row placed, no line.
    if (!counts.unmatched) return null;
    const vars = { n: counts.unmatched, total: counts.total, unit };
    return (
        <Note>
            {several
                ? t('condition_node.suggest.unmatched_several', '{n} of {total} sample {unit} match none of these and go to “Otherwise”.', vars)
                : keepRest
                  ? t('condition_node.suggest.unmatched_one_keep', '{n} of {total} sample {unit} don’t match and go to “Otherwise”.', vars)
                  : t('condition_node.suggest.unmatched_one', '{n} of {total} sample {unit} don’t match and stop here.', vars)}
        </Note>
    );
}

export function SuggestionPreview({ suggestion, counts, unit, existing, keepRest = false, losing, onApply, onReset, disabled }: SuggestionPreviewProps) {
    const t = useTranslation();
    // Each rule as the canvas card says it: "any attachment · File type is PDF".
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
                    {` — ${ruleSentence(r.expr, labels, t) ?? t('condition_node.suggest.custom_rule', 'a custom rule')}`}
                    {counts ? ` · ${t('mobile.flow.route.assist.matched', '{matched} of {total} sample {unit}', { matched: counts.perRule[i]?.matched ?? 0, total: counts.total, unit })}` : ''}
                </Text>
            ))}
            <CountLine counts={counts} unit={unit} several={rules.length > 1} keepRest={keepRest} />
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
