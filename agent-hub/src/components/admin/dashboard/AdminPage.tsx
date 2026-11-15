// The one frame of an admin dashboard page: the padding a StudioShell section
// gets (p-6, md:p-8), left-aligned, at one of two widths, with the shared
// SectionHeader on top when the dashboard names the page (from its rail label).
//   settings  a settings form: max-w-4xl, the width a line of settings reads at;
//   wide      a list, a grid or a table: the whole pane.
// Rendered once per page by AdminTabContent (page-framed tabs) and by the
// Organisation tab's OrgSectionBody, so a panel needs no h2 or max-width of its
// own. Panels that still draw their own header get no title here until a later
// wave drops theirs; a page never shows two.

import type { ComponentType, ReactNode } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';

export type AdminPageWidth = 'settings' | 'wide';

interface AdminPageProps {
    /** The page's name, as the rail row says it; left out, the panel draws its own header. */
    title?: ReactNode;
    description?: ReactNode;
    icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
    width?: AdminPageWidth;
    children: ReactNode;
    testId?: string;
}

const WIDTH: Readonly<Record<AdminPageWidth, string>> = {
    settings: 'max-w-4xl',
    wide: 'w-full',
};

export default function AdminPage({ title, description, icon, width = 'settings', children, testId }: AdminPageProps) {
    return (
        <div className="p-6 md:p-8" data-testid={testId} data-admin-page-width={width}>
            <div className={`flex flex-col gap-6 ${WIDTH[width]}`}>
                {title != null && <SectionHeader title={title} description={description} icon={icon} />}
                <div className="min-w-0">{children}</div>
            </div>
        </div>
    );
}
