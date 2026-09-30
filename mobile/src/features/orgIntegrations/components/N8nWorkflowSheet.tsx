/**
 * One configured n8n workflow, opened (N8nSection.jsx's expanded row): its
 * display name, the tool slug the AI calls (`n8n_run_<slug>`), the
 * description the AI reads, its inputs, whether agents may ingest it into a
 * knowledge base, and removing it. Field edits wait for the screen's Save.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, NoteRow, Sheet, TextField, ToggleRow } from '@/shared/ui';

import { N8nInputRow } from './N8nInputRow';
import type { WorkflowDraft } from '../hooks/useWorkflowDraft';
import { cleanSlug } from '../model/n8n';
import type { N8nWorkflow } from '../model/n8nTypes';

export function N8nWorkflowSheet({
    workflow,
    draft,
    onRemove,
    onClose,
}: {
    workflow: N8nWorkflow | null;
    draft: WorkflowDraft;
    onRemove: (workflow: N8nWorkflow) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const id = workflow?.id ?? '';
    return (
        <Sheet visible={workflow !== null} onClose={onClose} title={workflow?.name ?? ''} subtitle={`n8n_run_${workflow?.slug ?? ''}`} tall>
            {workflow ? (
                <>
                    <TextField
                        testID="n8n-wf-name"
                        label={t('mobile.orgIntegrations.n8n_wf_name', 'Display Name')}
                        value={workflow.name}
                        onChangeText={(name) => draft.update(id, { name })}
                    />
                    <TextField
                        testID="n8n-wf-slug"
                        label={t('mobile.orgIntegrations.n8n_wf_slug', 'Tool Slug')}
                        hint={`n8n_run_${workflow.slug}`}
                        autoCapitalize="none"
                        value={workflow.slug}
                        onChangeText={(slug) => draft.update(id, { slug: cleanSlug(slug) })}
                    />
                    <TextField
                        testID="n8n-wf-description"
                        label={t('mobile.orgIntegrations.n8n_wf_description', 'Description (shown to AI)')}
                        placeholder={t('mobile.orgIntegrations.n8n_wf_description_ph', 'Describe what this workflow does')}
                        multiline
                        value={workflow.description}
                        onChangeText={(description) => draft.update(id, { description })}
                    />
                    {workflow.inputs.length === 0 ? (
                        <NoteRow>{t('mobile.orgIntegrations.n8n_no_inputs', 'No inputs — AI sends freeform JSON.')}</NoteRow>
                    ) : null}
                    {workflow.inputs.map((input, index) => (
                        <N8nInputRow
                            key={index}
                            input={input}
                            index={index}
                            onChange={(patch) => draft.updateInput(id, index, patch)}
                            onRemove={() => draft.removeInput(id, index)}
                        />
                    ))}
                    <Button
                        label={t('mobile.orgIntegrations.n8n_add_input', 'Add input parameter')}
                        variant="secondary"
                        iconName="Plus"
                        onPress={() => draft.addInput(id)}
                    />
                    <ToggleRow
                        testID="n8n-wf-kb"
                        gutter={false}
                        label={t('mobile.orgIntegrations.n8n_wf_kb', 'Knowledge base ingestion')}
                        description={t('mobile.orgIntegrations.n8n_wf_kb_hint', 'Allow agents to ingest this workflow into their Knowledge Base.')}
                        value={workflow.allowKbIngestion}
                        disabled={draft.saving}
                        onValueChange={() => void draft.toggleKb(id)}
                    />
                    <Button
                        testID="n8n-wf-remove"
                        label={t('mobile.orgIntegrations.n8n_wf_remove', 'Remove workflow')}
                        variant="danger"
                        iconName="Trash2"
                        onPress={() => onRemove(workflow)}
                    />
                </>
            ) : null}
        </Sheet>
    );
}
