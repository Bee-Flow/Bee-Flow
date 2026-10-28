import { createContext, useContext, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { FieldRow, inputClass } from './basicFields';
import { useTranslation } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';

/** A link value object, by kind. */
export interface CmsLink {
    kind?: 'page' | 'external' | 'anchor' | 'app';
    pageId?: string;
    anchor?: string;
    url?: string;
    newTab?: boolean;
    path?: string;
}

/** One entry of the public page list the internal-page dropdown offers. */
export interface CmsPageOption {
    id: string;
    slug?: string;
    title?: string;
    isHomepage?: boolean;
}

export type CreatePageFn = (input: { title: string; slug?: string }) => Promise<{ id: string; slug?: string; title?: string } | null | undefined>;

/**
 * Optional context for "+ Create new page…" inside any LinkField. The
 * provider value is `async ({title, slug}) => ({id, slug, title})` and is
 * supplied once at the top of the editor by ProductWebsitePanel. When a
 * LinkField finds a value here it appends a sentinel option to the
 * internal-page selector that lets the user spin up a page without
 * leaving whatever they're editing. We use Context (rather than threading
 * the callback through every editor's props) so the existing 12+ editor
 * components don't all need new prop signatures.
 */
export const CreatePageContext = createContext<CreatePageFn | null>(null);

const NEW_PAGE_SENTINEL = '__cms_new_page__';

const deriveSlug = (text: string) =>
    String(text || '').toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 64);

interface PageSelectorProps {
    link: CmsLink;
    set: (patch: Partial<CmsLink>) => void;
    pages: CmsPageOption[];
    brokenPage: boolean;
    linkedPage: CmsPageOption | null | undefined;
}

/**
 * The inline "+ Create new page…" flow: its form state, submit and cancel.
 * Cancel restores the pageId the link pointed at before the sentinel was picked.
 */
function useNewPageForm(link: CmsLink, set: PageSelectorProps['set']) {
    const { t } = useTranslation();
    const onCreatePage = useContext(CreatePageContext);
    // Captured when the sentinel is picked, not on render: the pageId we'd
    // capture in render gets stomped when the user picks the sentinel.
    const previousPageIdRef = useRef(link.pageId || '');
    const [creating, setCreating] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [newTitle, setNewTitle] = useState('');
    const [newSlug, setNewSlug] = useState('');
    const slugAuto = useRef(true);

    const start = () => {
        previousPageIdRef.current = link.pageId || '';
        slugAuto.current = true;
        setNewTitle('');
        setNewSlug('');
        setCreateError(null);
        setCreating(true);
    };

    const submitNew = async () => {
        if (!onCreatePage || submitting) return;
        const title = newTitle.trim();
        if (!title) return;
        setSubmitting(true);
        setCreateError(null);
        try {
            const result = await onCreatePage({ title, slug: newSlug.trim() || undefined });
            if (!result?.id) throw new Error(t('cms_site.site.fields.create_no_id', 'Page creation returned no id'));
            // Point the link at the freshly-created page. It appears in the
            // `pages` prop on the next render (the parent reloaded its payload
            // in handleAddPage), so the dropdown shows it as selected.
            set({ pageId: result.id });
            setCreating(false);
        } catch (err) {
            setCreateError(messageOf(err, t('cms_site.site.fields.create_failed', 'Failed to create page')));
        } finally {
            setSubmitting(false);
        }
    };

    const cancelNew = () => {
        setCreating(false);
        setCreateError(null);
        // Restore the prior pageId so the select doesn't stay on the sentinel.
        if (previousPageIdRef.current && previousPageIdRef.current !== link.pageId) {
            set({ pageId: previousPageIdRef.current });
        }
    };

    const onTitle = (value: string) => {
        setNewTitle(value);
        if (slugAuto.current) setNewSlug(deriveSlug(value));
    };
    const onSlug = (value: string) => {
        slugAuto.current = false;
        setNewSlug(value.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
    };

    return { onCreatePage, creating, submitting, createError, newTitle, newSlug, start, submitNew, cancelNew, onTitle, onSlug };
}

type NewPageForm = ReturnType<typeof useNewPageForm>;

function NewPageFormFields({ form }: { form: NewPageForm }) {
    const { t } = useTranslation();
    const { submitting, createError, newTitle, newSlug, submitNew, cancelNew, onTitle, onSlug } = form;
    return (
        <div className="rounded-md border border-dashed border-[var(--accent-primary)]/40 bg-[var(--bg-tertiary)] p-2 flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {t('cms_site.site.fields.new_title', 'New page title')}
            </label>
            <input
                autoFocus
                type="text"
                className={inputClass}
                placeholder={t('cms_site.site.fields.new_title_placeholder', 'e.g. Pricing')}
                value={newTitle}
                onChange={e => onTitle(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); submitNew(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelNew(); }
                }}
            />
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {t('cms_site.site.fields.slug', 'Slug')}
            </label>
            <input
                type="text"
                className={`${inputClass} font-mono`}
                placeholder={t('cms_site.site.fields.slug_placeholder', 'auto')}
                value={newSlug}
                onChange={e => onSlug(e.target.value)}
            />
            {createError && (
                <span className="text-xs text-red-400">{createError}</span>
            )}
            <div className="flex gap-1.5 justify-end">
                <button
                    type="button"
                    onClick={cancelNew}
                    disabled={submitting}
                    className="text-xs px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                    {t('cms_site.site.fields.cancel', 'Cancel')}
                </button>
                <button
                    type="button"
                    onClick={submitNew}
                    disabled={submitting || !newTitle.trim()}
                    className="text-xs px-3 py-1 rounded bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {submitting ? t('cms_site.site.fields.creating', 'Creating…') : t('cms_site.site.fields.create_page', 'Create page')}
                </button>
            </div>
        </div>
    );
}

