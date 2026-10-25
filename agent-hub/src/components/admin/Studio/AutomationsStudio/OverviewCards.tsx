import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { folderSectionsOf, type FolderSection } from './folderSections';
import { NO_FOLDER, isFailing, triggerTextOf, type AutomationRecord, type RunIdSet } from './overviewModel';
import { OutcomeBit, StatusBadge, TriggerTile, titleOf, useRowMenu } from './OverviewBits';
import StepStrip from './StepStrip';
import { TONE_CLASSES, triggerToneOf } from './triggerTone';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatNextRun } from '../../../automation/taskFormatters';
import { STATUS_TOKENS } from '../../../shared/statusTokens';
import type { CardProps, RowPropsFn } from './AutomationsOverview.types';
import type { TreeFolder } from '../../../automation/folderTree';

/**
 * The cards view of "All automations": a gallery, grouped into the sidebar's
 * folders once the library has any. Each folder is a section with a sticky
 * header (its path, its count) that folds away, so forty automations read as
 * five shelves rather than one wall of cards.
 */

// The card grid: as many columns as fit at 21rem, by the overview's own
// width. auto-fill keeps empty tracks, so three automations stay card-sized.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(21rem,100%),1fr))] gap-3';

interface CardsViewProps {
    rows: AutomationRecord[];
    folders?: readonly TreeFolder[] | null;
    rowProps?: RowPropsFn | null;
    activeRunIds?: RunIdSet | null;
    column: string;
}

export function CardsView({ rows, folders, rowProps, activeRunIds, column }: CardsViewProps) {
    const sections = useMemo(() => folderSectionsOf(rows, folders), [rows, folders]);
    const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
    const toggle = (id: string) => setClosed((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const cards = (list: AutomationRecord[]) => list.map(a => (
        <Card key={a.id} automation={a} props={rowProps?.(a)} liveRunning={!!activeRunIds?.has?.(a.id)} />
    ));
    if (!sections) {
        return <div className={`${column} ${GRID} p-4`} data-testid="automations-overview-cards">{cards(rows)}</div>;
    }
    return (
        <div className={`${column} px-4 pb-4`} data-testid="automations-overview-cards">
            {sections.map(s => (
                <section key={s.id} data-testid="overview-folder-section" data-folder={s.id} aria-label={sectionName(s, null)}>
                    <SectionHeader section={s} open={!closed.has(s.id)} onToggle={() => toggle(s.id)} />
                    {!closed.has(s.id) && <div className={GRID}>{cards(s.rows)}</div>}
                </section>
            ))}
        </div>
    );
}

function sectionName(s: FolderSection, t: ((k: string, en: string) => string) | null) {
    if (s.id === NO_FOLDER) return t ? t('studio_misc.overview.no_folder', 'No folder') : 'No folder';
    return s.path || (t ? t('studio_misc.overview.untitled_folder', 'Untitled folder') : 'Untitled folder');
}

function SectionHeader({ section: s, open, onToggle }: { section: FolderSection; open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const name = sectionName(s, t);
    // "Finance / Invoices": the parents quiet, the folder itself in full ink.
    const cut = s.id === NO_FOLDER ? -1 : name.lastIndexOf(' / ');
    const parents = cut > 0 ? name.slice(0, cut + 3) : '';
    const leaf = cut > 0 ? name.slice(cut + 3) : name;
    const Icon = s.id === NO_FOLDER ? null : open ? FolderOpen : Folder;
    return (
        <h3 className="sticky top-0 z-[1] m-0 bg-[var(--bg-primary)] pt-4 pb-2">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                data-testid="overview-folder-header"
                className="group/fh flex items-center gap-2 w-full min-w-0 text-left rounded-md px-1 py-1 hover:bg-[var(--bg-secondary)] transition"
            >
                <ChevronRight size={14} aria-hidden="true" className={`shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`} />
                {Icon && <Icon size={15} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />}
                <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]">
                    {parents && <span className="font-normal text-[var(--text-tertiary)]">{parents}</span>}
                    {leaf}
                </span>
                <span className="shrink-0 rounded-full bg-[var(--bg-secondary)] px-1.5 text-[11px] tabular-nums text-[var(--text-tertiary)]">{s.rows.length}</span>
                <span className="flex-1 border-t border-[var(--border-subtle,var(--border-default))] ml-1" aria-hidden="true" />
            </button>
        </h3>
    );
}

export function Card({ automation: a, props, liveRunning, compact = false, hideLifecycle = false }: CardProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { onContextMenu, kebab, menu } = useRowMenu(props);
    const tone = triggerToneOf(a);
    const failing = isFailing(a);
    const paused = !a.isActive && !a.isDraft;
    const nextRun = a.nextRunAt && a.isActive ? t('studio_misc.overview.next_at', 'Next {when}', { when: formatNextRun(a.nextRunAt) }) : null;
    const when = nextRun || (a.lastRunAt ? t('studio_misc.overview.ran_at', 'Ran {when}', { when: rel(a.lastRunAt) }) : null);
    const description = (a.description || '').trim();
    return (
        <>
            <div
                role="button"
                tabIndex={0}
                data-testid="automations-overview-card"
                data-automation-id={a.id}
                data-tone={tone}
                onClick={props?.onSelect}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props?.onSelect?.(); } }}
                onContextMenu={onContextMenu}
                className={`group relative flex flex-col overflow-hidden rounded-xl border bg-[var(--bg-card)] text-left transition-all hover:shadow-md cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] ${compact ? 'p-3 pt-3.5' : 'p-3.5 pt-4'} ${
                    failing ? 'border-[var(--error)]' : 'border-[var(--border-subtle,var(--border-default))]'
                } ${props?.selected ? 'ring-2 ring-[var(--accent-primary)]' : ''} ${paused ? 'opacity-80' : ''}`}
            >
                {/* The trigger's colour along the top edge: a page of cards
                    sorts itself by kind before a title is read. */}
                <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-[3px] ${TONE_CLASSES[tone].accent} ${a.isActive ? 'opacity-80' : 'opacity-40'}`} />
                <div className="flex items-start gap-2.5 mb-2">
                    <TriggerTile automation={a} size={compact ? 'md' : 'lg'} />
                    <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold truncate text-[var(--text-primary)]" title={titleOf(a, t)}>{titleOf(a, t)}</span>
                            {liveRunning && <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${STATUS_TOKENS.running.solid} bg-current shrink-0`} aria-hidden="true" />}
                        </div>
                        <div className="text-xs mt-0.5 truncate text-[var(--text-secondary)]" title={triggerTextOf(a, t)}>{triggerTextOf(a, t)}</div>
                    </div>
                    <span className="-mr-1 -mt-1">{kebab}</span>
                </div>
                {!compact && description && (
                    <p className="text-xs m-0 mb-2.5 line-clamp-2 text-[var(--text-secondary)]">{description}</p>
                )}
                <div className="mb-3 min-w-0">
                    <StepStrip automation={a} small={compact} />
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 min-w-0">
                    {!hideLifecycle ? <StatusBadge automation={a} /> : <span />}
                    <span className="flex items-center justify-end gap-2 min-w-0">
                        <OutcomeBit automation={a} liveRunning={liveRunning} when={when} />
                    </span>
                </div>
            </div>
            {menu}
        </>
    );
}
