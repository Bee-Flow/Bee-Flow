import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import MarkdownEditor from './MarkdownEditor';
import {
    AppIcon, CollapsibleCard, FieldRow, ImageField, InlineHint, SegmentedControl, TextArea, TextField, Toggle,
} from './jsComponents';
import {
    POST_LIMITS, fromLocalInput, normalizePostSlug, toLocalInput, visibility,
    type AdminPost, type PostStatus, type PostTranslation,
} from './blogApi';
import type { BlogSaveStatus } from './useBlogEditor';

/**
 * Right-hand inspector of the Blog entry.
 *   no post selected → the blog index settings (heading + intro per language,
 *                      posts per page)
 *   a post           → status/schedule, title, slug, excerpt, the Markdown
 *                      body, cover, author, tags and SEO
 *   translation mode → the translatable text of the post only (title,
 *                      excerpt, body, cover alt, SEO text), source as hint
 * Every change is live in the canvas and autosaved; Publish makes it public.
 */

export interface BlogSettings {
    title: Record<string, string>;
    description: Record<string, string>;
    postsPerPage: number;
}

interface Props {
    post: AdminPost | null;
    translations: Record<string, PostTranslation>;
    saveStatus: BlogSaveStatus;
    error: string | null;
    translationMode: boolean;
    activeLocale: string;
    localeName: string;
    defaultLocale: string;
    onPostChange: (patch: Partial<AdminPost>) => void;
    onTranslationChange: (locale: string, patch: PostTranslation) => void;
    settings: BlogSettings;
    onSettingsChange: (next: BlogSettings) => void;
}

const inputCls = 'w-full px-2 py-1 rounded text-xs border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]';

function Counter({ value, limit }: { value: string; limit: number }) {
    const len = (value || '').length;
    return <span className={`text-[10px] tabular-nums ${len > limit ? 'text-amber-500' : 'text-[var(--text-muted)]'}`}>{len}/{limit}</span>;
}

function TagInput({ tags, onChange, label, placeholder }: { tags: string[]; onChange: (next: string[]) => void; label: string; placeholder: string }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const add = (raw: string) => {
        const parts = raw.split(',').map(s => s.trim().replace(/\s+/g, ' ').slice(0, POST_LIMITS.tagLength)).filter(Boolean);
        if (!parts.length) return;
        const seen = new Set(tags.map(tg => normalizePostSlug(tg)));
        const next = [...tags];
        for (const p of parts) {
            const key = normalizePostSlug(p);
            if (!key || seen.has(key) || next.length >= POST_LIMITS.tags) continue;
            seen.add(key);
            next.push(p);
        }
        onChange(next);
        setDraft('');
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
        else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
    };
    return (
        <FieldRow label={label} hint={t('cms_blog.inspector.tags_hint', 'Up to {n}. Enter or comma adds one.', { n: POST_LIMITS.tags })}>
            <div className={`${inputCls} flex flex-wrap gap-1 items-center`}>
                {tags.map(tg => (
                    <span key={tg} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent-primary)]/15 text-[var(--text-primary)]">
                        {tg}
                        <button
                            type="button"
                            aria-label={t('cms_blog.inspector.remove_tag', 'Remove tag {tag}', { tag: tg })}
                            onClick={() => onChange(tags.filter(x => x !== tg))}
                            className="text-[var(--text-muted)] hover:text-red-400"
                        >
                            <AppIcon name="X" className="w-3 h-3" />
                        </button>
                    </span>
                ))}
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={() => add(draft)}
                    disabled={tags.length >= POST_LIMITS.tags}
                    placeholder={tags.length ? '' : placeholder}
                    aria-label={label}
                    className="flex-1 min-w-[80px] bg-transparent focus:outline-none"
                />
            </div>
        </FieldRow>
    );
}

/**
 * The slug commits on blur (or Enter), normalised: committing per keystroke
 * would let the autosave's normalised answer rewrite the field mid-word.
 */
function SlugInput({ slug, fallback, onCommit, label }: { slug: string; fallback: string; onCommit: (s: string) => void; label: string }) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        const next = normalizePostSlug(draft) || fallback;
        setDraft(null);
        if (next && next !== slug) onCommit(next);
    };
    return (
        <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--text-muted)]">/blog/</span>
            <input
                value={draft ?? slug}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
                className={inputCls}
                aria-label={label}
            />
        </div>
    );
}

