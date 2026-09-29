/**
 * The four states every data screen has: loading, empty, error, offline.
 *
 * Bee Flow's web app writes these ad hoc, so an error in one place is a red
 * banner and in another a console log. On a phone they matter more — there is
 * no devtools tab to check — so each one here says what happened AND what the
 * person can do about it. An empty state with no action is a dead end.
 */

import { Feather } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Button } from './Button';
import { Text } from './Text';
import { ApiError, OfflineError } from '../api/client';
import { translate, useTranslation } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';


export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
    const theme = useTheme();
    return <ActivityIndicator size={size} color={theme.colors.accentPrimary} />;
}

/** Centred spinner for a screen that has nothing to show yet. */
export function LoadingState({ label }: { label?: string }) {
    const theme = useTheme();
    return (
        <View style={[styles.centre, { gap: theme.spacing.md, padding: theme.spacing.xl }]}>
            <Spinner size="large" />
            {label ? (
                <Text variant="caption" tone="tertiary" center>
                    {label}
                </Text>
            ) : null}
        </View>
    );
}

export function EmptyState({
    icon = 'inbox',
    title,
    message,
    actionLabel,
    onAction,
    style,
}: {
    icon?: keyof typeof Feather.glyphMap;
    title: string;
    message?: string;
    actionLabel?: string;
    onAction?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    return (
        <View style={[styles.centre, { gap: theme.spacing.md, padding: theme.spacing.xxl }, style]}>
            <View
                style={{
                    width: 64,
                    height: 64,
                    borderRadius: theme.radii.lg,
                    backgroundColor: theme.colors.bgTertiary,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Feather name={icon} size={26} color={theme.colors.textMuted} />
            </View>
            <Text variant="heading" center>
                {title}
            </Text>
            {message ? (
                <Text variant="body" tone="tertiary" center>
                    {message}
                </Text>
            ) : null}
            {actionLabel && onAction ? (
                // Primary, not secondary. There are 44 of these and they are
                // the app's only teaching surface — the one button on an
                // otherwise empty screen is the thing the person came to do,
                // and it should look like it.
                <Button label={actionLabel} onPress={onAction} />
            ) : null}
        </View>
    );
}

/**
 * The machine-readable `code` the server put in the body, or ''.
 *
 * `ApiError.body` is the parsed JSON body (src/api/client.ts) — the client
 * already keeps it, so nothing needed to change there to read this. It is
 * `unknown` on purpose, so this narrows rather than casts: a body that is a
 * string, an array, or absent answers '' and every caller falls through to the
 * status-only branch it had before.
 */
function errorCode(error: ApiError): string {
    const body = error.body as { code?: unknown } | null | undefined;
    return body && typeof body === 'object' && typeof body.code === 'string' ? body.code : '';
}

/**
 * The sentence the SERVER wrote, or '' when it wrote none.
 *
 * The client synthesises `HTTP 404` as the message whenever the body was not
 * JSON or carried no `error`/`message` (src/api/client.ts). That placeholder
 * is not a sentence anybody should read: `error.message || 'This item no
 * longer exists.'` would show "HTTP 404" and never reach the fallback it was
 * written for. So the placeholder is filtered back out here, once, rather than
 * every branch below having to remember.
 */
function serverSentence(error: ApiError): string {
    const message = (error.message || '').trim();
    return /^HTTP \d{3}$/.test(message) ? '' : message;
}

/**
 * Turn whatever was thrown into something a person can act on.
 *
 * The mapping is deliberate: a 402 is a plan limit, not a crash, and telling
 * someone "HTTP 402" when they have run out of messages this month is how a
 * support ticket gets opened for a non-problem.
 *
 * The rule for the message, everywhere below: when the server wrote a specific
 * sentence, show the server's sentence and keep the generic one as the
 * fallback. A status code is a category, not an explanation, and answering a
 * precise refusal with a category is how a person ends up debugging the wrong
 * thing.
 */
export function describeError(error: unknown): { title: string; message: string; retryable: boolean } {
    if (error instanceof OfflineError) {
        return {
            title: translate('mobile.error.offline_title', 'You are offline'),
            message: translate(
                'mobile.error.offline_message',
                'Bee Flow will pick up where you left off once you are back on a network.',
            ),
            retryable: true,
        };
    }
    if (error instanceof ApiError) {
        if (error.status === 402) {
            return {
                title: translate('mobile.error.plan_limit_title', 'Plan limit reached'),
                message:
                    serverSentence(error) ||
                    translate(
                        'mobile.error.plan_limit_message',
                        'Your organisation has used its allowance for this period.',
                    ),
                retryable: false,
            };
        }
        if (error.status === 403) {
            // Two different refusals share this status, and telling them apart
            // needs the body, not the code. `not_editable` means "you can see
            // this row, it is simply not yours to change" — S3 made that a 403
            // where it used to be a 404 (server/routes/skills.js, PUT /:id and
            // GET /:id/test-runs), so without this branch a colleague who
            // opens a shared skill and presses save is told to talk to sales.
            if (errorCode(error) === 'not_editable') {
                return {
                    title: translate('mobile.error.not_editable_title', 'Not yours to edit'),
                    message:
                        serverSentence(error) ||
                        translate(
                            'mobile.error.not_editable_message',
                            'You can open this, but only its owner — or an administrator in the organisation it belongs to — can change it.',
                        ),
                    retryable: false,
                };
            }
            return {
                title: translate('mobile.error.plan_access_title', 'Not available on your plan'),
                message:
                    serverSentence(error) ||
                    translate(
                        'mobile.error.plan_access_message',
                        'Ask an administrator if you need access to this.',
                    ),
                retryable: false,
            };
        }
        if (error.status === 404) {
            // A 404 is not always "it is gone": routes answer it for "not
            // yours", "wrong knowledge base", "no such document in this note".
            // The server's own sentence goes first for the same reason the 402
            // and 403 branches use it — "no longer exists" sends someone
            // looking for a deletion that never happened.
            return {
                title: translate('error.not_found', 'Not found'),
                message:
                    serverSentence(error) ||
                    translate('mobile.error.not_found_message', 'This item no longer exists.'),
                retryable: false,
            };
        }
        if (error.status && error.status >= 500) {
            return {
                title: translate('mobile.error.server_title', 'The server had a problem'),
                message: translate(
                    'mobile.error.server_message',
                    'This is not something you did. Try again in a moment.',
                ),
                retryable: true,
            };
        }
        return {
            title: translate('mobile.error.generic_title', 'That did not work'),
            message: error.message,
            retryable: true,
        };
    }
    return {
        title: translate('mobile.error.unknown_title', 'Something went wrong'),
        message:
            (error as Error)?.message ||
            translate('mobile.error.unknown_message', 'Try again.'),
        retryable: true,
    };
}

export function ErrorState({
    error,
    onRetry,
    style,
}: {
    error: unknown;
    onRetry?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    // Subscribes this component to the catalogue; describeError() itself reads
    // it through translate(), which does not re-render anything on its own.
    const t = useTranslation();
    const { title, message, retryable } = describeError(error);
    return (
        <View style={[styles.centre, { gap: theme.spacing.md, padding: theme.spacing.xxl }, style]}>
            <Feather name="alert-circle" size={28} color={theme.colors.error} />
            <Text variant="heading" center>
                {title}
            </Text>
            <Text variant="body" tone="tertiary" center>
                {message}
            </Text>
            {retryable && onRetry ? (
                <Button label={t('mobile.error.retry', 'Try again')} onPress={onRetry} variant="secondary" />
            ) : null}
        </View>
    );
}

/**
 * A shimmerless skeleton.
 *
 * Deliberately static: an animated shimmer on a list of twenty rows is a
 * continuous repaint, and on a mid-range Android phone that costs more frames
 * than the skeleton saves in perceived speed.
 */
export function Skeleton({
    width = '100%',
    height = 16,
    radius,
    style,
}: {
    width?: number | `${number}%`;
    height?: number;
    radius?: number;
    style?: StyleProp<ViewStyle>;
}) {
    const theme = useTheme();
    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                {
                    width,
                    height,
                    borderRadius: radius ?? theme.radii.sm,
                    backgroundColor: theme.colors.bgTertiary,
                },
                style,
            ]}
        />
    );
}

/**
 * How full the bar is, in whole per cent, and how wide to draw it.
 *
 * Split out and exported because it is the only arithmetic in this file and
 * every part of it is a boundary someone gets wrong: a fraction arriving as
 * 1.02 from a byte counter that overshoots, a NaN from a division by a zero
 * total, and the floor — a bar that has genuinely started must never render as
 * a hairline of nothing, so it is held at 2% until the real value passes it.
 */
export function progressPercent(fraction: number): { percent: number; width: `${number}%` } {
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    const percent = Math.round(clamped * 100);
    return { percent, width: `${Math.max(2, percent)}%` };
}

/**
 * A determinate progress bar.
 *
 * Determinate only: an indeterminate bar is a Spinner with extra steps, and
 * this exists for the one job a spinner cannot do — say how far through a
 * long upload you are, so the person deciding whether to keep the screen on
 * has something to decide with.
 *
 * Written first inside features/recording's OutboxRow, which is where uploads
 * are watched. It is here because the accessibility work is the hard part and
 * should not be re-derived: a screen reader needs the `progressbar` role and a
 * real `accessibilityValue`, or it announces a decorative box, and the live
 * region belongs on whatever text accompanies it rather than on the bar, so
 * that TalkBack reads "63 per cent" once instead of on every repaint.
 */
export function ProgressBar({
    fraction,
    label,
    tint,
}: {
    /** 0 to 1. Out-of-range and NaN are clamped rather than trusted. */
    fraction: number;
    /** What is progressing — "Uploading Monday standup", not "Progress". */
    label: string;
    tint?: string;
}) {
    const theme = useTheme();
    const { percent, width } = progressPercent(fraction);
    return (
        <View
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityValue={{ now: percent, min: 0, max: 100 }}
            style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: theme.colors.bgTertiary,
                overflow: 'hidden',
            }}
        >
            <View
                style={{
                    width,
                    height: '100%',
                    backgroundColor: tint ?? theme.colors.accentPrimary,
                }}
            />
        </View>
    );
}

