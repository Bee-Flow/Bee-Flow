import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Identity translator: t('key', 'Fallback') renders the fallback, so the pill
// labels below are the English the call sites ask for.
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

// Hoisted mock of the studio-apps API — AppsHomePage merges listAccessible +
// listMine (published-only) into the consumer directory.
vi.mock('../../components/admin/Studio/AppStudio/studioAppsApi', () => {
    const studioAppsApi = { listAccessible: vi.fn(), listMine: vi.fn() };
    return { default: studioAppsApi, studioAppsApi };
});

import AppsHomePage, { readAppRecents, rememberAppOpened } from './AppsHomePage';
import { studioAppsApi } from '../../components/admin/Studio/AppStudio/studioAppsApi';
import scopedStorage from '../../utils/scopedStorage';

beforeEach(() => {
    vi.clearAllMocks();
    studioAppsApi.listAccessible.mockResolvedValue({ apps: [] });
    studioAppsApi.listMine.mockResolvedValue({ apps: [] });
    // No signed-in user and no history by default: the recents block below
    // opts in explicitly, and every other test here must render as it does for
    // a first-time reader.
    localStorage.clear();
    scopedStorage.setCurrentUser(null);
});

describe('AppsHomePage', () => {
    it('renders accessible published tiles that link to the run view', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'CRM Pipeline', description: 'Track deals', isPublished: true, accentColor: '#0F766E' },
                { id: 'a2', name: 'Ticket Tracker', isPublished: true },
            ],
        });

        render(<AppsHomePage />);

        expect(await screen.findByText('CRM Pipeline')).toBeInTheDocument();
        expect(screen.getByText('Track deals')).toBeInTheDocument();
        expect(screen.getByText('Ticket Tracker')).toBeInTheDocument();

        // Each tile is an anchor to /app/apps/:id (the standalone run view).
        const crmLink = screen.getByRole('link', { name: /CRM Pipeline/i });
        expect(crmLink).toHaveAttribute('href', '/app/apps/a1');
    });

    it('merges owned-published apps and drops drafts + duplicates', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'Shared App', isPublished: true }],
        });
        studioAppsApi.listMine.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'Shared App', isPublished: true }, // duplicate of accessible
                { id: 'a2', name: 'My Published', isPublished: true },
                { id: 'a3', name: 'My Draft', isPublished: false },   // dropped
            ],
        });

        render(<AppsHomePage />);

        await screen.findByText('Shared App');
        expect(screen.getByText('My Published')).toBeInTheDocument();
        expect(screen.queryByText('My Draft')).not.toBeInTheDocument();
        // Deduped: only one "Shared App" tile in the directory grid. Scoped to
        // the section, because a recently-used app is shown TWICE on purpose
        // (once as a shortcut, once in its place in the directory) — that is
        // not the duplicate this test is about.
        expect(within(screen.getByTestId('apps-all')).getAllByText('Shared App')).toHaveLength(1);
    });

    // APPS-15 (project visibility). The SERVER decides which apps are
    // accessible; this directory must never add a membership rule of its own.
    // An accessible, published app that also happens to be filed into a Studio
    // Project is still an app you may open, so it renders. The property holds
    // whichever way the open server-side question is settled — today
    // studioAppStore.canReadStudioApp ignores project_id, while the comment on
    // mapAppMetaRow claims project members may see it without an org publish.
    it('does not drop apps that are filed into a project', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'p1', name: 'Project App', isPublished: true, projectId: 'proj-7' },
                { id: 's1', name: 'Standalone App', isPublished: true, projectId: null },
            ],
        });

        render(<AppsHomePage />);

        expect(await screen.findByText('Project App')).toBeInTheDocument();
        expect(screen.getByText('Standalone App')).toBeInTheDocument();
    });

    it('shows the empty state when nothing is shared', async () => {
        render(<AppsHomePage />);
        expect(await screen.findByText(/No apps have been shared with you yet/i)).toBeInTheDocument();
    });

    it('surfaces a retryable error when loading fails', async () => {
        studioAppsApi.listAccessible.mockRejectedValue(new Error('boom'));
        render(<AppsHomePage />);
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText(/boom/i)).toBeInTheDocument();
        expect(within(alert).getByText('Retry')).toBeInTheDocument();
    });
});

