/**
 * "I declare this item, and here is the evidence" (web: custom/AttestDrawer):
 * an outcome, a statement, and files uploaded as evidence first — the
 * attestation then carries only `{ sha256, filename }` per file. An item that
 * requires evidence cannot be recorded without one.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FormSheet } from '@/shared/patterns';
import { Button, Text, TextField } from '@/shared/ui';

import { ChoiceChips } from './ChoiceChips';
import type { EvidenceRef } from '../api/upload';
import { useEvidenceUpload } from '../hooks/useEvidence';
import { labelText } from '../model/fields';
import type { AttestSpec, Rec } from '../model/types';

export interface AttestSheetProps {
    spec: AttestSpec;
    rec: Rec;
    title: string;
    onClose: () => void;
    onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}

export function AttestSheet({ spec, rec, title, onClose, onSubmit }: AttestSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [outcome, setOutcome] = useState('');
    const [statement, setStatement] = useState('');
    const [refs, setRefs] = useState<EvidenceRef[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [saving, setSaving] = useState(false);
    const upload = useEvidenceUpload({
        subjectType: spec.subjectType,
        subjectId: spec.subjectId?.(rec) ?? null,
        checkId: spec.checkId?.(rec) ?? null,
    });
    const needsEvidence = spec.evidenceRequired?.(rec) === true;
    const blocked = !outcome || (needsEvidence && refs.length === 0);

    const attach = async () => {
        const result = await upload.pickAndUpload();
        if (!result) return;
        if ('error' in result) setError(new Error(result.error));
        else setRefs((prev) => [...prev, result.ref]);
    };

    const submit = async () => {
        setSaving(true);
        setError(null);
        try {
            await onSubmit({ outcome, statement: statement.trim() || null, evidence_refs: refs });
            onClose();
        } catch (err) {
            setError(err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <FormSheet
            visible
            onClose={onClose}
            title={title}
            submitLabel={t('compliance.custom_attest_save', 'Record attestation')}
            onSubmit={() => void submit()}
            submitting={saving}
            canSubmit={!blocked && !upload.uploading}
            error={error}
        >
            <ChoiceChips
                testID="attest-outcome"
                label={t('compliance.custom_attest_outcome', 'Outcome')}
                options={spec.outcomes.map((o) => ({ value: o.value, label: labelText(o.label, t) }))}
                value={outcome}
                onChange={setOutcome}
                required
            />
            <TextField
                testID="attest-statement"
                label={t('compliance.custom_attest_statement', 'Statement')}
                hint={t('compliance.custom_attest_statement_hint', 'what you checked, and how')}
                value={statement}
                onChangeText={setStatement}
                multiline
            />
            <View style={styles.evidence}>
                <Text variant="label" tone="secondary">
                    {`${t('compliance.custom_attest_evidence', 'Evidence')} · ${needsEvidence ? t('compliance.custom_attest_evidence_required', 'required for this item') : t('compliance.custom_attest_evidence_optional', 'optional')}`}
                </Text>
                {refs.map((r) => (
                    <Text key={r.sha256} variant="caption" numberOfLines={1}>
                        {r.filename ?? t('compliance.custom_attest_evidence_file', 'file')}
                    </Text>
                ))}
                <Button
                    testID="attest-upload"
                    variant="secondary"
                    size="sm"
                    iconName="Upload"
                    loading={upload.uploading}
                    label={upload.uploading ? t('compliance.custom_attest_uploading', 'Uploading…') : t('compliance.custom_attest_upload', 'Attach evidence')}
                    onPress={() => void attach()}
                />
            </View>
        </FormSheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        evidence: { gap: theme.spacing[2], paddingVertical: theme.spacing[2], alignItems: 'flex-start' },
    });
