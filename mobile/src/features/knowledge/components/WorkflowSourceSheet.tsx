/**
 * An n8n workflow into the knowledge base (POST /:id/ingest/n8n): only the
 * workflows an administrator allowed (`allowKbIngestion`). "Its output" runs
 * the workflow and keeps what it returns; "The workflow itself" keeps its
 * definition as a readable document.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { LoadingState, OptionRow, Segmented, Text, useToast } from '@/shared/ui';

import { useIngestibleWorkflows, useIngestWorkflow } from '../hooks/sources';
import { sourceErrorMessage } from '../model/sourceErrors';

type Mode = 'data' | 'definition';

export function WorkflowSourceSheet({ kbId, visible, onClose }: { kbId: string; visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [picked, setPicked] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>('data');
    const workflows = useIngestibleWorkflows(visible);
    const ingest = useIngestWorkflow(kbId, {
        onSuccess: (chunks) => {
            toast(t('mobile.knowledge.workflow_done', 'Added — {chunks} passages', { chunks }), 'success');
            onClose();
        },
    });
    const list = workflows.data ?? [];
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.knowledge.workflow', 'n8n workflow')}
            submitLabel={t('knowledge.form.add', 'Add source')}
            canSubmit={Boolean(picked)}
            submitting={ingest.isPending}
            onSubmit={() => picked && ingest.mutate({ workflowId: picked, mode })}
        >
            {ingest.error ? <Text variant="caption" tone="error">{sourceErrorMessage(t, ingest.error)}</Text> : null}
            <Segmented<Mode>
                options={[
                    { value: 'data', label: t('mobile.knowledge.workflow_data', 'Its output') },
                    { value: 'definition', label: t('mobile.knowledge.workflow_definition', 'The workflow itself') },
                ]}
                value={mode}
                onChange={setMode}
            />
            {workflows.isLoading ? <LoadingState /> : null}
            {workflows.isError ? <Text variant="caption" tone="warning">{t('mobile.knowledge.workflows_failed', 'The workflows could not be read.')}</Text> : null}
            {workflows.isSuccess && list.length === 0 ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.knowledge.no_workflows', 'No n8n workflow is allowed into knowledge bases yet. An administrator can allow one in the organisation settings.')}
                </Text>
            ) : null}
            {list.map((w) => (
                <OptionRow key={w.id} label={w.name || w.id} selected={picked === w.id} onPress={() => setPicked(w.id)} />
            ))}
        </FormSheet>
    );
}