// ── A load that FAILED is not an answer ─────────────────────────────
// Every piece of chrome around the grid makes a claim about this reader's
// access: how many apps they may open, that only what they may use appears,
// which of them is new. When the fetch broke, the page knows none of that —
// so it says the one thing it does know, and nothing else. "We could not ask"
// must not be dressed up as "we asked, and you have nothing".
describe('AppsHomePage when the directory could not be loaded', () => {
    const failBoth = (err = new Error('boom')) => {
        studioAppsApi.listAccessible.mockRejectedValue(err);
        studioAppsApi.listMine.mockRejectedValue(err);
    };

    it('claims nothing about the reader’s access when the fetch failed', async () => {
        failBoth();
        render(<AppsHomePage />);
        await screen.findByRole('alert');

        // No count of apps, and no box to search a directory that was never
        // received.
        expect(screen.queryByText(/published$/)).not.toBeInTheDocument();
        expect(document.querySelector('input[type="search"]')).toBeNull();
        // No verdict on access, and no footnote explaining a grid that is not
        // there.
        expect(screen.queryByText(/Only what you are allowed to use appears here/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/An app is a small tool someone in your organization built/i))
            .not.toBeInTheDocument();
        // And above all: not "nothing matched your search" to a reader who
        // never typed anything.
        expect(screen.queryByText(/No apps match your search/i)).not.toBeInTheDocument();
    });

    it('does not offer the empty state either — that would answer the question too', async () => {
        failBoth();
        render(<AppsHomePage />);
        await screen.findByRole('alert');

        expect(screen.queryByText(/No apps have been shared with you yet/i)).not.toBeInTheDocument();
    });

    it('gives the whole directory back once a retry succeeds', async () => {
        // The other half of the rule: withholding the chrome while the answer
        // is unknown may not leave the page stranded once it IS known.
        failBoth();
        render(<AppsHomePage />);
        await screen.findByRole('alert');

        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'CRM Pipeline', isPublished: true }],
        });
        studioAppsApi.listMine.mockResolvedValue({ apps: [] });
        fireEvent.click(screen.getByText('Retry'));

        expect(await screen.findByText('CRM Pipeline')).toBeInTheDocument();
        expect(screen.getByText(/Only what you are allowed to use appears here/i)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

// ── Category filter (closed vocabulary) ─────────────────────────────
describe('AppsHomePage category filter', () => {
    const withCategories = () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'CRM Pipeline', isPublished: true, category: 'sales' },
                { id: 'a2', name: 'Ticket Tracker', isPublished: true, category: 'service' },
                { id: 'a3', name: 'Leave Requests', isPublished: true, category: 'hr' },
                { id: 'a4', name: 'Scratch Tool', isPublished: true },
            ],
        });
    };

    it('shows a pill per category in view, in the closed list order, plus All', async () => {
        withCategories();
        render(<AppsHomePage />);

        const group = await screen.findByRole('group', { name: /filter apps by category/i });
        const labels = within(group).getAllByRole('button').map((b) => b.textContent);
        // Sales before Service before HR — the closed list's own order, not
        // the order the apps happened to arrive in, and not alphabetical.
        expect(labels).toEqual(['All', 'Sales', 'Service', 'HR']);
        // Finance and Internal are in the vocabulary but have no app here.
        expect(within(group).queryByRole('button', { name: 'Finance' })).not.toBeInTheDocument();
    });

    it('filters the grid to the chosen category and back via All', async () => {
        withCategories();
        render(<AppsHomePage />);

        await screen.findByText('CRM Pipeline');
        fireEvent.click(screen.getByRole('button', { name: 'Service' }));

        expect(screen.getByText('Ticket Tracker')).toBeInTheDocument();
        expect(screen.queryByText('CRM Pipeline')).not.toBeInTheDocument();
        expect(screen.queryByText('Scratch Tool')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Service' })).toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(screen.getByRole('button', { name: 'All' }));
        expect(screen.getByText('CRM Pipeline')).toBeInTheDocument();
        expect(screen.getByText('Scratch Tool')).toBeInTheDocument();
    });

    it('never mints a chip for a value outside the closed list, and keeps that app under All', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'Typo App', isPublished: true, category: 'Financien' },
                { id: 'a2', name: 'Free Text App', isPublished: true, category: 'Marketing & Growth' },
                { id: 'a3', name: 'Real Sales App', isPublished: true, category: 'sales' },
            ],
        });
        render(<AppsHomePage />);

        const group = await screen.findByRole('group', { name: /filter apps by category/i });
        expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Sales']);

        // The uncategorised-by-the-rules apps stay reachable under All …
        expect(screen.getByText('Typo App')).toBeInTheDocument();
        expect(screen.getByText('Free Text App')).toBeInTheDocument();
        // … and drop out of a real category's view.
        fireEvent.click(within(group).getByRole('button', { name: 'Sales' }));
        expect(screen.getByText('Real Sales App')).toBeInTheDocument();
        expect(screen.queryByText('Typo App')).not.toBeInTheDocument();
    });

    it('accepts a stored value case-insensitively rather than dropping it', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'Ledger', isPublished: true, category: ' Finance ' }],
        });
        render(<AppsHomePage />);

        const group = await screen.findByRole('group', { name: /filter apps by category/i });
        expect(within(group).getByRole('button', { name: 'Finance' })).toBeInTheDocument();
    });

    it('hides the pill row entirely when no app carries a category', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'Only App', isPublished: true }],
        });
        render(<AppsHomePage />);

        await screen.findByText('Only App');
        expect(screen.queryByRole('group', { name: /filter apps by category/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    });

    it('shows no pill row on the empty state', async () => {
        render(<AppsHomePage />);
        await screen.findByText(/No apps have been shared with you yet/i);
        expect(screen.queryByRole('group', { name: /filter apps by category/i })).not.toBeInTheDocument();
    });
});

