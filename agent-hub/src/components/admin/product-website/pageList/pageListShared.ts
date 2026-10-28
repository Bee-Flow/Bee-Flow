import { slugIssues as slugIssuesJs } from '@/utils/cmsPublicRouting';
import ModalShellJs from '../dialogs/ModalShell';

/** One entry of the site's page index, as the page list shows it. */
export interface PageListPage {
    id: string;
    title?: string;
    slug?: string;
    isHomepage?: boolean;
    [key: string]: unknown;
}

/** A saved page template, summary shape. */
export interface PageTemplate {
    id: string;
    name?: string;
    description?: string;
    blockCount?: number;
    createdAt?: string | null;
    /** Ships with the product: can be applied, can not be deleted. */
    builtin?: boolean;
}

export interface NewPageInput {
    title: string;
    slug: string;
    templateId?: string;
}

/** The routing lint's verdict on a slug: blocking issues refuse the save, the rest only warn. */
interface SlugIssue {
    kind: 'reserved' | 'duplicate' | 'unroutable';
    blocking: boolean;
    message: string;
}

// cmsPublicRouting and ModalShell are TypeScript now; the aliases keep the compiled text.
export const slugIssues = slugIssuesJs;

export const ModalShell = ModalShellJs;

/**
 * Slug-shaped sanitising while typing: lowercase, spaces → hyphens, anything
 * outside [a-z0-9_-] dropped. Server-side `cmsStore.updatePageMeta` also
 * re-normalises and resolves slug collisions, so this is purely typing UX.
 */
export function normalizeSlugForInput(raw: string | null | undefined): string {
    return String(raw || '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '');
}

export function formatTemplateDate(iso: string): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return ''; }
}
