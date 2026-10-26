import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { AppIcon, CollapsibleCard, FieldRow, ImageField, TextField } from './jsComponents';
import { POST_LIMITS, normalizePostSlug, type AdminPost } from './blogApi';

export const inputCls = 'w-full px-2 py-1 rounded text-xs border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]';

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

export type FieldProps = { post: AdminPost; onPostChange: (patch: Partial<AdminPost>) => void };

export function CoverAndDetails({ post, onPostChange }: FieldProps) {
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
