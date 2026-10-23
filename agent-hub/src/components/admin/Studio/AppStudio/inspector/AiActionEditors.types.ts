import type { SchemaField, FormulaBinding, TableColumn } from './aiFieldMatching';
import type { AppAction, FormFieldRef } from './appDefinition';
import type { AppTable } from '../bi/useAppTables';

/** A binding that reads a source: a form field, an expression, or (kb_query) a fixed text. */
export type SourceBinding = { kind: string; expr?: unknown; value?: string };

export type WriteTo = { tableId: string; mapping: Record<string, string> };

export type NamedField = SchemaField & { name: string };

/** The members of the three native AI action kinds this file edits. */
export interface AiAction extends AppAction {
    resultVar?: string;
    knowledgeBaseIds?: string[];
    modelTier?: string | null;
    schema?: SchemaField[];
    source?: SourceBinding | null;
    writeTo?: WriteTo;
    prompt?: string;
    output?: string;
    attachments?: SourceBinding | null;
    query?: SourceBinding | null;
    topK?: number;
}

export interface KnowledgeBase { id: string; name?: string }

/** What a schema edit tells the caller beyond the new list. */
export interface SchemaMeta {
    removed?: string;
    renamed?: { from?: string; to: string };
}

export interface ApplyPatch { schema?: SchemaField[]; writeTo?: WriteTo }

export interface ModelTierRowProps {
    value: string | null | undefined;
    onChange: (key: string) => void;
    disabled: boolean;
}

export interface FieldSourcePickerProps {
    label: string;
    hint?: string;
    binding?: SourceBinding | null;
    onChange: (binding: FormulaBinding | null) => void;
    formFields: FormFieldRef[];
    disabled: boolean;
    ariaLabel: string;
}

export interface SchemaFieldsEditorProps {
    fields: SchemaField[] | undefined;
    onChange: (next: SchemaField[], meta?: SchemaMeta) => void;
    disabled: boolean;
    hint?: string;
}

export interface KbMultiSelectProps {
    value: string[] | undefined;
    onChange: (ids: string[]) => void;
    disabled: boolean;
}

/** One "output field → column" row per declared field. */
export interface MappingRowsProps {
    fields: NamedField[];
    targets: TableColumn[];
    columnForField: (fieldName: string) => string;
    onPick: (fieldName: string, col: string) => void;
    disabled: boolean;
}

/** What the current mapping will actually save — an unmapped step saves nothing. */
export interface MappingSummaryProps {
    mapped: number;
    total: number;
}

export interface WriteToEditorProps {
    writeTo: WriteTo | undefined;
    onApply: (patch: ApplyPatch) => void;
    schemaFields: SchemaField[] | undefined;
    tables: AppTable[];
    disabled: boolean;
}

export interface ResultVarFieldProps {
    value: string | undefined;
    onChange: (value: string) => void;
    disabled: boolean;
    required?: boolean;
}

export interface AiExtractEditorProps {
    action: AiAction;
    commit: (nextAction: AppAction) => void;
    formFields: FormFieldRef[];
    disabled: boolean;
}

export interface AiGenerateEditorProps {
    action: AiAction;
    commit: (nextAction: AppAction) => void;
    formFields: FormFieldRef[];
    disabled: boolean;
}

export interface KbQueryEditorProps {
    action: AiAction;
    commit: (nextAction: AppAction) => void;
    formFields: FormFieldRef[];
    disabled: boolean;
}

export interface AiActionEditorProps {
    action: AppAction;
    commit: (nextAction: AppAction) => void;
    formFields: FormFieldRef[];
    disabled: boolean;
}
