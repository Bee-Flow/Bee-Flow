/**
 * The Parameters tab (the web's workspace panel of the same name): the
 * document's instructions, its typed parameters — what an automation, an app or a
 * person fills per customer — and where it lives in the library.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Button, Icon, IconButton, ListRow, Segmented, TextField, useToast } from '@/shared/ui';

import { ParameterSheet } from './ParameterSheet';
import { TabFrame } from './TabFrame';
import type { DocumentWrite } from '../hooks/useDocumentWriter';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import { contractProblem } from '../model/contract';
import { kindLabel, paramTypeLabel } from '../model/format';
import { contractPatch, type ContractDraft } from '../model/patches';
import type { ContractParameter, DocKind, StudioDocument, Visibility } from '../model/types';
import { newParameter, removeAt, replaceAt } from '../model/values';

function ParameterRow({ p, onEdit }: { p: ContractParameter; onEdit: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const copy = async () => {
        await Clipboard.setStringAsync(`{{${p.key}}}`);
        toast(t('mobile.studio_documents.param.copied', 'Placeholder copied — paste it into the text.'), 'success');
    };
    return (
        <ListRow
            title={`${p.label || p.key || t('mobile.studio_documents.param.new', 'New parameter')}${p.required ? ' *' : ''}`}
            subtitle={`${paramTypeLabel(t, p.type)} · ${p.summary || p.key}`}
            trailing={
                p.instructions ? (
                    <IconButton
                        icon={<Icon name="Copy" size={16} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.studio_documents.param.copy', 'Copy the placeholder')}
                        disabled={!p.key}
                        onPress={() => void copy()}
                    />
                ) : (
                    <Badge label={t('mobile.studio_documents.param.review', 'Instructions need review')} tone="warning" />
                )
            }
            onPress={onEdit}
        />
    );
}

function LibraryPlace({ draft, isDeck, onChange }: { draft: ContractDraft; isDeck: boolean; onChange: (patch: Partial<ContractDraft>) => void }) {
    const t = useTranslation();
    const kinds: DocKind[] = isDeck ? ['document', 'template'] : ['document', 'template', 'section'];
    return (
        <>
            <Segmented<DocKind>
                options={kinds.map((kind) => ({ value: kind, label: kindLabel(t, kind, isDeck) }))}
                value={draft.kind}
                onChange={(kind) => onChange(kind === 'document' ? { kind, visibility: 'private' } : { kind })}
                accessibilityLabel={t('mobile.studio_documents.library_type', 'Library type')}
                fullWidth
            />
            {draft.kind !== 'document' ? (
                <Segmented<Visibility>
                    options={[
                        { value: 'private', label: t('mobile.studio_documents.private', 'Private') },
                        { value: 'team', label: t('mobile.studio_documents.team_library', 'Team library') },
                    ]}
                    value={draft.visibility}
                    onChange={(visibility) => onChange({ visibility })}
                    accessibilityLabel={t('mobile.studio_documents.visibility', 'Visibility')}
                    fullWidth
                />
            ) : null}
        </>
    );
}

export function ParametersTab({ doc, write }: { doc: StudioDocument; write: DocumentWrite }) {
    const t = useTranslation();
    const draft = useSettingsDraft<ContractDraft>({ contract: doc.contract, kind: doc.kind, visibility: doc.visibility }, write, contractPatch);
    const [editing, setEditing] = useState<{ index: number; parameter: ContractParameter } | null>(null);
    const { contract } = draft.draft;
    const setContract = (patch: Partial<ContractDraft['contract']>) =>
        draft.setDraft((d) => ({ ...d, contract: { ...d.contract, ...patch } }));
    const isDeck = doc.docType === 'presentation';

    return (
        <TabFrame
            editable={doc.editable}
            save={{ dirty: draft.dirty, saving: draft.saving, error: draft.error, onSave: () => void draft.save(), problem: draft.dirty ? contractProblem(contract) : null }}
        >
            <TextField
                label={t('mobile.studio_documents.instructions', 'Document instructions')}
                value={contract.instructions}
                multiline
                editable={doc.editable}
                onChangeText={(instructions) => setContract({ instructions })}
            />
            {contract.parameters.map((p, index) => (
                <ParameterRow key={`${index}:${p.key}`} p={p} onEdit={() => setEditing({ index, parameter: p })} />
            ))}
            {doc.editable ? (
                <Button label={t('mobile.studio_documents.param.add', 'Add parameter')} iconName="Plus" variant="secondary" onPress={() => setEditing({ index: contract.parameters.length, parameter: newParameter() })} />
            ) : null}
            <LibraryPlace draft={draft.draft} isDeck={isDeck} onChange={(patch) => draft.setDraft((d) => ({ ...d, ...patch }))} />
            <ParameterSheet
                parameter={editing?.parameter ?? null}
                onClose={() => setEditing(null)}
                onDone={(next) => {
                    if (editing) {
                        const list = contract.parameters;
                        setContract({ parameters: editing.index < list.length ? replaceAt(list, editing.index, next) : [...list, next] });
                    }
                    setEditing(null);
                }}
                onDelete={() => {
                    if (editing) setContract({ parameters: removeAt(contract.parameters, editing.index) });
                    setEditing(null);
                }}
            />
        </TabFrame>
    );
}
