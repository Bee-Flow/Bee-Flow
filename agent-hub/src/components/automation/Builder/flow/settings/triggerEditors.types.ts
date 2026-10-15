import type { OnFocusField } from '../../mapping/focusField.types';
import type { DesignedField, OnRenameField } from './fieldDesigner.types';
import type { FormEditorContext } from './FormPageEditor';
import type { TriggerFilterValues } from './triggerFilters.types';

/** A trigger node's draft: only the keys these forms read are named, the rest passes through. */
export interface TriggerDraft {
    kind?: string;
    label?: string;
    scheduleCron?: string;
    scheduleTz?: string;
    params?: DesignedField[] | null;
    filter?: TriggerFilterValues | null;
    appProvider?: string;
    appEventName?: string;
    toolName?: string;
    description?: string;
    form?: Record<string, unknown> | null;
    mode?: string;
    waitSeconds?: number;
    [key: string]: unknown;
}

export type SetDraftField = (key: string, value: unknown) => void;

/** The saved automation as the trigger forms read it (its id and its triggers). */
export interface TriggerAutomation {
    id?: string;
    definition?: {
        trigger?: { id?: string; kind?: string; [key: string]: unknown } | null;
        triggers?: Array<{ id?: string; kind?: string; [key: string]: unknown }>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/** One event an app can trigger on. */
export interface ProviderEvent {
    id: string;
    label?: string;
    deliverability?: string;
    deliverabilityNote?: string;
}

/** One app that can start an automation (a stale backend still serves bare ids). */
export interface AppEventProvider {
    id: string;
    label: string;
    defaultEvent?: string;
    events?: ProviderEvent[];
}

export interface TriggerCatalog {
    triggers?: Array<{ kind?: string; providers?: Array<string | AppEventProvider> }>;
}

export interface TriggerFieldsProps {
    draft: TriggerDraft;
    set: SetDraftField;
    setNested: (parent: string, key: string, value: unknown) => void;
    errorSections?: Set<string>;
    catalog?: TriggerCatalog | null;
    automation?: TriggerAutomation | null;
    stepId?: string | null;
    isSecondaryTrigger?: boolean;
    onTestSubmit?: ((answers: Record<string, unknown>) => Promise<unknown>) | null;
    onRenameField?: OnRenameField | null;
    formEditor?: FormEditorContext | null;
}

export interface AppEventFieldsProps {
    draft: TriggerDraft;
    set: SetDraftField;
    setNested: (parent: string, key: string, value: unknown) => void;
    catalog?: TriggerCatalog | null;
}

/** The forms that edit a declared parameter list share these props. */
export interface ParamFieldsProps {
    draft: TriggerDraft;
    set: SetDraftField;
    onRenameField?: OnRenameField | null;
}

export interface FormPageFieldsProps {
    draft: TriggerDraft;
    set: SetDraftField;
    stepId?: string | null;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
    onRenameField?: OnRenameField | null;
    formEditor?: FormEditorContext | null;
}
