import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CHARACTERISATION — the projects list exactly as it behaves today (PRJ-0).
 *
 * This is the safety net for the redesign, not a wish list: everything here
 * pins CURRENT behaviour, warts included, so a refactor that changes an empty
 * state, a filter or a per-role affordance has to say so out loud.
 *
 * The list is a pure props surface — AgentHub owns the fetch (`GET
 * /api/projects` in AgentHub.jsx) and hands the array down — so the only
 * request-shaped thing this page decides is the licence gate around it.
 */

const granted = new Set();

// Behaves like the real RequireTier's feature branch: children when the
// capability is held, an upgrade panel otherwise.
vi.mock('../licensing/LicenseContext', () => ({
    RequireTier: ({ feature, children }) => (
        granted.has(feature) ? children : <div data-testid="upgrade-prompt">{feature}</div>
    ),
}));

const { default: ProjectsPage } = await import('./ProjectsPage');

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

const OWNED = {
    id: 'p-own',
    name: 'Onboarding',
    description: 'Everything for new hires',
    permission: 'owner',
    icon: '🚀',
    color: '#22c55e',
    updatedAt: minutesAgo(2),
    knowledgeBaseIds: ['kb1', 'kb2'],
    extractMemories: true,
};
const EDITABLE = { id: 'p-edit', name: 'Billing', permission: 'editor', updatedAt: minutesAgo(10) };
const READONLY = { id: 'p-view', name: 'Archive', permission: 'viewer', updatedAt: minutesAgo(30) };

function renderPage(props = {}) {
    return render(<ProjectsPage projects={[]} {...props} />);
}

beforeEach(() => {
    granted.clear();
    granted.add('projects');
});

describe('the licence gate around the list', () => {
    it('shows the upgrade panel instead of the list when projects are not licensed', () => {
        granted.clear();
        const { getByTestId, queryByTestId } = renderPage({ projects: [OWNED] });
        expect(getByTestId('upgrade-prompt')).toHaveTextContent('projects');
        expect(queryByTestId('projects-page')).toBeNull();
    });

    it('renders the list once the projects capability is held', () => {
        const { getByTestId } = renderPage({ projects: [OWNED] });
        expect(getByTestId('projects-page')).toBeTruthy();
    });
});

describe('with nothing to show', () => {
    it('invites you to make your first project', () => {
        const { getByText } = renderPage({ projects: [], onCreateProject: vi.fn() });
        expect(getByText('No projects yet')).toBeTruthy();
        expect(getByText('Group your conversations and add custom instructions and knowledge bases.')).toBeTruthy();
    });

    it('offers a create button inside the empty state, not just in the toolbar', () => {
        const onCreateProject = vi.fn();
        const { getAllByText } = renderPage({ projects: [], onCreateProject });
        const buttons = getAllByText('New Project');
        expect(buttons).toHaveLength(2); // toolbar + empty state
        fireEvent.click(buttons[1]);
        expect(onCreateProject).toHaveBeenCalledTimes(1);
    });

    it('drops both create buttons when the parent supplies no create handler', () => {
        const { queryAllByText, queryByTestId } = renderPage({ projects: [] });
        expect(queryAllByText('New Project')).toHaveLength(0);
        expect(queryByTestId('projects-page-create')).toBeNull();
    });

    it('counts zero of zero in the header', () => {
        const { getByText } = renderPage({ projects: [] });
        expect(getByText('0 of 0')).toBeTruthy();
    });
});

