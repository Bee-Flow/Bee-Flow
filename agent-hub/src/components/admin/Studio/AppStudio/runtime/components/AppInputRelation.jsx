import { tryEvaluate } from '@shared/expr/engine.mjs';
import { useMemo } from 'react';
import ComboBox, { BindingLoader, CANDIDATE_LIMIT, useHasQueryClient } from './comboBox';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useDataContext } from '../DataContext';
import { useFormField } from '../formContext';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { displayValue } from '../uiBits';

/**
 * App Studio runtime — 'input_relation'. Spec: server/appStudio/componentSpecs.js.
 *
 * A combobox over the candidate records of a data table. Candidates come from a
 * `records` binding resolved against the shared dataState (the same seam
 * AppTable/AppList read record bindings through — useAppDataSource fetches into
 * dataState, resolveBinding reads it out). `displayField` labels each option.
 * SUBMITS the picked record id, or an id[] when `multiple`.
 *
 * `filter` IS A FORMULA, AND IT IS EVALUATED HERE.
 * The spec says so — `filter: { type: 'formula' }`, "a formula that narrows the
 * choices" — and this component used to hand that string to the binding as if
 * it were a filter ARRAY. The server compiles binding filters
 * (queryCompiler: `filters must be an array`), so every screen carrying a
 * filtered relation picker answered 500 on load and the picker listed nothing.
 * It had never worked.
 *
 * So the formula is applied to the fetched rows, in the same shape and with the
 * same helper as `list.selectedWhen` and `data_grid.rowTone`: `item` is the
 * candidate row, the screen's scope is in scope, truthiness wins. That keeps one
 * meaning of `item.x == vars.y` across the runtime rather than two.
 *
 * The cost is that narrowing happens AFTER the candidate page, so a filter that
 * matches only rows past CANDIDATE_LIMIT finds nothing. That is the same
 * ceiling the unfiltered picker already had, and a wrong answer that arrives is
 * worse than a narrow one: the alternative here was a 500.
 *
 * The binding is built HERE from props, so AppDataScope's static screen scan
 * never sees it and never fetches it — this input owns its own fetch, into the
 * SAME DataContext cache the scan writes to (one query per cache key).
 *
 * Interaction, keyboard handling and chips live in comboBox.jsx, shared with
 * `input_person`.
 */

export { CANDIDATE_LIMIT };

function candidateId(row) {
    return row?.id ?? row?._id ?? row?.uuid ?? null;
}

export default function AppInputRelation({ node }) {
    const { t } = useTranslation();
    const { mode, actionState, dataState, scope } = useRuntime();
    const { appId, dataState: scopedDataState } = useDataContext();
    const hasQueryClient = useHasQueryClient();
    const {
        name, label = t('studio_apps_runtime.inputs.related', 'Related'), tableId = null, displayField = null,
        multiple = false, required = false, filter = null,
    } = node.props || {};
    const { value, setValue, error } = useFormField({
        name, defaultValue: multiple ? [] : null, required, label,
    });
    const id = `${node.id}-input`;

    // An explicit limit, because the server clamps a MISSING one to 50: a
    // relation picker over a real table silently only ever saw the first fifty
    // rows, and then searched inside those — so a record past row 50 could not
    // be picked at all, with nothing on screen to say so.
    const recordsBinding = useMemo(
        () => (tableId ? { kind: 'records', tableId, limit: CANDIDATE_LIMIT } : null),
        [tableId],
    );
    // Own fetch first, screen-scan result second — in the run view both land on
    // the same cache key, so this only matters before the scan has any entry.
    const mergedDataState = { ...scopedDataState, ...dataState };
    const { value: rows, isLoading, error: loadError } = resolveBinding(recordsBinding, { actionState, dataState: mergedDataState, scope });
    const canFetch = !!recordsBinding && !!appId && hasQueryClient;

    const options = useMemo(() => {
        const all = Array.isArray(rows) ? rows : [];
        // A formula that cannot be evaluated narrows to NOTHING rather than to
        // everything: a picker silently offering rows the author meant to
        // exclude is the failure nobody catches. `tryEvaluate` answers
        // `{ value: undefined }` instead of throwing, which falls that way by
        // itself.
        const expr = typeof filter === 'string' && filter.trim() ? filter.trim() : null;
        const list = expr
            ? all.filter((item) => !!tryEvaluate(expr, { ...scope, item }).value)
            : all;
        return list
            .map((row) => {
                const cid = candidateId(row);
                const labelValue = displayField ? walkPath(row, displayField) : (row?.name ?? row?.title ?? row?.label ?? cid);
                return cid == null ? null : { id: cid, label: displayValue(labelValue) };
            })
            .filter(Boolean);
    }, [rows, displayField, filter, scope]);

    const selectedIds = multiple ? (Array.isArray(value) ? value : []) : (value != null ? [value] : []);

    return (
        <>
            {canFetch ? <BindingLoader binding={recordsBinding} sample={mode !== 'run'} /> : null}
            <ComboBox
                id={id}
                label={label}
                required={required}
                error={error}
                options={options}
                selectedIds={selectedIds}
                multiple={multiple}
                disabled={!tableId}
                placeholder={t('studio_apps_runtime.inputs.search_records', 'Search records…')}
                disabledText={t('studio_apps_runtime.inputs.no_table', 'No table selected')}
                isLoading={isLoading}
                loadError={loadError}
                emptyText={t('studio_apps_runtime.inputs.no_records', 'No matching records.')}
                onPick={(cid) => {
                    if (multiple) { if (!selectedIds.includes(cid)) setValue([...selectedIds, cid]); }
                    else setValue(cid);
                }}
                onRemove={(cid) => {
                    if (multiple) setValue(selectedIds.filter((x) => x !== cid));
                    else setValue(null);
                }}
            />
        </>
    );
}
