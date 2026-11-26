/**
 * The frame of one page of Cowork (a task, Cowork preferences, Teamwork, Templates, Admin rules): the "Tasks" link back
 * to the home, then what the page shows (./coworkSheetPanels.ts). It is a part of the Cowork column, not a layer over
 * it, and it arrives with the one ENTER of ./coworkMotion.ts.
 *
 * When it opens, the focus moves to the page's heading, so a screen reader says where the reader is and Tab goes on
 * from the top. A page that is still loading has no heading yet: the frame takes the focus under the page's name and
 * hands it on to the heading once that is there, unless the reader moved on first.
 */
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { ENTER } from './coworkMotion';
import { LINK_BUTTON } from './coworkUi';
import { useTranslation } from '@/hooks/useTranslation';

interface CoworkPageFrameProps {
    /** The page's name for a screen reader, while it has no heading of its own yet. */
    label: string;
    /** Back to the home. */
    onBack: () => void;
    ownBack?: boolean;
    children: ReactNode;
}

/** Moves the focus to the first heading inside `frame`; false while there is none. */
function focusHeading(frame: HTMLElement): boolean {
    const heading = frame.querySelector<HTMLElement>('h1, h2');
    if (!heading) return false;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    return true;
}

export function TaskBack({ onBack }: { onBack: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" className={`${LINK_BUTTON} self-start`} onClick={onBack} data-testid="cowork-page-back">
            <ArrowLeft aria-hidden="true" size={16} />
            {t('cowork_pages.back', 'Tasks')}
        </button>
    );
}

export default function CoworkPageFrame({ label, onBack, children, ownBack }: CoworkPageFrameProps) {
    const frame = useRef<HTMLElement>(null);
    useEffect(() => {
        const el = frame.current;
        if (!el || focusHeading(el)) return undefined;
        el.focus({ preventScroll: true });
        const watch = new MutationObserver(() => {
            if (document.activeElement !== el || focusHeading(el)) watch.disconnect();
        });
        watch.observe(el, { childList: true, subtree: true });
        return () => watch.disconnect();
    }, []);
    return (
        <section ref={frame} tabIndex={-1} aria-label={label} className={`${ENTER} flex flex-col gap-4 outline-none`} data-testid="cowork-page-frame">
            {!ownBack && <TaskBack onBack={onBack} />}
            {children}
        </section>
    );
}