describe('with projects', () => {
    it('renders one card per project', () => {
        const { getByTestId } = renderPage({ projects: [OWNED, EDITABLE, READONLY] });
        expect(getByTestId('project-card-p-own')).toBeTruthy();
        expect(getByTestId('project-card-p-edit')).toBeTruthy();
        expect(getByTestId('project-card-p-view')).toBeTruthy();
    });

    it('counts the filtered set against the total', () => {
        const { getByText } = renderPage({ projects: [OWNED, EDITABLE, READONLY] });
        expect(getByText('3 of 3')).toBeTruthy();
    });

    it('puts name, description, role, age, KB count and the memories marker on one card', () => {
        const { getByTestId } = renderPage({ projects: [OWNED] });
        const card = getByTestId('project-card-p-own');
        expect(card.textContent).toContain('Onboarding');
        expect(card.textContent).toContain('Everything for new hires');
        expect(card.textContent).toContain('Owner');
        expect(card.textContent).toContain('2m ago');
        expect(card.textContent).toContain('2 KBs');
        expect(card.textContent).toContain('Memories');
    });

    it('singularises the knowledge-base count at one', () => {
        const { getByTestId } = renderPage({ projects: [{ ...OWNED, knowledgeBaseIds: ['kb1'] }] });
        expect(getByTestId('project-card-p-own').textContent).toContain('1 KB');
        expect(getByTestId('project-card-p-own').textContent).not.toContain('1 KBs');
    });

    it('leaves out the KB and memories notes when there is nothing to say', () => {
        const { getByTestId } = renderPage({ projects: [EDITABLE] });
        const card = getByTestId('project-card-p-edit');
        expect(card.textContent).not.toContain('KB');
        expect(card.textContent).not.toContain('Memories');
    });

    it('opens a project when its card is clicked', () => {
        const onSelectProject = vi.fn();
        const { getByTestId } = renderPage({ projects: [OWNED], onSelectProject });
        fireEvent.click(getByTestId('project-card-p-own'));
        expect(onSelectProject).toHaveBeenCalledWith(OWNED);
    });

    // wrat: a project the server sends WITHOUT a permission field reads as
    // "Viewer" here, while the sidebar (ProjectsSection) treats the same
    // project as owned. One of the two is lying — hoort in stage PRJ-3/PRJ-13
    // te veranderen, samen met de rolbron.
    it('labels a project with no permission at all as a viewer', () => {
        const { getByTestId } = renderPage({ projects: [{ id: 'p-bare', name: 'Bare' }] });
        expect(getByTestId('project-card-p-bare').textContent).toContain('Viewer');
    });
});

describe('what each role may do from the list', () => {
    it('offers edit and delete to the owner', () => {
        const { getByTitle } = renderPage({ projects: [OWNED], onDeleteProject: vi.fn() });
        expect(getByTitle('Edit project')).toBeTruthy();
        expect(getByTitle('Delete project')).toBeTruthy();
    });

    it('offers only edit to an editor', () => {
        const { getByTitle, queryByTitle } = renderPage({ projects: [EDITABLE], onDeleteProject: vi.fn() });
        expect(getByTitle('Edit project')).toBeTruthy();
        expect(queryByTitle('Delete project')).toBeNull();
    });

    it('offers neither to a viewer', () => {
        const { queryByTitle } = renderPage({ projects: [READONLY], onDeleteProject: vi.fn() });
        expect(queryByTitle('Edit project')).toBeNull();
        expect(queryByTitle('Delete project')).toBeNull();
    });

    // wrat: the pencil is wired to onSelectProject, so "edit" and "open" are
    // the same action — the icon promises a shortcut that does not exist.
    // Hoort in stage PRJ-13 te veranderen.
    it('sends the edit pencil to the very same handler as opening the card', () => {
        const onSelectProject = vi.fn();
        const { getByTitle } = renderPage({ projects: [OWNED], onSelectProject });
        fireEvent.click(getByTitle('Edit project'));
        expect(onSelectProject).toHaveBeenCalledWith(OWNED);
    });

    // wrat: the trash can is drawn from the ROLE alone, never from whether a
    // handler exists — and AgentHub renders <ProjectsPage> without
    // onDeleteProject. So in the running app every owner sees a delete button
    // that does nothing at all: no confirm, no request, no message. Hoort in
    // stage PRJ-13 te veranderen (of de knop weg, of hem echt aansluiten).
    it('still draws a delete button for an owner when no delete handler was passed', () => {
        const onSelectProject = vi.fn();
        const { getByTitle } = renderPage({ projects: [OWNED], onSelectProject });
        const trash = getByTitle('Delete project');
        expect(trash).toBeTruthy();
        fireEvent.click(trash);
        // Silently nothing — not even the card-open fallback.
        expect(onSelectProject).not.toHaveBeenCalled();
    });

    it('does not open the project when edit or delete is pressed', () => {
        const onSelectProject = vi.fn();
        const onDeleteProject = vi.fn();
        const { getByTitle } = renderPage({ projects: [OWNED], onSelectProject, onDeleteProject });
        fireEvent.click(getByTitle('Delete project'));
        expect(onDeleteProject).toHaveBeenCalledWith(OWNED);
        expect(onSelectProject).not.toHaveBeenCalled();

        // The pencil shares its handler WITH the card, so a click that leaks
        // through to the card is only visible in the COUNT: one press, one call.
        fireEvent.click(getByTitle('Edit project'));
        expect(onSelectProject).toHaveBeenCalledTimes(1);
    });
});

