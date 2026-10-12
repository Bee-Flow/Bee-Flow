/**
 * The Blog editor pieces: Markdown commands, the preview payload, the post
 * list (filter, create, delete) and the inspector (field edits, status rules,
 * translation mode). No network: the components get their data as props.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BlogPostList from './BlogPostList';
import BlogInspector from './BlogInspector';
import { buildBlogPreview } from './blogPreview';
import { imageMarkdown, insertBlock, insertLink, toggleLinePrefix, wordCount, wrapSelection } from './markdownCommands';
import { normalizePostSlug, visibility, type AdminPost, type AdminPostSummary } from './blogApi';

const post = (extra: Partial<AdminPost> = {}): AdminPost => ({
    id: 'po_1', slug: 'hello', title: 'Hello', excerpt: '', body: 'Body text', coverImage: '', coverAlt: '', authorName: '',
    tags: [], status: 'draft', publishedAt: null, seo: { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});
const row = (id: string, title: string, extra: Partial<AdminPostSummary> = {}): AdminPostSummary => ({
    id, slug: title.toLowerCase(), title, excerpt: '', status: 'draft', publishedAt: null, updatedAt: null, coverImage: '', tags: [], translatedLocales: [], ...extra,
});

describe('markdown commands', () => {
    it('wraps and unwraps a selection', () => {
        const once = wrapSelection({ value: 'say hi', start: 4, end: 6 }, '**');
        expect(once).toEqual({ value: 'say **hi**', start: 6, end: 8 });
        expect(wrapSelection(once, '**').value).toBe('say hi');
        expect(wrapSelection({ value: '', start: 0, end: 0 }, '_', '_', 'text').value).toBe('_text_');
    });
    it('toggles line prefixes, replaces heading levels, numbers lists', () => {
        expect(toggleLinePrefix({ value: 'a\nb', start: 0, end: 3 }, '- ').value).toBe('- a\n- b');
        expect(toggleLinePrefix({ value: '- a\n- b', start: 0, end: 7 }, '- ').value).toBe('a\nb');
        expect(toggleLinePrefix({ value: '### Title', start: 2, end: 2 }, '## ').value).toBe('## Title');
        expect(toggleLinePrefix({ value: 'x\ny', start: 0, end: 3 }, '', { numbered: true }).value).toBe('1. x\n2. y');
    });
    it('inserts blocks on their own lines and links with the URL selected', () => {
        expect(insertBlock({ value: 'para', start: 4, end: 4 }, '---').value).toBe('para\n\n---\n\n');
        const link = insertLink({ value: 'see docs', start: 4, end: 8 });
        expect(link.value).toBe('see [docs](https://)');
        expect(link.value.slice(link.start, link.end)).toBe('https://');
        expect(imageMarkdown('/api/cms/asset/cms/a b.png', 'A [b]')).toBe('![A b](/api/cms/asset/cms/a%20b.png)');
        expect(wordCount('## Hi there\n\nOne **two**')).toBe(4);
    });
});

describe('blogApi helpers', () => {
    it('normalises slugs like the server and reports visibility', () => {
        expect(normalizePostSlug(' Café — Über Privacy! ')).toBe('cafe-uber-privacy');
        expect(visibility({ status: 'scheduled', publishedAt: new Date(Date.now() + 1e7).toISOString() })).toBe('scheduled');
        expect(visibility({ status: 'scheduled', publishedAt: new Date(Date.now() - 1e7).toISOString() })).toBe('live');
        expect(visibility({ status: 'draft', publishedAt: null })).toBe('draft');
    });
});

describe('buildBlogPreview', () => {
    const labelFor = (_k: string, fallback: string) => fallback;
    it('previews the edited post with the translation merged in', () => {
        const out = buildBlogPreview({
            post: post({ tags: ['Product'] }), posts: [], translation: { title: 'Hallo', body: '' }, locale: 'nl', defaultLocale: 'en',
            settings: { title: { en: 'Blog', nl: 'Nieuws' } }, labelFor,
        });
        expect(out.view).toBe('post');
        if (out.view !== 'post' || !out.post) throw new Error('post view expected');
        expect(out.post.title).toBe('Hallo');
        expect(out.post.body).toBe('Body text');
        expect(out.basePath).toBe('/nl/blog');
        expect(out.title).toBe('Nieuws');
        expect(out.post.tags).toEqual([{ slug: 'product', label: 'Product' }]);
    });
    it('the index preview lists only what visitors will see', () => {
        const out = buildBlogPreview({
            post: null,
            posts: [row('po_1', 'Draft'), row('po_2', 'Live', { status: 'published', publishedAt: '2020-01-01T00:00:00Z' })],
            translation: null, locale: 'en', defaultLocale: 'en', settings: null, labelFor,
        });
        if (out.view !== 'index') throw new Error('index view expected');
        expect(out.posts.map(p => p.title)).toEqual(['Live']);
    });
});

describe('BlogPostList', () => {
    it('filters by status and search, creates and deletes', async () => {
        const user = userEvent.setup();
        const onCreate = vi.fn();
        const onDelete = vi.fn();
        const onSelect = vi.fn();
        render(
            <BlogPostList
                posts={[row('po_1', 'First draft'), row('po_2', 'Launch news', { status: 'published', publishedAt: '2020-01-01T00:00:00Z' })]}
                loaded activePostId={null} onSelect={onSelect} onCreate={onCreate} onDelete={onDelete} locale="en"
            />,
        );
        const list = screen.getByRole('list', { name: 'Posts' });
        expect(within(list).getAllByRole('listitem')).toHaveLength(2);
        await user.click(screen.getByRole('button', { name: 'Published' }));
        expect(within(list).getAllByRole('listitem')).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: 'All' }));
        await user.type(screen.getByRole('searchbox'), 'draft');
        expect(within(list).getByText('First draft')).toBeInTheDocument();
        await user.click(within(list).getByText('First draft'));
        expect(onSelect).toHaveBeenCalledWith('po_1');
        await user.click(screen.getByRole('button', { name: 'Delete “First draft”' }));
        expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'po_1' }));
        await user.click(screen.getByRole('button', { name: /New post/ }));
        expect(onCreate).toHaveBeenCalled();
    });
});

describe('BlogInspector', () => {
    const base = {
        translations: {}, saveStatus: 'idle' as const, error: null, translationMode: false, activeLocale: 'en', localeName: 'English',
        defaultLocale: 'en', onTranslationChange: vi.fn(), settings: { title: {}, description: {}, postsPerPage: 10 }, onSettingsChange: vi.fn(),
    };

    it('edits title, schedules with a default date and commits the slug on blur', async () => {
        const user = userEvent.setup();
        const onPostChange = vi.fn();
        render(<BlogInspector {...base} post={post()} onPostChange={onPostChange} />);
        await user.type(screen.getByRole('textbox', { name: 'Title' }), '!');
        expect(onPostChange).toHaveBeenCalledWith({ title: 'Hello!' });
        await user.click(screen.getByRole('button', { name: 'Scheduled' }));
        const scheduled = onPostChange.mock.calls.at(-1)?.[0];
        expect(scheduled.status).toBe('scheduled');
        expect(Date.parse(scheduled.publishedAt)).toBeGreaterThan(Date.now());
        const slug = screen.getByRole('textbox', { name: 'Address' });
        await user.clear(slug);
        await user.type(slug, 'My New Slug');
        expect(onPostChange).not.toHaveBeenCalledWith({ slug: expect.stringContaining('My') });
        await user.tab();
        expect(onPostChange).toHaveBeenCalledWith({ slug: 'my-new-slug' });
    });

    it('in translation mode edits only the translation, with the source as placeholder', async () => {
        const user = userEvent.setup();
        const onTranslationChange = vi.fn();
        const onPostChange = vi.fn();
        render(<BlogInspector {...base} translationMode activeLocale="nl" localeName="Dutch" post={post()} onPostChange={onPostChange} onTranslationChange={onTranslationChange} />);
        const title = screen.getAllByPlaceholderText('Hello')[0];
        await user.type(title, 'H');
        expect(onTranslationChange).toHaveBeenCalledWith('nl', { title: 'H' });
        expect(onPostChange).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Scheduled' })).toBeNull();
    });

    it('without a post it edits the blog page settings for the active language', async () => {
        const user = userEvent.setup();
        const onSettingsChange = vi.fn();
        render(<BlogInspector {...base} post={null} onPostChange={vi.fn()} onSettingsChange={onSettingsChange} activeLocale="nl" localeName="Dutch" />);
        await user.type(screen.getByRole('textbox', { name: 'Heading (Dutch)' }), 'N');
        expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ title: { nl: 'N' } }));
    });
});