// ── APPS-05: "Recently used" ────────────────────────────────────────
// The property under test is what the heading CLAIMS: these are apps this
// reader opened, most recent first. Where the stamp is written (AppRunPage) is
// covered in that file's own test.
describe('AppsHomePage recently used', () => {
    const DIRECTORY = [
        { id: 'a1', name: 'CRM Pipeline', isPublished: true, category: 'sales' },
        { id: 'a2', name: 'Ticket Tracker', isPublished: true, category: 'service' },
        { id: 'a3', name: 'Leave Requests', isPublished: true, category: 'hr' },
        { id: 'a4', name: 'Expense Claims', isPublished: true },
    ];

    const signIn = (userId = 'u1') => scopedStorage.setCurrentUser(userId);
    const withDirectory = (apps = DIRECTORY) => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps });
    };

    it('lists only apps this reader opened, most recently opened first', async () => {
        signIn();
        rememberAppOpened('a3', 1_000);
        rememberAppOpened('a1', 3_000);
        rememberAppOpened('a2', 2_000);
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('Expense Claims');

        const recent = within(screen.getByTestId('apps-recent'));
        expect(recent.getAllByRole('link').map((a) => a.textContent)).toEqual([
            expect.stringContaining('CRM Pipeline'),
            expect.stringContaining('Ticket Tracker'),
            expect.stringContaining('Leave Requests'),
        ]);
        // Never opened, so it is not "recently used" — however new it is.
        expect(recent.queryByText('Expense Claims')).not.toBeInTheDocument();
    });

    it('keeps a recently used app in the full directory grid as well', async () => {
        signIn();
        rememberAppOpened('a1', 3_000);
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('Expense Claims');

        // The shortcut does not move the app out of the place you look for it.
        expect(within(screen.getByTestId('apps-recent')).getByText('CRM Pipeline')).toBeInTheDocument();
        expect(within(screen.getByTestId('apps-all')).getByText('CRM Pipeline')).toBeInTheDocument();
    });

    it('shows no recents section, and no section labels, before anything is opened', async () => {
        signIn();
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        // An app you never opened may not appear under "Recently used" — so
        // with no history there is no section at all, and therefore nothing
        // for an "All apps" label to distinguish it from.
        expect(screen.queryByTestId('apps-recent')).not.toBeInTheDocument();
        expect(screen.queryByText('Recently used')).not.toBeInTheDocument();
        expect(screen.queryByText('All apps')).not.toBeInTheDocument();
        expect(within(screen.getByTestId('apps-all')).getByText('CRM Pipeline')).toBeInTheDocument();
    });

    it('labels both sections once there is a recents block to tell apart', async () => {
        signIn();
        rememberAppOpened('a1');
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('Expense Claims');

        expect(screen.getByText('Recently used')).toBeInTheDocument();
        expect(screen.getByText('All apps')).toBeInTheDocument();
    });

    it('shows at most three, dropping the oldest opens', async () => {
        signIn();
        ['a1', 'a2', 'a3', 'a4'].forEach((id, i) => rememberAppOpened(id, 1_000 + i));
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        const recent = within(screen.getByTestId('apps-recent'));
        expect(recent.getAllByRole('link')).toHaveLength(3);
        expect(recent.queryByText('CRM Pipeline')).not.toBeInTheDocument();
    });

    it('drops an opened app that is no longer in the directory', async () => {
        signIn();
        rememberAppOpened('gone', 5_000);
        rememberAppOpened('a1', 4_000);
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('Expense Claims');

        // An app that was unpublished, unshared or deleted since you opened it
        // must not be offered as a shortcut to a 404.
        const recent = within(screen.getByTestId('apps-recent'));
        expect(recent.getAllByRole('link')).toHaveLength(1);
        expect(recent.getByText('CRM Pipeline')).toBeInTheDocument();
    });

    it('follows the category chip instead of contradicting it', async () => {
        signIn();
        rememberAppOpened('a1', 2_000); // sales
        rememberAppOpened('a2', 1_000); // service
        withDirectory();

        render(<AppsHomePage />);
        // Wait on the one app that is in neither the recents block nor a
        // category, so the query stays unambiguous while two grids are up.
        await screen.findByText('Expense Claims');
        fireEvent.click(screen.getByRole('button', { name: 'Service' }));

        const recent = within(screen.getByTestId('apps-recent'));
        expect(recent.getByText('Ticket Tracker')).toBeInTheDocument();
        expect(recent.queryByText('CRM Pipeline')).not.toBeInTheDocument();
    });

    it('never leaks one account\'s history to the next on a shared browser', async () => {
        signIn('u1');
        rememberAppOpened('a1');
        scopedStorage.setCurrentUser('u2');
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');
        expect(screen.queryByTestId('apps-recent')).not.toBeInTheDocument();
    });

    it('survives corrupt or non-object stored history', async () => {
        signIn();
        localStorage.setItem('beeflow:u1:appRecents', '{not json');
        withDirectory();

        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');
        expect(screen.queryByTestId('apps-recent')).not.toBeInTheDocument();
    });

    it('ignores a remembered entry whose timestamp is not a usable number', async () => {
        signIn();
        // Parses fine — so the JSON catch never sees it. Only the timestamp
        // filter can throw these out, and without it they would sort
        // unpredictably against the real ones.
        localStorage.setItem('beeflow:u1:appRecents', JSON.stringify({
            a1: 'yesterday', a2: null, a3: 0, a4: 4_000,
        }));
        withDirectory();

        render(<AppsHomePage />);
        // CRM Pipeline is a1 — filtered out of the history, so it appears
        // exactly once and settles the render without ambiguity.
        await screen.findByText('CRM Pipeline');

        const recent = within(screen.getByTestId('apps-recent'));
        expect(recent.getAllByRole('link').map((a) => a.textContent)).toEqual([
            expect.stringContaining('Expense Claims'),
        ]);
        expect(readAppRecents()).toEqual({ a4: 4_000 });
    });

    it('remembers more opens than it shows, so an older app regains its place', async () => {
        signIn();
        // Twelve distinct apps opened, oldest first.
        for (let i = 0; i < 12; i += 1) rememberAppOpened(`x${i}`, 1_000 + i);
        // The oldest of those is still remembered …
        expect(readAppRecents().x0).toBe(1_000);
        // … until a thirteenth pushes it out.
        rememberAppOpened('x12', 2_000);
        expect(readAppRecents().x0).toBeUndefined();
        expect(Object.keys(readAppRecents())).toHaveLength(12);
    });
});

