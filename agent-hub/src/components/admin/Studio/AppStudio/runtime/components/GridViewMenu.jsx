import { useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { VIEW_OPTIONS } from './gridViewPrefs';
import useTranslation from '../../../../../../hooks/useTranslation';

/**
 * The reader's own controls for one grid: how tall the rows are, how they are
 * separated, and how much room a long cell may take.
 *
 * Deliberately a popover and not a row of buttons in the chrome — these are
 * settings you touch once and then forget, and three segmented controls sitting
 * permanently above every table would cost more attention than they save.
 */

const LABEL_KEYS = ['density', 'look', 'clamp'];

const labelsFor = (t) => ({
    density: {
        label: t('studio_apps_runtime.view_menu.row_height', 'Row height'),
        options: {
            compact: t('studio_apps_runtime.view_menu.density_tight', 'Tight'),
            comfortable: t('studio_apps_runtime.view_menu.density_normal', 'Normal'),
            spacious: t('studio_apps_runtime.view_menu.density_roomy', 'Roomy'),
        },
    },
    look: {
        label: t('studio_apps_runtime.view_menu.row_separation', 'Row separation'),
        options: {
            default: t('studio_apps_runtime.view_menu.look_lines', 'Lines'),
            striped: t('studio_apps_runtime.view_menu.look_stripes', 'Stripes'),
            minimal: t('studio_apps_runtime.view_menu.look_space', 'Space'),
            cards: t('studio_apps_runtime.view_menu.look_cards', 'Cards'),
        },
    },
    clamp: {
        label: t('studio_apps_runtime.view_menu.long_text', 'Long text'),
        options: {
            1: t('studio_apps_runtime.view_menu.clamp_1', '1 line'),
            2: t('studio_apps_runtime.view_menu.clamp_2', '2 lines'),
            3: t('studio_apps_runtime.view_menu.clamp_3', '3 lines'),
            off: t('studio_apps_runtime.view_menu.clamp_full', 'Full'),
        },
    },
});

function Segmented({ groupKey, value, onChange }) {
    const { t } = useTranslation();
    const meta = labelsFor(t)[groupKey];
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {meta.label}
            </span>
            <div className="flex" role="group" aria-label={meta.label}>
                {VIEW_OPTIONS[groupKey].map((opt, i, all) => {
                    const active = value === opt;
                    return (
                        <button
                            key={opt}
                            type="button"
                            onClick={() => onChange(opt)}
                            aria-pressed={active}
                            className="px-2 py-1 text-xs font-medium border whitespace-nowrap"
                            style={{
                                background: active ? 'var(--app-primary-soft)' : 'var(--bg-primary)',
                                color: active ? 'var(--app-primary)' : 'var(--text-secondary)',
                                borderColor: active ? 'var(--app-primary)' : 'var(--border-default)',
                                // One continuous control: only the ends are
                                // rounded, and adjacent borders collapse.
                                borderRadius: i === 0
                                    ? 'var(--app-radius) 0 0 var(--app-radius)'
                                    : i === all.length - 1 ? '0 var(--app-radius) var(--app-radius) 0' : 0,
                                marginLeft: i === 0 ? 0 : -1,
                                position: active ? 'relative' : undefined,
                            }}
                        >
                            {meta.options[opt] ?? opt}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default function GridViewMenu({ view, onChange, onReset, hasOverrides }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);

    // Click-outside and Escape both close it. Without the outside handler the
    // panel stayed open behind the next thing you clicked, which on a wide
    // table means it covers the rows you were trying to read.
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open]);

    return (
        <div ref={wrapRef} className="relative shrink-0" data-app-grid-viewmenu="true">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={t('studio_apps_runtime.view_menu.title', 'How this table is shown')}
                className="inline-flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium border"
                style={{
                    background: hasOverrides ? 'var(--app-primary-soft)' : 'var(--bg-primary)',
                    color: hasOverrides ? 'var(--app-primary)' : 'var(--text-secondary)',
                    borderColor: hasOverrides ? 'var(--app-primary)' : 'var(--border-default)',
                    borderRadius: 'var(--app-radius)',
                }}
            >
                <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('studio_apps_runtime.view_menu.view', 'View')}</span>
            </button>

            {open ? (
                <div
                    role="dialog"
                    aria-label={t('studio_apps_runtime.view_menu.settings', 'Table view settings')}
                    className="absolute right-0 z-20 mt-1 flex flex-col gap-3 border p-3 shadow-lg"
                    style={{
                        background: 'var(--bg-card)',
                        borderColor: 'var(--border-default)',
                        borderRadius: 'var(--app-radius)',
                        minWidth: 260,
                    }}
                >
                    {LABEL_KEYS.map((key) => (
                        <Segmented key={key} groupKey={key} value={view[key]} onChange={(v) => onChange(key, v)} />
                    ))}
                    <div className="flex items-center justify-between gap-3 pt-1">
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {t('studio_apps_runtime.view_menu.only_you', 'Only changes how you see it.')}
                        </span>
                        <button
                            type="button"
                            onClick={onReset}
                            disabled={!hasOverrides}
                            className="px-2 py-1 text-xs font-medium disabled:opacity-40"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            {t('studio_apps_runtime.view_menu.reset', 'Reset')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
