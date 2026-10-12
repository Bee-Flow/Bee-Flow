import { useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { AppIcon } from './jsComponents';
import { visibility, type AdminPostSummary } from './blogApi';

/**
 * Navigator column for the Blog entry: blog settings, a "New post" action,
 * search + status filter and the post list. Selecting a row opens the post in
 * the inspector and the canvas; "Blog settings" (null) edits the index.
 */

type Filter = 'all' | 'draft' | 'scheduled' | 'live';

interface Props {
    posts: AdminPostSummary[];
    loaded: boolean;
    activePostId: string | null;
    onSelect: (postId: string | null) => void;
    onCreate: () => void;
    onDelete: (post: AdminPostSummary) => void;
    locale: string;
}

const PILL_CLASS: Record<string, string> = {
    draft: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
    scheduled: 'bg-amber-500/15 text-amber-500',
    live: 'bg-emerald-500/15 text-emerald-500',
};

function shortDate(iso: string | null, locale: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(d); } catch { return d.toISOString().slice(0, 10); }
}

function StatusFilter({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
    const { t } = useTranslation();
    const filters: { id: Filter; label: string }[] = [
        { id: 'all', label: t('cms_blog.list.filter_all', 'All') },
        { id: 'draft', label: t('cms_blog.status.draft', 'Draft') },
        { id: 'scheduled', label: t('cms_blog.status.scheduled', 'Scheduled') },
        { id: 'live', label: t('cms_blog.status.live', 'Published') },
    ];
    return (
        <div className="flex flex-wrap gap-1 mt-2" role="group" aria-label={t('cms_blog.list.filter', 'Filter by status')}>
            {filters.map(f => (
                <button
                    key={f.id}
                    type="button"
                    aria-pressed={value === f.id}
                    onClick={() => onChange(f.id)}
                    className={`px-2 py-0.5 rounded-full text-[11px] border ${value === f.id
                        ? 'border-[var(--accent-primary)] text-[var(--text-primary)]'
                        : 'border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                >
                    {f.label}
                </button>
            ))}
        </div>
    );
}

function PostRow({ post: p, active, onSelect, onDelete, locale }: {
    post: AdminPostSummary; active: boolean; onSelect: (id: string) => void; onDelete: (p: AdminPostSummary) => void; locale: string;
}) {
    const { t } = useTranslation();
    const v = visibility(p);
    const pill = v === 'draft' ? t('cms_blog.status.draft', 'Draft')
        : v === 'scheduled' ? t('cms_blog.status.scheduled', 'Scheduled') : t('cms_blog.status.live', 'Published');
    const date = shortDate(p.publishedAt || p.updatedAt, locale);
    return (
        <li className="group relative">
            <button
                type="button"
                onClick={() => onSelect(p.id)}
                aria-current={active ? 'true' : undefined}
                className={`w-full text-left px-2 py-1.5 pr-7 rounded ${active ? 'bg-[var(--accent-primary)]/10' : 'hover:bg-[var(--bg-tertiary)]'}`}
            >
                <span className="block text-sm text-[var(--text-primary)] truncate">
                    {p.title || t('cms_blog.list.untitled', 'Untitled post')}
                </span>
                <span className="flex items-center gap-1.5 mt-0.5 text-[10px] text-[var(--text-muted)]">
                    <span className={`px-1.5 rounded-full ${PILL_CLASS[v]}`}>{pill}</span>
                    {date ? <span>{date}</span> : null}
                    {p.translatedLocales.length ? <span className="uppercase">{p.translatedLocales.join(' ')}</span> : null}
                </span>
            </button>
            <button
                type="button"
                onClick={() => onDelete(p)}
                title={t('cms_blog.list.delete', 'Delete post')}
                aria-label={t('cms_blog.list.delete_named', 'Delete “{title}”', { title: p.title })}
                className="absolute right-1 top-1.5 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--text-muted)] hover:text-red-400"
            >
                <AppIcon name="Trash2" className="w-3.5 h-3.5" />
            </button>
        </li>
    );
}

export default function BlogPostList({ posts, loaded, activePostId, onSelect, onCreate, onDelete, locale }: Props) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return posts.filter((p) => {
            if (filter !== 'all' && visibility(p) !== filter) return false;
            return !q || `${p.title} ${p.slug} ${p.tags.map(tg => tg.label).join(' ')}`.toLowerCase().includes(q);
        });
    }, [posts, query, filter]);

    return (
        <div className="h-full flex flex-col min-h-0">
            <div className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {t('cms_blog.list.title', 'Posts')}
                </span>
                <button
                    type="button"
                    onClick={onCreate}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary)]/90"
                >
                    <AppIcon name="Plus" className="w-3.5 h-3.5" />
                    {t('cms_blog.list.new', 'New post')}
                </button>
            </div>

            <button
                type="button"
                onClick={() => onSelect(null)}
                className={`mx-2 mt-1 flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left ${activePostId === null
                    ? 'bg-[var(--accent-primary)]/10 text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'}`}
            >
                <AppIcon name="Newspaper" className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{t('cms_blog.list.settings', 'Blog page & settings')}</span>
            </button>

            <div className="px-2 pt-2 shrink-0">
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('cms_blog.list.search', 'Search posts…')}
                    aria-label={t('cms_blog.list.search', 'Search posts…')}
                    className="w-full px-2 py-1 rounded text-xs border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                />
                <StatusFilter value={filter} onChange={setFilter} />
            </div>

            <ul className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-0.5" aria-label={t('cms_blog.list.title', 'Posts')}>
                {!loaded ? (
                    <li className="px-2 py-4 text-xs text-[var(--text-muted)]">{t('cms_blog.list.loading', 'Loading posts…')}</li>
                ) : visible.length === 0 ? (
                    <li className="px-2 py-4 text-xs text-[var(--text-muted)]">
                        {posts.length === 0
                            ? t('cms_blog.list.empty', 'No posts yet. Write your first one with “New post”.')
                            : t('cms_blog.list.no_match', 'No posts match.')}
                    </li>
                ) : visible.map(p => (
                    <PostRow key={p.id} post={p} active={p.id === activePostId} onSelect={onSelect} onDelete={onDelete} locale={locale} />
                ))}
            </ul>
        </div>
    );
}