// ── APPS-01: search ─────────────────────────────────────────────────
// The directory is org-sized, so the filter runs over the list the page
// already holds. What is under test is what the reader experiences: typing
// narrows the grid, and an empty result says so instead of showing nothing.
describe('AppsHomePage search', () => {
    const DIRECTORY = [
        { id: 'a1', name: 'CRM Pipeline', description: 'Track deals', isPublished: true },
        { id: 'a2', name: 'Ticket Tracker', description: 'Support queue', isPublished: true },
        { id: 'a3', name: 'Bakker-tool', description: 'Check an invoice before it goes out', isPublished: true },
    ];
    const withDirectory = () => studioAppsApi.listAccessible.mockResolvedValue({ apps: DIRECTORY });
    const type = (value) => fireEvent.change(screen.getByRole('searchbox'), { target: { value } });

    it('narrows the grid to the apps whose name matches, whatever the casing', async () => {
        withDirectory();
        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        type('crm');

        expect(screen.getByText('CRM Pipeline')).toBeInTheDocument();
        expect(screen.queryByText('Ticket Tracker')).not.toBeInTheDocument();
        expect(screen.queryByText('Bakker-tool')).not.toBeInTheDocument();
    });

    it('finds an app by a word only its description carries', async () => {
        withDirectory();
        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        // Half the tools in a real directory are named after the department
        // that ordered them; "invoice" appears only in the description.
        type('invoice');

        expect(screen.getByText('Bakker-tool')).toBeInTheDocument();
        expect(screen.queryByText('CRM Pipeline')).not.toBeInTheDocument();
    });

    it('says nothing matched rather than showing an empty grid', async () => {
        withDirectory();
        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        type('zzzz');

        expect(screen.getByText('No apps match your search.')).toBeInTheDocument();
        expect(within(screen.getByTestId('apps-all')).queryAllByRole('link')).toHaveLength(0);
        // Not the "nothing has been shared with you" state: the directory is
        // full, the query is what came up empty.
        expect(screen.queryByText(/No apps have been shared with you yet/i)).not.toBeInTheDocument();
    });

    it('gives the whole directory back when the box is emptied', async () => {
        withDirectory();
        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        type('crm');
        type('');

        expect(screen.getByText('Ticket Tracker')).toBeInTheDocument();
        expect(screen.getByText('Bakker-tool')).toBeInTheDocument();
    });

    it('offers no search box when there is nothing to search', async () => {
        render(<AppsHomePage />);
        await screen.findByText(/No apps have been shared with you yet/i);
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    });
});

