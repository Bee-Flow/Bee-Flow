import useTranslation from '../../../../../hooks/useTranslation';
import { suiteTabCount } from './ribbonCategories';
import type { CategoryDef, RibbonCategoryId } from './ribbonCategories';
import type { RibbonAnchor } from './ribbonAnchor';

/**
 * Where the row folds, by how many suite tabs (Nextcloud apps, Google
 * Workspace, Microsoft 365) it carries: each one is about 140px of tab. With
 * one suite tab the full row needs about 1150px, so below 1180px of ribbon
 * width the inactive tabs keep only their icon, and below 1440px the "Adds
 * after" pill keeps only "step n"; every further suite tab moves both
 * thresholds 150px up. Literal class strings, because Tailwind only generates
 * what it can read in the source.
 */
export interface RibbonFold {
    tabPad: string;
    tabText: string;
    anchorFull: string;
    anchorShort: string;
    anchorWidth: string;
}

const FOLDS: readonly RibbonFold[] = [
    {
        tabPad: '@max-[1180px]/ribbon:px-2',
        tabText: '@max-[1180px]/ribbon:hidden',
        anchorFull: '@max-[1440px]/ribbon:hidden',
        anchorShort: '@max-[1440px]/ribbon:inline',
        anchorWidth: '@max-[1440px]/ribbon:max-w-[140px]',
    },
    {
        tabPad: '@max-[1330px]/ribbon:px-2',
        tabText: '@max-[1330px]/ribbon:hidden',
        anchorFull: '@max-[1590px]/ribbon:hidden',
        anchorShort: '@max-[1590px]/ribbon:inline',
        anchorWidth: '@max-[1590px]/ribbon:max-w-[140px]',
    },
    {
        tabPad: '@max-[1480px]/ribbon:px-2',
        tabText: '@max-[1480px]/ribbon:hidden',
        anchorFull: '@max-[1740px]/ribbon:hidden',
        anchorShort: '@max-[1740px]/ribbon:inline',
        anchorWidth: '@max-[1740px]/ribbon:max-w-[140px]',
    },
];

/** The fold thresholds for a row with these tabs. */
export function ribbonFold(categories: CategoryDef[]): RibbonFold {
    const extra = Math.max(suiteTabCount(categories) - 1, 0);
    return FOLDS[Math.min(extra, FOLDS.length - 1)];
}

/**
 * The category tabs of the ribbon row (design 5a). Clicking a tab opens that
 * one category under the row. The active tab is filled with the primary
 * accent; the others wear their family colour. When the ribbon is too narrow
 * for every name (`ribbonFold` above) the inactive tabs keep only their icon
 * (the name stays their accessible name and tooltip), so the row never wraps.
 */
export default function CategoryTabs({ categories, active, expanded, onSelect }: {
    categories: CategoryDef[];
    active: RibbonCategoryId;
    expanded: boolean;
    onSelect: (id: RibbonCategoryId) => void;
}) {
    const { t } = useTranslation();
    const fold = ribbonFold(categories);
    return (
        // A real box: the build film measures it as the fallback origin for a
        // step whose own command is not on screen.
        <div
            role="tablist"
            aria-label={t('automations.ribbon.categories', 'Step categories')}
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
                                : `${tone} font-medium hover:bg-[var(--bg-tertiary)] ${fold.tabPad}`
                        }`}
                    >
                        <Icon size={13} />
                        <span className={on ? '' : fold.tabText}>{label}</span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * "Adds after [step n · label]": where a click lands. When the ribbon is too
 * narrow (`ribbonFold`: below 1440px with one suite tab) the pill keeps only
 * "step n" (the whole sentence stays the tooltip): beside the suite tabs the
 * row has no room for the step's name, and a clipped tab or a crammed row is
 * worse than a shorter pill. Below 820px the whole pill goes.
 */
export function AddsAfterPill({ anchor, fold = FOLDS[0] }: { anchor: RibbonAnchor; fold?: RibbonFold }) {
    const { t } = useTranslation();
    const caption = t('automations.ribbon.adds_after', 'Adds after');
    const full = anchor.number != null
        ? t('automations.ribbon.anchor_pill', 'step {n} · {label}', { n: anchor.number, label: anchor.label })
        : anchor.label;
    return (
        <span className="flex items-center gap-1.5 min-w-0 @max-[820px]/ribbon:hidden" data-testid="ribbon-adds-after" title={`${caption} ${full}`}>
            <span className="shrink-0">{caption}</span>
            <span className={`px-2 py-px rounded-full bg-[var(--bg-secondary)] text-[var(--text-primary)] font-medium truncate max-w-[220px] ${fold.anchorWidth}`}>
                {anchor.number != null ? (
                    <>
                        <span className={fold.anchorFull}>{full}</span>
                        <span className={`hidden ${fold.anchorShort}`}>{t('automations.canvas.row_step', 'step {n}', { n: anchor.number })}</span>
                    </>
                ) : full}
            </span>
        </span>
    );
}
