import { screen, waitFor } from '@testing-library/react';
import { renderWithClient } from '../../test/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GithubStarButton, { DEFAULT_REPO_URL, accessibleName, formatStars, normaliseRepoUrl, safeRepoUrl, statsMatch } from './GithubStarButton';

function stubFetch(result: { ok: boolean; json?: unknown } | 'reject') {
    const fetchMock = vi.fn(() => (result === 'reject'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: result.ok, json: () => Promise.resolve(result.json) })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('GithubStarButton', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shows the count from our own server, never from GitHub', async () => {
        const fetchMock = stubFetch({ ok: true, json: { stars: 1234 } });
        renderWithClient(<GithubStarButton label="GitHub" starsFallback={10} />);
        await waitFor(() => expect(screen.getByText(formatStars(1234) as string)).toBeTruthy());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]).toEqual(['/api/public/github-stats', expect.objectContaining({ credentials: 'omit' })]);
    });

    it('uses the manual fallback while the server has no number', async () => {
        stubFetch({ ok: false });
        renderWithClient(<GithubStarButton starsFallback={42} />);
        expect(screen.getByText('42')).toBeTruthy();
    });

    it('is a plain GitHub link when there is no count at all', async () => {
        stubFetch('reject');
        renderWithClient(<GithubStarButton label="GitHub" />);
        const link = screen.getByRole('link', { name: 'GitHub (opens in a new tab)' });
        expect(link.getAttribute('href')).toBe(DEFAULT_REPO_URL);
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(link.querySelector('.github-star-count')).toBeNull();
    });

    it('only ever links to an https address', () => {
        expect(safeRepoUrl('javascript:alert(1)')).toBe(DEFAULT_REPO_URL);
        expect(safeRepoUrl('https://github.com/acme/app')).toBe('https://github.com/acme/app');
    });

    it('shows the live count only for the repository the server reports', async () => {
        stubFetch({ ok: true, json: { stars: 1234, url: 'https://github.com/Bee-Flow/Bee-Flow' } });
        renderWithClient(<GithubStarButton label="Ours" repoUrl="https://github.com/bee-flow/bee-flow.git/" starsFallback={7} />);
        renderWithClient(<GithubStarButton label="Theirs" repoUrl="https://github.com/acme/app" starsFallback={7} />);
        await waitFor(() => expect(screen.getByRole('link', { name: /^Ours,/ }).textContent).toContain(formatStars(1234) as string));
        // Another repository never shows the server's number, only its own manual count.
        const theirs = screen.getByRole('link', { name: /^Theirs/ });
        expect(theirs.textContent).toContain('7');
        expect(theirs.textContent).not.toContain(formatStars(1234) as string);
    });

    it('without an address of its own it shows the live count and links to that repository', async () => {
        stubFetch({ ok: true, json: { stars: 5, url: 'https://github.com/owner/repo' } });
        renderWithClient(<GithubStarButton />);
        await waitFor(() => expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/owner/repo'));
        expect(screen.getByRole('link').getAttribute('aria-label')).toBe('GitHub, 5 stars (opens in a new tab)');
    });

    it('the desktop header and the mobile menu share one request', async () => {
        const fetchMock = stubFetch({ ok: true, json: { stars: 3 } });
        renderWithClient(<><GithubStarButton label="Desktop" /><GithubStarButton label="Mobile" /></>);
        await waitFor(() => expect(screen.getByRole('link', { name: /^Mobile, 3 stars/ })).toBeTruthy());
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('names the link with label, count and the new-tab note, in the content\'s words', () => {
        expect(accessibleName(undefined, null)).toBe('GitHub (opens in a new tab)');
        expect(accessibleName('Star us', '1,234')).toBe('Star us, 1,234 stars (opens in a new tab)');
        expect(accessibleName('', '12', 'sterren', 'opent in een nieuw tabblad')).toBe('GitHub, 12 sterren (opent in een nieuw tabblad)');
    });

    it('compares repository addresses without case, trailing slash or .git', () => {
        expect(normaliseRepoUrl(' https://GitHub.com/A/B.git/ ')).toBe('https://github.com/a/b');
        expect(statsMatch('', 'https://github.com/x/y')).toBe(true);
        expect(statsMatch('https://github.com/x/y/', 'https://github.com/X/Y')).toBe(true);
        expect(statsMatch('https://github.com/x/z', 'https://github.com/x/y')).toBe(false);
        expect(statsMatch('https://github.com/x/y', undefined)).toBe(false);
    });
});
