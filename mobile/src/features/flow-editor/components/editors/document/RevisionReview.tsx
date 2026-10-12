/**
 * The revision a Fill in a document step is pinned to, and — when the
 * document has moved on since — the web's "Review available update": the
 * document as it is now (its instructions, the values it asks for, its
 * optional sections), read on request, and applied to the step only when the
 * author says so. Until then the step keeps filling the revision it was
 * built against.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { DocumentContract, DocumentTemplate } from '@/features/flow-editor/api';
import { useDocumentContract } from '@/features/flow-editor/hooks';
import { Button, Card, Text } from '@/shared/ui';

import { shortRevision, updateAvailable } from './fillDocumentModel';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

function Review({ latest, onApply, onCancel }: { latest: ReturnType<typeof useDocumentContract>; onApply: (versionId: string) => void; onCancel: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const next = latest.data;
    return (
        <Card testID="fill-document-review">
            <View style={styles.stack}>
                <Text variant="body" weight="semibold">
                    {t('automations.document_fields.review_template_update', 'Review template update')}
                </Text>
                {latest.isPending ? <Note>{t('common.loading', 'Loading...')}</Note> : null}
                {latest.isError ? <Warn tone="error">{t('mobile.flow.fill.load_failed', 'Could not load your documents.')}</Warn> : null}
                {next?.instructions ? <Note>{next.instructions}</Note> : null}
                {next?.parameters.map((p) => (
                    <Note key={p.key}>{`${p.key}${p.required ? ' *' : ''} — ${p.summary || p.instructions}`}</Note>
                ))}
                {next?.sections.map((s) => (
                    <Note key={s.id}>{`${s.title}: ${s.summary}`}</Note>
                ))}
                <View style={styles.actions}>
                    <Button size="sm" variant="secondary" label={t('common.cancel', 'Cancel')} onPress={onCancel} />
                    <Button
                        size="sm"
                        label={t('automations.document_fields.apply_reviewed_revision', 'Apply reviewed revision')}
                        disabled={!next?.versionId}
                        onPress={() => next && onApply(next.versionId)}
                        testID="fill-document-apply-revision"
                    />
                </View>
            </View>
        </Card>
    );
}

export function RevisionReview({
    documentId,
    contract,
    picked,
    onPin,
    disabled,
}: {
    documentId: string;
    contract: DocumentContract | undefined;
    picked: DocumentTemplate | null;
    onPin: (versionId: string) => void;
    disabled: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [reviewing, setReviewing] = useState(false);
    const latest = useDocumentContract(documentId, null, reviewing);
    if (!contract?.versionId) return null;
    return (
        <View style={styles.stack}>
            <View style={styles.row}>
                <Text variant="caption" tone="tertiary" style={styles.grow}>
                    {t('mobile.flow.fill.pinned', 'Pinned revision: {id}', { id: shortRevision(contract.versionId) })}
                </Text>
                {updateAvailable(contract, picked) && !reviewing ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        label={t('automations.document_fields.review_available_update', 'Review available update')}
                        onPress={() => setReviewing(true)}
                        disabled={disabled}
                        testID="fill-document-review-update"
                    />
                ) : null}
            </View>
            {reviewing ? (
                <Review
                    latest={latest}
                    onCancel={() => setReviewing(false)}
                    onApply={(versionId) => {
                        onPin(versionId);
                        setReviewing(false);
                    }}
                />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    stack: { gap: theme.spacing.sm } satisfies ViewStyle,
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    grow: { flex: 1 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
});