// ── APPS-09: the order, and the line that names it ──────────────────
describe('AppsHomePage ordering', () => {
    it('orders the directory by name, not by when the builder last saved it', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'z', name: 'Zebra Tool', isPublished: true, updatedAt: '2026-09-09T10:00:00.000Z' },
                { id: 'm', name: 'Mango Tool', isPublished: true, updatedAt: '2019-01-01T10:00:00.000Z' },
                { id: 'a', name: 'Apple Tool', isPublished: true, updatedAt: '2026-09-08T10:00:00.000Z' },
            ],
        });
        render(<AppsHomePage />);
        await screen.findByText('Zebra Tool');

        // "Last touched by whoever built it" is noise to a reader: an app
        // moves to the front because someone fixed a label in it.
        const names = within(screen.getByTestId('apps-all')).getAllByRole('link')
            .map((a) => a.textContent);
        expect(names).toEqual([
            expect.stringContaining('Apple Tool'),
            expect.stringContaining('Mango Tool'),
            expect.stringContaining('Zebra Tool'),
        ]);
    });

    it('names the order it actually uses', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a', name: 'Apple Tool', isPublished: true },
                { id: 'z', name: 'Zebra Tool', isPublished: true },
            ],
        });
        render(<AppsHomePage />);
        await screen.findByText('Apple Tool');

        expect(screen.getByText('Sorted by name')).toBeInTheDocument();
        // The design asked for "most used". There is no honest usage number
        // on an app yet, so the line may not claim one.
        expect(screen.queryByText(/most used/i)).not.toBeInTheDocument();
    });

    it('says nothing about the order of a single app', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a', name: 'Apple Tool', isPublished: true }],
        });
        render(<AppsHomePage />);
        await screen.findByText('Apple Tool');
        expect(screen.queryByText('Sorted by name')).not.toBeInTheDocument();
    });
});

