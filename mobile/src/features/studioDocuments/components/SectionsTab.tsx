/**
 * The Sections tab: the parts of the document that apply only sometimes, and
 * the rule for each. "Choose when each section applies. Unknown customer data
 * needs input before a final PDF." Adding a section declares it and appends
 * it to the body in one save, as the web does.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Button, ListRow, Text, useToast } from '@/shared/ui';

import { SectionSheet } from './SectionSheet';
import { TabFrame } from './TabFrame';
import type { DocumentWrite } from '../hooks/useDocumentWriter';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import { contractProblem } from '../model/contract';
import { conditionText } from '../model/format';
import { addSectionPatch, contractPatch, newSectionId, type ContractDraft } from '../model/patches';
import type { ContractSection, StudioDocument } from '../model/types';
import { replaceAt } from '../model/values';

export interface SectionsTabProps {
    doc: StudioDocument;
    write: DocumentWrite;
    /** Saves the text still being typed, so the new section lands after it. */
    beforeBodyChange: () => Promise<void>;
    /** After a section is added the body changed: the screen reloads its editors. */
    onBodyChanged: () => void;
}

export function SectionsTab({ doc, write, beforeBodyChange, onBodyChanged }: SectionsTabProps) {
    const t = useTranslation();
    const { toast } = useToast();
    const draft = useSettingsDraft<ContractDraft>({ contract: doc.contract, kind: doc.kind, visibility: doc.visibility }, write, contractPatch);
    const [editing, setEditing] = useState<number | null>(null);
    const [adding, setAdding] = useState(false);
    const { sections, parameters } = draft.draft.contract;

    const add = async () => {
        setAdding(true);
        try {
            if (draft.dirty && !(await draft.save())) return;
            await beforeBodyChange();
            const title = t('mobile.studio_documents.section.new', 'New section');
            const body = t('mobile.studio_documents.section.body', 'Write your content here.');
            await write((current) => addSectionPatch({ id: newSectionId(), title, body }, current));
            onBodyChanged();
        } catch (error) {
            toast(describeError(error).message, 'error');
        } finally {
            setAdding(false);
        }
    };

    return (
        <TabFrame
            editable={doc.editable}
            save={{ dirty: draft.dirty, saving: draft.saving, error: draft.error, onSave: () => void draft.save(), problem: draft.dirty ? contractProblem(draft.draft.contract) : null }}
        >
            <Text variant="caption" tone="tertiary">
                {t('mobile.studio_documents.section.hint', 'Choose when each section applies. Unknown customer data needs input before a final PDF.')}
            </Text>
            {sections.map((s: ContractSection, index) => (
                <ListRow key={s.id} title={s.title || s.id} subtitle={conditionText(t, s.condition)} wrapTitle onPress={() => setEditing(index)} />
            ))}
            {doc.editable ? (
                <Button label={t('mobile.studio_documents.section.add', 'Add section')} iconName="Plus" variant="secondary" loading={adding} onPress={() => void add()} />
            ) : null}
            <SectionSheet
                section={editing === null ? null : (sections[editing] ?? null)}
                parameters={parameters}
                onClose={() => setEditing(null)}
                onDone={(next) => {
                    if (editing !== null) draft.setDraft((d) => ({ ...d, contract: { ...d.contract, sections: replaceAt(d.contract.sections, editing, next) } }));
                    setEditing(null);
                }}
            />
        </TabFrame>
    );
}
