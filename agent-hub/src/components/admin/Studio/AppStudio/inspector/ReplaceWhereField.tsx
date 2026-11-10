import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import FilterRowsEditor from '../bi/FilterRowsEditor';
import type { FilterEntry, FilterField } from '../bi/FilterRowsEditor.types';
import type { AppDefinition, AppNode } from './appDefinition';

/** Server LIMITS.MAX_BULK_WRITE_ROWS: the most rows one replace may delete before it is refused. */
const MAX_REPLACE_ROWS = 500;

interface ReplaceWhereFieldProps {
    /** The stored writeTo.replaceWhere: a clause list, or absent. */
    value: unknown;
    /** The target table's columns, which the clauses name. */
    fields: FilterField[];
    /** The new clause list, or undefined to remove replaceWhere. */
    onChange: (next: FilterEntry[] | undefined) => void;
    definition?: AppDefinition | null;
    node?: AppNode | null;
    disabled?: boolean;
}

/**
 * writeTo.replaceWhere: delete the rows these clauses match, then write. The server took it all
 * along and the editor had no way to say it (#592), so "read this document again" doubled the
 * lines instead of refreshing them.
 *
 * An empty list is never written: the server refuses one (it would delete every row), and absent
 * already means "replace nothing". The switch keeps itself open while the list is still empty, so
 * the first clause can be added without the section closing under it. OR groups are offered, as
 * in every other write filter.
 */
export default function ReplaceWhereField({ value, fields, onChange, definition = null, node = null, disabled = false }: ReplaceWhereFieldProps) {
    const { t } = useTranslation();
    const clauses = Array.isArray(value) ? (value as FilterEntry[]) : [];
    const stored = value !== undefined && value !== null;
    const [opened, setOpened] = useState(false);
    const open = stored || opened;
    const toggle = (on: boolean) => {
        setOpened(on);
        if (!on && stored) onChange(undefined);
    };
    return (
        <FormField
            label={t('studio_apps_step_fields.replace_where.label', 'Replace rows first')}
            hint={t('studio_apps_step_fields.replace_where.hint', 'Before writing, delete the rows that match these conditions, so running the step again refreshes the rows instead of adding them twice. More than {max} matching rows, or an empty value, refuses the step and changes nothing.', { max: MAX_REPLACE_ROWS })}
        >
            <div className="flex flex-col gap-2" data-replace-where={open ? 'on' : 'off'}>
                <Toggle
                    size="sm"
                    label={t('studio_apps_step_fields.replace_where.toggle', 'Delete matching rows before writing')}
                    checked={open}
                    onChange={toggle}
                    disabled={disabled}
                />
                {open ? (
                    <FilterRowsEditor
                        fields={fields}
                        filters={clauses}
                        onChange={(next) => {
                            if (!next.length) setOpened(true);
                            onChange(next.length ? next : undefined);
                        }}
                        allowFormula
                        allowGroups
                        definition={definition}
                        node={node}
                        disabled={disabled}
                    />
                ) : null}
            </div>
        </FormField>
    );
}
