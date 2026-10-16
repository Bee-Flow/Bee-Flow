import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { Github } from '../../components/icons/brandIcons';
import './githubStarButton.css';

/**
 * Header call-to-action of kind "github": a GitHub button with the live star
 * count. The count is NOT fetched from GitHub by the visitor's browser (that
 * would hand every visitor's IP address to a third party): it comes from our
 * own server, `GET /api/public/github-stats`, which fetches GitHub itself and
 * caches the answer for a day. One request per page view: the desktop header
 * and the mobile menu share it (module-level promise).
 *
 * The server reports ONE repository, its own (GITHUB_STATS_REPO). The live
 * number is therefore only shown when the button links to that repository
 * (same normalised address) or names none; a button that links elsewhere shows
 * only the editor's manual count, never another repository's stars. With
 * neither the button is just the GitHub link.
 *
 * The link always has an accessible name: the label (or "GitHub"), the count
 * and that it opens a new tab, from the block content (`starsText`,
 * `newTabText`), so the site translation covers them.
 */

export const DEFAULT_REPO_URL = 'https://github.com/Bee-Flow/Bee-Flow';


export function formatStars(n: unknown): string | null {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    try {
        return new Intl.NumberFormat().format(n);
    } catch {
        return String(n);
    }
}

/** Only an http(s) address is ever used as the link; anything else falls back to the default repository. */
export function safeRepoUrl(url: unknown): string {
    if (typeof url !== 'string') return DEFAULT_REPO_URL;
    const trimmed = url.trim();
    return /^https:\/\//i.test(trimmed) ? trimmed : DEFAULT_REPO_URL;
}

/** Lower-cased, without trailing slashes or `.git`: two spellings of one repository compare equal. */
export function normaliseRepoUrl(url: unknown): string {
    if (typeof url !== 'string') return '';
    return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

interface GithubStats {
    stars?: number;
    url?: string;
}

let statsRequest: Promise<GithubStats | null> | null = null;

/** The page's one request for the server's cached numbers; every button shares it. */
function loadGithubStats(): Promise<GithubStats | null> {
    if (!statsRequest) {
        statsRequest = fetch('/api/public/github-stats', { credentials: 'omit' })
            .then((r) => (r.ok ? r.json() : null))
            .then((payload: { stars?: unknown; url?: unknown } | null) => (payload ? {
                stars: typeof payload.stars === 'number' ? payload.stars : undefined,
                url: typeof payload.url === 'string' ? payload.url : undefined,
            } : null))
            // Fail-soft: the manual fallback count (or no count) is the degraded look.
            .catch(() => null);
    }
    return statsRequest;
}

/** Tests only: forget the shared request so the next button fetches again. */
export function forgetGithubStats(): void {
    statsRequest = null;
}

/** Whether the server's numbers belong to the repository the button links to. */
export function statsMatch(repoUrl: string | undefined, statsUrl: string | undefined): boolean {
    const own = normaliseRepoUrl(repoUrl);
    return own === '' || (statsUrl !== undefined && own === normaliseRepoUrl(statsUrl));
}

function useGithubStats(): GithubStats | null {
    const [stats, setStats] = useState<GithubStats | null>(null);
    useEffect(() => {
        let cancelled = false;
        loadGithubStats().then((s) => { if (!cancelled) setStats(s); });
        return () => { cancelled = true; };
    }, []);
    return stats;
}

export interface GithubStarButtonProps {
    repoUrl?: string;
    label?: string;
    /** Count to show until (or instead of) the server's cached number. */
    starsFallback?: number;
    /** Screen-reader word after the count ("stars"); content, so it translates. */
    starsText?: string;
    /** Screen-reader note that the link opens a new tab; content, so it translates. */
    newTabText?: string;
    className?: string;
}

export function accessibleName(label: string | undefined, count: string | null, starsText?: string, newTabText?: string): string {
    const name = label?.trim() || 'GitHub';
    const stars = count ? `, ${count} ${starsText?.trim() || 'stars'}` : '';
    return `${name}${stars} (${newTabText?.trim() || 'opens in a new tab'})`;
}

export default function GithubStarButton({ repoUrl, label, starsFallback, starsText, newTabText, className }: GithubStarButtonProps) {
    const stats = useGithubStats();
    const live = stats && statsMatch(repoUrl, stats.url) ? stats.stars : undefined;
    const count = formatStars(live ?? starsFallback);
    // Without an address of its own the button links to the repository the numbers are from.
    const href = normaliseRepoUrl(repoUrl) === '' && stats?.url ? safeRepoUrl(stats.url) : safeRepoUrl(repoUrl);
    return (
        <a
            className={['github-star-button', className].filter(Boolean).join(' ')}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={accessibleName(label, count, starsText, newTabText)}
        >
            {/* The same GitHub glyph as the footer and the GitHub stats block (already on the entry). */}
            <Github aria-hidden="true" className="github-star-mark" />
            {label ? <span className="github-star-label">{label}</span> : null}
            {count ? (
                <span className="github-star-count">
                    <Star aria-hidden="true" />
                    <span>{count}</span>
                </span>
            ) : null}
        </a>
    );
}
