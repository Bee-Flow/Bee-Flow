import useTranslation from '@/hooks/useTranslation';
import useAppTables from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import { useEditorChrome } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import WriteToEditor from '@/components/admin/Studio/AppStudio/inspector/WriteToEditor';
import { canonicalSchema } from '@/components/admin/Studio/AppStudio/inspector/aiSchemaEdits';
import type { SchemaField } from '@/components/admin/Studio/AppStudio/inspector/aiFieldMatching';
import type { ApplyPatch, WriteTo } from '@/components/admin/Studio/AppStudio/inspector/AiActionEditors.types';
import { FIXED_WRITE_OUTPUTS } from '../writeToOutputs';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/**
 * `aiWriteTo`: where an AI step's rows land (ai_extract), or the rows of a step with fixed outputs
 * (file_intake, dataset_query). The bare ai_extract action's editor, including the key columns and
 * "Replace rows first" (writeTo.replaceWhere, with OR groups).
 *
 * ai_extract maps its schema fields; the other two map their fixed output names, and never have a
 * schema written for them (they have no `schema` field: canonicalize would drop it).
 */
function AiWriteToControl({ value, step, onChange, onStepChange, definition, node, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const { tables } = useAppTables(chrome?.appId ?? null);
    const fixed = FIXED_WRITE_OUTPUTS[step.kind];
    const schemaFields: SchemaField[] = fixed ? fixed.map((name) => ({ name })) : (Array.isArray(step.schema) ? step.schema as SchemaField[] : []);
    const writeTo = value && typeof value === 'object' ? value as WriteTo : undefined;
    const apply = ({ writeTo: next, schema }: ApplyPatch) => {
        if (schema && !fixed && onStepChange) {
            // A schema taken from the table's columns, in the shape canonicalize stores.
            const { writeTo: _old, ...rest } = step;
            const stored = canonicalSchema(schema);
            onStepChange(next ? { ...rest, schema: stored, writeTo: next } : { ...rest, schema: stored });
            return;
        }
        onChange(next);
    };
    return (
        <div data-step-control="aiWriteTo">
            <WriteToEditor
                writeTo={writeTo}
                schemaFields={schemaFields}
                tables={tables}
                onApply={apply}
                disabled={disabled}
                fixedOutputs={!!fixed}
                hint={fixed ? t('studio_apps_step_fields.write_to.fixed_hint', 'One row per result. Pick the column each output lands in.') : undefined}
                definition={definition}
                node={node}
            />
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'aiWriteTo', Control: AiWriteToControl };
export default entry;
