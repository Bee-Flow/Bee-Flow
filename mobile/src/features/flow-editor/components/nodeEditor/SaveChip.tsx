/**
 * The one lasting sign that an edit landed — the web's SaveStatus chip in the
 * node editor's header (BFSF-338): "Saving…", "Saved", or a failure that says
 * so and offers to try again. A failure the server will keep refusing (a 400
 * about this definition) is shown with its reason instead of a retry.
 */

import React from 'react';
import { Pressable } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useDraftState } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { Text } from '@/shared/ui';

export function SaveChip({ store }: { store: DraftStore }) {
    const t = useTranslation();
    const status = useDraftState(store, (s) => s.status);
    const saveError = useDraftState(store, (s) => s.saveError);
    if (status === 'saving' || status === 'pending') {
        return (
            <Text variant="label" tone="tertiary" testID="save-state">
                {t('common.saving', 'Saving…')}
            </Text>
        );
    }
    if (status === 'error' && saveError) {
        const reason = saveError.kind === 'permanent' ? describeError(saveError.error).message : null;
        return (
            <Pressable
                onPress={() => void store.getState().retry()}
                accessibilityRole="button"
                accessibilityHint={t('mobile.flow.ndv.retry_save', 'Try saving again')}
                testID="save-state"
            >
                <Text variant="label" tone="error" numberOfLines={2}>
                    {reason ? `${t('routines.ndv.save_failed', 'Save failed')} · ${reason}` : t('routines.ndv.save_failed', 'Save failed')}
                </Text>
            </Pressable>
        );
    }
    if (status === 'saved') {
        return (
            <Text variant="label" tone="tertiary" testID="save-state">
                {t('common.saved', 'Saved')}
            </Text>
        );
    }
    return null;
}
