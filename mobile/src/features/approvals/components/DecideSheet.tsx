/**
 * The confirmation before a decision leaves the phone. A rejection asks for a
 * reason, so the next person reading the approval knows what has to change.
 *
 * An approval that asks for answers (its snapshot's fields) asks them here,
 * with the same controls a form page uses (features/forms FormRenderer), and
 * Approve sends them: approving without them is refused by the server. A
 * file or a pick from an app cannot be given from the phone yet; the sheet
 * says so rather than offer an Approve that cannot succeed.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FormRenderer, type Answers, type FillField } from '@/features/forms';
import { Banner, Button, Sheet, TextField } from '@/shared/ui';

import type { ApprovalDecision } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footer: { flexDirection: 'row', gap: theme.spacing.md },
        half: { flex: 1 },
        body: { gap: theme.spacing.md },
    });

/** Fields a phone cannot answer yet: they need an upload or an app search the approvals route does not offer. */
const PHONE_CANNOT_ANSWER = new Set(['file', 'app_pick']);

export function DecideSheet({
    confirming,
    reason,
    onReasonChange,
    submitting,
    onConfirm,
    onClose,
    fields = [],
}: {
    /** The decision being confirmed, or null when the sheet is closed. */
    confirming: ApprovalDecision | null;
    reason: string;
    onReasonChange: (text: string) => void;
    submitting: boolean;
    /** Resolves once the decision landed; rejects with the server's refusal (shown under the answers). */
    onConfirm: (decision: ApprovalDecision, answers?: Answers) => void | Promise<void>;
    onClose: () => void;
    /** The answers approving asks for; empty for a plain yes or no. */
    fields?: FillField[];
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const rejecting = confirming === 'reject';
    const asking = !rejecting && fields.length > 0;
    const approveLabel = t('approvals.approve', 'Approve');
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
                    {asking ? null : (
                        <Button
                            label={rejecting ? t('approvals.reject', 'Reject') : approveLabel}
                            // Destructive only inside the confirmation sheet: the
                            // row behind it is a choice, and painting one half red
                            // there would make rejecting look like the dangerous answer.
                            variant={rejecting ? 'danger' : 'primary'}
                            style={styles.half}
                            loading={submitting}
                            onPress={() => confirming && void onConfirm(confirming)}
                        />
                    )}
                </View>
            }
        >
            <View style={styles.body}>
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
                {asking ? <AnswersForm fields={fields} submitLabel={approveLabel} onSubmit={(answers) => onConfirm('approve', answers)} /> : null}
            </View>
        </Sheet>
    );
}

function AnswersForm({ fields, submitLabel, onSubmit }: { fields: FillField[]; submitLabel: string; onSubmit: (answers: Answers) => void | Promise<void> }) {
    const t = useTranslation();
    const blocked = fields.some((f) => PHONE_CANNOT_ANSWER.has(f.type));
    return (
        <>
            {blocked ? (
                <Banner tone="warning">
                    {t('mobile.approvals.answers_on_web', 'This approval asks for a file or a pick from an app. Give those in the web app.')}
                </Banner>
            ) : null}
            <FormRenderer
                form={{
                    title: t('mobile.approvals.answers_title', 'Your answers'),
                    description: '',
                    submitLabel,
                    successMessage: '',
                    theme: null,
                    fields,
                    multiPage: false,
                }}
                onSubmit={async (values) => {
                    await onSubmit(values);
                }}
            />
        </>
    );
}
