/**
 * The empty state: art, a title, a sentence, and — when there is one — the
 * action the person came here to take. The web's EmptyState
 * (shared/EmptyState.tsx): a scene from the shared illustrations or a glyph
 * in tertiary ink, an 18/600 title, a tertiary sentence, and a PILL action.
 *
 * On a phone there is no devtools tab to check, so an empty state says what
 * happened AND what the person can do about it. An empty state with no action
 * is a dead end.
 */

import React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Button } from './Button';
import { feedbackStyles } from './feedbackStyles';
import { Icon, type IconName } from './icons/Icon';
import { Illustration, type IllustrationName } from './illustrations';
import { Text } from './Text';

export interface EmptyStateProps {
    /**
     * A glyph above the title, in tertiary ink. Wins over `illustration`, as
     * on the web: a caller that chose its own art keeps it.
     */
    icon?: IconName;
    /** One of the shared scenes. With neither, the empty inbox. */
    illustration?: IllustrationName;
    title: string;
    message?: string;
    /** Label of the one button. Rendered only together with `onAction`. */
    actionLabel?: string;
    onAction?: () => void;
    /** `secondary` for a quieter call to action. */
    actionVariant?: 'primary' | 'secondary';
    /** A glyph inside the action pill. */
    actionIcon?: IconName;
    style?: StyleProp<ViewStyle>;
}

export function EmptyState({
    icon,
    illustration = 'empty-inbox',
    title,
    message,
    actionLabel,
    onAction,
    actionVariant = 'primary',
    actionIcon,
    style,
}: EmptyStateProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={[feedbackStyles.centre, styles.column, style]}>
            <View style={styles.art} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {icon ? (
                    <Icon name={icon} size={40} color={styles.ink.color} strokeWidth={1.5} />
                ) : (
                    <Illustration name={illustration} color={styles.ink.color} accent={styles.accent.color} />
                )}
            </View>
            <Text variant="heading" center style={styles.title}>
                {title}
            </Text>
            {message ? (
                <Text variant="body" tone="tertiary" center style={styles.message}>
                    {message}
                </Text>
            ) : null}
            {actionLabel && onAction ? (
                // Primary by default: these are the app's only teaching
                // surface, and the one button on an otherwise empty screen is
                // the thing the person came to do.
                <Button label={actionLabel} onPress={onAction} variant={actionVariant} iconName={actionIcon} pill />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    column: { paddingHorizontal: theme.spacing[6], paddingVertical: theme.spacing[12] } satisfies ViewStyle,
    art: { marginBottom: theme.spacing[4] } satisfies ViewStyle,
    ink: { color: theme.colors.textTertiary },
    accent: { color: theme.colors.accentPrimary },
    title: { marginBottom: theme.spacing[2] } satisfies TextStyle,
    message: { maxWidth: 448, marginBottom: theme.spacing[6] } satisfies TextStyle,
});
