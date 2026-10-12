/**
 * Customer preview: the values this document is filled with, whether each
 * conditional section applies (worked out on the phone as you type, with the
 * server's own rule — model/contract.ts), "Validate & preview", and the PDF.
 *
 * On a plain document the values are stored with it; on a template the
 * server keeps none — they only feed this preview.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Badge, Button, Segmented, Text } from '@/shared/ui';

import { makeEditorStyles } from './editorStyles';
import { TabFrame } from './TabFrame';
import { ValidationCard } from './ValidationCard';
import { ValueInput } from './ValueInput';
import { useValidateStudioDocument } from '../hooks/mutations';
import type { DocumentWrite } from '../hooks/useDocumentWriter';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import { evaluateCondition, nestValues } from '../model/contract';
import { sectionStateLabel } from '../model/format';
import { sampleValuesOf, sectionOverridesOf, valuesPatch, type ValuesDraft } from '../model/patches';
import type { ContractSection, StudioDocument } from '../model/types';

type Choice = 'automatic' | 'include' | 'exclude';
const TONES = { included: 'success', excluded: 'neutral', unresolved: 'warning' } as const;

function SectionChoice({ section, choice, values, onChange }: { section: ContractSection; choice: Choice; values: Record<string, unknown>; onChange: (c: Choice) => void }) {
    const t = useTranslation();
    const state = choice === 'include' ? 'included' : choice === 'exclude' ? 'excluded' : evaluateCondition(section.condition, values).state;
    return (
        <View>
            <Text variant="caption" tone="secondary">
                {section.title || section.id}
            </Text>
            <Segmented<Choice>
                options={[
                    { value: 'automatic', label: t('automations.line_color_panel.automatic', 'Automatic') },
                    { value: 'include', label: t('automations.document_fields.include', 'Include') },
                    { value: 'exclude', label: t('automations.document_fields.exclude', 'Exclude') },
                ]}
                value={choice}
                onChange={onChange}
                accessibilityLabel={section.title}
                fullWidth
            />
            <Badge label={sectionStateLabel(t, state)} tone={TONES[state]} />
        </View>
    );
}

export interface PreviewTabProps {
    doc: StudioDocument;
    write: DocumentWrite;
    onOpenPdf: () => void;
    exporting: boolean;
}

export function PreviewTab({ doc, write, onOpenPdf, exporting }: PreviewTabProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeEditorStyles);
    const draft = useSettingsDraft<ValuesDraft>({ sampleValues: sampleValuesOf(doc), sectionOverrides: sectionOverridesOf(doc) }, write, valuesPatch);
    const validate = useValidateStudioDocument(doc.id);
    const { sampleValues, sectionOverrides } = draft.draft;
    const nested = nestValues(sampleValues);
    const run = async () => {
        if (draft.dirty && !(await draft.save())) return;
        validate.mutate({ values: sampleValues, overrides: sectionOverrides });
    };
    // The PDF is rendered from the STORED values, so unsaved ones are saved first.
    const openPdf = async () => {
        if (draft.dirty && !(await draft.save())) return;
        onOpenPdf();
    };
    return (
        <TabFrame editable={doc.editable} save={{ dirty: draft.dirty, saving: draft.saving, error: draft.error ?? validate.error, onSave: () => void draft.save() }}>
            <Text variant="caption" tone="tertiary">
                {doc.kind === 'document'
                    ? t('mobile.studio_documents.values.stored', 'Customer values are stored on this private document.')
                    : t('mobile.studio_documents.values.sample', 'Sample data is used only for this preview and is never saved to a shared template.')}
            </Text>
            {doc.contract.parameters.map((p) => (
                <ValueInput
                    key={p.key}
                    parameter={p}
                    label={`${p.label || p.key}${p.required ? ' *' : ''}`}
                    value={sampleValues[p.key]}
                    onChange={(next) => draft.setDraft((d) => ({ ...d, sampleValues: { ...d.sampleValues, [p.key]: next } }))}
                />
            ))}
            {doc.contract.sections.map((s) => (
                <SectionChoice
                    key={s.id}
                    section={s}
                    values={nested}
                    choice={(sectionOverrides[s.id] as Choice | undefined) ?? 'automatic'}
                    onChange={(c) => draft.setDraft((d) => ({ ...d, sectionOverrides: { ...d.sectionOverrides, [s.id]: c } }))}
                />
            ))}
            <View style={styles.block}>
                <Button label={t('mobile.studio_documents.values.validate', 'Validate & preview')} iconName="ListChecks" variant="secondary" loading={validate.isPending} onPress={() => void run()} />
                {validate.data ? <ValidationCard result={validate.data} /> : null}
                <Button label={t('documents.download_pdf', 'Download PDF')} iconName="Download" loading={exporting} onPress={() => void openPdf()} />
            </View>
        </TabFrame>
    );
}
