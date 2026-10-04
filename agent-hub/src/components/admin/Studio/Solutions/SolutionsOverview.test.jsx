import { fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import SolutionsOverview from './SolutionsOverview';

/**
 * The Solutions overview: three tabs, and a card per Solution.
 *
 * Two kinds of behaviour are pinned below, and only the second kind is what
 * this screen exists for.
 *
 * The first is the tabs: every row the server returned has to appear under
 * exactly one of them, because a row that lands on none is a Solution the
 * screen silently loses.
 *
 * The second is the whole reason GET /api/projects/summary answers `null`
 * instead of 0. On an overview a Solution LOOKS FINE — a card with no red on it
 * is read as healthy at a glance, and nobody clicks in to check. So every tally
 * that could not be read has to say so on the card, and every empty state has
 * to be reachable only from a successful read. Each test below whose name is
 * shouted is one of those; each of them fails the moment the screen rounds an
 * unknown off to good news.
 */

function summaryRow(over = {}) {
    return {
        id: 'p1',
        name: 'Quotes',
        description: 'From request to signed quote.',
        icon: '📦',
        permission: 'owner',
        installedFromBlueprintId: null,
        counts: {
            automations: 3, apps: 1, webpages: 0, datatables: 2, agents: 0,
            knowledgeBases: 1, notebooks: 0, skills: 0, documentTemplates: 0,
        },
        runs: { today: 12, failed: 0 },
        completeness: { blocked: false, complete: true, findings: 0, errors: 0, warnings: 0, unavailable: [] },
        update: null,
        unavailable: [],
        complete: true,
        ...over,
    };
}

const OK = (rows, over = {}) => ({ status: 'ok', rows, unavailable: [], hasMore: false, ...over });

function mockFetch({ blueprints = [], blueprintsOk = true } = {}) {
    globalThis.__authFetch = vi.fn(async (url) => {
        if (String(url).includes('/package/blueprints')) {
            return blueprintsOk
                ? { ok: true, status: 200, json: async () => ({ blueprints }) }
                : { ok: false, status: 500, json: async () => ({ error: 'Request failed' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
}

beforeEach(() => mockFetch());
afterEach(() => { delete globalThis.__authFetch; });

describe('the three tabs', () => {
    it('offers From us, Installed and Catalogue, and counts the installed ones', () => {
        const { getByText, getByRole } = render(
            <SolutionsOverview summary={OK([
                summaryRow({ id: 'a' }),
                summaryRow({ id: 'b', installedFromBlueprintId: 'bp1' }),
            ])} />,
        );
        expect(getByText('From us')).toBeTruthy();
        expect(getByText('Catalogue')).toBeTruthy();
        expect(getByRole('radio', { name: /Installed/ }).textContent).toContain('1');
    });

    it('shows the Solutions built here, and the installed ones on their own tab', () => {
        const { getAllByTestId, getByText, container } = render(
            <SolutionsOverview summary={OK([
                summaryRow({ id: 'a', name: 'Built here' }),
                summaryRow({ id: 'b', name: 'Came from a Blueprint', installedFromBlueprintId: 'bp1' }),
            ])} />,
        );
        expect(getAllByTestId('solutions-card')).toHaveLength(1);
        expect(getByText('Built here')).toBeTruthy();

        fireEvent.click(getByText('Installed'));
        const cards = container.querySelectorAll('[data-testid="solutions-card"]');
        expect(cards).toHaveLength(1);
        expect(getByText('Came from a Blueprint')).toBeTruthy();
    });

    it('A SOLUTION SOMEBODY SHARED WITH YOU STILL APPEARS', () => {
        // The tabs split on where a Solution came from, not on who owns it. Had
        // "From us" meant "owned by me", this row would be on no tab at all and
        // would vanish from the screen entirely.
        const { getByText } = render(
            <SolutionsOverview summary={OK([summaryRow({ id: 's', name: 'Shared with me', permission: 'viewer' })])} />,
        );
        expect(getByText('Shared with me')).toBeTruthy();
        expect(getByText(/viewer/)).toBeTruthy();
    });

    it('opens a card into the Solution', () => {
        const onOpen = vi.fn();
        const { getByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow()])} onOpen={onOpen} />,
        );
        fireEvent.click(getByTestId('solutions-card'));
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    });
});

describe('what the overview could not read', () => {
    it('A FAILED READ IS NOT AN EMPTY WORKSPACE', () => {
        // "Nothing here yet. Create a Solution…" over a 500 is the single most
        // expensive sentence this screen could print: it tells somebody their
        // work is gone.
        const { getByTestId, queryByTestId } = render(
            <SolutionsOverview summary={{ status: 'error', rows: [], unavailable: ['all'], hasMore: false }} />,
        );
        expect(getByTestId('solutions-overview-unavailable')).toBeTruthy();
        expect(queryByTestId('solutions-empty')).toBeNull();
    });

    it('the Installed tab shows no count at all when the read failed — never a 0', () => {
        const { getByRole } = render(
            <SolutionsOverview summary={{ status: 'error', rows: [], unavailable: ['all'], hasMore: false }} />,
        );
        expect(getByRole('radio', { name: /Installed/ }).textContent).not.toContain('0');
    });

    it('names the tallies that failed for every card at once', () => {
        const { getByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow()], { unavailable: ['runs', 'agents'] })} />,
        );
        expect(getByTestId('solutions-overview-partial').textContent)
            .toContain('how often things ran, agents');
    });

    it('says when the list was cut short', () => {
        const { getByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow()], { hasMore: true })} />,
        );
        expect(getByTestId('solutions-overview-more').textContent).toContain('most recently changed');
    });

    it('an empty answer that DID arrive gets the empty sentence', () => {
        const { getByTestId } = render(<SolutionsOverview summary={OK([])} />);
        expect(getByTestId('solutions-empty').textContent).toContain('Nothing here yet');
    });

    it('an empty INSTALLED tab says something different from an empty workspace', () => {
        const { getByText, getByTestId } = render(<SolutionsOverview summary={OK([summaryRow()])} />);
        fireEvent.click(getByText('Installed'));
        expect(getByTestId('solutions-empty').textContent).toContain('came from a Blueprint');
    });
});

