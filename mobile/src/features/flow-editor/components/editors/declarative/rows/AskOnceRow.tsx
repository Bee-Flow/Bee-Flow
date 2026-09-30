/**
 * "Ask this app only once per run" — the web's AskOnceRow
 * (actionEditors/askOnceRow.jsx): reuse the first answer within a run, and —
 * only once that is on — keep it for later runs too (stored, encrypted, and
 * the administrator's call). An action that changes something, or one the
 * catalog marks as checked fresh every time, cannot be ticked, and says why.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ToggleField } from '@/features/flow-editor/components/fields';

type AskOnce = true | { acrossRuns?: boolean; ttlSeconds?: number } | null | undefined;

/** Why the tick is unavailable for this action, or null (the web's askOnceAvailability). */
export function askOnceBlocked(action: { askOnceable?: unknown; sideEffect?: unknown } | null | undefined): 'writes' | 'fresh' | null {
    if (!action || action.askOnceable !== false) return null;
    return action.sideEffect === true ? 'writes' : 'fresh';
}

/** The next `askOnce` when "keep it for later runs" changes; the TTL rides along. */
export function acrossRunsValue(current: AskOnce, on: boolean): AskOnce {
    const ttl = current && typeof current === 'object' && Number.isFinite(Number(current.ttlSeconds)) ? { ttlSeconds: Number(current.ttlSeconds) } : null;
    if (on) return { acrossRuns: true, ...(ttl || {}) };
    return ttl ? { ...ttl } : true;
}

export function AskOnceRow({
    value,
    onChange,
    blocked,
    appLabel,
    disabled,
    label,
    reason: ownReason,
}: {
    value: AskOnce;
    onChange: (next: AskOnce) => void;
    blocked: 'writes' | 'fresh' | null;
    appLabel: string | null;
    disabled?: boolean;
    /** The http_request step asks of a "service", not an "app". */
    label?: string;
    /** The caller's own reason (a refusal, or a caution on an enabled tick) — the http_request step's. */
    reason?: string | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const on = !!value;
    const acrossRuns = !!(value && typeof value === 'object' && value.acrossRuns);
    const reason = ownReason
        ? ownReason
        : blocked === 'writes'
            ? t('mobile.flow.ask_once.writes', 'This action changes something in {app}, so its answer cannot be reused.', { app: appLabel || t('mobile.flow.ask_once.the_app', 'the app') })
            : blocked === 'fresh'
              ? t('mobile.flow.ask_once.fresh', 'This look-up is checked fresh every time — either it changes by the minute, or its permissions are checked as it runs.')
              : null;
    return (
        <View style={styles.box}>
            <ToggleField
                value={on}
                onChange={(next) => onChange(next ? true : undefined)}
                disabled={disabled || !!blocked}
                label={label ?? t('mobile.flow.ask_once.label', 'Ask this app only once per run')}
                description={
                    reason ??
                    t('mobile.flow.ask_once.hint', 'If this step asks the same thing more than once in a run — inside a loop, say — the first answer is used again instead of asking every time.')
                }
            />
            {on ? (
                <ToggleField
                    value={acrossRuns}
                    onChange={(next) => onChange(acrossRunsValue(value, next))}
                    disabled={disabled}
                    label={t('mobile.flow.ask_once.across_runs', '…and keep the answer for later runs too')}
                    description={t(
                        'mobile.flow.ask_once.across_runs_hint',
                        'The answer is stored, encrypted, so the next run can use it instead of asking again. Your administrator decides whether that is allowed, and for how long; until they turn it on, this step asks every run.',
                    )}
                />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.xs } satisfies ViewStyle,
});
