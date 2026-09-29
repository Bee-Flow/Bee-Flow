import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { denseInputClass, FOCUS_RING_INSET } from '../settings/formStyles';
import { stepDragProps } from '../stepDrag';
import useTranslation from '../../../../../hooks/useTranslation';
import { RibbonDropdown } from './jsComponents';
import { actionRows } from './menuRows';
import type { MenuSection, RowSpec } from './menuRows';
import type { OpenState } from './AppCommands';
import type { RibbonApp, StepPayload } from './ribbonCategories';

/**
 * The content of every ribbon dropdown, in the style of the Nextcloud apps'
 * action lists: a small header, a filter once the list is long, then rows
 * with an icon, the name and what it does in up to two lines. Every row is a
 * button: it adds on click (or Enter), drags onto the canvas, and a row that
 * cannot be added stays visible with its reason. An app of several actions
 * opens its own list in place, with a way back.
 */

type AddFn = (payload: StepPayload) => void;

// Past this many rows, reading top to bottom is slower than typing a word.
export const MENU_FILTER_THRESHOLD = 6;

const HEADER = 'text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';

function MenuRow({ row, onAdd, onOpenApp }: { row: RowSpec; onAdd: AddFn; onOpenApp: (app: RibbonApp) => void }) {
    const desc = row.disabled ? row.disabledReason : row.desc;
    const addable = !!row.payload && !row.disabled;
    return (
        <button
            type="button"
            disabled={!!row.disabled}
            onClick={() => {
                if (row.payload) onAdd(row.payload);
                else if (row.app) onOpenApp(row.app);
            }}
            {...(addable ? stepDragProps(row.payload) : null)}
            title={desc || row.label}
            data-ribbon-row=""
            className={`w-full text-left flex items-start gap-2.5 px-3 py-1.5 hover:bg-[var(--bg-secondary)] transition disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-transparent ${FOCUS_RING_INSET} ${addable ? 'select-none cursor-grab active:cursor-grabbing' : ''}`}
        >
            <span className="shrink-0 mt-0.5 h-6 w-6 rounded-md bg-[var(--bg-secondary)] flex items-center justify-center">
                {row.glyph}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-[var(--text-primary)] truncate">{row.label}</span>
                {desc && (
                    <span className={`block text-[11px] leading-snug text-[var(--text-tertiary)] line-clamp-2 ${row.disabled ? 'italic' : ''}`}>{desc}</span>
                )}
            </span>
            {row.app && <ChevronRight size={13} className="shrink-0 mt-1 text-[var(--text-tertiary)]" aria-hidden="true" />}
        </button>
    );
}

interface PageProps {
    /** The header. Without one (the "More" list) each section carries its own. */
    title?: string | null;
    hint?: string | null;
    sections: MenuSection[];
    filterLabel: (n: number) => string;
    emptyText?: string | null;
    noMatchText?: (q: string) => string;
    onAdd: AddFn;
    onOpenApp: (app: RibbonApp) => void;
    onBack?: (() => void) | null;
}

function matches(row: RowSpec, needle: string): boolean {
    return [row.label, row.desc, row.terms].some(s => !!s && s.toLowerCase().includes(needle));
}