describe('search', () => {
    it('matches on name, case-insensitively', () => {
        const { getByTestId, queryByTestId } = renderPage({ projects: [OWNED, EDITABLE] });
        fireEvent.change(getByTestId('projects-page-search'), { target: { value: 'BILL' } });
        expect(getByTestId('project-card-p-edit')).toBeTruthy();
        expect(queryByTestId('project-card-p-own')).toBeNull();
    });

    it('matches on the description too, case-insensitively', () => {
        // The description carries capitals the query does not, and the name says
        // nothing about hires: only a search that lowers BOTH sides finds this.
        const capitalised = {
            id: 'p-caps', name: 'Zeta', permission: 'owner',
            description: 'Everything for New Hires',
        };
        const { getByTestId, queryByTestId } = renderPage({ projects: [capitalised, EDITABLE] });
        fireEvent.change(getByTestId('projects-page-search'), { target: { value: 'new hires' } });
        expect(getByTestId('project-card-p-caps')).toBeTruthy();
        expect(queryByTestId('project-card-p-edit')).toBeNull();
    });

    it('says "no matches" rather than "no projects" when a search comes up empty', () => {
        const { getByTestId, getByText, queryByText } = renderPage({ projects: [OWNED] });
        fireEvent.change(getByTestId('projects-page-search'), { target: { value: 'zzz' } });
        expect(getByText('No matches')).toBeTruthy();
        expect(getByText('Try a different search.')).toBeTruthy();
        expect(queryByText('No projects yet')).toBeNull();
    });

    it('withholds the empty-state create button while a search is active', () => {
        const { getByTestId, getAllByText } = renderPage({ projects: [OWNED], onCreateProject: vi.fn() });
        fireEvent.change(getByTestId('projects-page-search'), { target: { value: 'zzz' } });
        expect(getAllByText('New Project')).toHaveLength(1); // toolbar only
    });

    it('keeps the total honest while filtering', () => {
        const { getByTestId, getByText } = renderPage({ projects: [OWNED, EDITABLE] });
        fireEvent.change(getByTestId('projects-page-search'), { target: { value: 'Billing' } });
        expect(getByText('1 of 2')).toBeTruthy();
    });
});

