// A link from one admin dashboard page to another rail row
// (/app/admin/<path>). The app has no router: like OrgInfoPanel's jump to the
// invitations, it pushes the address and fires a popstate so the shell opens
// the row. The query string is kept, so a platform admin stays on the
// organisation chosen in the scope bar (?org=).

import type { MouseEvent, ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

/** The address of a rail row, with the current query string (the chosen organisation). */
function adminRowHref(path: string): string {
    const search = typeof window === 'undefined' ? '' : window.location.search;
    return `/app/admin/${path}${search}`;
}

function openAdminRow(event: MouseEvent<HTMLAnchorElement>, href: string) {
    // A modified click (new tab, new window) is the browser's.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    try {
        if (window.location.pathname + window.location.search !== href) window.history.pushState({}, '', href);
        window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
        window.location.href = href;
    }
}

interface AdminRowLinkProps {
    /** The rail row's path under /app/admin/ (`access`, `organisation/azure`). */
    path: string;
    children: ReactNode;
}

export default function AdminRowLink({ path, children }: AdminRowLinkProps) {
    const href = adminRowHref(path);
    return (
        <a
            href={href}
            onClick={(e) => openAdminRow(e, href)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--text-primary)] underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] rounded-sm"
        >
            {children}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </a>
    );
}