function SaveLine({ status, error }: { status: BlogSaveStatus; error: string | null }) {
    const { t } = useTranslation();
    if (error) return <p className="text-[11px] text-red-400 mb-3">{error}</p>;
    const text = status === 'saving' ? t('cms_blog.inspector.saving', 'Saving…')
        : status === 'saved' ? t('cms_blog.inspector.saved', 'Saved to the draft — publish the site to make it public.')
            : status === 'error' ? t('cms_blog.inspector.save_failed', 'Not saved. The next edit retries.') : '';
    return text ? <p className="text-[11px] text-[var(--text-muted)] mb-3">{text}</p> : null;
}

function SettingsPanel({ settings, onChange, activeLocale, localeName }: {
    settings: BlogSettings; onChange: (next: BlogSettings) => void; activeLocale: string; localeName: string;
}) {
    const { t } = useTranslation();
    const setText = (key: 'title' | 'description', value: string) => {
        const map = { ...(settings[key] || {}) };
        if (value) map[activeLocale] = value; else delete map[activeLocale];
        onChange({ ...settings, [key]: map });
    };
    return (
        <div className="p-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">{t('cms_blog.settings.title', 'Blog page')}</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">
                {t('cms_blog.settings.intro', 'The index at /blog lists your published posts, newest first, with a tag filter and an RSS feed at /blog/feed.xml. Add a menu link to it under Header.')}
            </p>
            <TextField
                label={t('cms_blog.settings.heading', 'Heading ({language})', { language: localeName })}
                value={settings.title?.[activeLocale] || ''}
                onChange={(v) => setText('title', v.slice(0, 120))}
                placeholder={t('cms_blog.settings.heading_placeholder', 'Blog')}
            />
            <TextArea
                label={t('cms_blog.settings.description', 'Intro ({language})', { language: localeName })}
                value={settings.description?.[activeLocale] || ''}
                onChange={(v) => setText('description', v.slice(0, 500))}
                placeholder={t('cms_blog.settings.description_placeholder', 'News, product updates and stories from the team.')}
                hint={t('cms_blog.settings.description_hint', 'Also the description search engines show for /blog.')}
            />
            <FieldRow label={t('cms_blog.settings.per_page', 'Posts per page')}>
                <input
                    type="number"
                    min={1}
                    max={50}
                    value={settings.postsPerPage || 10}
                    onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        onChange({ ...settings, postsPerPage: Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 10 });
                    }}
                    className={inputCls}
                />
            </FieldRow>
        </div>
    );
}

function TranslationFields({ post, override, locale, localeName, onChange }: {
    post: AdminPost; override: PostTranslation; locale: string; localeName: string;
    onChange: (locale: string, patch: PostTranslation) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="p-3">
            <InlineHint>
                {t('cms_blog.translate.hint', 'Translating “{title}” into {language}. Empty fields show the original. Slug, tags, images and dates come from the original post.', { title: post.title, language: localeName })}
            </InlineHint>
            <TextField label={t('cms_blog.inspector.title', 'Title')} value={override.title || ''} placeholder={post.title} onChange={(v) => onChange(locale, { title: v })} />
            <TextArea label={t('cms_blog.inspector.excerpt', 'Excerpt')} value={override.excerpt || ''} placeholder={post.excerpt} onChange={(v) => onChange(locale, { excerpt: v })} />
            <FieldRow label={t('cms_blog.inspector.body', 'Text')}>
                <MarkdownEditor
                    value={override.body || ''}
                    onChange={(v) => onChange(locale, { body: v })}
                    maxLength={POST_LIMITS.body}
                    ariaLabel={t('cms_blog.inspector.body', 'Text')}
                    placeholder={t('cms_blog.translate.body_placeholder', 'Translate the text here (Markdown). Leave empty to show the original.')}
                    textOnly
                />
            </FieldRow>
            {post.coverImage ? (
                <TextField label={t('cms_blog.inspector.cover_alt', 'Cover description (alt text)')} value={override.coverAlt || ''} placeholder={post.coverAlt} onChange={(v) => onChange(locale, { coverAlt: v })} />
            ) : null}
            <TextField label={t('cms_blog.inspector.meta_title', 'Search title')} value={override.seo?.metaTitle || ''} placeholder={post.seo.metaTitle || post.title} onChange={(v) => onChange(locale, { seo: { metaTitle: v } })} />
            <TextArea label={t('cms_blog.inspector.meta_description', 'Search description')} value={override.seo?.metaDescription || ''} placeholder={post.seo.metaDescription || post.excerpt} onChange={(v) => onChange(locale, { seo: { metaDescription: v } })} />
        </div>
    );
}

