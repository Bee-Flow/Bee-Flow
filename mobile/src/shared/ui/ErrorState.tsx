/**
 * A failed load, said in words a person can act on.
 *
 * The sentence comes from describeError (core/api/errors.ts), which is the only
 * place on the phone that turns a refusal into words; this component only
 * decides whether a retry is worth offering.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Button } from './Button';
import { feedbackStyles } from './feedbackStyles';
import { Icon } from './icons/Icon';
import { Text } from './Text';

export interface ErrorStateProps {
    /** Whatever was thrown; describeError decides the title and sentence. */
    error: unknown;
    /** Shown as "Try again" only when the error is retryable. */
    onRetry?: () => void;
    style?: StyleProp<ViewStyle>;
}

export function ErrorState({ error, onRetry, style }: ErrorStateProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    // Subscribes this component to the catalogue; describeError() itself reads
    // it through translate(), which does not re-render anything on its own.
    const t = useTranslation();
    const { title, message, retryable } = describeError(error);
    return (
        <View style={[feedbackStyles.centre, styles.column, style]}>
            <Icon name="CircleAlert" size={28} color={theme.colors.errorInk} />
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

const makeStyles = (theme: Theme) => ({
    column: { gap: theme.spacing.md, padding: theme.spacing.xxl } satisfies ViewStyle,
});