describe('one card', () => {
    const cardFor = (over) => render(<SolutionsOverview summary={OK([summaryRow(over)])} />);

    it('shows a chip per kind it holds, and none for a kind it has none of', () => {
        const { container } = cardFor();
        const sections = [...container.querySelectorAll('[data-testid="solution-card-chip"]')]
            .map(el => el.getAttribute('data-section'));
        expect(sections).toEqual(['automations', 'apps', 'datatables', 'knowledgeBases']);
    });

    it('A COUNT THAT COULD NOT BE READ IS NAMED, NOT LEFT OFF', () => {
        const { getByTestId, container } = cardFor({
            counts: { automations: null, apps: 1, webpages: 0, datatables: 0, agents: 0, knowledgeBases: 0, notebooks: 0, skills: 0, documentTemplates: 0 },
        });
        expect(container.querySelectorAll('[data-testid="solution-card-chip"]')).toHaveLength(1);
        expect(getByTestId('solution-card-counts-partial').textContent).toContain('automations');
    });

    it('is Complete only when the checks ran and found nothing', () => {
        const chip = cardFor().getByTestId('solution-card-health');
        expect(chip.getAttribute('data-state')).toBe('clear');
        expect(chip.textContent).toContain('Complete');
    });

    it('CHECKS THAT DID NOT RUN ARE NOT A CLEAN BILL OF HEALTH', () => {
        const chip = cardFor({ completeness: null }).getByTestId('solution-card-health');
        expect(chip.getAttribute('data-state')).toBe('unknown');
        expect(chip.textContent).toContain('Not checked');
        expect(chip.getAttribute('title')).toContain('not a clean bill of health');
    });

    it('a Solution that could not be fully read says so, and gives no count', () => {
        const chip = cardFor({
            completeness: { blocked: true, complete: false, findings: 2, errors: 2, warnings: 0, unavailable: ['apps'] },
        }).getByTestId('solution-card-health');
        expect(chip.getAttribute('data-state')).toBe('unread');
        expect(chip.textContent).toContain('Could not be fully read');
        expect(chip.textContent).not.toContain('2');
    });

    it('counts what has to be fixed when the picture was whole', () => {
        const chip = cardFor({
            completeness: { blocked: true, complete: true, findings: 2, errors: 2, warnings: 0, unavailable: [] },
        }).getByTestId('solution-card-health');
        expect(chip.textContent).toContain('2 things to fix');
    });

    it('shows how much ran, and how much of it failed', () => {
        const line = cardFor({ runs: { today: 12, failed: 3 } }).getByTestId('solution-card-runs');
        expect(line.textContent).toContain('12 runs today');
        expect(line.textContent).toContain('3 failed');
    });
});

