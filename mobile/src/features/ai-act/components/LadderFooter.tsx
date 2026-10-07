/**
 * The ladder's buttons. Through the three steps: Later (on the first) or
 * Back, and Next — a step may be left open, the outcome then says it is
 * pending. On the outcome: Back, and Record as self-declared, which waits
 * for steps 1 and 3 when the automation contains AI.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button } from '@/shared/ui';

import type { AiActLadder } from './useAiActLadder';

export function LadderFooter({ ladder, onClose }: { ladder: AiActLadder; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const first = ladder.step === 1;
    const last = ladder.page === 'outcome';
    return (
        <View style={styles.row}>
            <Button
                label={first ? t('compliance.ladder_later', 'Later') : t('common.back', 'Back')}
                variant="secondary"
                onPress={first ? onClose : ladder.back}
                disabled={ladder.saving}
                style={styles.button}
                testID={first ? 'ladder-later' : 'ladder-back'}
            />
            {last ? (
                <Button
                    label={t('compliance.ladder_record', 'Record as self-declared')}
                    iconName="PenLine"
                    onPress={ladder.record}
                    disabled={!ladder.canRecord}
                    loading={ladder.saving}
                    style={styles.button}
                    testID="ladder-record"
                />
            ) : (
                <Button label={t('common.next', 'Next')} onPress={ladder.next} style={styles.button} testID="ladder-next" />
            )}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing.sm },
        button: { flex: 1 },
    });
