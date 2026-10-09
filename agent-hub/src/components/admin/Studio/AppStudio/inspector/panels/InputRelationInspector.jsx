import React from 'react';
import { FieldKeyField, TextField, usePatch, INPUT_CLS } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import ExpressionInput from '../logic/ExpressionInput';
import { registerInspector } from '../registry';
import useAppTables from '../../bi/useAppTables';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';

/**
 * Content panel for input_relation. Props mirror componentSpecs.js (authoritative).
 *
 * The table was a free-text box the author had to fill with a raw `tbl_…` id,
 * and the display field and filter were untyped strings — while this very
 * folder already ships a table picker, a field picker and an expression editor.
 * So the one input that exists to point at another table was the one place you
 * had to know an id by heart.
 */
export default function InputRelationInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);
    const chrome = useEditorChrome();
    const appId = chrome?.appId ?? null;

    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.field_name', 'Field name')} value={props.name} onChange={(v) => patch({ name: v })} hint={t('studio_apps_panels.input_relation.field_name_hint', 'The key this value submits as (record id).')} disabled={disabled} />
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />

            <FormField label={t('studio_apps_panels.input_relation.data_table', 'Data table')} hint={t('studio_apps_panels.input_relation.data_table_hint', 'Which table to pick records from.')}>
                {/* useAppTables is a network hook, so it is only mounted where
                    an app id exists — outside the editor shell the raw field
                    still works rather than the panel crashing. */}
                {appId ? (
                    <TablePicker
                        appId={appId}
                        value={props.tableId || ''}
                        onChange={(v) => patch({ tableId: v || null })}
                        disabled={disabled}
                    />
                ) : (
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={props.tableId || ''}
                        onChange={(e) => patch({ tableId: e.target.value || null })}
                        placeholder={t('studio_apps_panels.input_relation.open_app_placeholder', 'Open the app to pick a table')}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={t('studio_apps_panels.input_relation.data_table', 'Data table')}
                    />
                )}
            </FormField>

            <FieldKeyField
                label={t('studio_apps_panels.input_relation.display_field', 'Display field')}
                value={props.displayField}
                onChange={(v) => patch({ displayField: v || null })}
                // A relation points at a TABLE, so the field list comes from
                // that table rather than from this component's own source.
                source={props.tableId ? { kind: 'records', tableId: props.tableId } : null}
                placeholder={t('studio_apps_panels.input_relation.display_field_placeholder', 'name')}
                hint={t('studio_apps_panels.input_relation.display_field_hint', 'Which field labels each option.')}
                ariaLabel={t('studio_apps_panels.input_relation.display_field', 'Display field')}
                disabled={disabled}
            />

            <FormField label={t('studio_apps_panels.input_relation.filter', 'Filter')} hint={t('studio_apps_panels.input_relation.filter_hint', 'A formula that narrows the choices (optional).')}>
                <ExpressionInput
                    variant="inline"
                    value={props.filter || ''}
                    onChange={(v) => patch({ filter: v || null })}
                    definition={definition}
                    node={node}
                    ariaLabel={t('studio_apps_panels.input_relation.filter', 'Filter')}
                    placeholder={t('studio_apps_panels.input_relation.filter_placeholder', 'e.g. item.active == true')}
                    disabled={disabled}
                />
            </FormField>

            <Toggle label={t('studio_apps_panels.input_relation.multiple', 'Allow multiple')} checked={!!props.multiple} onChange={(v) => patch({ multiple: v })} disabled={disabled} size="sm" />
            <Toggle label={t('studio_apps_panels.common.required', 'Required')} checked={!!props.required} onChange={(v) => patch({ required: v })} disabled={disabled} size="sm" />
        </div>
    );
}


function TablePicker({ appId, value, onChange, disabled }) {
    const { t } = useTranslation();
    const { tables, isLoading } = useAppTables(appId);
    return (
        <select
            className={INPUT_CLS}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled || isLoading}
            aria-label={t('studio_apps_panels.input_relation.data_table', 'Data table')}
        >
            <option value="">{isLoading ? t('studio_apps_panels.input_relation.loading_tables', 'Loading the tables…') : t('studio_apps_panels.input_relation.pick_table', 'Pick a table…')}</option>
            {tables.map((tbl) => <option key={tbl.id} value={tbl.id}>{tbl.name || tbl.key}</option>)}
        </select>
    );
}

registerInspector('input_relation', InputRelationInspector);
