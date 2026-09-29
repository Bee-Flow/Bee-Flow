import { Check, ChevronDown } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import SegmentedControl from '../../../shared/SegmentedControl';
import type { BuilderTab } from '../useBuilderTabUrl';
import useDismiss from './useDismiss';

/** The tab counts; null = not known (renders no count, never a "0"). */
interface ViewCounts { runs?: number | null; versions?: number | null }

interface ViewDef { id: BuilderTab; label: string; desc: string }

// The ids stay ('build' and 'history' are persisted initialTab values,
// BFSF-343); only the words change.
function views(t: TranslateFn): ViewDef[] {
    return [
        { id: 'build', label: t('routines.header.view_editor', 'Editor'), desc: t('routines.header.view_editor_desc', 'Design the routine on the canvas') },
        { id: 'settings', label: t('routines.header.view_settings', 'Settings'), desc: t('routines.header.view_settings_desc', 'Name, sharing and behaviour') },
        { id: 'history', label: t('routines.header.view_runs', 'Runs'), desc: t('routines.header.view_runs_desc', 'What happened each time this routine ran') },
        { id: 'versions', label: t('routines.header.view_versions', 'Versions'), desc: t('routines.header.view_versions_desc', 'Earlier versions you can open or make live') },
    ];
}

function countFor(id: BuilderTab, counts?: ViewCounts): number | null {
    if (id === 'history') return counts?.runs ?? null;
    if (id === 'versions') return counts?.versions ?? null;
    return null;
}

interface Props { tab: BuilderTab; onTabChange: (tab: BuilderTab) => void; counts?: ViewCounts }

/**
 * Editor · Settings · Runs n · Versions n, centred in the bar (artboard 5a).
 * Below 1080px of the bar's own width the segments fold into one menu.
 */
export default function ViewSwitcher({ tab, onTabChange, counts }: Props) {
    const { t } = useTranslation();
    const defs = views(t);
    return (
        <>
            <div className="@max-[1080px]/bar:hidden">
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('routines.header.views_label', 'Builder views')}
                    value={tab}
                    onChange={onTabChange}
                    options={defs.map(v => ({ value: v.id, label: v.label, badge: countFor(v.id, counts) }))}
                />
            </div>
            <div className="hidden @max-[1080px]/bar:block">
                <ViewMenu tab={tab} onTabChange={onTabChange} counts={counts} />
            </div>
        </>
    );
}

/** The same four views as one compact menu (narrow bars and step mode). */
export function ViewMenu({ tab, onTabChange, counts }: Props) {
    const { t } = useTranslation();
    const { open, setOpen, ref } = useDismiss();
    const defs = views(t);
    const current = defs.find(v => v.id === tab) || defs[0];
    return (
        <div ref={ref} className="relative flex-shrink-0">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[13px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
            >
                {current.label}
                <ChevronDown size={13} className="opacity-60" />
            </button>
            {open && (
                <div role="menu" className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-40 w-52 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg py-1">
                    {defs.map(v => {
                        const n = countFor(v.id, counts);
                        return (
                            <button
                                key={v.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={v.id === tab}
                                // The accessible name is the label alone; the
                                // description below is display-only.
                                aria-label={v.label}
                                onClick={() => { onTabChange(v.id); setOpen(false); }}
                                className={`w-full text-left px-3 py-1.5 text-sm flex items-start gap-2 transition ${
                                    v.id === tab
                                        ? 'text-[var(--text-primary)] bg-[var(--bg-secondary)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                                }`}
                            >
                                <Check size={13} className={`mt-0.5 ${v.id === tab ? 'opacity-100' : 'opacity-0'}`} />
                                <span className="min-w-0">
                                    <span className="block">
                                        {v.label}
                                        {n != null && <span className="ml-1.5 tabular-nums text-[var(--text-tertiary)]">{n}</span>}
                                    </span>
                                    <span aria-hidden="true" className="block text-[10px] text-[var(--text-tertiary)] leading-snug">{v.desc}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
