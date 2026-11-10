import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import BindingField from '../../inspector/panels/BindingField';
import { INPUT_CLS } from '../../inspector/panels/kit';
import FilterRowsEditor from '../../bi/FilterRowsEditor';
import useAppTables, { fieldsForTable } from '../../bi/useAppTables';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import type { FilterRow } from '../../bi/FilterRowsEditor.types';
import type { AppAction, AppDefinition, AppNode } from '../../inspector/appDefinition';

/** Server LIMITS.MAX_BULK_WRITE_ROWS: the most rows one filter-mode step changes. */
const MAX_BULK_ROWS = 500;

interface RecordTargetFieldProps {
    step: AppAction;
    /** Replaces the whole step (the mode switch removes the other mode's fields). */
    onChange: (next: AppAction) => void;
    definition: AppDefinition;
    node?: AppNode | null;
    disabled?: boolean;
}

type Mode = 'one' | 'filter';

/**
 * update_record / delete_record: which rows. "One row" is the recordId binding; "Rows matching a
 * filter" is a clause list plus a limit (package 5). Switching removes the other mode's fields, and
 * expectedUpdatedAt with them (a compare-and-set token belongs to one row).
 */
export default function RecordTargetField({ step, onChange, definition, node = null, disabled = false }: RecordTargetFieldProps) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const { tables } = useAppTables(chrome?.appId ?? null);
    const mode: Mode = step.filter !== undefined && step.filter !== null ? 'filter' : 'one';
    const fields = fieldsForTable(tables, typeof step.tableId === 'string' ? step.tableId : '');

    const setMode = (next: Mode) => {
        if (next === mode) return;
        const { recordId: _r, filter: _f, limit: _l, expectedUpdatedAt: _e, ...rest } = step;
        onChange(next === 'filter' ? { ...rest, filter: [] } : rest);
    };
    const filters = (Array.isArray(step.filter) ? step.filter : []) as FilterRow[];
    const limit = typeof step.limit === 'number' ? step.limit : undefined;

    return (
        <div className="flex flex-col gap-2" data-record-target={mode}>
            <SegmentedControl
                value={mode}
                onChange={(v) => setMode(v as Mode)}
                options={[
                    { value: 'one', label: t('studio_apps_edit.step_settings.target_one', 'One row') },
                    { value: 'filter', label: t('studio_apps_edit.step_settings.target_filter', 'Rows matching a filter') },
                ]}
                disabled={disabled}
                size="sm"
                ariaLabel={t('studio_apps_edit.step_settings.target_mode', 'Which rows')}
            />
            {mode === 'one' ? (
                <BindingField
                    label={t('studio_apps_edit.step_settings.field_record', 'Record')}
                    value={step.recordId}
                    onChange={(v) => onChange({ ...step, recordId: v })}
                    definition={definition}
                    node={node}
                    disabled={disabled}
                />
            ) : (
                <>
                    <FilterRowsEditor
                        fields={fields}
                        filters={filters}
                        onChange={(next) => onChange({ ...step, filter: next })}
                        allowFormula
                        allowGroups
                        definition={definition}
                        node={node}
                        disabled={disabled}
                    />
                    <FormField
                        label={t('studio_apps_edit.step_settings.field_limit', 'At most')}
                        hint={t('studio_apps_edit.step_settings.bulk_limit_hint', 'Rows changed in one run, oldest first (at most {{max}}). An empty filter value changes nothing.', { max: MAX_BULK_ROWS })}
                    >
                        <input
                            type="number"
                            className={INPUT_CLS}
                            min={1}
                            max={MAX_BULK_ROWS}
                            value={limit ?? ''}
                            placeholder={String(MAX_BULK_ROWS)}
                            onChange={(e) => {
                                const n = Number.parseInt(e.target.value, 10);
                                const { limit: _old, ...rest } = step;
                                onChange(Number.isFinite(n) && n > 0 ? { ...rest, limit: Math.min(n, MAX_BULK_ROWS) } : rest);
                            }}
                            disabled={disabled}
                            aria-label={t('studio_apps_edit.step_settings.field_limit', 'At most')}
                        />
                    </FormField>
                </>
            )}
        </div>
    );
}