type FieldProps = { post: AdminPost; onPostChange: (patch: Partial<AdminPost>) => void };

function StatusFields({ post, onPostChange }: FieldProps) {
    const { t } = useTranslation();
    const state = visibility(post);
    const statusOptions = [
        { value: 'draft', label: t('cms_blog.status.draft', 'Draft') },
        { value: 'scheduled', label: t('cms_blog.status.scheduled', 'Scheduled') },
        { value: 'published', label: t('cms_blog.status.live', 'Published') },
    ];
    const setStatus = (status: string) => {
        const next = status as PostStatus;
        if (next === 'scheduled' && !post.publishedAt) {
            onPostChange({ status: next, publishedAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
        } else if (next === 'published' && post.status !== 'published' && (!post.publishedAt || Date.parse(post.publishedAt) > Date.now())) {
            onPostChange({ status: next, publishedAt: new Date().toISOString() });
        } else {
            onPostChange({ status: next });
        }
    };
    const statusNote = state === 'draft'
        ? t('cms_blog.inspector.note_draft', 'Only you can see this post. Visitors never see a draft, even after publishing the site.')
        : state === 'scheduled'
            ? t('cms_blog.inspector.note_scheduled', 'Goes live by itself at the date below — once the site has been published with it.')
            : t('cms_blog.inspector.note_live', 'Visible to visitors after the next site publish.');

    return (
        <>
            <FieldRow label={t('cms_blog.inspector.status', 'Status')} hint={statusNote}>
                <SegmentedControl options={statusOptions} value={post.status} onChange={setStatus} />
            </FieldRow>
            {post.status !== 'draft' ? (
                <FieldRow label={post.status === 'scheduled' ? t('cms_blog.inspector.goes_live', 'Goes live at') : t('cms_blog.inspector.published_at', 'Publication date')}>
                    <input
                        type="datetime-local"
                        value={toLocalInput(post.publishedAt)}
                        onChange={(e) => onPostChange({ publishedAt: fromLocalInput(e.target.value) })}
                        className={inputCls}
                    />
                </FieldRow>
            ) : null}

        </>
    );
}

function MainFields({ post, onPostChange }: FieldProps) {
    const { t } = useTranslation();
    return (
        <>
            <FieldRow label={t('cms_blog.inspector.title', 'Title')} hint={<Counter value={post.title} limit={70} />}>
                <input
                    value={post.title}
                    onChange={(e) => onPostChange({ title: e.target.value.slice(0, POST_LIMITS.title) })}
                    className={`${inputCls} text-sm font-medium`}
                    aria-label={t('cms_blog.inspector.title', 'Title')}
                />
            </FieldRow>

            <FieldRow
                label={t('cms_blog.inspector.slug', 'Address')}
                hint={t('cms_blog.inspector.slug_hint', 'Public at /blog/{slug}. Changing it after publishing breaks shared links.', { slug: post.slug || '…' })}
            >
                <SlugInput
                    slug={post.slug}
                    fallback={normalizePostSlug(post.title)}
                    onCommit={(slug) => onPostChange({ slug })}
                    label={t('cms_blog.inspector.slug', 'Address')}
                />
            </FieldRow>

            <FieldRow label={t('cms_blog.inspector.excerpt', 'Excerpt')} hint={<Counter value={post.excerpt} limit={155} />}>
                <textarea
                    value={post.excerpt}
                    rows={3}
                    onChange={(e) => onPostChange({ excerpt: e.target.value.slice(0, POST_LIMITS.excerpt) })}
                    placeholder={t('cms_blog.inspector.excerpt_placeholder', 'One or two sentences for the blog page and search results.')}
                    className={inputCls}
                    aria-label={t('cms_blog.inspector.excerpt', 'Excerpt')}
                />
            </FieldRow>

            <FieldRow label={t('cms_blog.inspector.body', 'Text')}>
                <MarkdownEditor
                    value={post.body}
                    onChange={(v) => onPostChange({ body: v })}
                    maxLength={POST_LIMITS.body}
                    ariaLabel={t('cms_blog.inspector.body', 'Text')}
                    placeholder={t('cms_blog.inspector.body_placeholder', 'Write your post. Use ## for a section heading — the title above is already the main heading.')}
                />
            </FieldRow>

        </>
    );
}

function CoverAndDetails({ post, onPostChange }: FieldProps) {
    const { t } = useTranslation();
    return (
        <>
            <CollapsibleCard title={t('cms_blog.inspector.cover', 'Cover image')} defaultOpen persistKey="blog.cover">
                <ImageField value={post.coverImage} onChange={(v) => onPostChange({ coverImage: v })} label={t('cms_blog.inspector.cover_image', 'Image')} />
                {post.coverImage ? (
                    <TextField
                        label={t('cms_blog.inspector.cover_alt', 'Cover description (alt text)')}
                        value={post.coverAlt}
                        onChange={(v) => onPostChange({ coverAlt: v.slice(0, 200) })}
                        placeholder={t('cms_blog.inspector.cover_alt_placeholder', 'What the image shows')}
                    />
                ) : null}
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_blog.inspector.details', 'Author and tags')} defaultOpen persistKey="blog.details">
                <TextField
                    label={t('cms_blog.inspector.author', 'Author name')}
                    value={post.authorName}
                    onChange={(v) => onPostChange({ authorName: v.slice(0, 100) })}
                    placeholder={t('cms_blog.inspector.author_placeholder', 'Shown as “By …”; leave empty to show none')}
                    hint={t('cms_blog.inspector.author_hint', 'Free text, shown publicly. Not linked to an account.')}
                />
                <TagInput
                    tags={post.tags}
                    onChange={(tags) => onPostChange({ tags })}
                    label={t('cms_blog.inspector.tags', 'Tags')}
                    placeholder={t('cms_blog.inspector.tags_placeholder', 'product, privacy')}
                />
            </CollapsibleCard>

        </>
    );
}

function SeoFields({ post, onPostChange }: FieldProps) {
    const { t } = useTranslation();
    return (
        <>
            <CollapsibleCard title={t('cms_blog.inspector.seo', 'Search and social')} persistKey="blog.seo">
                <TextField
                    label={t('cms_blog.inspector.meta_title', 'Search title')}
                    value={post.seo.metaTitle}
                    onChange={(v) => onPostChange({ seo: { ...post.seo, metaTitle: v.slice(0, 200) } })}
                    placeholder={post.title}
                    hint={<Counter value={post.seo.metaTitle || post.title} limit={60} />}
                />
                <TextArea
                    label={t('cms_blog.inspector.meta_description', 'Search description')}
                    value={post.seo.metaDescription}
                    onChange={(v) => onPostChange({ seo: { ...post.seo, metaDescription: v.slice(0, 500) } })}
                    placeholder={post.excerpt}
                    hint={<Counter value={post.seo.metaDescription || post.excerpt} limit={155} />}
                />
                <ImageField
                    value={post.seo.ogImage}
                    onChange={(v) => onPostChange({ seo: { ...post.seo, ogImage: v } })}
                    label={t('cms_blog.inspector.og_image', 'Social image (defaults to the cover)')}
                />
                <Toggle
                    value={post.seo.noIndex}
                    onChange={(v) => onPostChange({ seo: { ...post.seo, noIndex: v } })}
                    label={t('cms_blog.inspector.no_index', 'Hide from search engines')}
                />
            </CollapsibleCard>
        </>
    );
}

export default function BlogInspector(props: Props) {
    const { post, translationMode, activeLocale, localeName, onPostChange } = props;

    if (!post) {
        return (
            <div className="h-full overflow-y-auto">
                <SettingsPanel settings={props.settings} onChange={props.onSettingsChange} activeLocale={activeLocale} localeName={localeName} />
            </div>
        );
    }

    if (translationMode) {
        return (
            <div className="h-full overflow-y-auto">
                <div className="px-3 pt-3"><SaveLine status={props.saveStatus} error={props.error} /></div>
                <TranslationFields
                    post={post}
                    override={props.translations[activeLocale] || {}}
                    locale={activeLocale}
                    localeName={localeName}
                    onChange={props.onTranslationChange}
                />
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto p-3">
            <SaveLine status={props.saveStatus} error={props.error} />
            <StatusFields post={post} onPostChange={onPostChange} />
            <MainFields post={post} onPostChange={onPostChange} />
            <CoverAndDetails post={post} onPostChange={onPostChange} />
            <SeoFields post={post} onPostChange={onPostChange} />
        </div>
    );
}
