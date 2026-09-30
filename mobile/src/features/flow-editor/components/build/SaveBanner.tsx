/**
 * A failed save, said once and in the open: why, and Try again when the
 * store has stopped retrying on its own. Nothing is drawn while saves land —
 * the header's subline says "Saving…" and "Saved" quietly.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useDraftState } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { Banner, Button } from '@/shared/ui';

import { saveWords } from './saveWords';

export function SaveBanner({ store }: { store: DraftStore }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const status = useDraftState(store, (s) => s.status);
    const saveError = useDraftState(store, (s) => s.saveError);
    if (status !== 'error' || !saveError) return null;
    const words = saveWords({ status, saveError }, t);
    return (
        <View style={styles.slot} accessibilityLiveRegion="polite">
            <Banner
                tone="error"
                action={
                    saveError.willRetry ? undefined : (
                        <Button size="sm" variant="ghost" label={t('mobile.flow.save.retry', 'Try again')} onPress={() => void store.getState().retry()} />
                    )
                }
            >
                {words.text}
            </Banner>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    slot: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2] } satisfies ViewStyle,
});
