import { useMemo, useState, type ComponentType } from 'react';
import { Braces, List, Maximize2, Table2, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import OutputFieldsViewJs from './mapping/OutputFieldsView';
import TruncatedOutput from './TruncatedOutput';
import FriendlyValue, { isTruncatedOutput } from './output/FriendlyValue';
import { expandEnabled, type MapCtx } from './output/mapAttrs';
import { JsonTree, Scalar } from './output/ScalarValue';
import SmartOutput, { smartRowsOf } from './output/SmartOutput';
import useOutputColumns from './output/useOutputColumns';
import WideOutputView from './output/WideOutputView';

const OutputFieldsView = OutputFieldsViewJs as unknown as ComponentType<{
    value: unknown; basePath?: string; onInsert?: ((path: string, opts: { raw: boolean }) => void) | null;
}>;

/**
 * Friendly, non-technical view of a step's output.
 *
 * Default "Table" mode renders the data the way an average user expects:
 *   - arrays of objects  → a real HTML table (columns = the object fields)
 *   - arrays of scalars  → a simple bulleted list
 *   - objects            → labelled fields (nested arrays become tables)
 *   - scalars            → plain text (no quotes / braces)
 *
 * A per-step toggle flips to "JSON", the collapsible JsonTree, so power users
 * keep the exact structure. The toggle only appears when there is structure
 * worth simplifying.
 *
 * Mapping (opt-in): with `enableDrag` and a `basePath`, every field, column
 * and cell becomes draggable and click-to-insert, carrying its binding path
 * (e.g. `steps.x.output.results[*].content`).
 *
 * `smartTable` (the step drawer's "Continues on" column, artboards 4b/4d): a
 * list shows a few useful columns with the technical ones hidden, and opens
 * into a large view with row search, a column picker and a row detail.
 */
export interface OutputViewProps {
    value: unknown;
    emptyMessage?: string;
    basePath?: string;
    onCopyPath?: ((path: string) => void) | null;
    fill?: boolean;
    enableDrag?: boolean;
    onPickPath?: ((path: string, opts: { raw: boolean }) => void) | null;
    allowExpand?: boolean | null;
    /** Offer the FIELDS view (design 1h) and open on it for a plain record. */
    fieldsView?: boolean;
    /** Lists as the drawer's smart table, with the large view. */
    smartTable?: boolean;
    /** Where the column choice is remembered (per step); null = not at all. */
    columnsKey?: string | null;
    /** Field names a next step reads: they make the column suggestion. */
    usedFields?: readonly string[];
    /** The step's name, for the large view's title. */
    stepLabel?: string | null;
}

export default function OutputView(props: OutputViewProps) {
    // The run history swaps an output over its cap for a sentinel. Caught
    // here, above the Table/JSON switch, so neither view renders the sentinel
    // as if it were the step's answer (BFSF-402).
    if (isTruncatedOutput(props.value)) {
        return (
            <TruncatedOutput
                sentinel={props.value as Record<string, unknown>}
                fill={!!props.fill}
                renderFull={(full) => <OutputBody {...props} value={full} />}
            />
        );
    }
    return <OutputBody {...props} />;
}

const NO_ROWS: unknown[] = [];
const NO_FIELDS: readonly string[] = [];

function OutputBody({
    value, emptyMessage = 'No output.', basePath = '', onCopyPath = null,
    fill = false, enableDrag = false, onPickPath = null, allowExpand = null,
    fieldsView = false, smartTable = false, columnsKey = null, usedFields = NO_FIELDS, stepLabel = null,
}: OutputViewProps) {
    const { t } = useTranslation();
    const structured = value !== null && typeof value === 'object';
    const smartRows = useMemo(() => (smartTable ? smartRowsOf(value) : null), [smartTable, value]);
    const cols = useOutputColumns(smartRows ?? NO_ROWS, smartRows ? columnsKey : null, usedFields);
    const [wide, setWide] = useState<{ row: number | null } | null>(null);
    const plainRecord = fieldsView && structured && !Array.isArray(value);
    // The user's choice, or the default for this shape until they make one.
    // A record that is really one list opens on its table.
    const [choice, setMode] = useState<'fields' | 'table' | 'json' | null>(null);
    const mode = choice ?? (plainRecord && !smartRows ? 'fields' : 'table');
    const fieldsMode = plainRecord && mode === 'fields';
    const map: MapCtx | null = enableDrag && basePath ? { path: basePath, onPick: onPickPath } : null;
    const canExpand = expandEnabled(allowExpand, map);
    const jsonMode = structured && mode === 'json';
    const smartMode = !!smartRows && !fieldsMode && !jsonMode;
    const fieldsBtn = <ToggleBtn active={fieldsMode} onClick={() => setMode('fields')} Icon={List} label={t('routines.output.mode_fields', 'Fields')} />;

    // `fill` grows the card to fill its parent (the Run tab) and scrolls
    // internally; the default sizing keeps it compact for the dry-run cards.
    return (
        <div className={`rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/30 overflow-hidden ${fill ? 'flex flex-col flex-1 min-h-0' : 'mt-1'}`}>
            {structured && (
                <div className="flex items-center justify-end gap-1 px-1.5 py-1 border-b border-[var(--border-default)] shrink-0">
                    {smartRows && (
                        <button
                            type="button"
                            onClick={() => setWide({ row: null })}
                            className="mr-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                            title={t('routines.output.expand_title', 'Open the large view: search rows, choose columns, see a row in full')}
                        >
                            <Maximize2 size={11} /> {t('routines.output.expand', 'Expand')}
                        </button>
                    )}
                    {/* Table leads when the value really is one (artboard 4b). */}
                    {plainRecord && !smartRows && fieldsBtn}
                    <ToggleBtn active={!fieldsMode && mode !== 'json'} onClick={() => setMode('table')} Icon={Table2} label={t('routines.output.mode_table', 'Table')} />
                    {plainRecord && smartRows && fieldsBtn}
                    <ToggleBtn active={mode === 'json'} onClick={() => setMode('json')} Icon={Braces} label={t('routines.output.mode_json', 'JSON')} />
                </div>
            )}
            {/* JSON mode drops the padding: JsonTree is a full-height box with
                its own scroller. */}
            <div className={`overflow-auto custom-scrollbar text-xs ${jsonMode ? '' : 'p-1.5'} ${fill ? 'flex-1 min-h-0' : 'max-h-72'}`}>
                {!structured ? (
                    <Scalar value={value} emptyMessage={emptyMessage} map={map} />
                ) : fieldsMode ? (
                    <OutputFieldsView value={value} basePath={basePath} onInsert={onPickPath} />
                ) : jsonMode ? (
                    // Search and a second level open are the component's own
                    // defaults (BFSF-434).
                    <JsonTree value={value} basePath={basePath} onCopyPath={onCopyPath} emptyMessage={emptyMessage} />
                ) : smartMode && smartRows ? (
                    <SmartOutput value={value} rows={smartRows} cols={cols} onExpand={(row) => setWide({ row: row ?? null })} />
                ) : (
                    <FriendlyValue value={value} emptyMessage={emptyMessage} map={map} allowExpand={canExpand} />
                )}
            </div>
            {wide && smartRows && (
                <WideOutputView rows={smartRows} cols={cols} stepLabel={stepLabel} initialRow={wide.row} onClose={() => setWide(null)} />
            )}
        </div>
    );
}

interface ToggleBtnProps { active: boolean; onClick: () => void; Icon: LucideIcon; label: string }

function ToggleBtn({ active, onClick, Icon, label }: ToggleBtnProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                active
                    ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            aria-pressed={active}
        >
            <Icon size={11} /> {label}
        </button>
    );
}