// ── APPS-10: the card ───────────────────────────────────────────────
describe('AppsHomePage card', () => {
    it('promises the way in on every card, without waiting for a hover', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'CRM Pipeline', isPublished: true }],
        });
        render(<AppsHomePage />);
        const card = await screen.findByRole('link', { name: /CRM Pipeline/ });

        expect(within(card).getByText('Open')).toBeInTheDocument();
        // A promise that only appears under a mouse is invisible on a phone
        // and to a keyboard. Checked as the PROPERTY rather than as one
        // banned class name: `opacity-0`, `opacity-[0]` and `invisible` are
        // three spellings of the same broken promise, and a test that forbids
        // only the spelling that was once removed lets the next two through.
        const hidden = /group-hover:|(^|\s)(invisible|hidden)(\s|$)|opacity-0|opacity-\[0/;
        expect(card.innerHTML).not.toMatch(/group-hover:/);
        for (let el = within(card).getByText('Open'); el && el !== card.parentElement; el = el.parentElement) {
            expect(el.className || '').not.toMatch(hidden);
        }
    });

    it('reserves the description box even for an app that has no description', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'With Text', description: 'Two whole lines of it', isPublished: true },
                { id: 'a2', name: 'Without Text', isPublished: true },
            ],
        });
        render(<AppsHomePage />);
        await screen.findByText('With Text');

        // Same reserved box on both, so a row of cards ends at one height and
        // the footer rules line up across it.
        for (const name of ['With Text', 'Without Text']) {
            const card = screen.getByRole('link', { name: new RegExp(name) });
            const box = card.querySelector('.h-\\[34px\\]');
            expect(box, `${name} should reserve a description box`).not.toBeNull();
            // And exactly one height on it: jsdom measures nothing, so a
            // second height class next to the first would otherwise sail
            // through while deciding the real height in the browser.
            expect((box.className.match(/(^|\s)h-\S+/g) || []).map((c) => c.trim()))
                .toEqual(['h-[34px]']);
        }
    });

    it('carries the app’s category in its own footer, not only in the pill row', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'CRM Pipeline', isPublished: true, category: 'sales' },
                { id: 'a2', name: 'Scratch Tool', isPublished: true },
            ],
        });
        render(<AppsHomePage />);
        const card = await screen.findByRole('link', { name: /CRM Pipeline/ });

        expect(within(card).getByText('Sales')).toBeInTheDocument();
        // An app without one says nothing rather than inventing a category.
        const plain = screen.getByRole('link', { name: /Scratch Tool/ });
        expect(within(plain).queryByText('Sales')).not.toBeInTheDocument();
    });
});

