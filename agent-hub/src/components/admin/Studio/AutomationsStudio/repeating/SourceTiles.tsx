import { CalendarDays, FolderOpen, Mail, Plus, RefreshCw, Search, Workflow, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';
import type { ScanSourceGroup } from '../../../../../api/queries/automation/repeating';
import { settingsPathForTab } from '../../../../../authedApp/settingsRoutes';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { AppGlyph } from '../../../../automation/Builder/flow/appGlyphs';
import { CANVAS_BUTTON_PRIMARY, CANVAS_CHIP, EYEBROW } from '../../../../automation/Builder/flow/canvasClasses';
import MiniNode from '../../../../automation/Builder/flow/MiniNode';
import { groupLabel } from './patternView';

const GROUP_ICON: Readonly<Record<string, ReactNode>> = Object.freeze({
    mail: <Mail size={16} aria-hidden="true" />,
    calendar: <CalendarDays size={16} aria-hidden="true" />,
    files: <FolderOpen size={16} aria-hidden="true" />,
    beeflow: <Workflow size={16} aria-hidden="true" />,
});

const MAX_GLYPHS = 4;

/** An on/off switch in the canvas's accent colour. */
function SourceSwitch({ on, label, disabled, onToggle }: { on: boolean; label: string; disabled: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            disabled={disabled}
            onClick={onToggle}
            className={`relative ml-auto shrink-0 w-7 h-4 rounded-full transition disabled:opacity-50 disabled:cursor-not-allowed ${on ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-default)]'}`}
        >
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-[var(--bg-card)] shadow-sm transition-all ${on ? 'left-[14px]' : 'left-0.5'}`} />
        </button>
    );
}

/** The connected apps of one group as a row of brand marks, named for screen readers. */
function AppGlyphRow({ apps }: { apps: ScanSourceGroup['apps'] }) {
    const shown = apps.slice(0, MAX_GLYPHS);
    return (
        <span className="flex items-center gap-1 min-w-0">
            {shown.map(a => (
                <span key={a.id} title={a.label} className="inline-flex">
                    <span aria-hidden="true" className="inline-flex"><AppGlyph integrationId={a.id} size={13} /></span>
                    <span className="sr-only">{a.label}</span>
                </span>
            ))}
            {apps.length > shown.length && <span className="text-[10px] text-[var(--text-tertiary)]">+{apps.length - shown.length}</span>}
        </span>
    );
}

function SourceTile({ group, on, disabled, onToggle }: { group: ScanSourceGroup; on: boolean; disabled: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const label = groupLabel(group.id, t);
    const kind = group.kind === 'live'
        ? t('automations.repeating.sourceLive', 'Live')
        : t('automations.repeating.sourceHistory', 'History');
    const eyebrow = `${t('automations.repeating.sourceEyebrow', 'Source')} · ${kind}`;
    const connected = group.apps.filter(a => a.connected);
    if (!group.connected) {
        return (
            <MiniNode family="trigger" dashed eyebrow={eyebrow} title={label} icon={GROUP_ICON[group.id]} testId={`source-tile-${group.id}`}
                sub={t('automations.repeating.sourceNotConnected', 'Nothing connected yet')}>
                <a href={settingsPathForTab('integrations')} className="self-start mt-0.5 text-[11px] font-semibold text-[var(--accent-primary)] hover:underline">
                    {t('automations.repeating.sourceConnect', 'Connect')}
                </a>
            </MiniNode>
        );
    }
    let sub = t('automations.repeating.sourceReady', 'Ready to read');
    if (connected.length === 1) sub = t('automations.repeating.sourceAppsOne', '1 app connected');
    else if (connected.length > 1) sub = t('automations.repeating.sourceApps', '{count} apps connected', { count: connected.length });
    return (
        <MiniNode family="trigger" eyebrow={eyebrow} title={label} sub={sub} icon={GROUP_ICON[group.id]} testId={`source-tile-${group.id}`}>
            <span className="flex items-center gap-2 mt-1 min-w-0">
                <AppGlyphRow apps={connected} />
                <SourceSwitch on={on} disabled={disabled} onToggle={onToggle}
                    label={t('automations.repeating.sourceInclude', 'Include {source}', { source: label })} />
            </span>
        </MiniNode>
    );
}

/** "+ Focus" until opened; then the field, with a way to drop it again. */
function FocusField({ focus, setFocus, open, setOpen, disabled }: {
    focus: string; setFocus: (v: string) => void; open: boolean; setOpen: (v: boolean) => void; disabled: boolean;
}) {
    const { t } = useTranslation();
    if (!open && !focus) {
        return (
            <button type="button" className={`${CANVAS_CHIP} hover:text-[var(--text-primary)] transition disabled:opacity-50`} disabled={disabled} aria-expanded={false} onClick={() => setOpen(true)}>
                <Plus size={12} aria-hidden="true" />
                {t('automations.repeating.focusAdd', 'Focus')}
            </button>
        );
    }
    return (
        <span className="flex items-center gap-1 w-full @[40rem]/repeating:w-auto @[40rem]/repeating:min-w-[18rem] @[40rem]/repeating:flex-1 @[40rem]/repeating:max-w-md">
            <input
                type="text"
                value={focus}
                onChange={e => setFocus(e.target.value)}
                disabled={disabled}
                aria-label={t('automations.repeating.focusLabel', 'Focus (optional)')}
                placeholder={t('automations.repeating.focusPlaceholder', 'Optional: a focus, like invoices or support tickets')}
                className="flex-1 min-w-0 text-[12px] px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-50"
            />
            <button type="button" disabled={disabled} onClick={() => { setFocus(''); setOpen(false); }}
                aria-label={t('automations.repeating.focusRemove', 'Remove focus')}
                className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50">
                <X size={13} aria-hidden="true" />
            </button>
        </span>
    );
}

export interface ScanActionProps {
    scanned: boolean;
    lastScannedAt: string | null;
    onScan: (force: boolean) => void;
    /** Why the scan cannot run now; the button is disabled and says this beside it. */
    disabledReason: string | null;
}

/** "Scan my recent work" before the first scan; "Scanned 2h ago · Scan again" after. */
export function ScanAction({ scanned, lastScannedAt, onScan, disabledReason }: ScanActionProps) {
    const { t } = useTranslation();
    const relative = useRelativeTime();
    const reasonId = useId();
    const why = disabledReason
        ? <span id={reasonId} role="status" className="text-[11px] text-[var(--warning)]">{disabledReason}</span>
        : null;
    if (scanned) {
        const when = relative(lastScannedAt) || t('time.just_now', 'just now');
        return (
            <span className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--text-tertiary)]">
                <span>{t('automations.repeating.scannedAgo', 'Scanned {when}', { when })}</span>
                <span aria-hidden="true">·</span>
                <button type="button" onClick={() => onScan(true)} disabled={!!disabledReason} aria-describedby={why ? reasonId : undefined}
                    className="inline-flex items-center gap-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition">
                    <RefreshCw size={11} aria-hidden="true" />
                    {t('automations.repeating.scanAgain', 'Scan again')}
                </button>
                {why}
            </span>
        );
    }
    return (
        <span className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={() => onScan(false)} disabled={!!disabledReason} aria-describedby={why ? reasonId : undefined} className={CANVAS_BUTTON_PRIMARY}>
                <Search size={13} aria-hidden="true" />
                {t('automations.repeating.scan', 'Scan my recent work')}
            </button>
            {why ?? (
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('automations.repeating.scanHint', 'Takes about a minute. Privacy Shield checks everything Bee reads.')}
                </span>
            )}
        </span>
    );
}

export interface SourceTilesProps {
    groups: ScanSourceGroup[];
    selected: ReadonlySet<string>;
    onToggle: (id: string) => void;
    /** A scan is running: nothing can change underneath it. */
    busy: boolean;
    focus: string;
    setFocus: (v: string) => void;
    focusOpen: boolean;
    setFocusOpen: (v: boolean) => void;
    /** Hidden while a scan runs (the flow's Stop takes its place). */
    action: ScanActionProps | null;
}

/**
 * What the scan may read, as four source nodes in the canvas's trigger shape:
 * Mail, Calendar & meetings, Files and Bee Flow activity. Each says whether
 * it is read live or from what Bee Flow already keeps, which apps are behind
 * it, and has its own switch; a group with nothing connected is a dashed
 * placeholder with "Connect". Under the tiles: the optional focus (folded
 * behind a chip) and the scan action.
 */
export default function SourceTiles({ groups, selected, onToggle, busy, focus, setFocus, focusOpen, setFocusOpen, action }: SourceTilesProps) {
    const { t } = useTranslation();
    return (
        <section className="flex flex-col gap-3" aria-label={t('automations.repeating.sourcesTitle', 'Sources')}>
            <div className={`${EYEBROW} text-[var(--text-tertiary)]`}>{t('automations.repeating.sourcesTitle', 'Sources')}</div>
            <ul className="m-0 p-0 list-none grid grid-cols-1 gap-3 @[30rem]/repeating:grid-cols-2 @[64rem]/repeating:grid-cols-4">
                {groups.map(g => (
                    <li key={g.id} className={`min-w-0 transition-opacity ${g.connected && !selected.has(g.id) ? 'opacity-60' : ''}`}>
                        <SourceTile group={g} on={selected.has(g.id)} disabled={busy} onToggle={() => onToggle(g.id)} />
                    </li>
                ))}
            </ul>
            <div className="flex items-center gap-3 flex-wrap">
                <FocusField focus={focus} setFocus={setFocus} open={focusOpen} setOpen={setFocusOpen} disabled={busy} />
                {action && <ScanAction {...action} />}
            </div>
        </section>
    );
}
