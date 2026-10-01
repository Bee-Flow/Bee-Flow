import { Check, ChevronDown, Columns3, LayoutGrid, LayoutList, ListFilter, Workflow, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import FilterPillsJs from '../../../shared/FilterPills';
import SegmentedControl from '../../../shared/SegmentedControl';
import CreateMenuButton from './CreateMenuButton';
import { GROUPS, SORTS } from './overviewModel';

// .jsx modules whose `= undefined` / `= null` defaults would type the props as
// undefined-only or null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;
const FilterPills = FilterPillsJs as unknown as ComponentType<Record<string, unknown>>;

/** One pill: the value it filters on, its word and how many it lets through. */
export interface PillOption {
    value: string;
    label: string;
    count?: number;
    tone?: string;
}

const SORT_LABEL: Record<string, string> = {
    updated: 'Recently updated',
    name: 'Name',
    lastRun: 'Last run',
    nextRun: 'Next run',
    status: 'Status',
};
const GROUP_LABEL: Record<string, string> = { status: 'Status', trigger: 'Trigger', folder: 'Folder' };

const VIEW_OPTIONS = [
    { value: 'list', label: 'List', icon: <LayoutList size={13} aria-hidden="true" /> },
    { value: 'cards', label: 'Cards', icon: <LayoutGrid size={13} aria-hidden="true" /> },
    { value: 'board', label: 'Board', icon: <Columns3 size={13} aria-hidden="true" /> },
];

export interface OverviewToolbarProps {
    /** False for an empty library: the toolbar then only names the page. */
    hasRows: boolean;
    state: string;
    onState: (next: string) => void;
    stateOptions: PillOption[];
    trigger: string;
    onTrigger: (next: string) => void;
    triggerOptions: PillOption[];
    /** Folder pills — only when the library HAS folders to filter by. */
    folder?: string;
    onFolder?: (next: string) => void;
    folderOptions?: PillOption[];
    narrowed: boolean;
    onClear: () => void;
    view: string;
    onView: (next: string) => void;
    sort: string;
    onSort: (next: string) => void;
    groupBy: string;
    onGroup: (next: string) => void;
    onCreate?: (() => void) | null;
    onCreateBlock?: (() => void) | null;
    onCreateFolder?: (() => void) | null;
    canCreate?: boolean;
}

/**
 * The overview's one toolbar: what to show on the left, how to show it on the
 * right. It sits in the same centred column as the list below it, so on an
 * ultrawide screen Sort and New stay above the table they act on.
 */
export default function OverviewToolbar(props: OverviewToolbarProps) {
    const { hasRows, view, sort, groupBy, onCreate, onCreateBlock, onCreateFolder, canCreate = true } = props;
    const showTriggers = props.triggerOptions.length > 2;
    // Like the trigger row: a folder nobody made is not a filter worth offering.
    const showFolders = (props.folderOptions?.length ?? 0) > 1 && !!props.onFolder;
    const folderValue = props.folder ?? 'all';
    const onFolder = props.onFolder ?? (() => {});
    return (
        <div className="flex-shrink-0 border-b border-[var(--border-default)]">
            <div className="mx-auto max-w-[110rem] flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 min-h-[3rem]">
                {hasRows ? (
                    <>
                        {/* From 84rem of the overview's OWN width (its @container, never
                            the viewport: the sidebar takes a share of the screen) the
                            pills stand in the toolbar. Below it they fold into one
                            "Filter" button, so a laptop gets one calm row (filter ·
                            sort · view · New) instead of two crowded ones. */}
                        <div className="hidden @[84rem]/overview:flex items-center gap-x-3 gap-y-2 flex-wrap">
                            <FilterPills value={props.state} onChange={props.onState} options={props.stateOptions} ariaLabel="Filter by state" testId="automations-overview-state" />
                            {showTriggers && (
                                <>
                                    <span aria-hidden="true" className="w-px h-4 bg-[var(--border-default)]" />
                                    <FilterPills value={props.trigger} onChange={props.onTrigger} options={props.triggerOptions} ariaLabel="Filter by trigger" testId="automations-overview-trigger" />
                                </>
                            )}
                            {showFolders && (
                                <>
                                    <span aria-hidden="true" className="w-px h-4 bg-[var(--border-default)]" />
                                    <FilterPills value={folderValue} onChange={onFolder} options={props.folderOptions} ariaLabel="Filter by folder" testId="automations-overview-folder" />
                                </>
                            )}
                            {props.narrowed && (
                                <button
                                    type="button"
                                    onClick={props.onClear}
                                    className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                                >
                                    <X size={11} aria-hidden="true" /> Clear
                                </button>
                            )}
                        </div>
                        <div className="@[84rem]/overview:hidden">
                            <FilterMenu {...props} showTriggers={showTriggers} showFolders={showFolders} />
                        </div>
                    </>
                ) : (
                    <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                        <Workflow size={14} aria-hidden="true" className="text-[var(--type-trigger)]" />
                        All automations
                    </span>
                )}
                <div className="flex-1" />
                <div className="flex items-center gap-3">
                    {view === 'board' && (
                        <PickerMenu
                            label="Group"
                            value={groupBy}
                            options={GROUPS}
                            labels={GROUP_LABEL}
                            onChange={props.onGroup}
                            ariaLabel="Group automations by"
                            testId="automations-overview-group"
                        />
                    )}
                    <PickerMenu
                        label="Sort"
                        value={sort}
                        options={SORTS}
                        labels={SORT_LABEL}
                        onChange={props.onSort}
                        ariaLabel="Sort automations"
                        testId="automations-overview-sort"
                    />
                    <SegmentedControl size="sm" value={view} onChange={props.onView} options={VIEW_OPTIONS} ariaLabel="View" />
                    {/* The same split + as the sidebar: the main part makes an
                        automation, the chevron also offers a building block. */}
                    {onCreate && canCreate && (
                        <CreateMenuButton variant="label" onCreateAutomation={onCreate} onCreateBlock={onCreateBlock} onCreateFolder={onCreateFolder} testId="overview-create" />
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * The folded pills: one "Filter" button (it names what is narrowed, "Filter:
 * Live · Schedule") opening a small panel with the same two pill rows.
 */
/** What the folded button names: the labels of the narrowed filters. */
function pickedLabels({ state, stateOptions, trigger, triggerOptions, folder, folderOptions }: Pick<OverviewToolbarProps, 'state' | 'stateOptions' | 'trigger' | 'triggerOptions' | 'folder' | 'folderOptions'>) {
    return [
        state !== 'all' ? stateOptions.find(o => o.value === state)?.label : null,
        trigger !== 'all' ? triggerOptions.find(o => o.value === trigger)?.label : null,
        folder && folder !== 'all' ? folderOptions?.find(o => o.value === folder)?.label : null,
    ].filter(Boolean);
}

function FilterMenu({ state, onState, stateOptions, trigger, onTrigger, triggerOptions, folder, onFolder, folderOptions, narrowed, onClear, showTriggers, showFolders }: OverviewToolbarProps & { showTriggers: boolean; showFolders: boolean }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    // Only read when showFolders (the parent includes onFolder in that flag).
    const folderValue = folder ?? 'all';
    const onFolderSafe = onFolder ?? (() => {});
    const picked = pickedLabels({ state, stateOptions, trigger, triggerOptions, folder, folderOptions });
    const filter = t('routines.overview.filter', 'Filter');
    const heading = 'text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]';
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                data-testid="automations-overview-filter"
                className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-xs transition ${
                    narrowed
                        ? 'border-[var(--accent-primary)] text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)]'
                        : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                }`}
            >
                <ListFilter size={13} aria-hidden="true" />
                <span className="truncate max-w-[16rem]">{picked.length ? `${filter}: ${picked.join(' · ')}` : filter}</span>
                <ChevronDown size={12} aria-hidden="true" className="opacity-60" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="left"
                width={400}
                role="dialog"
                aria-label={filter}
                className="p-3 flex flex-col gap-3"
                data-testid="automations-overview-filter-panel"
            >
                <div className="flex flex-col gap-1.5">
                    <span className={heading}>{t('routines.overview.filterState', 'State')}</span>
                    <FilterPills value={state} onChange={onState} options={stateOptions} ariaLabel="Filter by state" />
                </div>
                {showTriggers && (
                    <div className="flex flex-col gap-1.5">
                        <span className={heading}>{t('routines.overview.filterTrigger', 'Trigger')}</span>
                        <FilterPills value={trigger} onChange={onTrigger} options={triggerOptions} ariaLabel="Filter by trigger" />
                    </div>
                )}
                {showFolders && (
                    <div className="flex flex-col gap-1.5">
                        <span className={heading}>{t('routines.overview.filterFolder', 'Folder')}</span>
                        <FilterPills value={folderValue} onChange={onFolderSafe} options={folderOptions} ariaLabel="Filter by folder" />
                    </div>
                )}                {narrowed && (
                    <button
                        type="button"
                        onClick={() => { onClear(); setOpen(false); }}
                        className="self-start inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                    >
                        <X size={11} aria-hidden="true" />
                        {t('routines.overview.clearFilters', 'Clear filters')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}

/** "Sort: Recently updated ▾" — the Skills overview's SortMenu, generalised. */
function PickerMenu({ label, value, options, labels, onChange, ariaLabel, testId }: {
    label: string;
    value: string;
    options: readonly string[];
    labels: Record<string, string>;
    onChange: (next: string) => void;
    ariaLabel: string;
    testId: string;
}) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement | null>(null);
    return (
        <div className="relative" ref={anchorRef}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid={testId}
                className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
            >
                {label}: {labels[value]}
                <ChevronDown size={12} aria-hidden="true" className="opacity-60" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                width={190}
                role="menu"
                aria-label={ariaLabel}
                className="py-1"
            >
                {options.map((v) => (
                    <button
                        key={v}
                        type="button"
                        role="menuitemradio"
                        aria-checked={v === value}
                        onClick={() => { onChange(v); setOpen(false); }}
                        className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition ${
                            v === value
                                ? 'text-[var(--text-primary)] bg-[var(--bg-secondary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                        <Check size={13} aria-hidden="true" className={v === value ? 'opacity-100' : 'opacity-0'} />
                        {labels[v]}
                    </button>
                ))}
            </AnchoredMenu>
        </div>
    );
}
