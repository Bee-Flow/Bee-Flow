import { Check } from 'lucide-react';

// Compact save-state pill for the editor header. State machine:
//   - idle:    nothing rendered (no churn before the first save)
//   - saving:  spinner + label
//   - saved:   check + label
//   - error:   warning icon, full server message in `title` tooltip,
//              click to retry the save
export default function SaveStateIndicator({ t, state, savedAt, errorMsg, onRetry }) {
    if (!state || state === 'idle') return null;

    if (state === 'saving') {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                <span className="w-3 h-3 inline-block rounded-full border border-[var(--text-tertiary)] border-t-transparent animate-spin" />
                {t('agent_wizard.save_state_indicator_saving', 'Saving…')}
            </span>
        );
    }
    if (state === 'saved') {
        let timeStr = '';
        if (savedAt) {
            const now = new Date();
            const isToday = savedAt.toDateString() === now.toDateString();
            const time = savedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
            if (isToday) {
                timeStr = time;
            } else {
                const date = savedAt.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
                timeStr = `${date} · ${time}`;
            }
        }
        return (
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                <Check size={12} className="text-emerald-500" />
                {t('agent_wizard.save_state_indicator_saved', 'Saved')}{timeStr ? ` · ${timeStr}` : ''}
            </span>
        );
    }
    // error
    const tooltip = errorMsg
        ? `${t('agent_wizard.builder.save_error', 'Save failed')}: ${errorMsg}`
        : (t('agent_wizard.builder.save_error', 'Save failed'));
    return (
        <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 cursor-pointer"
            title={tooltip}
        >
            <span aria-hidden="true">!</span>
            {t('agent_wizard.builder.save_error', 'Save failed')}
            <span className="underline">{t('agent_wizard.builder.save_retry', 'retry')}</span>
        </button>
    );
}
