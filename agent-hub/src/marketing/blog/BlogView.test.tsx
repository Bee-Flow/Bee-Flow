/**
 * The public blog renderer: index (featured post, tag filter, paging), post
 * page (meta, draft badge, neighbours, feed link) and the URL gate of the
 * Markdown body — a stored javascript: link must never become a link.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BlogView from './BlogView';
import BlogMarkdown from './BlogMarkdown';
import { indexHref, label, safeBlogUrl, type BlogIndexPayload, type BlogPostPayload, type BlogPostSummary } from './blogFormat';

const summary = (i: number, extra: Partial<BlogPostSummary> = {}): BlogPostSummary => ({
    id: `po_${i}`, slug: `post-${i}`, title: `Post ${i}`, excerpt: `Excerpt ${i}`, coverImage: i === 0 ? 'cms/cover.jpg' : '',
    coverAlt: '', authorName: '', tags: [{ slug: 'product', label: 'Product' }], publishedAt: '2026-10-01T09:00:00Z',
    updatedAt: null, readingMinutes: 2, ...extra,
});

const common = { locale: 'en', defaultLocale: 'en', basePath: '/blog', title: 'Journal', description: 'From the team', labels: {} };

describe('BlogView — index', () => {
    it('features the newest post, lists the rest, links tags and pages', () => {
        const blog: BlogIndexPayload = {
            ...common, view: 'index', posts: [summary(0), summary(1), summary(2)], page: 1, pageCount: 2, total: 4,
            tag: null, tags: [{ slug: 'product', label: 'Product', count: 4 }],
        };
        const { container } = render(<BlogView blog={blog} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Journal' })).toBeInTheDocument();
        expect(container.querySelector('.blog-card--featured')?.textContent).toContain('Post 0');
        expect(container.querySelectorAll('.blog-grid .blog-card')).toHaveLength(2);
        expect(screen.getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/blog?tag=product');
        expect(screen.getByRole('link', { name: 'Older posts' })).toHaveAttribute('href', '/blog?page=2');
        expect(screen.getByRole('link', { name: 'Post 1' })).toHaveAttribute('href', '/blog/post-1');
        expect(container.querySelector('.blog-card--featured img')).toHaveAttribute('src', '/api/cms/asset/cms/cover.jpg');
    });

    it('shows the tag heading and the empty state', () => {
        const blog: BlogIndexPayload = { ...common, view: 'index', posts: [], page: 1, pageCount: 1, total: 0, tag: { slug: 'x', label: 'X' }, tags: [] };
        render(<BlogView blog={blog} />);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Posts tagged “X”');
        expect(screen.getByText('No posts with this tag.')).toBeInTheDocument();
    });
});

describe('BlogView — post', () => {
    it('renders the article head, draft badge, neighbours and the feed link', () => {
        const blog: BlogPostPayload = {
            ...common, view: 'post',
            post: { ...summary(5, { authorName: 'Ann' }), body: 'Hello **world**', status: 'draft' },
            older: summary(4), newer: null,
        };
        render(<BlogView blog={blog} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Post 5' })).toBeInTheDocument();
        expect(screen.getByText('By Ann')).toBeInTheDocument();
        expect(screen.getByText('Draft — not visible to visitors')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Previous post/ })).toHaveAttribute('href', '/blog/post-4');
        expect(screen.getByRole('link', { name: 'RSS feed' })).toHaveAttribute('href', '/blog/feed.xml');
    });
});

describe('BlogMarkdown', () => {
    it('drops unsafe links and raw HTML, keeps safe ones, shifts headings', () => {
        const { container } = render(<BlogMarkdown markdown={'# Top\n\n[bad](javascript:alert(1)) [ok](https://example.com) <img src=x onerror=alert(1)>\n\n![pic](cms/a.png)'} />);
        expect(container.querySelector('h1')).toBeNull();
        expect(container.querySelector('h2#top')).toHaveTextContent('Top');
        const links = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
        expect(links).toEqual(['https://example.com']);
        expect(container.querySelector('a')).toHaveAttribute('rel', 'noopener noreferrer nofollow');
        expect(container.querySelector('img[onerror]')).toBeNull();
        expect(container.querySelector('img')).toHaveAttribute('src', '/api/cms/asset/cms/a.png');
    });
});

describe('blogFormat', () => {
    it('safeBlogUrl mirrors the server gate', () => {
        expect(safeBlogUrl('java\tscript:alert(1)')).toBe('');
        expect(safeBlogUrl('data:text/html,x')).toBe('');
        expect(safeBlogUrl('//evil.example')).toBe('');
        expect(safeBlogUrl('mailto:a@b.c', 'image')).toBe('');
        expect(safeBlogUrl('/pricing')).toBe('/pricing');
        expect(safeBlogUrl('cms/x.png')).toBe('/api/cms/asset/cms/x.png');
    });
    it('labels interpolate and fall back to English', () => {
        expect(label({ min_read: '{n} min. lezen' }, 'min_read', { n: 3 })).toBe('3 min. lezen');
        expect(label({}, 'page_of', { page: 2, pages: 5 })).toBe('Page 2 of 5');
        expect(indexHref('/nl/blog', { tag: 'a', page: 2 })).toBe('/nl/blog?tag=a&page=2');
    });
});
