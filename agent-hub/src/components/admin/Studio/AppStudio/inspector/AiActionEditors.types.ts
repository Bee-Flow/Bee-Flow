import type { SchemaField, FormulaBinding, TableColumn } from './aiFieldMatching';
import type { AppAction, AppDefinition, AppNode, FormFieldRef } from './appDefinition';
import type { AppTable } from '../bi/useAppTables';
import type { AiCheck } from './AiChecksField';

/** A binding that reads a source: a form field, an expression, or (kb_query) a fixed text. */
type SourceBinding = { kind: string; expr?: unknown; value?: string };

/**
 * The writeTo of ai_extract (and file_intake / dataset_query). Every edit spreads the existing
 * object, so the fields this editor does not show (constants, replaceWhere, ...) survive it.
 */
export type WriteTo = {
    tableId: string;
    mapping: Record<string, string>;
    constants?: Record<string, unknown>;
    upsertOn?: string;
    /** Columns that identify a row: same key → update instead of a new row. */
    upsertKey?: string[];
    insertMissing?: boolean;
    fillOnly?: boolean;
    /** Clauses of the rows deleted before writing. */
    replaceWhere?: unknown[];
};

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
    /** Answer reliability (schema v3, AiChecksField): all optional, absent = as before. */
    temperature?: number;
    checks?: AiCheck[];
    repairRounds?: number;
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
    /** The fields are the step's fixed outputs (file_intake, dataset_query): never derive or adopt a schema. */
    fixedOutputs?: boolean;
    hint?: string;
    /** For formula values in the replaceWhere clauses. */
    definition?: AppDefinition | null;
    node?: AppNode | null;
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
