/**
 * Edits this phone kept while the server did not have them, for a routine
 * that has since been changed elsewhere. Which copy wins is the person's call,
 * not the phone's: keep the phone's edits (applied over the server's copy,
 * one undo away) or discard them.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { LocalDraft } from '@/features/flow-editor/hooks';
import { Banner, Button } from '@/shared/ui';

export function LocalDraftBanner({ local }: { local: LocalDraft }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    if (!local.conflict) return null;
    return (
        <View style={styles.slot} accessibilityLiveRegion="polite" testID="local-draft-banner">
            <Banner tone="warning">
                {t(
                    'mobile.flow.local.conflict',
                    'This phone kept changes that never reached the server, and the routine has been changed elsewhere since. Keep the changes from this phone?',
                )}
            </Banner>
            <View style={styles.actions}>
                <Button size="sm" variant="ghost" label={t('mobile.flow.local.discard', 'Discard them')} onPress={() => local.resolve(false)} testID="local-draft-discard" />
                <Button size="sm" label={t('mobile.flow.local.keep', 'Keep my changes')} onPress={() => local.resolve(true)} testID="local-draft-keep" />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    slot: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2], gap: theme.spacing[2] } satisfies ViewStyle,
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing[2] } satisfies ViewStyle,
});
