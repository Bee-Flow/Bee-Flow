import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The Studio shell has no tab bar anymore — section navigation lives in the
// app sidebar (Sidebar renders the registry + gates; covered by
// Sidebar.studioNav.test.jsx). What the shell still owns, and what this file
// asserts: resolving the active section from the registry (built-ins +
// runtime modules), lazy-mounting it behind the local Suspense boundary,
// rendering it EVEN when its gate is false (the server 403s the data), and
// aggregating the per-app fullscreen-editing flags into onEditingChange.

// Stub every registry app with a marker — these paths must match the lazy()
// import specifiers in studioApps.jsx (they resolve to the same modules).
vi.mock('../../agents/AgentStudio/index', () => ({
    default: ({ onEditingChange }) => (
        <div data-testid="app-agents">
            <button data-testid="agents-start-editing" onClick={() => onEditingChange(true)}>start</button>
            <button data-testid="agents-stop-editing" onClick={() => onEditingChange(false)}>stop</button>
        </div>
    ),
}));
vi.mock('./SkillsStudio', () => ({ default: () => <div data-testid="app-skills" /> }));
vi.mock('./KnowledgeStudio', () => ({ default: () => <div data-testid="app-knowledge" /> }));
vi.mock('../../automation/index', () => ({ default: () => <div data-testid="app-aiTasks" /> }));
vi.mock('./Approvals/ApprovalsStudio', () => ({ default: () => <div data-testid="app-approvals" /> }));
vi.mock('../../../pages/WebpagesPage', () => ({ default: () => <div data-testid="app-webpages" /> }));
vi.mock('../../../pages/meeting-notes/MeetingNotesPage', () => ({ default: () => <div data-testid="app-meetingNotes" /> }));
vi.mock('./Forms/FormsStudio', () => ({ default: () => <div data-testid="app-forms" /> }));
vi.mock('./Runs/RunsStudio', () => ({ default: () => <div data-testid="app-runs" /> }));
vi.mock('./Playbooks/PlaybooksStudio', () => ({ default: (p) => <div data-testid="app-playbooks" data-initial={p.initialPlaybookId || ''} /> }));
// Start is not in STUDIO_APPS (studioStart.js explains why) but the shell
// mounts it through the same lazy() + getProps shape.
vi.mock('./StudioStart', () => ({ default: () => <div data-testid="app-start" /> }));

import Studio from './index.jsx';

const renderStudio = (props = {}) => render(
    <Studio
        user={{ permissions: ['all'] }}
        hasPermission={() => true}
        onNavigate={vi.fn()}
        {...props}
    />
);

describe('Studio shell — registry-driven sections', () => {
    beforeEach(() => cleanup());

    it('mounts the default Agents section through the local Suspense', async () => {
        renderStudio();
        expect(await screen.findByTestId('app-agents')).toBeTruthy();
    });

    it('mounts the Start section, which lives beside the registry (H1)', async () => {
        // /app/studio with no segment parses to 'start' now
        // (studioRoutes.test.js). If the shell could not resolve that id it
        // would render an empty div — a white pane on Studio's front door —
        // so the route change and this branch belong to the same commit.
        renderStudio({ section: 'start' });
        expect(await screen.findByTestId('app-start')).toBeTruthy();
        expect(screen.queryByTestId('app-agents')).toBeNull();
    });

    it('mounts the Forms section, which is a directory and has no id segment (H2)', async () => {
        // /app/studio/forms takes no further segment on purpose — the only id
        // its rows carry is a form's public URL token (studioApps.jsx). So
        // "does the shell resolve this section at all" is the whole contract
        // between the route and the screen.
        renderStudio({ section: 'forms' });
        expect(await screen.findByTestId('app-forms')).toBeTruthy();
    });

    it('mounts the Runs section, which is not a kind and has no create (H2)', async () => {
        // The registry's other exception alongside Approvals: a run is not a
        // thing you make, so the descriptor carries no `kind` and no `create`.
        // The shell must still resolve and mount it like any other section —
        // the rail row and every ?run= deep link land here.
        renderStudio({ section: 'runs' });
        expect(await screen.findByTestId('app-runs')).toBeTruthy();
        expect(screen.queryByTestId('app-agents')).toBeNull();
    });

    it('mounts the Playbooks section and forwards its deep-link id', async () => {
        // /app/studio/playbooks/<id> reopens one film mid-build; the shell's
        // getProps literal is where that id would silently drop.
        renderStudio({ section: 'playbooks', initialPlaybookId: 'pb_1' });
        const el = await screen.findByTestId('app-playbooks');
        expect(el.getAttribute('data-initial')).toBe('pb_1');
    });

    it('renders the active app lazily for a non-default section', async () => {
        renderStudio({ section: 'webpages' });
        expect(await screen.findByTestId('app-webpages')).toBeTruthy();
        expect(screen.queryByTestId('app-agents')).toBeNull();
    });

    it('still renders the active section for a user its gate would exclude (server 403s the data)', async () => {
        // No licence features, no permissions — the sidebar would hide this
        // section, but a deep link into it must still render the app.
        renderStudio({ section: 'webpages', user: {}, hasPermission: () => false });
        expect(await screen.findByTestId('app-webpages')).toBeTruthy();
    });

    it('fires the aggregate editing flag while an app reports editing', async () => {
        const onEditingChange = vi.fn();
        renderStudio({ onEditingChange });
        const start = await screen.findByTestId('agents-start-editing');

        fireEvent.click(start);
        expect(onEditingChange).toHaveBeenLastCalledWith(true);

        fireEvent.click(screen.getByTestId('agents-stop-editing'));
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
    });
});
