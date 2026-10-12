import { TextField, InlineHint, SectionHeaderFields } from '../blog/jsComponents';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Latest posts ──────────────────────────────────────────────────────
//
// The block stores no posts: the newest PUBLISHED posts of the live site are
// fetched at view time from /api/cms/blog/posts, so a new post shows up here
// without re-publishing this page. This editor controls how many, an
// optional tag filter and the wording around them.

type BlockData = Record<string, unknown>;

const set = (data: BlockData, key: string, value: unknown): BlockData => ({ ...(data || {}), [key]: value });

export function LatestPostsEditor({ data = {}, onChange }: { data?: BlockData; onChange: (next: BlockData) => void }) {
    const { t } = useTranslation();
    const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '');
    return (
        <>
            <InlineHint>
                {t('cms_blog.block.hint', 'Shows the newest published posts of the live site. Write and publish posts under Blog in the navigator.')}
            </InlineHint>

            <SectionHeaderFields data={data} onChange={onChange} persistScope="blog-latest" />

            <TextField
                label={t('cms_blog.block.limit', 'How many posts (1–6)')}
                value={String(data.limit ?? '')}
                onChange={(v: string) => {
                    const n = Number.parseInt(v, 10);
                    onChange(set(data, 'limit', v === '' ? '' : Math.min(6, Math.max(1, Number.isFinite(n) ? n : 3))));
                }}
                placeholder="3"
            />
            <TextField
                label={t('cms_blog.block.tag', 'Only posts with this tag (optional)')}
                value={str('tagId')}
                onChange={(v: string) => onChange(set(data, 'tagId', v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 40)))}
                placeholder={t('cms_blog.block.tag_placeholder', 'e.g. product')}
            />
            <TextField
                label={t('cms_blog.block.link_label', 'Link to the blog')}
                value={str('linkLabel')}
                onChange={(v: string) => onChange(set(data, 'linkLabel', v))}
                placeholder={t('cms_blog.block.link_placeholder', 'All posts')}
            />
            <TextField
                label={t('cms_blog.block.empty_text', 'Text in the editor while there are no posts')}
                value={str('emptyText')}
                onChange={(v: string) => onChange(set(data, 'emptyText', v))}
                placeholder={t('cms_blog.block.empty_placeholder', 'Published posts appear here')}
            />
        </>
    );
}
