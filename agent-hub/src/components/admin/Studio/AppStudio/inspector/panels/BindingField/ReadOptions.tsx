import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import ExpressionInput from '../../logic/ExpressionInput';
import type { FilterField } from '@/components/admin/Studio/AppStudio/bi/FilterRowsEditor.types';
import type { AppDefinition, AppNode } from '../../appDefinition';
import { searchableFields, searchExpr, withSearchFields, withSearchExpr, type BindingSearch } from './readOptions.helpers';

/**
 * How a table binding's filters join, and a free search over some of its columns.
 *
 * Both are written only when the author sets them: "every filter must match" is the default and
 * writes nothing, and a binding without a search has no `search` key. The search text is a
 * formula (the usual value is a search box: `vars.filters.q`), so an empty box shows every row.
 */

interface MatchModeProps {
    match?: 'all' | 'any';
    onChange: (match: 'any' | undefined) => void;
    disabled: boolean;
}

/** "Show a row when: every filter matches / any filter matches" (offered with two or more filters). */
export function MatchMode({ match, onChange, disabled }: MatchModeProps) {
    const { t } = useTranslation();
    return (
        <select
            className={INPUT_CLS}
            value={match === 'any' ? 'any' : 'all'}
            onChange={(e) => onChange(e.target.value === 'any' ? 'any' : undefined)}
            disabled={disabled}
            aria-label={t('studio_apps_dataread.match_label', 'How the filters combine')}
        >
            <option value="all">{t('studio_apps_dataread.match_all', 'Show a row when every filter matches')}</option>
            <option value="any">{t('studio_apps_dataread.match_any', 'Show a row when any filter matches')}</option>
        </select>
    );
}

interface SearchOptionProps {
    search?: BindingSearch;
    fields: FilterField[];
    onChange: (search: BindingSearch | undefined) => void;
    disabled: boolean;
    definition: AppDefinition;
    node: AppNode | null;
}

/** "Search in some columns": the columns to look in and the text (a formula) to look for. */
export function SearchOption({ search, fields, onChange, disabled, definition, node }: SearchOptionProps) {
    const { t } = useTranslation();
    const columns = searchableFields(fields);
    if (!columns.length) return null;
    return (
        <div className="flex flex-col gap-2">
            <Toggle
                size="sm"
                label={t('studio_apps_dataread.search_label', 'Search in some columns')}
                description={t('studio_apps_dataread.search_desc', 'Shows the rows where any chosen column contains the text. An empty text shows every row.')}
                checked={!!search}
                disabled={disabled}
                onChange={(on) => onChange(on ? { value: { kind: 'formula', expr: 'vars.filters.q' }, fields: columns.slice(0, 1).map((col) => col.key) } : undefined)}
                ariaLabel={t('studio_apps_dataread.search_aria', 'Search in some columns')}
            />
            {search ? (
                <>
                    <ExpressionInput
                        variant="inline"
                        value={searchExpr(search)}
                        onChange={(expr) => onChange(withSearchExpr(search, expr))}
                        definition={definition}
                        node={node}
                        placeholder={t('studio_apps_dataread.search_placeholder', 'e.g. vars.filters.q')}
                        ariaLabel={t('studio_apps_dataread.search_text', 'Text to search for')}
                        disabled={disabled}
                        showPicker
                    />
                    <fieldset className="flex flex-col gap-1 min-w-0" disabled={disabled}>
                        <legend className="text-xs text-[var(--text-secondary)] mb-1">{t('studio_apps_dataread.search_in', 'Look in these columns')}</legend>
                        {columns.map((col) => (
                            <label key={col.key} className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                                <input
                                    type="checkbox"
                                    className="accent-[var(--accent-primary)]"
                                    checked={(search.fields ?? []).includes(col.key)}
                                    onChange={(e) => onChange(withSearchFields(search, col.key, e.target.checked))}
                                />
                                {col.name || col.key}
                            </label>
                        ))}
                    </fieldset>
                </>
            ) : null}
        </div>
    );
}