/**
 * Internal-page selector pulled out of LinkField so the inline-create flow
 * (the "+ Create new page…" sentinel + form) can own its local state without
 * cluttering the LinkField body. The selector falls back to plain-select
 * behaviour when no CreatePageContext is available — every other call site
 * (existing block editors, footer/header link rows, etc.) just keeps working.
 */
function PageSelector({ link, set, pages, brokenPage, linkedPage }: PageSelectorProps) {
    const { t } = useTranslation();
    const form = useNewPageForm(link, set);
    const { onCreatePage, creating } = form;

    const handleSelectChange = (e: ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        if (value === NEW_PAGE_SENTINEL) { form.start(); return; }
        set({ pageId: value });
    };

    return (
        <div className="flex flex-col gap-1.5 mt-1.5">
            <select
                className={`${inputClass} ${brokenPage ? 'border-red-500/50 focus:border-red-500' : ''}`}
                // While the inline form is open, the select shows the sentinel so the
                // picker reflects the in-progress flow instead of the stale selection.
                value={creating ? NEW_PAGE_SENTINEL : (link.pageId || '')}
                onChange={handleSelectChange}
            >
                {pages.length === 0 && !creating && <option value="">{t('cms_site.site.fields.no_pages', '— no pages —')}</option>}
                {/* If pageId is dangling, surface it in the dropdown so
                    the user can see what's set and pick a replacement. */}
                {brokenPage && (
                    <option value={link.pageId}>
                        {t('cms_site.site.fields.missing_page', '⚠ Missing page ({id})', { id: link.pageId })}
                    </option>
                )}
                {pages.map(p => (
                    <option key={p.id} value={p.id}>
                        {p.title || p.slug} (/{p.slug}{p.isHomepage ? t('cms_site.site.fields.home_suffix', ' · home') : ''})
                    </option>
                ))}
                {/* Only inside the Product Website editor (a CreatePageContext
                    provider); other reuses of LinkField stay unaffected. */}
                {onCreatePage && (
                    <option value={NEW_PAGE_SENTINEL}>{t('cms_site.site.fields.create_new_page', '+ Create new page…')}</option>
                )}
            </select>
            {brokenPage && !creating && (
                <span className="text-xs text-red-400">
                    {t('cms_site.site.fields.broken_link', 'This link points to a page that no longer exists. Pick another page above.')}
                </span>
            )}
            {linkedPage && !creating && (
                <span className="text-xs text-[var(--text-muted)]">
                    → {linkedPage.isHomepage ? '/' : `/${linkedPage.slug}`}
                    {link.anchor ? `#${link.anchor}` : ''}
                </span>
            )}
            {creating && <NewPageFormFields form={form} />}
            <input
                type="text"
                className={inputClass}
                placeholder={t('cms_site.site.fields.anchor_placeholder', '#section-anchor (optional)')}
                value={link.anchor || ''}
                onChange={e => set({ anchor: e.target.value.replace(/^#/, '') })}
            />
        </div>
    );
}

function ExternalLinkFields({ link, set }: { link: CmsLink; set: (patch: Partial<CmsLink>) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5 mt-1.5">
            <input
                type="url"
                className={inputClass}
                placeholder={t('cms_site.site.fields.link_url_placeholder', 'https://…')}
                value={link.url || ''}
                onChange={e => set({ url: e.target.value })}
            />
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                <input
                    type="checkbox"
                    checked={!!link.newTab}
                    onChange={e => set({ newTab: e.target.checked })}
                    className="accent-[var(--accent-primary)]"
                />
                {t('cms_site.site.fields.link_new_tab', 'Open in new tab')}
            </label>
        </div>
    );
}

interface LinkFieldProps {
    label?: ReactNode;
    value: CmsLink | null | undefined;
    onChange: (link: CmsLink) => void;
    /** The public page list from the admin payload, for the internal-page dropdown. */
    pages?: CmsPageOption[];
    hint?: ReactNode;
}

/**
 * LinkField — edit a Link value object:
 *   { kind: 'page',     pageId, anchor? }
 *   { kind: 'external', url, newTab? }
 *   { kind: 'anchor',   anchor }
 *   { kind: 'app',      path }
 */
export function LinkField({ label, value, onChange, pages = [], hint }: LinkFieldProps) {
    const { t } = useTranslation();
    const link: CmsLink = value && typeof value === 'object' ? value : { kind: 'external', url: '' };
    const kind = link.kind || 'external';

    const set = (patch: Partial<CmsLink>) => onChange({ ...link, ...patch });

    // Detect a dangling page reference: link kind is 'page' but the pageId no
    // longer exists in the current site (page was deleted or the user switched
    // sites). Surfaced as an inline warning so users notice before publishing.
    const linkedPage = kind === 'page'
        ? pages.find(p => p.id === link.pageId)
        : null;
    const brokenPage = kind === 'page' && pages.length > 0 && !!link.pageId && !linkedPage;

    return (
        <FieldRow label={label} hint={hint}>
            {/* kind selector */}
            <select
                className={inputClass}
                value={kind}
                onChange={e => {
                    const next = e.target.value;
                    if (next === 'page')     onChange({ kind: 'page', pageId: pages[0]?.id || '' });
                    if (next === 'anchor')   onChange({ kind: 'anchor', anchor: '' });
                    if (next === 'external') onChange({ kind: 'external', url: '' });
                    if (next === 'app')      onChange({ kind: 'app', path: '/app' });
                }}
            >
                <option value="page">{t('cms_site.site.fields.link_page', 'Internal page')}</option>
                <option value="anchor">{t('cms_site.site.fields.link_anchor', 'Anchor on this page')}</option>
                <option value="external">{t('cms_site.site.fields.link_external', 'External URL')}</option>
                <option value="app">{t('cms_site.site.fields.link_app', 'App route')}</option>
            </select>

            {/* kind-specific fields */}
            {kind === 'page' && (
                <PageSelector link={link} set={set} pages={pages} brokenPage={brokenPage} linkedPage={linkedPage} />
            )}
            {kind === 'anchor' && (
                <input
                    type="text"
                    className={`${inputClass} mt-1.5`}
                    placeholder={t('cms_site.site.fields.link_anchor_placeholder', 'section-id (without #)')}
                    value={link.anchor || ''}
                    onChange={e => set({ anchor: e.target.value.replace(/^#/, '') })}
                />
            )}
            {kind === 'external' && <ExternalLinkFields link={link} set={set} />}
            {kind === 'app' && (
                <input
                    type="text"
                    className={`${inputClass} mt-1.5`}
                    placeholder="/app"
                    value={link.path || ''}
                    onChange={e => set({ path: e.target.value })}
                />
            )}
        </FieldRow>
    );
}
