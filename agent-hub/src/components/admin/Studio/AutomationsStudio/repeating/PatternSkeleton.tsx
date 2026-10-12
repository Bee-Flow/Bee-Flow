import { familyClasses } from '../../../../automation/Builder/flow/canvasClasses';

/**
 * The pattern list's layout: one column, two side by side once the tab is
 * 56rem wide (its own `@container/repeating`, never the viewport), and a lone
 * last card spanning both. Separate cards with a gap rather than the old
 * hairline list, because each card carries its own border and family bar.
 * Shared with the skeleton so nothing jumps when cards land.
 */
export const PATTERN_GRID = 'grid grid-cols-1 gap-3 @[56rem]/repeating:grid-cols-2 @[56rem]/repeating:[&>*:last-child:nth-child(odd)]:col-span-2';

const BLOCK = 'rounded bg-[var(--bg-tertiary)]';

/**
 * Placeholder pattern cards while a first scan runs: the trigger bar, the
 * kicker, a title, a line of why, a row of pills and a row of mini nodes,
 * so the list does not jump when the real cards arrive.
 */
export default function PatternSkeleton({ count = 2 }: { count?: number }) {
    return (
        <div className={PATTERN_GRID} aria-hidden="true" data-testid="pattern-skeleton">
            {Array.from({ length: Math.max(1, count) }, (_, i) => (
                <div key={i} className={`flex flex-col gap-2.5 pl-[18px] pr-4 py-3.5 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-md)] animate-pulse motion-reduce:animate-none ${familyClasses('trigger').bar}`}>
                    <div className={`h-2.5 w-1/3 ${BLOCK}`} />
                    <div className={`h-4 w-3/5 ${BLOCK}`} />
                    <div className={`h-3 w-4/5 ${BLOCK}`} />
                    <div className="flex gap-1.5">
                        <div className={`h-4 w-20 ${BLOCK}`} />
                        <div className={`h-4 w-16 ${BLOCK}`} />
                        <div className={`h-4 w-24 ${BLOCK}`} />
                    </div>
                    <div className="flex gap-3">
                        <div className={`h-12 flex-1 ${BLOCK}`} />
                        <div className={`h-12 flex-1 ${BLOCK}`} />
                    </div>
                </div>
            ))}
        </div>
    );
}
