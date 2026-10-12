import useMediaQuery from '../../../../../pages/meeting-notes/hooks/useMediaQuery';

/**
 * "One row per [Attachment] [Label item]": which inner list a row stands for.
 * Generic on purpose (the Condition's level choice reuses it): one option is a
 * plain sentence, two or more a segmented control, and below 480px that
 * control becomes a select with the same label, because a row of segments
 * does not fit a phone.
 */
export interface LevelChooserProps {
    levels: Array<{ path: string; label: string; countLabel?: string }>;
    value: string;
    onChange(path: string): void;
    label: string;
    sentence: (label: string) => string;
}

const SEGMENT = 'px-2.5 py-1 text-xs rounded-md transition text-left';
const SEGMENT_ON = 'bg-[var(--bg-card)] text-[var(--text-primary)] font-semibold shadow-sm';
const SEGMENT_OFF = 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

export default function LevelChooser({ levels, value, onChange, label, sentence }: LevelChooserProps) {
    const small = useMediaQuery('(max-width: 479px)') as boolean;
    if (levels.length === 0) return null;
    if (levels.length === 1) {
        const only = levels[0];
        return (
            <div data-testid="level-chooser-sentence">
                <div className="text-sm font-semibold text-[var(--text-primary)]">{sentence(only.label)}</div>
                {only.countLabel && <div className="text-[11px] text-[var(--text-tertiary)]">{only.countLabel}</div>}
            </div>
        );
    }
    if (small) {
        return (
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                <span>{label}</span>
                <select
                    aria-label={label}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-primary)]"
                >
                    {levels.map(l => (
                        <option key={l.path} value={l.path}>{l.countLabel ? `${l.label} (${l.countLabel})` : l.label}</option>
                    ))}
                </select>
            </label>
        );
    }
    return (
        <div className="flex flex-wrap items-center gap-2" data-testid="level-chooser-segmented">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{label}</span>
            <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-lg bg-[var(--bg-tertiary)] p-0.5">
                {levels.map(l => {
                    const on = l.path === value;
                    return (
                        <button
                            key={l.path}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => { if (!on) onChange(l.path); }}
                            className={`${SEGMENT} ${on ? SEGMENT_ON : SEGMENT_OFF}`}
                        >
                            <span className="block">{l.label}</span>
                            {l.countLabel && <span className="block text-[10px] font-normal text-[var(--text-tertiary)]">{l.countLabel}</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
