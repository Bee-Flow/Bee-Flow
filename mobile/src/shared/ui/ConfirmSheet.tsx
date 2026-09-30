/**
 * A confirmation sheet: what is about to happen, one button that does it, and
 * a way out.
 *
 * RN's Alert is available, but it renders in the OS's own palette and reads as
 * a system error next to eight themed surfaces — and it cannot show what is
 * about to be lost. Deleting a knowledge base takes its chunks and embeddings
 * with it, which is worth a sentence. For a promise-based call site, use
 * `useConfirm()` from shared/patterns, which renders this sheet.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';

import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';

export interface ConfirmSheetProps {
    visible: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
    /** Dims the confirm button and ignores presses while the work runs. */
    busy?: boolean;
    /**
     * `destructive` (the default) paints the confirm button as the tinted
     * danger button. `primary` is
     * for a confirmation that loses nothing — signing out, sending.
     */
    tone?: 'destructive' | 'primary';
}

export function ConfirmSheet({
    visible,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
    busy = false,
    tone = 'destructive',
}: ConfirmSheetProps) {
    const t = useTranslation();
    return (
        <Sheet visible={visible} onClose={onCancel} title={title}>
            <Text variant="body" tone="secondary">
                {message}
            </Text>
            <View style={styles.actions}>
                <Button
                    label={confirmLabel}
                    onPress={onConfirm}
                    loading={busy}
                    // The web's ConfirmDialog: a tinted danger button (the
                    // error colour at 10% under its ink), not a solid red slab.
                    variant={tone === 'primary' ? 'primary' : 'danger'}
                    size="lg"
                    fullWidth
                />
                <Button label={t('common.cancel', 'Cancel')} onPress={onCancel} variant="ghost" size="lg" fullWidth />
            </View>
        </Sheet>
    );
}

const styles = StyleSheet.create({ actions: { gap: 8 } });