/** A placeholder shaped like the list it is standing in for. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <View
            accessibilityLabel={t('mobile.ui.loading', 'Loading')}
            style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
        >
            {Array.from({ length: rows }, (_, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                    <Skeleton width={40} height={40} radius={theme.radii.md} />
                    <View style={{ flex: 1, gap: theme.spacing.sm, justifyContent: 'center' }}>
                        <Skeleton width={i % 3 === 0 ? '55%' : '75%'} height={14} />
                        <Skeleton width="40%" height={11} />
                    </View>
                </View>
            ))}
        </View>
    );
}

/** Inline banner for a non-blocking problem — a failed background sync, say. */
export function Banner({
    tone = 'warning',
    icon,
    children,
    action,
}: {
    tone?: 'warning' | 'error' | 'info' | 'success';
    icon?: keyof typeof Feather.glyphMap;
    children: ReactNode;
    action?: ReactNode;
}) {
    const theme = useTheme();
    const colour = {
        warning: theme.colors.warning,
        error: theme.colors.error,
        info: theme.colors.accentPrimary,
        success: theme.colors.success,
    }[tone];
    const fallbackIcon = {
        warning: 'alert-triangle',
        error: 'alert-octagon',
        info: 'info',
        success: 'check-circle',
    }[tone] as keyof typeof Feather.glyphMap;

    return (
        <View
            accessibilityLiveRegion="polite"
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.md,
                padding: theme.spacing.md,
                borderRadius: theme.radii.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colour,
                // 12% of the tone over the card colour — readable in all eight
                // themes without a per-theme banner palette.
                backgroundColor: theme.colors.itemHoverBg,
            }}
        >
            <Feather name={icon ?? fallbackIcon} size={18} color={colour} />
            <View style={{ flex: 1 }}>
                {typeof children === 'string' ? (
                    <Text variant="caption">{children}</Text>
                ) : (
                    children
                )}
            </View>
            {action}
        </View>
    );
}

const styles = StyleSheet.create({
    centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
