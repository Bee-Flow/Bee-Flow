import { useTranslation } from '@/hooks/useTranslation';

/**
 * LookSectionNav — the table of contents of the Look editor. Highlights the
 * section currently in view (set by the parent via IntersectionObserver) and
 * scrolls to a section when clicked.
 *
 * Vertical, it is a run of sub-rows under "Look" in the Appearance sidebar (the
 * rows of SectionNav, indented); below 1100px the editor renders it
 * horizontally above its content.
 */
interface Props {
    sections: { id: string; label: string }[];
    activeId: string;
    onJump: (id: string) => void;
    orientation?: 'vertical' | 'horizontal';
}

const ROW_ACTIVE = 'bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]';
const ROW_IDLE = 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]';

export default function LookSectionNav({ sections, activeId, onJump, orientation = 'vertical' }: Props) {
    const { t } = useTranslation();
    const isVertical = orientation === 'vertical';
    return (
        <nav
            aria-label={t('appearance.look_section_nav_look_editor_sections', 'Look editor sections')}
            className={isVertical ? 'shrink-0' : 'w-full shrink-0 overflow-x-auto border-b border-[var(--border-default)] px-4 py-2'}
        >
            <ul className={`m-0 list-none p-0 ${isVertical ? 'flex flex-col gap-0.5' : 'flex items-center gap-1 whitespace-nowrap'}`}>
                {sections.map((s) => {
                    const active = activeId === s.id;
                    return (
                        <li key={s.id}>
                            <button
                                type="button"
                                onClick={() => onJump(s.id)}
                                aria-current={active ? 'true' : undefined}
                                className={`block w-full rounded-md text-left transition-colors ${isVertical ? 'py-1.5 pl-9 pr-3 text-[13px]' : 'px-2.5 py-1 text-xs'} ${active ? ROW_ACTIVE : ROW_IDLE}`}
                            >
                                {s.label}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
