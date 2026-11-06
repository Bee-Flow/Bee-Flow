export interface Segment {
    value: number;
    /** Any CSS colour, normally a theme variable or `areaMeta(...).color`. */
    color: string;
    label: string;
}

export interface SegmentBarProps {
    segments: Segment[];
    /** Bar height in px; 8 by default. */
    height?: number;
}

/**
 * Data-driven widths and colours cannot be static classes, so they are set on
 * the element through its ref (no `style={{}}` object).
 */
function paint(el: HTMLElement | null, props: Record<string, string>) {
    if (!el) return;
    for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value);
}

export function SegmentBar({ segments, height = 8 }: SegmentBarProps) {
    const shown = segments.filter(s => s.value > 0);
    const total = shown.reduce((sum, s) => sum + s.value, 0);
    const ariaLabel = segments.map(s => `${s.label} ${s.value}`).join(', ');
    return (
        <div
            role="img"
            aria-label={ariaLabel}
            ref={el => paint(el, { height: `${height}px` })}
            className="flex w-full gap-[2px] overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
        >
            {shown.map(s => (
                <span
                    key={s.label}
                    ref={el => paint(el, { 'flex-grow': String(s.value / total), 'background-color': s.color })}
                    className="block h-full min-w-[3px]"
                />
            ))}
        </div>
    );
}
