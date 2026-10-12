import { ChevronRight } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { Crumb } from './levels';

interface CrumbsProps {
    crumbs: Crumb[];
    onCrumb: (target: number) => void;
}

/** Below 760px of view width the trail keeps the first crumb and the last two. */
const KEEP_TAIL = 2;
const NARROW_HIDDEN = '@max-[760px]/wideout:hidden';

/**
 * Where the large view is: "Continues on · Read › Je Fabrikam factuur (row 1)
 * › Attachments". Every crumb but the last is a button; the last is the
 * current place and takes focus after a jump. One line, never wrapping.
 */
export default function Crumbs({ crumbs, onCrumb }: CrumbsProps) {
    const { t } = useTranslation();
    const hidesSome = crumbs.length > KEEP_TAIL + 1;
    return (
        <nav aria-label={t('automations.output.trail', 'Where you are')} className="min-w-0">
            <ol className="flex items-center flex-nowrap gap-1 min-w-0 overflow-hidden text-[13px]">
                {crumbs.map((c, i) => {
                    const middle = i > 0 && i < crumbs.length - KEEP_TAIL;
                    return (
                        // The current crumb keeps its width (up to 200px); the ones before it give way.
                        <li key={c.target} className={`flex items-center gap-1 ${c.current ? 'shrink-0' : 'min-w-0'} ${middle ? NARROW_HIDDEN : ''}`}>
                            {i > 0 && <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />}
                            <CrumbItem crumb={c} onCrumb={onCrumb} />
                            {i === 0 && hidesSome && (
                                <span aria-hidden className="hidden @max-[760px]/wideout:inline-flex items-center gap-1 text-[var(--text-tertiary)]">
                                    <ChevronRight size={12} className="shrink-0" />…
                                </span>
                            )}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

function CrumbItem({ crumb, onCrumb }: { crumb: Crumb; onCrumb: (target: number) => void }) {
    if (crumb.current) {
        return (
            <span aria-current="page" tabIndex={-1} data-crumb-current className="font-semibold truncate max-w-[200px] outline-none" title={crumb.text}>
                {crumb.text}
            </span>
        );
    }
    return (
        <button
            type="button"
            onClick={() => onCrumb(crumb.target)}
            title={crumb.text}
            className="truncate max-w-[200px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline rounded focus-visible:outline-2 focus-visible:outline-[var(--type-ai)]"
        >
            {crumb.text}
        </button>
    );
}
