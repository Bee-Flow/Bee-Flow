import useTranslation from '@/hooks/useTranslation';
import useAppTables, { fieldsForTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import { useEditorChrome } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import { SchemaFieldsEditor } from '@/components/admin/Studio/AppStudio/inspector/AiGenerateEditor';
import { canonicalSchema, MAX_AI_SCHEMA_FIELDS, schemaEditPatch } from '@/components/admin/Studio/AppStudio/inspector/aiSchemaEdits';
import type { SchemaField } from '@/components/admin/Studio/AppStudio/inspector/aiFieldMatching';
import type { SchemaMeta, WriteTo } from '@/components/admin/Studio/AppStudio/inspector/AiActionEditors.types';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/**
 * `aiSchema`: the fields an AI step returns (ai_extract, ai_generate with structured output), in
 * the same editor the bare AI actions use. A rename or a removal carries the step's writeTo
 * mapping along (schemaEditPatch), exactly as the bare ai_extract editor does.
 *
 * ai_generate only reads its schema with `output: 'structured'`, so the editor stays out of the
 * way of a text step, as it does for the bare action.
 */
function AiSchemaControl({ value, step, onChange, onStepChange, disabled, hint }: StepFieldControlProps) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const { tables } = useAppTables(chrome?.appId ?? null);
    if (step.kind === 'ai_generate' && step.output !== 'structured') return null;
    const fields = Array.isArray(value) ? (value as SchemaField[]) : [];
    const writeTo = step.writeTo as WriteTo | undefined;
    const commit = (next: SchemaField[], meta?: SchemaMeta) => {
        const schema = canonicalSchema(next.slice(0, MAX_AI_SCHEMA_FIELDS));
        const patch = schemaEditPatch(schema, meta, writeTo, fieldsForTable(tables, writeTo?.tableId));
        if (patch.writeTo && onStepChange) onStepChange({ ...step, ...patch });
        else onChange(patch.schema);
    };
    return (
        <div className="flex flex-col gap-1" data-step-control="aiSchema">
            <SchemaFieldsEditor
                fields={fields}
                onChange={commit}
                disabled={disabled}
                hint={writeTo?.tableId ? t('studio_apps_insp.ai_actions.fields_hint_table', 'The AI returns these; matching columns are filled in below.') : hint}
            />
            {fields.length >= MAX_AI_SCHEMA_FIELDS ? (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('studio_apps_step_fields.schema.at_limit', 'A step returns at most {max} fields.', { max: MAX_AI_SCHEMA_FIELDS })}
                </p>
            ) : null}
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'aiSchema', Control: AiSchemaControl };
export default entry;
