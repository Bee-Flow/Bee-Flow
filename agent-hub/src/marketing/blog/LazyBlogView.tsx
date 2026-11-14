import { Suspense, lazy } from 'react';
import './postCard.css';
import type { BlogPayload } from './blogFormat';

const BlogView = lazy(() => import('./BlogView'));

/**
 * The blog view, loaded on demand: a page without a blog does not carry its
 * code and styles in the public entry. While it loads, a full-height
 * placeholder keeps the footer where it will be.
 */
export default function LazyBlogView({ blog }: { blog: BlogPayload | null | undefined }) {
    return (
        <Suspense fallback={<div className="blog-loading" />}>
            <BlogView blog={blog} />
        </Suspense>
    );
}
