import useTranslation from '../../../../../hooks/useTranslation';
import type { CategoryDef, RibbonCategoryId } from './ribbonCategories';
import type { RibbonAnchor } from './ribbonAnchor';

/**
 * The category tabs of the ribbon row (design 5a). Clicking a tab opens that
 * one category under the row. The active tab is filled with the primary
 * accent; the others wear their family colour. Below 1180px of ribbon width
 * the inactive tabs keep only their icon (the name stays their accessible
 * name and tooltip), so the row never wraps: with the Nextcloud tab the full
 * row needs about 1150px.
 */
export default function CategoryTabs({ categories, active, expanded, onSelect }: {
    categories: CategoryDef[];
    active: RibbonCategoryId;
    expanded: boolean;
    onSelect: (id: RibbonCategoryId) => void;
}) {
    const { t } = useTranslation();
    return (
        // A real box: the build film measures it as the fallback origin for a
        // step whose own command is not on screen.
        <div
            role="tablist"
            aria-label={t('routines.ribbon.categories', 'Step categories')}
            className="flex items-center gap-1 min-w-0 overflow-x-clip"
            data-ribbon-origin="tabs"
        >
            {categories.map(({ id, labelKey, fallback, Icon, tone, origin }) => {
                const label = t(labelKey, fallback);
                const on = id === active;
                return (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        aria-expanded={on ? expanded : undefined}
                        aria-label={label}
                        title={label}
                        onClick={() => onSelect(id)}
                        data-ribbon-origin={origin || undefined}
                        className={`shrink-0 inline-flex items-center gap-1.5 h-[30px] px-3 rounded-lg text-[12px] whitespace-nowrap transition ${
                            on
                                ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-semibold'
                                : `${tone} font-medium hover:bg-[var(--bg-tertiary)] @max-[1180px]/ribbon:px-2`
                        }`}
                    >
                        <Icon size={13} />
                        <span className={on ? '' : '@max-[1180px]/ribbon:hidden'}>{label}</span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * "Adds after [step n · label]": where a click lands. Below 1440px of ribbon
 * width the pill keeps only "step n" (the whole sentence stays the tooltip):
 * with the Nextcloud tab the row has no room for the step's name, and a
 * clipped tab or a crammed row is worse than a shorter pill. Below 820px the
 * whole pill goes.
 */
export function AddsAfterPill({ anchor }: { anchor: RibbonAnchor }) {
    const { t } = useTranslation();
    const caption = t('routines.ribbon.adds_after', 'Adds after');
    const full = anchor.number != null
        ? t('routines.ribbon.anchor_pill', 'step {n} · {label}', { n: anchor.number, label: anchor.label })
        : anchor.label;
    return (
        <span className="flex items-center gap-1.5 min-w-0 @max-[820px]/ribbon:hidden" data-testid="ribbon-adds-after" title={`${caption} ${full}`}>
            <span className="shrink-0">{caption}</span>
            <span className="px-2 py-px rounded-full bg-[var(--bg-secondary)] text-[var(--text-primary)] font-medium truncate max-w-[220px] @max-[1440px]/ribbon:max-w-[140px]">
                {anchor.number != null ? (
                    <>
                        <span className="@max-[1440px]/ribbon:hidden">{full}</span>
                        <span className="hidden @max-[1440px]/ribbon:inline">{t('routines.canvas.row_step', 'step {n}', { n: anchor.number })}</span>
                    </>
                ) : full}
            </span>
        </span>
    );
}