// ── APPS-11: the "new" badge ────────────────────────────────────────
// publishedAt already travels to the client (studioAppStore.mapAppMetaRow), so
// the badge needs nothing from the server. What it must never do is call an
// old tool new because someone saved a typo fix in it.
describe('AppsHomePage new badge', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
    const cardFor = (name) => screen.getByRole('link', { name: new RegExp(name) });

    it('badges an app published within the last two weeks', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'Fresh Tool', isPublished: true, publishedAt: daysAgo(3) }],
        });
        render(<AppsHomePage />);
        await screen.findByText('Fresh Tool');
        expect(within(cardFor('Fresh Tool')).getByText('new')).toBeInTheDocument();
    });

    it('stops badging once it is older than that', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'Old Tool', isPublished: true, publishedAt: daysAgo(15) }],
        });
        render(<AppsHomePage />);
        await screen.findByText('Old Tool');
        expect(within(cardFor('Old Tool')).queryByText('new')).not.toBeInTheDocument();
    });

    it('never calls an old app new because the builder saved it today', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{
                id: 'a1', name: 'Year Old Tool', isPublished: true,
                publishedAt: daysAgo(400), updatedAt: new Date().toISOString(),
            }],
        });
        render(<AppsHomePage />);
        await screen.findByText('Year Old Tool');
        expect(within(cardFor('Year Old Tool')).queryByText('new')).not.toBeInTheDocument();
    });

    it('does not fall back to updatedAt when there is no publication date', async () => {
        // The tell-tale case for the rule in the source: an app the builder
        // saved a minute ago but that carries no publishedAt at all. Falling
        // back to updatedAt here would badge every app anyone touched today.
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{
                id: 'a1', name: 'Touched Today', isPublished: true,
                updatedAt: new Date().toISOString(),
            }],
        });
        render(<AppsHomePage />);
        await screen.findByText('Touched Today');
        expect(within(cardFor('Touched Today')).queryByText('new')).not.toBeInTheDocument();
    });

    it('says nothing when there is no publication date to go on', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'Undated Tool', isPublished: true },
                { id: 'a2', name: 'Broken Date Tool', isPublished: true, publishedAt: 'whenever' },
            ],
        });
        render(<AppsHomePage />);
        await screen.findByText('Undated Tool');
        expect(within(cardFor('Undated Tool')).queryByText('new')).not.toBeInTheDocument();
        expect(within(cardFor('Broken Date Tool')).queryByText('new')).not.toBeInTheDocument();
    });
});

// ── APPS-12: the two explanations ───────────────────────────────────
describe('AppsHomePage explanations', () => {
    it('says beside the filters that this is only what you may use', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'CRM Pipeline', isPublished: true }],
        });
        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        // The claim is true of the data: the server filters to owner /
        // org-published / shared-group, and this page drops everything that
        // is not published on top of that.
        expect(screen.getByText(/Only what you are allowed to use appears here/i)).toBeInTheDocument();
    });

    it('closes with the footnote about what an app is and who sees it', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'CRM Pipeline', isPublished: true }],
        });
        render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        expect(screen.getByText(/An app is a small tool someone in your organization built/i))
            .toBeInTheDocument();
    });

    it('explains neither when there is no directory to explain', async () => {
        render(<AppsHomePage />);
        await screen.findByText(/No apps have been shared with you yet/i);

        // The empty state already says the whole story; two more paragraphs
        // under it would be three ways of saying "nothing here yet".
        expect(screen.queryByText(/Only what you are allowed to use appears here/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/An app is a small tool someone in your organization built/i))
            .not.toBeInTheDocument();
    });
});
