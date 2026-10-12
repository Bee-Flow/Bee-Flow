import { Check, ChevronDown, Hammer, Hand, ListChecks, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { isPlanStatusInProgress } from './planBuild';
import { WORK_MODE_SHORTCUT_LABEL } from './workModeShortcut';

export const WORK_MODES = [
    { id: 'discuss', Icon: MessageCircleQuestion, key: 'discuss', label: 'Only discuss', description: 'Explains and advises. Leaves the flow unchanged.' },
    { id: 'approve', Icon: Hand, key: 'approve', label: 'Approve each change', description: 'Shows a proposal. You choose whether to apply it.' },
    { id: 'plan', Icon: ListChecks, key: 'plan', label: 'Plan first', description: 'Explores, asks questions and writes a plan. Builds after your approval.' },
    { id: 'build', Icon: Hammer, key: 'build', label: 'Build directly', description: 'Builds immediately. Changes can be undone.' },
];

// `planStatus` / `planVersion` describe the plan the builder is working through.
// While it is open (building, or paused for an answer) the trigger says so
// instead of the user's own mode, because every follow-up continues that plan;
// the chosen mode applies again once the plan is built.
//
// `anchor` says what the menu is positioned against. 'self' (default): the
// picker's own box, for a picker standing alone. 'composer': the nearest
// positioned ancestor, which in the chat is the composer box. The picker sits in
// that box's toolbar, a few dozen pixels from its left edge, so a 320px menu
// hung off the button spilled past the right edge of a 240-360px side panel;
// anchored to the composer it takes the composer's width.
export default function WorkModePicker({ value = 'approve', onChange, disabled = false, alwaysPlanLarge = true, onAlwaysPlanLargeChange = null, anchor = 'self', planStatus = /** @type {string | null} */ (null), planVersion = /** @type {number | string | null} */ (null) }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const triggerRef = useRef(null);
    const menuRef = useRef(null);
    useEffect(() => {
        const close = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
        const escape = e => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
    }, []);
    // Opening moves focus to the checked mode, so the arrow keys have somewhere to start.
    useEffect(() => {
        if (open) (menuRef.current?.querySelector('[aria-checked="true"]') || menuRef.current?.querySelector('[role="menuitemradio"]'))?.focus();
    }, [open]);
    const closeToTrigger = () => { setOpen(false); triggerRef.current?.focus(); };
    const onMenuKeyDown = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToTrigger(); return; }
        if (e.key === 'Tab') { setOpen(false); return; }
        const items = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"]') || [])];
        const at = items.indexOf(document.activeElement);
        const to = e.key === 'ArrowDown' ? (at + 1) % items.length
            : e.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1)
                : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
        if (to < 0 || !items.length) return;
        e.preventDefault();
        items[to].focus();
    };
    const selected = WORK_MODES.find(m => m.id === value) || WORK_MODES[1];
    const buildingPlan = isPlanStatusInProgress(planStatus);
    const triggerLabel = buildingPlan ? t('automations.assistant.mode.building_plan', 'Building plan v{version}', { version: planVersion ?? '' }) : t(`automations.assistant.mode.${selected.key}`, selected.label);
    const TriggerIcon = buildingPlan ? Hammer : selected.Icon;
    return <div ref={ref} className={`min-w-0 ${anchor === 'composer' ? '' : 'relative'}`}>
        <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-keyshortcuts="Alt+M" onClick={() => setOpen(!open)}
            onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}
            className="flex items-center gap-1.5 min-w-0 rounded-lg px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50">
            <TriggerIcon size={13} className="shrink-0" /><span className="truncate">{triggerLabel}</span><ChevronDown size={11} className="shrink-0" />
        </button>
        {open && <div ref={menuRef} role="menu" aria-label={t('automations.assistant.work_mode', 'Work mode')} onKeyDown={onMenuKeyDown}
            className={`absolute bottom-full mb-2 z-50 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-1.5 shadow-lg ${anchor === 'composer' ? 'inset-x-0 max-w-full' : 'left-0 w-[min(320px,calc(100vw-48px))] max-w-[calc(100cqw-24px)]'}`}>
            <div className="flex justify-between p-2 text-[11px] text-[var(--text-tertiary)]"><span>{t('automations.assistant.work_mode', 'Work mode')}</span><kbd title={t('automations.assistant.work_mode_shortcut', 'Alt+M switches the work mode')} className="font-sans">{WORK_MODE_SHORTCUT_LABEL}</kbd></div>
            {buildingPlan && <p className="px-2 pb-2 text-[11px] leading-4 text-[var(--text-tertiary)]">{t('automations.assistant.mode.building_plan_hint', 'Follow-up messages continue this plan. Your own work mode applies again when it is done.')}</p>}
            {WORK_MODES.map(m => <button key={m.id} type="button" role="menuitemradio" aria-checked={value === m.id}
                onClick={() => { onChange(m.id); closeToTrigger(); }} className={`flex w-full gap-2.5 rounded-lg p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--type-ai)] ${value === m.id ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'}`}>
                <m.Icon size={15} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-[var(--text-primary)]">{t(`automations.assistant.mode.${m.key}`, m.label)}</span><span className="block mt-0.5 text-[11px] leading-4 text-[var(--text-tertiary)]">{t(`automations.assistant.mode.${m.key}_hint`, m.description)}</span></span>
                {value === m.id && <Check size={13} className="shrink-0 mt-0.5" />}
            </button>)}
            {onAlwaysPlanLargeChange && <label className="flex items-center gap-2 border-t border-[var(--border-default)] mt-1 p-2 text-[11px] text-[var(--text-secondary)]"><span className="flex-1">{t('automations.assistant.large_plan', 'Ask before applying large changes (4+ steps)')}</span><input type="checkbox" checked={alwaysPlanLarge} onChange={e => onAlwaysPlanLargeChange(e.target.checked)} /></label>}
        </div>}
    </div>;
}
