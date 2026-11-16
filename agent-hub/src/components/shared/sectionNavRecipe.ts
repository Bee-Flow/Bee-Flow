// The row recipe of SectionNav, which takes the admin rail's
// (components/admin/dashboard/AdminRail): the current row lifted as a raised
// card (--bg-card + shadow), the others on the hover tint, 13px labels. A list
// whose rows carry their own actions next to the row button (the locales in
// Languages) cannot be a SectionNav, so it builds its rows from these.

/** The list: one scrolling row below md, a column from md. */
export const SECTION_NAV_LIST = 'flex flex-row gap-0.5 overflow-x-auto p-2 md:flex-col md:overflow-x-visible';
/** The row's surface: corners and the hover/current transition. */
export const SECTION_NAV_ROW_BOX = 'rounded-lg transition-all duration-150';
/** The row's content: spacing and the 13px label. */
export const SECTION_NAV_ROW_LABEL = 'items-center gap-2.5 whitespace-nowrap px-2.5 py-2 text-left text-[13px] leading-tight text-[var(--text-primary)]';
export const SECTION_NAV_ROW_ACTIVE = 'bg-[var(--bg-card)] font-semibold shadow-sm';
export const SECTION_NAV_ROW_IDLE = 'font-medium hover:bg-[var(--item-hover-bg)]';
