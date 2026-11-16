/**
 * The translation progress bar of a Languages editor: the accent while work is
 * left, the theme's success colour once everything is translated. The width is
 * the one value that is only known at runtime, so it is the only inline style.
 */
export default function ProgressFill({ percent }: { percent: number }) {
    const clamped = Math.max(0, Math.min(100, percent));
    return (
        <div className="flex-1 h-2 rounded-full overflow-hidden bg-[var(--bg-tertiary)]">
            <div
                className={`h-full rounded-full transition-all ${clamped >= 100 ? 'bg-[var(--success)]' : 'bg-[var(--accent-primary)]'}`}
                style={{ width: `${clamped}%` }}
            />
        </div>
    );
}
