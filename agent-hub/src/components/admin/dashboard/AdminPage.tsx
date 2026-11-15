// The one frame of an admin dashboard page: the page header (the rail row's
// label, and the row's description when it has one) and the width, left-aligned,
// for every row of the rail, in one place. A panel inside draws no h2 and no
// max-width of its own; its sub-sections keep their h3 headings.
//   settings  a settings form: max-w-4xl, the width a line of settings reads at;
//   wide      a list, a grid or a table: the whole pane;
//   fill      a tool that owns its scrolling (a list beside a detail, an editor
//             with its own columns, a report with a drawer): the header on top
//             and the panel filling the rest of the pane at its full width.
// A fill panel pads itself (p-6 md:p-8): the frame pads only its header, which
// then lines up with the panel's content; on the other widths the frame pads
// the page. Rendered by AdminTabContent for every tab, and by the Organisation
// tab's OrganisationHub / OrgSectionBody for its sections.

import type { ComponentType, ReactNode } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';

export type AdminPageWidth = 'settings' | 'wide' | 'fill';

interface AdminPageProps {
    /** The page's name, as the rail row says it; left out, no header (a host outside the dashboard). */
    title?: ReactNode;
    description?: ReactNode;
    icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
    width?: AdminPageWidth;
    children: ReactNode;
    testId?: string;
}

const WIDTH: Readonly<Record<Exclude<AdminPageWidth, 'fill'>, string>> = {
    settings: 'max-w-4xl',
    wide: 'w-full',
};

/** The header's own padding on a fill page, whose panel pads itself. */
const HEADER_INSET = 'px-6 pt-6 md:px-8 md:pt-8';

function Header({ title, description, icon }: Pick<AdminPageProps, 'title' | 'description' | 'icon'>) {
    return <SectionHeader title={title} description={description} icon={icon} />;
}

export default function AdminPage({ title, description, icon, width = 'settings', children, testId }: AdminPageProps) {
    const header = title != null ? <Header title={title} description={description} icon={icon} /> : null;
    if (width === 'fill') {
        return (
            <div className="flex h-full min-h-0 flex-col" data-testid={testId} data-admin-page-width={width}>
                {header && <div className={`shrink-0 ${HEADER_INSET}`} data-testid="admin-page-header">{header}</div>}
                <div className="relative min-h-0 flex-1">
                    <div className="absolute inset-0">{children}</div>
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
