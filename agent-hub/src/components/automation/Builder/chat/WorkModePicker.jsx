import { Check, ChevronDown, Hammer, Hand, ListChecks, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';

export const WORK_MODES = [
    { id: 'discuss', Icon: MessageCircleQuestion, key: 'discuss', label: 'Only discuss', description: 'Explains and advises. Leaves the flow unchanged.' },
    { id: 'approve', Icon: Hand, key: 'approve', label: 'Approve each change', description: 'Shows a proposal. You choose whether to apply it.' },
    { id: 'plan', Icon: ListChecks, key: 'plan', label: 'Plan first', description: 'Explores, asks questions and writes a plan. Builds after your approval.' },
    { id: 'build', Icon: Hammer, key: 'build', label: 'Build directly', description: 'Builds immediately. Changes can be undone.' },
];

export default function WorkModePicker({ value = 'approve', onChange, disabled = false, alwaysPlanLarge = true, onAlwaysPlanLargeChange = null }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        const close = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
        const escape = e => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
    }, []);
    const selected = WORK_MODES.find(m => m.id === value) || WORK_MODES[1];
    return <div ref={ref} className="relative min-w-0">
        <button type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
            className="flex items-center gap-1.5 min-w-0 rounded-lg px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50">
            <selected.Icon size={13} className="shrink-0" /><span className="truncate">{t(`automations.assistant.mode.${selected.key}`, selected.label)}</span><ChevronDown size={11} className="shrink-0" />
        </button>
        {open && <div role="menu" aria-label={t('automations.assistant.work_mode', 'Work mode')}
            className="absolute bottom-full left-0 mb-2 z-50 w-[min(320px,calc(100vw-48px))] max-w-[calc(100cqw-24px)] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-1.5 shadow-lg">
            <div className="flex justify-between p-2 text-[11px] text-[var(--text-tertiary)]"><span>{t('automations.assistant.work_mode', 'Work mode')}</span><span>{t('automations.work_mode_picker.tab', '⇧ Tab')}</span></div>
            {WORK_MODES.map(m => <button key={m.id} type="button" role="menuitemradio" aria-checked={value === m.id}
                onClick={() => { onChange(m.id); setOpen(false); }} className={`flex w-full gap-2.5 rounded-lg p-2.5 text-left ${value === m.id ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'}`}>
                <m.Icon size={15} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-[var(--text-primary)]">{t(`automations.assistant.mode.${m.key}`, m.label)}</span><span className="block mt-0.5 text-[11px] leading-4 text-[var(--text-tertiary)]">{t(`automations.assistant.mode.${m.key}_hint`, m.description)}</span></span>
                {value === m.id && <Check size={13} className="shrink-0 mt-0.5" />}
            </button>)}
            {onAlwaysPlanLargeChange && <label className="flex items-center gap-2 border-t border-[var(--border-default)] mt-1 p-2 text-[11px] text-[var(--text-secondary)]"><span className="flex-1">{t('automations.assistant.large_plan', 'Ask before applying large changes (4+ steps)')}</span><input type="checkbox" checked={alwaysPlanLarge} onChange={e => onAlwaysPlanLargeChange(e.target.checked)} /></label>}
        </div>}
    </div>;
}
