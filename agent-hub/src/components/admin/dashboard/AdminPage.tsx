// The one frame of an admin dashboard page: the page header (the rail row's
// label, and the row's description when it has one) and the width, left-aligned,
// for every row of the rail, in one place. A panel inside draws no h2 and no
// max-width of its own; its sub-sections keep their h3 headings.
//   settings  a settings form: max-w-4xl, the width a line of settings reads at;
//   wide      a list, a grid or a table: the whole pane;
//   fill      a tool that owns its scrolling (a list beside a detail, an editor
//             with its own columns, a report with a drawer): the header on top
//             and the panel filling the rest of the pane at its full width.
// On a fill page the frame pads its header; the panel either pads itself
// (p-6 md:p-8, its own scrolling list), or (`inset`) the frame insets it by the
// header's padding, so a list beside a detail starts where the header starts and
// a save bar ends 32px from the edge like every other page. On the other widths
// the frame pads the page. Rendered by AdminTabContent for every tab, and by the
// Organisation tab's OrganisationHub / OrgSectionBody for its sections.

import type { ComponentType, ReactNode } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';

export type AdminPageWidth = 'settings' | 'wide' | 'fill';

interface AdminPageProps {
    /** The page's name, as the rail row says it; left out, no header (a host outside the dashboard). */
    title?: ReactNode;
    description?: ReactNode;
    icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
    width?: AdminPageWidth;
    /** A fill page whose panel draws no padding of its own: the frame insets it like the header. */
    inset?: boolean;
    children: ReactNode;
    testId?: string;
}

const WIDTH: Readonly<Record<Exclude<AdminPageWidth, 'fill'>, string>> = {
    settings: 'max-w-4xl',
    wide: 'w-full',
};

/** The header's own padding on a fill page, whose panel pads itself. */
const HEADER_INSET = 'px-6 pt-6 md:px-8 md:pt-8';
/** The panel's box on an inset fill page: the header's sides, the gap a padded page has under it, and the page's bottom. */
const PANEL_INSET = 'inset-x-6 top-6 bottom-6 md:inset-x-8 md:bottom-8';

function Header({ title, description, icon }: Pick<AdminPageProps, 'title' | 'description' | 'icon'>) {
    return <SectionHeader title={title} description={description} icon={icon} />;
}

export default function AdminPage({ title, description, icon, width = 'settings', inset = false, children, testId }: AdminPageProps) {
    const header = title != null ? <Header title={title} description={description} icon={icon} /> : null;
    if (width === 'fill') {
        return (
            <div className="flex h-full min-h-0 flex-col" data-testid={testId} data-admin-page-width={width} data-admin-page-inset={inset ? 'true' : undefined}>
                {header && <div className={`shrink-0 ${HEADER_INSET}`} data-testid="admin-page-header">{header}</div>}
                <div className="relative min-h-0 flex-1">
                    <div className={`absolute ${inset ? PANEL_INSET : 'inset-0'}`}>{children}</div>
                </div>
            </div>
        );
    }
    // The page is at least the pane's height and the content takes what the
    // header leaves: a notice that fills its place (absolute inset-0, such as a
    // refused row) fills the area under the header, never the header itself.
    return (
        <div className="flex min-h-full flex-col p-6 md:p-8" data-testid={testId} data-admin-page-width={width}>
            <div className={`flex flex-1 flex-col gap-6 ${WIDTH[width]}`}>
                {header && <div data-testid="admin-page-header">{header}</div>}
                <div className="relative min-w-0 flex-1" data-testid="admin-page-content">{children}</div>
            </div>
        </div>
    );
}
