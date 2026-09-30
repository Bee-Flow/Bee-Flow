/**
 * The knowledge bases an AI step is grounded in (BFSF-410) — the web's
 * AiStepKbSelect: searched once before the step runs and added as reference
 * material. Only the bases made available to routines are offered (K5); the
 * runner re-checks every id against the running user anyway, so this list is
 * advice, not authority.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FieldRow } from '@/features/flow-editor/components/fields';
import { useAiStepKnowledgeBases } from '@/features/flow-editor/hooks';
import { OptionRow } from '@/shared/ui';

import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';
import { toggleKnowledgeBase } from './aiModel';

export function KnowledgeChooser({ draft, setMany, ctx }: StepEditorProps) {
    const t = useTranslation();
    const kbs = useAiStepKnowledgeBases();
    const selected = Array.isArray(draft.knowledgeBaseIds) ? (draft.knowledgeBaseIds as string[]) : [];
    let body: React.ReactNode;
    if (kbs.isPending) body = <Note>{t('common.loading', 'Loading...')}</Note>;
    else if (kbs.isError) body = <Warn>{t('mobile.flow.ai.kb_unreadable', 'The knowledge bases could not be read. The ones this step already uses are kept.')}</Warn>;
    else if (!kbs.data.length) body = <Note>{t('mobile.flow.ai.kb_empty', 'No knowledge bases yet — add one under Knowledge Bases first.')}</Note>;
    else {
        body = kbs.data.map((kb) => (
            <OptionRow
                key={kb.id}
                label={kb.name}
                selected={selected.includes(kb.id)}
                onPress={() => setMany(toggleKnowledgeBase(draft, kb.id))}
                disabled={ctx.disabled}
            />
        ));
    }
    return (
        <FieldRow
            label={t('routines.versions.setting.knowledgeBaseIds', 'Knowledge bases')}
            hint={t(
                'mobile.flow.ai.knowledge_bases_hint',
                'Ground this step in these knowledge bases — searched once before the step runs and added to the prompt as reference material. Good for steerable content like a brand style guide or a positioning doc.',
            )}
        >
            {body}
        </FieldRow>
    );
}
