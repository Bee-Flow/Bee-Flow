/**
 * ComplianceDesktop — the Compliance Center beside the admin dashboard rail
 * (every width from the md breakpoint up; a phone gets ComplianceMobile).
 *
 * The dashboard frame (AdminPage, width `fill`, `inset`: AdminTabContent's
 * FILL_INSET) draws the page header and insets this panel by the header's
 * padding, so the rail lines up under the page title and the header's last
 * button keeps its distance from the window edge. This frame draws no padding
 * of its own, or the inset doubles. Inside sits one bordered surface: the
 * section rail (ComplianceRail) beside the section header and its page.
 *
 * The rail is 300px. Where the frame's own width drops under 48rem (an 800px
 * window, or a small laptop with the dashboard rail open) it would squeeze the
 * page to a column, so it folds away (a container query on `chub`, not the
 * window: the dashboard rail decides how much room is left) and a menu button
 * at the start of the section header opens the same rows as a drawer
 * (MobileRailList, the phone's list).
 */
import { Menu } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import Modal from '@/components/shared/Modal';
import ComplianceRail from './ComplianceRail';
import ComplianceHeader, { type HubHeaderCtx } from './ComplianceHeader';
import MobileRailList from './mobile/MobileRailList';
import type { Section } from './sections';
import type { CheckRecord } from './pages/framework/checkSort';
import type { useFrameworks } from './data/aggregates';

/** The hub's one way to move: a section, an optional item and tab; `replace` rewrites the history entry. */
type NavigateTo = (sectionId: string, subId?: string | null, nextTab?: string | null, opts?: { replace?: boolean }) => void;
type Translate = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

/** Every group of the rail, in the rail's order, for the drawer. */
const DRAWER_GROUPS = ['frameworks', 'registers', 'admin'];

/**
 * Container-query classes (Tailwind reads each literal whole): from 48rem of
 * frame width the rail column shows and the menu button hides; below it the
 * other way round.
 */
export const RAIL_FOLD = Object.freeze({
    rail: 'hidden @min-[48rem]/chub:flex',
    menu: 'flex @min-[48rem]/chub:hidden',
});

export interface ComplianceDesktopProps {
    active: string;
    section: Section;
    currentTab: string | null;
    setTab: (next: string) => void;
    navigate: NavigateTo;
    onBack: (() => void) | null;
    counts: { counts: unknown };
    frameworks: ReturnType<typeof useFrameworks>;
    core: { overview: unknown; checks: CheckRecord[] };
    exportsEnabled: boolean;
    page: React.JSX.Element;
    headerCtx: Partial<HubHeaderCtx>;
}

export default function ComplianceDesktop({ active, section, currentTab, setTab, navigate, onBack, counts, frameworks, core, exportsEnabled, page, headerCtx }: ComplianceDesktopProps) {
    const { t } = useTranslation();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const sectionLabel = t(section.labelKey, section.labelFallback);
    const select = (id: string) => { setDrawerOpen(false); navigate(id); };

    return (
        <div className="@container/chub h-full min-h-0" data-testid="compliance-desktop">
            <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)]">
                <aside className={`${RAIL_FOLD.rail} w-[300px] shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-secondary)]`}
                    aria-label={t('compliance_layout.sections', 'Compliance sections')} data-testid="compliance-rail-column">
                    <ComplianceRail
                        active={active}
                        onSelect={(id: string, sub?: string | null) => navigate(id, sub)}
                        onOpenReports={() => navigate('overview', undefined, 'reports')}
                        counts={counts.counts}
                        frameworks={frameworks}
                        // null while the first read is out: the attention filter
                        // then falls back to the score instead of "no open checks".
                        checks={core.overview ? core.checks : null}
                        exportsEnabled={exportsEnabled}
                    />
                </aside>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 shrink-0">
                        <SectionMenuButton open={drawerOpen} onOpen={() => setDrawerOpen(true)} sectionLabel={sectionLabel} t={t} />
                        <div className="min-w-0 flex-1">
                            <ComplianceHeader section={section} tab={currentTab} onTab={setTab} ctx={headerCtx}
                                onBack={onBack || undefined} backLabel={onBack ? t('compliance.back_to_settings', 'Back to settings') : undefined} />
                        </div>
                    </div>
                    <div className="@container/cpage min-h-0 flex-1 overflow-y-auto">{page}</div>
                </div>
            </div>
            <Modal
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                placement="left"
                variant="bare"
                size="auto"
                className="w-80 max-w-[85vw] overflow-hidden"
                label={t('compliance_layout.sections', 'Compliance sections')}
                data-testid="compliance-section-drawer"
            >
                <div className="h-full overflow-y-auto bg-[var(--bg-secondary)] p-3">
                    <MobileRailList groups={DRAWER_GROUPS} withOverview showHeads counts={counts.counts} frameworks={frameworks}
                        active={active} onSelect={select} testId="compliance-section-drawer-list" />
                </div>
            </Modal>
        </div>
    );
}

interface SectionMenuButtonProps {
    open: boolean;
    onOpen: () => void;
    sectionLabel: string;
    t: Translate;
}

/** Below 48rem of frame width: the button that opens the section rail as a drawer, in the header's 48px strip. */
function SectionMenuButton({ open, onOpen, sectionLabel, t }: SectionMenuButtonProps) {
    return (
        <div className={`${RAIL_FOLD.menu} h-12 shrink-0 items-center border-b border-[var(--border-default)] bg-[var(--bg-secondary)] pl-1.5`}>
            <button
                type="button"
                onClick={onOpen}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={t('compliance_layout.sections_current', 'Compliance sections: {section}', { section: sectionLabel })}
                title={t('compliance_layout.sections', 'Compliance sections')}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                data-testid="compliance-section-menu"
            >
                <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
        </div>
    );
}
