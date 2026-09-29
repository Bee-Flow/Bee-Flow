import { ArrowLeft, Check, ChevronDown, Compass } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { LEARNING_PATHS } from '../../../components/onboarding/learningPaths';
import AnchoredMenu from '../../../components/shared/AnchoredMenu';
import SegmentedControl from '../../../components/shared/SegmentedControl';

/**
 * LearningHeader — the 48px row of every Learning Center screen (handoff
 * artboards 1a/1b/1d): the same measurements as StudioSectionHeader — back
 * arrow 32 · tile 28 · name 14/600 · chips · flex:1 · segment tabs · flex:1 ·
 * actions — composed locally because the tile here is an accent-tinted emoji
 * or lucide glyph rather than a Studio KIND tile.
 *
 * Props
 *   onBack, backLabel     back arrow (course screen)
 *   tile                  a ready 28px tile element
 *   title                 14/600 name
 *   chips                 nodes after the title (level chip, progress chip, path chip)
 *   tabs [{id,label,count}], activeTab, onTab
 *   actions               right-hand cluster
 */
export default function LearningHeader({ onBack, backLabel, tile, title, chips, tabs, activeTab, onTab, actions, t }) {
    const options = (tabs || []).map((tab) => ({ value: tab.id, label: tab.label, badge: tab.count != null ? { count: tab.count, tone: tab.tone } : undefined }));
    return (
        <div
            className="flex items-center gap-2.5 px-3 h-12 flex-nowrap min-w-0 flex-shrink-0"
            style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-default)' }}
            data-testid="learning-header"
        >
            {onBack && (
                <button type="button" onClick={onBack} title={backLabel} aria-label={backLabel}
                    className="grid place-items-center w-8 h-8 rounded-lg flex-shrink-0 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition">
                    <ArrowLeft size={16} aria-hidden="true" />
                </button>
            )}
            {tile}
            <h1 className="m-0 text-[14px] font-semibold whitespace-nowrap flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{title}</h1>
            {chips}
            <div className="flex-1 min-w-0" aria-hidden="true" />
            {options.length > 0 && (
                <>
                    <SegmentedControl size="sm" ariaLabel={t('studio.header.tabs', 'Sections')} value={activeTab} onChange={onTab} options={options} />
                    <div className="flex-1 min-w-0" aria-hidden="true" />
                </>
            )}
            {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
    );
}

/** The 28px accent-tinted tile that opens the header. */
export function HeaderTile({ icon: Icon, emoji }) {
    return (
        <div className="grid place-items-center flex-shrink-0" aria-hidden="true"
            style={{ width: 28, height: 28, borderRadius: 8, background: 'color-mix(in srgb, var(--accent-primary) 18%, transparent)', color: 'var(--accent-primary)', fontSize: 15, lineHeight: 1 }}>
            {emoji || (Icon && <Icon style={{ width: 15, height: 15 }} />)}
        </div>
    );
}

/**
 * "Path: Build agents & automations ▾" — the path chip. A menu, not a
 * separate picker screen: the learner's answer reorders the curriculum map
 * and steers the hero, and can be changed here at any time. With no path
 * chosen yet the chip asks the question and wears the accent border.
 */
export function PathChip({ t, path, onPick }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const current = LEARNING_PATHS.find((p) => p.id === path) || null;
    return (
        <>
            <button ref={ref} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
                title={t('learn.path.change_title', 'Change your learning path')}
                className="inline-flex items-center gap-[5px] text-[11px] font-medium whitespace-nowrap flex-shrink-0 transition hover:bg-[var(--bg-tertiary)]"
                style={{ padding: '3px 8px', borderRadius: 999, border: `1px solid ${current ? 'var(--border-default)' : 'var(--accent-primary)'}`, color: 'var(--text-secondary)', background: 'var(--bg-card)' }}>
                <Compass style={{ width: 11, height: 11 }} aria-hidden="true" />
                {current
                    ? t('learn.path.chip', 'Path: {path}').replace('{path}', t(current.titleKey, current.titleFallback))
                    : t('learn.path.q', 'What do you want to get good at?')}
                <ChevronDown style={{ width: 11, height: 11, color: 'var(--text-tertiary)' }} aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={ref} align="left" width={320} role="menu" aria-label={t('learn.path.q', 'What do you want to get good at?')} className="py-1">
                <div className="px-3 pt-1.5 pb-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.path.q_sub', 'Your pick reorders the courses below — everything stays available.')}</div>
                {LEARNING_PATHS.map((p) => {
                    const on = p.id === path;
                    return (
                        <button key={p.id} type="button" role="menuitemradio" aria-checked={on}
                            onClick={() => { onPick(p.id); setOpen(false); }}
                            className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition ${on ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'}`}>
                            <span className="text-[16px] leading-5" aria-hidden="true">{p.icon}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{t(p.titleKey, p.titleFallback)}</span>
                                <span className="block text-[11.5px] leading-[15px]" style={{ color: 'var(--text-tertiary)' }}>{t(p.descKey, p.descFallback)}</span>
                            </span>
                            <Check size={13} aria-hidden="true" className={`mt-1 ${on ? 'opacity-100' : 'opacity-0'}`} />
                        </button>
                    );
                })}
                {!current && (
                    <button type="button" role="menuitem" onClick={() => { onPick('skipped'); setOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('learn.path.skip', 'Skip for now')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}
