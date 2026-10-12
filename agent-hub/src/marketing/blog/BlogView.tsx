import './blog.css';
import BlogIndex from './BlogIndex';
import BlogPostView from './BlogPostView';
import type { BlogPayload } from './blogFormat';

/**
 * The blog body of a marketing page — rendered by ProductWebsite in place of
 * the block list when the content carries `blog` (a /blog URL, or the admin
 * preview of a post). Header, footer, design tokens, dark mode and the cookie
 * banner all come from the surrounding site, exactly as for a page.
 */
export default function BlogView({ blog }: { blog: BlogPayload | null | undefined }) {
    if (!blog || typeof blog !== 'object') return null;
    if (blog.view === 'post') return <BlogPostView blog={blog} />;
    return <BlogIndex blog={blog} />;
}