describe('one card · where it came from, and whether it has moved on', () => {
    const cardFor = (over) => render(<SolutionsOverview summary={OK([summaryRow(over)])} />);

    it('RUNS THAT COULD NOT BE COUNTED DO NOT READ AS A QUIET DAY', () => {
        const view = cardFor({ runs: null });
        const unknown = view.getByTestId('solution-card-runs');
        expect(unknown.getAttribute('data-state')).toBe('unknown');
        expect(unknown.textContent).toContain('could not be counted');
        view.unmount();

        const idle = cardFor({ runs: { today: 0, failed: 0 } }).getByTestId('solution-card-runs');
        expect(idle.getAttribute('data-state')).toBe('idle');
        expect(idle.textContent).toContain('Nothing ran today');
    });

    it('AN UNANSWERABLE UPDATE CHECK IS NOT SILENCE', () => {
        // Silence has to mean exactly one thing on this card — "the server
        // compared the versions and there is nothing newer". So the case where
        // it could NOT compare gets a line of its own.
        const { getByText, getByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow({
                installedFromBlueprintId: 'bp1',
                update: { blueprintId: 'bp1', installedVersion: 4, latestVersion: null, available: null },
            })])} />,
        );
        fireEvent.click(getByText('Installed'));
        const chip = getByTestId('solution-card-update');
        expect(chip.getAttribute('data-state')).toBe('unknown');
        expect(chip.textContent).toContain('could not be checked');
    });

    it('an up-to-date Solution shows no update chip at all', () => {
        const { getByText, queryByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow({
                installedFromBlueprintId: 'bp1',
                update: { blueprintId: 'bp1', installedVersion: 5, latestVersion: 5, available: false },
            })])} />,
        );
        fireEvent.click(getByText('Installed'));
        expect(queryByTestId('solution-card-update')).toBeNull();
    });

    it('a newer version is offered by name', () => {
        const { getByText, getByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow({
                installedFromBlueprintId: 'bp1',
                update: { blueprintId: 'bp1', installedVersion: 4, latestVersion: 5, available: true },
            })])} />,
        );
        fireEvent.click(getByText('Installed'));
        expect(getByTestId('solution-card-update').textContent).toContain('v5 available');
        expect(getByTestId('solution-card-sub').textContent).toContain('installed at v4');
    });
});

describe('the Catalogue tab', () => {
    it('lists the Blueprints kept on this instance, and only when opened', async () => {
        mockFetch({ blueprints: [{ id: 'bp1', name: 'Quotes', version: 2, description: 'A bundle' }] });
        const { getByText, findAllByTestId } = render(<SolutionsOverview summary={OK([])} />);
        // Nothing is fetched for a tab nobody opened.
        expect(globalThis.__authFetch).not.toHaveBeenCalled();

        fireEvent.click(getByText('Catalogue'));
        const cards = await findAllByTestId('solutions-catalogue-card');
        expect(cards).toHaveLength(1);
        expect(getByText('Blueprint v2')).toBeTruthy();
    });

    it('AN EMPTY CATALOGUE AND ONE THAT WOULD NOT LOAD SAY DIFFERENT THINGS', () => {
        mockFetch({ blueprints: [] });
        const empty = render(<SolutionsOverview summary={OK([])} />);
        fireEvent.click(empty.getByText('Catalogue'));
        return waitFor(() => {
            expect(empty.getByTestId('solutions-catalogue-empty').textContent).toContain('No Blueprints are kept');
        }).then(() => {
            empty.unmount();
            mockFetch({ blueprintsOk: false });
            const broken = render(<SolutionsOverview summary={OK([])} />);
            fireEvent.click(broken.getByText('Catalogue'));
            return waitFor(() => {
                expect(broken.getByTestId('solutions-catalogue-unavailable').textContent)
                    .toContain('could not be listed');
            });
        });
    });

    it('installing from the catalogue opens the wizard rather than installing', async () => {
        mockFetch({ blueprints: [{ id: 'bp1', name: 'Quotes', version: 2 }] });
        const { getByText, findByTestId } = render(<SolutionsOverview summary={OK([])} />);
        fireEvent.click(getByText('Catalogue'));
        fireEvent.click(await findByTestId('solutions-catalogue-install'));

        // The wizard's own footer sentence is the proof it is the dialog that
        // opened, and not a POST.
        expect((await findByTestId('install-footer-note')).textContent)
            .toBe('Everything arrives as a draft.');
        expect(globalThis.__authFetch.mock.calls.every(([, init]) => !init || !init.method || init.method === 'GET'))
            .toBe(true);
    });

    it('the Install button keeps only the file half — the chips are the tab now', () => {
        mockFetch({ blueprints: [{ id: 'bp1', name: 'Quotes', version: 2 }] });
        const { getByTestId, queryByText } = render(<SolutionsOverview summary={OK([])} />);
        expect(getByTestId('projects-page-install-blueprint')).toBeTruthy();
        expect(queryByText('Kept on this instance:')).toBeNull();
    });
});

