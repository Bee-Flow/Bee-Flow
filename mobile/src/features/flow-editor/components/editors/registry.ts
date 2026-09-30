/**
 * Which editor a step type gets — the node editor's one lookup, the phone's
 * version of the web's SettingsHost + settings/registry.js (there empty; the
 * web switches in SettingsForm instead).
 *
 *   1. a BESPOKE editor registered here (EDITORS) — for the types a form
 *      cannot describe: the Condition's rules, approval stages, the form
 *      builder, Edit data's operations, a table's rows, the schedule, code;
 *   2. otherwise the DECLARATIVE editor, when the type has a spec
 *      (declarative/specs);
 *   3. otherwise the JSON view of the step's settings.
 *
 * To add a bespoke editor: put it in `editors/<type>/`, import it here and
 * add it to EDITORS under every runtime type it edits. If its draft needs
 * keys formState does not carry for that type, give it a FORMS entry too, so
 * the node editor extracts and patches with its pair.
 */

import { createElement, type ReactElement } from 'react';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState } from '@/features/flow-editor/formState';

import { AI_STEP_FORM } from './ai/aiForm';
import { AiStepEditor } from './ai/AiStepEditor';
import { ApprovalEditor } from './approval/ApprovalEditor';
import { CodeEditor } from './code/CodeEditor';
import { DatatableEditor } from './datatable/DatatableEditor';
import { DATATABLE_FORM } from './datatable/datatableModel';
import { DeclarativeEditor, JsonStepEditor, specDraft, specFor, specPatch } from './declarative';
import { FillDocumentEditor } from './document/FillDocumentEditor';
import { FormPageStepEditor } from './form/FormPageStepEditor';
import { HttpRequestEditor } from './http/HttpRequestEditor';
import { LoopEditor } from './loop/LoopEditor';
import { RouteEditor } from './route/RouteEditor';
import { SetEditor } from './set/SetEditor';
import { TriggerEditor } from './trigger/TriggerEditor';
import type { StepEditor, StepEditorProps, StepForm } from './types';

export type { FormMode, StepEditor, StepEditorContext, StepEditorProps, StepForm } from './types';

/** Bespoke editors, by runtime step type. */
export const EDITORS: Readonly<Record<string, StepEditor>> = {
    trigger: TriggerEditor,
    // If / Switch / Filter are ONE node with one editor (routeModel).
    condition: RouteEditor,
    switch: RouteEditor,
    filter: RouteEditor,
    loop: LoopEditor,
    ai_step: AiStepEditor,
    set: SetEditor,
    approval: ApprovalEditor,
    form_page: FormPageStepEditor,
    datatable: DatatableEditor,
    http_request: HttpRequestEditor,
    code: CodeEditor,
    // Its picker and value rows read the Documents API; its plain bands are its spec's.
    fill_document: FillDocumentEditor,
    // `parallel` has no editor on the web either (nodeDefs: engine-only,
    // nothing builds `branches` yet), so it keeps the JSON view.
};

/** Bespoke editors' own draft/patch pairs, where formState's is not enough. */
export const FORMS: Readonly<Record<string, StepForm>> = {
    ai_step: AI_STEP_FORM,
    datatable: DATATABLE_FORM,
};

const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

export type EditorKind = 'bespoke' | 'declarative' | 'json';

export function editorKindFor(type: string | null | undefined): EditorKind {
    const key = String(type ?? '');
    if (own(EDITORS, key)) return 'bespoke';
    return specFor(key) ? 'declarative' : 'json';
}

/** The editor component for a step type. */
export function editorFor(type: string | null | undefined): StepEditor {
    const key = String(type ?? '');
    return own(EDITORS, key) ?? (specFor(key) ? DeclarativeEditor : JsonStepEditor);
}

/** The editor for `props.step`, rendered — the one place a type picks its component. */
export function renderStepEditor(props: StepEditorProps): ReactElement {
    return createElement(editorFor(props.step.type), props);
}

const FORMSTATE: StepForm = { extract: extractFormState, patch: buildPatch };

/** How a step of this type becomes its form's draft, and the draft its patch. */
export function stepFormFor(type: string | null | undefined): StepForm {
    const key = String(type ?? '');
    const registered = own(FORMS, key);
    if (registered) return registered;
    const spec = specFor(key);
    if (!spec?.extract && !spec?.patch) return FORMSTATE;
    return {
        extract: (step: FlowNode) => specDraft(spec, step),
        patch: (step: FlowNode, draft) => specPatch(spec, step, draft),
    };
}
