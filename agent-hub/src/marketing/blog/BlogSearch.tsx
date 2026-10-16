import { useId, useRef, useState } from 'react';
import { label, type BlogIndexPayload } from './blogFormat';
import { loadSearchIndex, searchEntries, searchIndexUrl, type SearchEntry } from './searchIndex';

/**
 * Search box on the blog index. The index is fetched the first time the box
 * is used, then every keystroke filters it locally; with no script the box is
 * absent and the tag links still work.
 */
export default function BlogSearch({ blog }: { blog: BlogIndexPayload }) {
    const inputId = useId();
    const [query, setQuery] = useState('');
    const [entries, setEntries] = useState<SearchEntry[] | null>(null);
    const [failed, setFailed] = useState(false);
    const requested = useRef(false);

    const ensureIndex = () => {
        if (requested.current) return;
        requested.current = true;
        loadSearchIndex(searchIndexUrl(blog.locale, blog.defaultLocale)).then(setEntries, () => setFailed(true));
    };

    const results = entries ? searchEntries(entries, query, ['post']) : [];
    const searching = query.trim() !== '' && entries !== null;
    return (
        <div className="blog-search" role="search">
            <label className="blog-search-label" htmlFor={inputId}>{label(blog.labels, 'search')}</label>
            <input
                id={inputId}
                className="blog-search-input"
                type="search"
                value={query}
                maxLength={80}
                placeholder={label(blog.labels, 'search')}
                onFocus={ensureIndex}
                onChange={(e) => { ensureIndex(); setQuery(e.target.value); }}
            />
            <div aria-live="polite">
                {searching && results.length === 0 ? <p className="blog-empty">{label(blog.labels, 'search_none')}</p> : null}
                {failed ? <p className="blog-empty">{label(blog.labels, 'search_none')}</p> : null}
                {results.length ? (
                    <ul className="blog-search-results">
                        {results.map((r) => (
                            <li key={r.u}><a href={r.u}>{r.t}</a>{r.d ? <span> {r.d}</span> : null}</li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </div>
    );
}
