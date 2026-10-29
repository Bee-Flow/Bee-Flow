/**
 * The confirmation before a decision leaves the phone. A rejection asks for a
 * reason, so the next person reading the approval knows what has to change.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, TextField } from '@/shared/ui';

import type { ApprovalDecision } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footer: { flexDirection: 'row', gap: theme.spacing.md },
        half: { flex: 1 },
    });

export function DecideSheet({
    confirming,
    reason,
    onReasonChange,
    submitting,
    onConfirm,
    onClose,
}: {
    /** The decision being confirmed, or null when the sheet is closed. */
    confirming: ApprovalDecision | null;
    reason: string;
    onReasonChange: (text: string) => void;
    submitting: boolean;
    onConfirm: (decision: ApprovalDecision) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const rejecting = confirming === 'reject';
    return (
        <Sheet
            visible={confirming !== null}
            onClose={onClose}
            title={rejecting ? t('mobile.approvals.reject_title', 'Reject this?') : t('mobile.approvals.approve_title', 'Approve this?')}
            subtitle={
                rejecting
                    ? t(
                          'mobile.approvals.reject_hint',
                          'The automation stops here. Say why, so the next person reading this knows.',
                      )
                    : t('mobile.approvals.approve_hint', 'The automation carries on from where it paused.')
            }
            footer={
                <View style={styles.footer}>
                    <Button label={t('common.cancel', 'Cancel')} variant="ghost" style={styles.half} onPress={onClose} />
                    <Button
                        label={rejecting ? t('approvals.reject', 'Reject') : t('approvals.approve', 'Approve')}
                        // Destructive only inside the confirmation sheet: the
                        // row behind it is a choice, and painting one half red
                        // there would make rejecting look like the dangerous answer.
                        variant={rejecting ? 'danger' : 'primary'}
                        style={styles.half}
                        loading={submitting}
                        onPress={() => confirming && onConfirm(confirming)}
                    />
                </View>
            }
        >
            <TextField
                label={rejecting ? t('mobile.approvals.reason', 'Reason') : t('mobile.approvals.note_optional', 'Note (optional)')}
                value={reason}
                onChangeText={onReasonChange}
                multiline
                placeholder={
                    rejecting
                        ? t('mobile.approvals.reason_placeholder', 'What needs to change before this can go ahead?')
                        : ''
                }
            />
        </Sheet>
    );
}