function MenuPage({ title = null, hint = null, sections, filterLabel, emptyText = null, noMatchText, onAdd, onOpenApp, onBack = null }: PageProps) {
    const { t } = useTranslation();
    const [q, setQ] = useState('');
    const total = sections.reduce((n, s) => n + s.rows.length, 0);
    const needle = q.trim().toLowerCase();
    const visible = needle
        ? sections.map(s => ({ ...s, rows: s.rows.filter(r => matches(r, needle)) })).filter(s => s.rows.length > 0)
        : sections.filter(s => s.rows.length > 0);
    const captioned = !title || visible.length > 1;
    let body: ReactNode;
    if (visible.length === 0) {
        body = (
            <div className="px-3 py-2 text-[11px] text-[var(--text-tertiary)] italic">
                {total === 0
                    ? (emptyText || t('routines.ribbon.no_actions', 'No actions available.'))
                    : (noMatchText ? noMatchText(q) : t('routines.ribbon.search_none', 'Nothing matches “{q}”.', { q }))}
            </div>
        );
    } else {
        body = visible.map(sec => (
            <div key={sec.key}>
                {captioned && <div className={`px-3 pt-2 pb-0.5 ${HEADER} text-[10px]`}>{sec.title}</div>}
                {sec.rows.map(row => <MenuRow key={row.key} row={row} onAdd={onAdd} onOpenApp={onOpenApp} />)}
            </div>
        ));
    }
    return (
        <div className="flex flex-col min-h-0">
            {title && (
                <div className="px-3 pt-2 pb-1 flex items-center gap-1 min-w-0">
                    {onBack && (
                        <button
                            type="button"
                            onClick={onBack}
                            aria-label={t('routines.ribbon.back', 'Back')}
                            title={t('routines.ribbon.back', 'Back')}
                            className={`-ml-1 shrink-0 h-5 w-5 grid place-items-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] ${FOCUS_RING_INSET}`}
                        >
                            <ChevronLeft size={13} />
                        </button>
                    )}
                    <span className={`${HEADER} truncate`}>{title}</span>
                </div>
            )}
            {hint && <div className="px-3 pb-1 text-[11px] leading-snug text-[var(--text-tertiary)]">{hint}</div>}
            {total > MENU_FILTER_THRESHOLD && (
                <div className="px-2 pb-2">
                    <div className="relative">
                        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                        <input
                            type="text"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder={filterLabel(total)}
                            aria-label={filterLabel(total)}
                            className={denseInputClass('w-full pl-7 pr-2')}
                        />
                    </div>
                </div>
            )}
            <div className="flex-1 py-1 overflow-y-auto custom-scrollbar min-h-0">{body}</div>
        </div>
    );
}

type PanelProps = Omit<PageProps, 'onOpenApp' | 'onBack'>;

/** A dropdown's content. Opening an app of several actions swaps in its action list. */
export default function MenuPanel(props: PanelProps) {
    const { t } = useTranslation();
    const [app, setApp] = useState<RibbonApp | null>(null);
    const appSections = useMemo(() => (app ? [{ key: app.id, title: app.label, rows: actionRows(app) }] : []), [app]);
    if (app) {
        return (
            <MenuPage
                key={app.id}
                title={app.label}
                sections={appSections}
                filterLabel={(n) => t('routines.ribbon.filter_actions', 'Filter {n} actions…', { n })}
                noMatchText={(q) => t('routines.ribbon.no_action_match', 'No action matches “{q}”.', { q })}
                onAdd={props.onAdd}
                onOpenApp={setApp}
                onBack={() => setApp(null)}
            />
        );
    }
    return <MenuPage {...props} onOpenApp={setApp} />;
}

/** The action list behind a multi-action app: the Nextcloud apps' dropdown. */
export function AppActionsList({ app, onAdd }: { app: RibbonApp; onAdd: AddFn }) {
    const { t } = useTranslation();
    const sections = useMemo(() => [{ key: app.id, title: app.label, rows: actionRows(app) }], [app]);
    return (
        <MenuPanel
            title={app.label}
            sections={sections}
            filterLabel={(n) => t('routines.ribbon.filter_actions', 'Filter {n} actions…', { n })}
            noMatchText={(q) => t('routines.ribbon.no_action_match', 'No action matches “{q}”.', { q })}
            onAdd={onAdd}
        />
    );
}

interface DropdownPillProps extends OpenState, PanelProps {
    /** The open-state key; unique on the row. */
    id: string;
    label: string;
    glyph: ReactNode;
    desc: string;
    tipFooter: string;
    /** `data-ribbon-origin` stamp of the pill. */
    origin?: string | null;
}

/** A pill whose dropdown lists a group of rows: a step group, the agents, the skills, a suite of apps. */
export function DropdownPill({ id, label, glyph, desc, tipFooter, origin = null, openKey, setOpenKey, ...panel }: DropdownPillProps) {
    return (
        <RibbonDropdown
            glyph={glyph}
            label={label}
            desc={desc}
            tipFooter={tipFooter}
            width={320}
            open={openKey === id}
            onToggle={() => setOpenKey(k => (k === id ? null : id))}
            buttonProps={origin ? { 'data-ribbon-origin': origin } : null}
        >
            <MenuPanel {...panel} />
        </RibbonDropdown>
    );
}
