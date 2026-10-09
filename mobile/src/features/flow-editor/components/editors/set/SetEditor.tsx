/**
 * The "Edit data" (set) editor — the web's SetFields (setEditors.jsx). Two
 * modes, derived — never stored — from whether `arrayRef` is present (the
 * Condition node's convention):
 *
 *   single — one record, built field by field;
 *   list   — the step works through an upstream list: the fields are worked
 *            out for each row, with the row in scope as "Current row", then
 *            the whole-table tools run.
 *
 * Which list it walks is detected when the step is wired, so it lives under
 * Advanced — unless it is still unset, when hiding it would be a dead end.
 * `forEach` is for single mode only; list mode clears it on save.
 */

import React, { type ReactNode } from 'react';

import { useTranslation } from '@/core/i18n';
import { resolveElementSample } from '@/features/flow-editor/bindings';
import { RowsEditor, SelectField } from '@/features/flow-editor/components/fields';
import { VariablePickerProvider } from '@/features/flow-editor/components/variables';
import { buildStepTypeMap } from '@/features/flow-editor/model';

import { JsonExtract } from './JsonExtract';
import { baseColumnsOf, type SetOp } from './setModel';
import { SetOperationsEditor } from './SetOperationsEditor';
import { FOR_EACH } from '../declarative/specs/common';
import { itemScope } from '../route/fieldOptions';
import { Band } from '../shared/Band';
import { listOf, recordOf } from '../shared/list';
import { Note } from '../shared/Note';
import { SourceSummary } from '../shared/SourceSummary';
import { SpecFields } from '../shared/SpecFields';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';

function Source({ editor, hint }: { editor: StepEditorProps; hint: string }) {
    const { draft, set, ctx } = editor;
    return (
        <SourceSummary
            hint={hint}
            source={typeof draft.arrayRef === 'string' ? draft.arrayRef : ''}
            maxItems={draft.maxItems}
            onSource={(source) => set('arrayRef', source)}
            onMaxItems={(maxItems) => set('maxItems', maxItems)}
            groups={ctx.groups}
            sampleRoot={ctx.sampleRoot}
            stepLabelById={ctx.stepLabelById}
            stepTypeById={buildStepTypeMap(ctx.definition)}
            disabled={ctx.disabled}
        />
    );
}

function Advanced({ editor, listMode, ops }: { editor: StepEditorProps; listMode: boolean; ops: readonly SetOp[] }) {
    const t = useTranslation();
    const { step, draft, set, ctx } = editor;
    return (
        <Band editor={editor} sectionKey="advanced" title={t('mobile.flow.section.advanced', 'Advanced')} defaultOpen={!listMode && !!draft.forEach} hasContent={!listMode && !!draft.forEach}>
            <SelectField
                label={t('automations.set_editors.works_on', 'Works on')}
                hint={t('automations.set_editors.detected_from_the_step_above_override', 'Detected from the step above — override it here if the guess is wrong.')}
                value={listMode ? 'items' : 'single'}
                options={[
                    { value: 'items', label: t('automations.set_editors.each_row_of_a_list', 'Each row of a list') },
                    { value: 'single', label: t('automations.set_editors.the_whole_run', 'The whole run') },
                ]}
                onChange={(v) => set('arrayRef', v === 'items' ? (draft.arrayRef ?? '') : null)}
                disabled={ctx.disabled}
                testID="set-works-on"
            />
            {listMode && ops.length > 0 ? <Note>{t('automations.set_editors.switching_to_the_whole_run_also', 'Switching to “The whole run” also removes the table tools.')}</Note> : null}
            {listMode && draft.arrayRef ? <Source editor={editor} hint={t('mobile.flow.set.source_hint', 'Detected from the step above. The fields are computed for each row of this list.')} /> : null}
            {!listMode ? <SpecFields editor={editor} fields={[FOR_EACH]} /> : null}
            {listMode && step.forEach ? <Warn>{t('automations.set_editors.list_mode_replaces_run_once_per', 'List mode replaces “Run once per item” — saving removes the old per-item setting.')}</Warn> : null}
        </Band>
    );
}

export function SetEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const listMode = typeof draft.arrayRef === 'string';
    const element = listMode ? resolveElementSample(draft.arrayRef as string, ctx.sampleRoot) : null;
    const scope = listMode ? itemScope(element, ctx, t('mobile.flow.set.current_row', 'Current row'), { _index: 0 }) : null;
    const ops = listOf<SetOp>(draft.operations);
    const scoped = (node: ReactNode) =>
        scope ? (
            <VariablePickerProvider groups={scope.groups} sampleRoot={scope.sampleRoot} stepLabelById={ctx.stepLabelById}>
                {node}
            </VariablePickerProvider>
        ) : (
            node
        );
    return (
        <>
            {listMode && !draft.arrayRef ? <Source editor={editor} hint={t('mobile.flow.set.no_source', 'This step has no list to work through yet — pick the step whose results it should edit.')} /> : null}
            <Band editor={editor} sectionKey="fields" title={listMode ? t('mobile.flow.set.fields_each_row', 'Fields added to each row') : t('automations.mapping.fields', 'Fields')} defaultOpen>
                <Note>
                    {listMode
                        ? t('mobile.flow.set.fields_each_row_hint', 'Every row keeps its own data. The fields below are worked out for each row — reuse a name to overwrite that column.')
                        : t('mobile.flow.set.fields_hint', 'One record, built field by field.')}
                </Note>
                {scoped(<RowsEditor value={recordOf(draft.fields)} onChange={(next) => set('fields', next)} keepEmpty disabled={ctx.disabled} testID="set-fields" />)}
                <JsonExtract
                    fields={draft.fields}
                    onFields={(next) => set('fields', next)}
                    listMode={listMode}
                    elementSample={element}
                    groups={ctx.groups}
                    sampleRoot={scope?.sampleRoot ?? ctx.sampleRoot}
                    disabled={ctx.disabled}
                />
            </Band>
            {listMode ? (
                <Band editor={editor} sectionKey="table" title={t('automations.set_editors.table_tools', 'Table tools')} defaultOpen>
                    <Note>{t('automations.set_editors.applied_to_the_whole_table_top', 'Applied to the whole table, top to bottom, after the fields above.')}</Note>
                    <SetOperationsEditor ops={ops} onChange={(next) => set('operations', next)} baseColumns={baseColumnsOf(element, draft.fields)} disabled={ctx.disabled} />
                </Band>
            ) : null}
            <Advanced editor={editor} listMode={listMode} ops={ops} />
        </>
    );
}