describe('the redesigned toolbar and states', () => {
    it('shows skeleton cards, marked busy, while the overview loads', () => {
        const { getByTestId, container } = render(
            <SolutionsOverview summary={{ status: 'loading', rows: [], unavailable: [], hasMore: false }} />,
        );
        expect(getByTestId('solutions-loading').getAttribute('aria-busy')).toBe('true');
        expect(container.querySelectorAll('[data-testid="solution-card-skeleton"]')).toHaveLength(6);
    });

    it('offers Retry on a failed overview', async () => {
        const onRetry = vi.fn();
        const { getByTestId } = render(
            <SolutionsOverview summary={{ status: 'error', rows: [], unavailable: ['all'], hasMore: false }} onRetry={onRetry} />,
        );
        await userEvent.click(getByTestId('solutions-overview-retry'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('searches by name and says so when nothing matches', async () => {
        const { getByTestId, queryAllByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow({ id: 'a', name: 'Quotes' }), summaryRow({ id: 'b', name: 'Invoices' })])} />,
        );
        await userEvent.type(getByTestId('solutions-search'), 'invo');
        expect(queryAllByTestId('solutions-card')).toHaveLength(1);
        await userEvent.type(getByTestId('solutions-search'), 'zzz');
        expect(getByTestId('solutions-empty').textContent).toContain('No Solution matches');
    });

    it('puts a Solution with failed runs first and filters on Needs attention', async () => {
        const { getAllByTestId, getByRole } = render(
            <SolutionsOverview summary={OK([
                summaryRow({ id: 'a', name: 'Calm' }),
                summaryRow({ id: 'b', name: 'Failing', runs: { today: 3, failed: 2 } }),
            ])} />,
        );
        expect(getAllByTestId('solutions-card')[0].getAttribute('data-project')).toBe('b');
        await userEvent.click(getByRole('button', { name: /Needs attention/ }));
        expect(getAllByTestId('solutions-card')).toHaveLength(1);
    });

    it('draws the Dev, UAT and PRD track on a card with stages', () => {
        const { getByTestId } = render(
            <SolutionsOverview summary={OK([summaryRow({ stages: [
                { stage: 'uat', projectId: 'u', currentReleaseSeq: 2, lastDeploymentStatus: 'succeeded' },
                { stage: 'prd', projectId: 'p', currentReleaseSeq: 1, lastDeploymentStatus: 'failed' },
            ] })])} />,
        );
        const track = getByTestId('solution-card-stages');
        expect(track.textContent).toContain('Dev');
        expect(track.textContent).toContain('UAT R2');
        expect(track.textContent).toContain('last deployment failed');
    });

    it('first-run empty state offers to create or to install', async () => {
        const { getByText, getByTestId } = render(<SolutionsOverview summary={OK([])} />);
        expect(getByText('Create first Solution')).toBeTruthy();
        await userEvent.click(getByTestId('solutions-empty-install'));
        await waitFor(() => expect(getByText(/No Blueprints are kept|Blueprint v/)).toBeTruthy());
    });
});