describe('the All / Mine / Shared filter', () => {
    it('starts on All and shows everything', () => {
        const { getByTestId } = renderPage({ projects: [OWNED, EDITABLE, READONLY] });
        expect(getByTestId('project-card-p-own')).toBeTruthy();
        expect(getByTestId('project-card-p-edit')).toBeTruthy();
        expect(getByTestId('project-card-p-view')).toBeTruthy();
    });

    it('narrows Mine to the projects you own', () => {
        const { getByTestId, queryByTestId } = renderPage({ projects: [OWNED, EDITABLE, READONLY] });
        fireEvent.click(getByTestId('projects-filter-mine'));
        expect(getByTestId('project-card-p-own')).toBeTruthy();
        expect(queryByTestId('project-card-p-edit')).toBeNull();
        expect(queryByTestId('project-card-p-view')).toBeNull();
    });

    it('narrows Shared to every role that is not owner', () => {
        const { getByTestId, queryByTestId } = renderPage({ projects: [OWNED, EDITABLE, READONLY] });
        fireEvent.click(getByTestId('projects-filter-shared'));
        expect(queryByTestId('project-card-p-own')).toBeNull();
        expect(getByTestId('project-card-p-edit')).toBeTruthy();
        expect(getByTestId('project-card-p-view')).toBeTruthy();
    });

    // wrat: a project with no permission field falls out of BOTH filters, so
    // "Mine" plus "Shared" does not add up to "All". Hoort in stage PRJ-13 te
    // veranderen, tegelijk met de rolbron uit PRJ-3.
    it('drops a permission-less project from Mine and from Shared alike', () => {
        const bare = { id: 'p-bare', name: 'Bare' };
        const { getByTestId, queryByTestId } = renderPage({ projects: [bare] });
        fireEvent.click(getByTestId('projects-filter-mine'));
        expect(queryByTestId('project-card-p-bare')).toBeNull();
        fireEvent.click(getByTestId('projects-filter-shared'));
        expect(queryByTestId('project-card-p-bare')).toBeNull();
        fireEvent.click(getByTestId('projects-filter-all'));
        expect(getByTestId('project-card-p-bare')).toBeTruthy();
    });

    it('gives Shared its own empty state and no create button', () => {
        const { getByTestId, getByText, getAllByText } = renderPage({ projects: [OWNED], onCreateProject: vi.fn() });
        fireEvent.click(getByTestId('projects-filter-shared'));
        expect(getByText('Nothing shared with you yet')).toBeTruthy();
        expect(getByText('When teammates share projects with you, they’ll appear here.')).toBeTruthy();
        expect(getAllByText('New Project')).toHaveLength(1); // toolbar only
    });
});

describe('sorting', () => {
    const OLD = { id: 'a', name: 'Alpha', permission: 'owner', updatedAt: '2020-01-01T00:00:00.000Z' };
    const NEW = { id: 'z', name: 'Zulu', permission: 'owner', updatedAt: '2030-01-01T00:00:00.000Z' };

    const names = (container) => [...container.querySelectorAll('[data-testid^="project-card-"]')]
        .map(el => el.getAttribute('data-testid'));

    it('puts the most recently updated first by default', () => {
        const { container } = renderPage({ projects: [OLD, NEW] });
        expect(names(container)).toEqual(['project-card-z', 'project-card-a']);
    });

    it('switches to alphabetical on request', () => {
        const { container, getByLabelText } = renderPage({ projects: [NEW, OLD] });
        fireEvent.change(getByLabelText('Sort projects'), { target: { value: 'az' } });
        expect(names(container)).toEqual(['project-card-a', 'project-card-z']);
    });

    it('sorts a project with no updatedAt to the very back', () => {
        const undated = { id: 'u', name: 'Undated', permission: 'owner' };
        const { container } = renderPage({ projects: [undated, OLD, NEW] });
        expect(names(container)).toEqual(['project-card-z', 'project-card-a', 'project-card-u']);
    });
});

describe('leaving the list', () => {
    it('shows a back button only when the parent can handle it', () => {
        const { queryByTitle } = renderPage({ projects: [] });
        expect(queryByTitle('Back')).toBeNull();
    });

    it('calls back out when the back button is pressed', () => {
        const onClose = vi.fn();
        const { getByTitle } = renderPage({ projects: [], onClose });
        fireEvent.click(getByTitle('Back'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
