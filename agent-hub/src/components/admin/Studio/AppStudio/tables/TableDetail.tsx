import { Database, FileInput, Link2, Loader2, Plus, Table2 } from 'lucide-react';
import TableDesigner from './TableDesigner';
import { modeLabel, sourceIsWritable, sourceLabel } from './tablesManagerModel';
import type { ModelTable, TableSource } from './tablesManagerModel';
import useTranslation from '@/hooks/useTranslation';

const GEN_BTN = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)]';

/**
 * Where do THIS table's rows live? Always visible, for both kinds — a strip
 * that only appears for the exception leaves the ordinary table unnamed, and
 * then it stays a guess which of the two you are looking at.
 */
function SourceStrip({ source }: { source: TableSource | null }) {
    const { t } = useTranslation();
    const mode = modeLabel(t, source);
    return (
        <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs border-[var(--border-default)] bg-[var(--bg-secondary)]"
            data-testid="table-source-strip"
        >
            {source
                ? <Link2 className="h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                : <Database className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />}
            <span className="text-[var(--text-primary)]">{sourceLabel(t, source)}</span>
            {source?.datatableId ? (
                <code className="rounded px-1 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {source.datatableId}
                </code>
            ) : null}
            {mode ? (
                <span className="text-[var(--text-tertiary)]">· {mode}</span>
            ) : null}
            {source ? (
                <span className="basis-full text-[var(--text-tertiary)]">
                    {t(
                        'app_studio.tables.source_linked_desc',
                        'The columns below describe what this app expects to find there. Changing them does not change the Studio table.',
                    )}
                </span>
            ) : null}
        </div>
    );
}

interface GeneratorsProps {
    isSaved: boolean;
    source: TableSource | null;
    onGenerate: (kind: 'form' | 'grid') => void;
    onSave: () => void;
    saving: boolean;
    dirty: boolean;
}

/** "Add to this screen": a bound form or grid, once the table exists server-side. */
function Generators({ isSaved, source, onGenerate, onSave, saving, dirty }: GeneratorsProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border p-3 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--text-secondary)]">
                <Database className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                {t('studio_apps_tables.manager.add_to_screen', 'Add to this screen')}
            </div>
            {isSaved ? (
                <div className="flex flex-wrap gap-2">
                    {/* A form WRITES. For a linked table that is only allowed
                      * when the source literally says so; an unknown mode does
                      * not count as yes. Leaving the button out is more honest
                      * than offering it and letting the first submission fail. */}
                    {source && !sourceIsWritable(source) ? (
                        <p className="text-xs text-[var(--text-tertiary)]">
                            {t('app_studio.tables.source_read_only_no_form', 'This link is read only, so there is no form to make — a grid can still show the rows.')}
                        </p>
                    ) : (
                        <button type="button" onClick={() => onGenerate('form')} className={GEN_BTN}>
                            <FileInput className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                            {t('studio_apps_tables.manager.make_form', 'Make a form')}
                        </button>
                    )}
                    <button type="button" onClick={() => onGenerate('grid')} className={GEN_BTN}>
                        <Table2 className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                        {t('studio_apps_tables.manager.make_grid', 'Make a grid')}
                    </button>
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-[var(--text-tertiary)]">
                        {t('studio_apps_tables.manager.save_first', 'Save this table first, then you can drop a form or a list onto the screen.')}
                    </p>
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={saving || !dirty}
                        className={`${GEN_BTN} disabled:opacity-50`}
                    >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                        {t('studio_apps_tables.manager.save_now', 'Save now')}
                    </button>
                </div>
            )}
        </div>
    );
}

interface TableDetailProps extends GeneratorsProps {
    table: ModelTable;
    tables: ModelTable[];
    savedTable: ModelTable | null;
    onChange: (table: ModelTable) => void;
}

/** The selected table: where its rows live, its fields, and the generators. */
export default function TableDetail({ table, tables, savedTable, onChange, ...gen }: TableDetailProps) {
    return (
        <div className="flex flex-col gap-4">
            <SourceStrip source={gen.source} />
            <TableDesigner table={table} tables={tables} savedTable={savedTable} onChange={onChange} disabled={gen.saving} />
            <Generators {...gen} />
        </div>
    );
}

/** Nothing selected: pick one, or add one. */
export function NoTableSelected({ onAdd }: { onAdd: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-sm text-[var(--text-tertiary)]">
            {t('studio_apps_tables.manager.pick_table', 'Pick a table on the left, or add one to get started.')}
            <button type="button" onClick={onAdd} className={GEN_BTN}>
                <Plus className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                {t('studio_apps_tables.manager.add_table', 'Add a table')}
            </button>
        </div>
    );
}
