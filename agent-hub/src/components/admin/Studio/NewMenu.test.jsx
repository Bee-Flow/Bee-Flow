import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchMock, toastMock } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    toastMock: { error: vi.fn(), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('../../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (key, fallback) => fallback || key, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../shared/Toast', () => ({ toast: toastMock, default: toastMock }));
vi.mock('../../automation/Builder/flow/settings/FormBuilderFields', () => ({
    defaultFormDeclaration: () => ({ title: 'New form', fields: [{ name: 'q1' }] }),
}));

import { NewMenu, NewMenuButton, buildNewMenuModel, createFormAutomation } from './NewMenu';
import { STUDIO_APPS, resolveStudioNav } from './studioApps';
import { queryWrapper } from '../../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const t = (key, fallback) => fallback || key;

// The sections a fully entitled org hands the menu: everything passes.
const allOpen = () => resolveStudioNav(STUDIO_APPS, {
    user: {}, hasLicenseFeature: () => true, canUse: () => true, hasPermission: () => true,
    can: () => true, lockReason: () => null,
}).filter((a) => !a.hiddenFromNav);

// A Community org: nothing effective, App/Webpage/Meeting/Solution outside
// the plan, Skills inside the plan but not switched on.
const community = () => resolveStudioNav(STUDIO_APPS, {
    user: {}, hasLicenseFeature: (f) => f === 'automations', canUse: (id) => id === 'automations',
    hasPermission: () => true, can: () => false,
    lockReason: (id) => (id === 'skills' ? 'not_granted' : 'ceiling'),
}).filter((a) => !a.hiddenFromNav);

describe('buildNewMenuModel — derived from the registry', () => {
    it('AI row first, then Build · AI · Bundle with dividers, every registry section with a create entry', () => {
        const model = buildNewMenuModel(allOpen(), t);
        expect(model[0]).toMatchObject({ type: 'ai', label: 'Describe it — AI picks the building blocks' });
        const shape = model.map((e) => (e.type === 'item' ? e.id : e.type));
        expect(shape).toEqual([
            'ai',
            // 'forms' — the section id, not the old hard-coded 'form' item.
            // Forms became a Studio section in Track H2, so the special case
            // that used to append it here is gone and the registry answers.
            'divider', 'aiTasks', 'datatables', 'webpages', 'documents', 'apps', 'forms',
            'divider', 'agents', 'skills', 'knowledge', 'meetingNotes',
            'divider', 'playbooks', 'solutions',
        ]);
        // Every nav section that you can MAKE something in is an item — the
        // rail and the menu are the same list minus the sections that have
        // nothing to create. Runs is the one such section in the rail (you
        // cannot make a run; you make an automation and it runs), so its absence
        // here is asserted rather than merely tolerated.
        for (const app of STUDIO_APPS.filter((a) => !a.hiddenFromNav)) {
            expect(
                model.some((e) => e.type === 'item' && e.id === app.id),
                `item for ${app.id}`,
            ).toBe(!!app.create);
        }
        expect(model.some((e) => e.id === 'runs')).toBe(false);
    });

    it('tints every item in its kind colour, the Form item included', () => {
        const byId = Object.fromEntries(buildNewMenuModel(allOpen(), t).filter((e) => e.type === 'item').map((e) => [e.id, e]));
        expect(byId.aiTasks.color).toBe('var(--type-trigger)');
        expect(byId.datatables.color).toBe('var(--type-data)');
        expect(byId.apps.color).toBe('var(--kind-app)');
        expect(byId.webpages.color).toBe('var(--kind-web)');
        expect(byId.forms.color).toBe('var(--type-pause)');
        expect(byId.agents.color).toBe('var(--type-ai)');
        expect(byId.skills.color).toBe('var(--kind-skill)');
        expect(byId.knowledge.color).toBe('var(--kind-kb)');
        expect(byId.meetingNotes.color).toBe('var(--kind-meet)');
        // A solution is a container and deliberately neutral (artboard 1b).
        expect(byId.solutions.color).toBe('var(--text-secondary)');
        expect(byId.meetingNotes.label).toBe('Record or upload a meeting');
    });

    it('locked kinds stay listed, locked, with the rail\'s hint; Forms locks with Automations', () => {
        const byId = Object.fromEntries(buildNewMenuModel(community(), t).filter((e) => e.type === 'item').map((e) => [e.id, e]));
        expect(byId.apps.locked).toBe('ceiling');
        expect(byId.apps.lockHint).toBe('Available on a higher plan');
        expect(byId.skills.locked).toBe('not_granted');
        expect(byId.skills.lockHint).toBe('Not switched on for your organisation — ask an admin');
        expect(byId.aiTasks.locked).toBeNull();
        // Same entitlement as Automations, so on a Community org both are open.
        expect(byId.forms.locked).toBeNull();
        expect(byId.agents.locked).toBeNull();
    });

    it('drops the whole Build group — Forms with it — when no Build section is listed', () => {
        const noBuild = allOpen().filter((a) => a.category !== 'build');
        const shape = buildNewMenuModel(noBuild, t).map((e) => (e.type === 'item' ? e.id : e.type));
        expect(shape).toEqual(['ai', 'divider', 'agents', 'skills', 'knowledge', 'meetingNotes', 'divider', 'playbooks', 'solutions']);
    });

    it('a runtime module without a create entry is not in the menu', () => {
        const model = buildNewMenuModel([...allOpen(), { id: 'security', runtime: true, gate: () => true, locked: null }], t);
        expect(model.some((e) => e.id === 'security')).toBe(false);
        expect(model.some((e) => e.id === 'divider-modules')).toBe(false);
    });
});

describe('buildNewMenuModel — the AI row goes where a person may go', () => {
    // The row's destination until Track H4 is the Automations builder's assistant.
    // An enabled item that navigates into a section the server 403s is a
    // button that leads to a refusal, and Studio/index.jsx renders a section
    // even when its gate says no.
    const withoutAutomations = () => allOpen().filter((a) => a.id !== 'aiTasks');

    it('is open when Automations are open', () => {
        expect(buildNewMenuModel(allOpen(), t)[0].locked).toBeFalsy();
    });

    it('is LOCKED when the Automations section is locked, with the same hint the rail shows', () => {
        const sections = allOpen().map((a) => (a.id === 'aiTasks' ? { ...a, locked: 'ceiling' } : a));
        const ai = buildNewMenuModel(sections, t)[0];
        expect(ai.locked).toBe('ceiling');
        expect(typeof ai.lockHint).toBe('string');
        expect(ai.lockHint.length).toBeGreaterThan(0);
    });

    it('is LOCKED when the Automations section is not there at all', () => {
        expect(buildNewMenuModel(withoutAutomations(), t)[0].locked).toBeTruthy();
        expect(buildNewMenuModel([], t)[0].locked).toBeTruthy();
        expect(buildNewMenuModel(null, t)[0].locked).toBeTruthy();
    });

    it('follows a caller that owns the destination, and judges nothing', () => {
        // With its own onAi the row no longer goes to Automations, so a locked
        // Automations section says nothing about it.
        expect(buildNewMenuModel(withoutAutomations(), t, { hasAiHandler: true })[0].locked).toBeFalsy();
    });
});

describe('<NewMenu> — a locked AI row is a signpost, not a door', () => {
    it('does not navigate, and is disabled', () => {
        const onNavigate = vi.fn();
        const sections = allOpen().map((a) => (a.id === 'aiTasks' ? { ...a, locked: 'ceiling' } : a));
        render(<NewMenu open onClose={() => {}} anchorRef={{ current: document.body }} sections={sections} onNavigate={onNavigate} />);
        const ai = screen.getByTestId('new-menu-ai');
        expect(ai.hasAttribute('disabled')).toBe(true);
        expect(ai.getAttribute('data-locked')).toBe('true');
        fireEvent.click(ai);
        expect(onNavigate).not.toHaveBeenCalled();
    });
});

describe('<NewMenuButton> — the split trigger', () => {
    beforeEach(() => {
        cleanup();
        fetchMock.mockReset();
        toastMock.error.mockReset();
    });

    it('is the 32px accent capsule: plus | divider | chevron, never the ink fill', () => {
        render(<NewMenuButton sections={allOpen()} onNavigate={vi.fn()} />);
        const trigger = screen.getByTestId('new-menu-trigger');
        expect(trigger.style.background).toBe('var(--accent-primary)');
        expect(trigger.style.color).toBe('var(--accent-primary-fg)');
        expect(trigger.className).toContain('h-8');
        expect(trigger.className).toContain('rounded-[10px]');
        expect(screen.getByTestId('new-menu-primary').textContent).toContain('New');
        expect(screen.getByTestId('new-menu-chevron').getAttribute('aria-haspopup')).toBe('menu');
        expect(screen.queryByTestId('new-menu')).toBeNull();
    });

    it('opens the menu from either segment and lists the AI row first', () => {
        render(<NewMenuButton sections={allOpen()} onNavigate={vi.fn()} />);
        fireEvent.click(screen.getByTestId('new-menu-chevron'));
        const menu = screen.getByTestId('new-menu');
        expect(menu.getAttribute('role')).toBe('menu');
        const items = menu.querySelectorAll('[role="menuitem"]');
        expect(items[0].getAttribute('data-testid')).toBe('new-menu-ai');
        expect(items[0].style.background).toBe('color-mix(in srgb, var(--type-ai) 10%, transparent)');
        // Escape closes; the primary segment reopens.
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('new-menu')).toBeNull();
        fireEvent.click(screen.getByTestId('new-menu-primary'));
        expect(screen.getByTestId('new-menu')).toBeTruthy();
    });

    it('onPrimary takes the left segment; the chevron still opens the menu', () => {
        const onPrimary = vi.fn();
        render(<NewMenuButton sections={allOpen()} onNavigate={vi.fn()} onPrimary={onPrimary} />);
        fireEvent.click(screen.getByTestId('new-menu-primary'));
        expect(onPrimary).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('new-menu')).toBeNull();
        fireEvent.click(screen.getByTestId('new-menu-chevron'));
        expect(screen.getByTestId('new-menu')).toBeTruthy();
    });
});

describe('<NewMenu> — items', () => {
    beforeEach(() => {
        cleanup();
        fetchMock.mockReset();
        toastMock.error.mockReset();
    });

    const renderOpen = (props = {}) => {
        const anchorRef = { current: document.body };
        return render(<NewMenu open onClose={vi.fn()} anchorRef={anchorRef} sections={allOpen()} onNavigate={vi.fn()} {...props} />);
    };

    it('renders one menuitem per creatable registry section, in kind colour', () => {
        renderOpen();
        for (const app of STUDIO_APPS.filter((a) => !a.hiddenFromNav && a.create)) {
            expect(screen.getByTestId(`new-menu-${app.id}`), `item ${app.id}`).toBeTruthy();
        }
        // Runs is in the rail but not here: there is nothing to create.
        expect(screen.queryByTestId('new-menu-runs')).toBeNull();
        expect(screen.getByTestId('new-menu-forms').getAttribute('data-kind')).toBe('form');
        expect(screen.getByTestId('new-menu-knowledge').querySelector('svg').style.color).toBe('var(--kind-kb)');
        // Three dividers: Build · AI · Bundle.
        expect(screen.getByTestId('new-menu').querySelectorAll('[role="separator"]').length).toBe(3);
    });

    it('a navigation-only item navigates and closes', () => {
        const onNavigate = vi.fn();
        const onClose = vi.fn();
        renderOpen({ onNavigate, onClose });
        fireEvent.click(screen.getByTestId('new-menu-knowledge'));
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/new');
        return waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('with an onAi the row hands over to the caller and navigates nowhere', () => {
        // Track H4's building-block picker lives with the caller that mounts
        // it (StudioHomeHeader.jsx). Once it does, this menu must not ALSO
        // send the reader to the Automations assistant — one click, one screen.
        const onAi = vi.fn();
        const onNavigate = vi.fn();
        const onClose = vi.fn();
        renderOpen({ onNavigate, onClose, onAi });
        fireEvent.click(screen.getByTestId('new-menu-ai'));
        expect(onAi).toHaveBeenCalledTimes(1);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it('without one it still falls back to the automation builder assistant — and locks with it', () => {
        // The fallback is unchanged on purpose: a caller that does not own a
        // destination still ends up in Automations, so the row must be locked
        // exactly when Automations are. Both halves are asserted here, because
        // dropping the fallback would make the lock a rule about nothing.
        const onNavigate = vi.fn();
        const onClose = vi.fn();
        renderOpen({ onNavigate, onClose });
        fireEvent.click(screen.getByTestId('new-menu-ai'));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations');
        expect(onClose).toHaveBeenCalled();

        cleanup();
        const nav2 = vi.fn();
        const noAutomations = allOpen().map((a) => (a.id === 'aiTasks' ? { ...a, locked: 'ceiling' } : a));
        renderOpen({ onNavigate: nav2, sections: noAutomations });
        const ai = screen.getByTestId('new-menu-ai');
        expect(ai.hasAttribute('disabled')).toBe(true);
        fireEvent.click(ai);
        expect(nav2).not.toHaveBeenCalled();
    });

    it('Form opens the Forms section\'s own "New form" dialog — nothing is posted from the menu', async () => {
        // The choice "collect the answers in a table or start an automation" is
        // made before the automation exists, on the dialog; the menu only goes there.
        const onNavigate = vi.fn();
        renderOpen({ onNavigate });
        fireEvent.click(screen.getByTestId('new-menu-forms'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/forms/new'));
        // The open menu READS (the training gates); what must not happen is a write.
        const writes = fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
        expect(writes).toEqual([]);
    });

    it('createFormAutomation is exported for callers that want the same thing without the menu', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'au-x' }) });
        const onNavigate = vi.fn();
        await createFormAutomation({ onNavigate, t });
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/au-x');
    });

    it('a refused create toasts and keeps the menu open', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'feature_locked' });
        const onClose = vi.fn();
        renderOpen({ onClose });
        fireEvent.click(screen.getByTestId('new-menu-skills'));
        await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
        expect(toastMock.error.mock.calls[0][0]).toContain('Could not create it.');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('locked kinds are disabled with the lock hint and do nothing when clicked', () => {
        const onNavigate = vi.fn();
        const anchorRef = { current: document.body };
        render(<NewMenu open onClose={vi.fn()} anchorRef={anchorRef} sections={community()} onNavigate={onNavigate} />);
        const apps = screen.getByTestId('new-menu-apps');
        expect(apps.disabled).toBe(true);
        expect(apps.getAttribute('aria-disabled')).toBe('true');
        expect(apps.getAttribute('title')).toBe('Available on a higher plan');
        expect(screen.getByTestId('new-menu-skills').getAttribute('title')).toBe('Not switched on for your organisation — ask an admin');
        fireEvent.click(apps);
        expect(onNavigate).not.toHaveBeenCalled();
        // The open ones still work.
        expect(screen.getByTestId('new-menu-aiTasks').disabled).toBe(false);
        expect(screen.getByTestId('new-menu-forms').disabled).toBe(false);
    });
});

describe('required training folds into the same lock as a licence', () => {
    // The org made "Build Your First Agent" a prerequisite for creating agents.
    const lockFor = (areaId) => (areaId === 'agents'
        ? { areaId, courseId: 'course-build-agent', courseTitle: 'Build Your First Agent', lessonsDone: 4, lessonsTotal: 7 }
        : null);
    const byId = (model) => Object.fromEntries(model.filter((e) => e.type === 'item').map((e) => [e.id, e]));

    it('locks only the sections the rule names, with the course and the progress in the hint', () => {
        const items = byId(buildNewMenuModel(allOpen(), t, { lockFor }));
        expect(items.agents.locked).toBe('training');
        expect(items.agents.lockHint).toBe('Finish “Build Your First Agent” first — 4 of 7 lessons done');
        // A rule on agents says nothing about the rest of Studio.
        expect(items.knowledge.locked).toBeNull();
        expect(items.aiTasks.locked).toBeNull();
    });

    it('leaves every row open when the org has no rules', () => {
        const items = byId(buildNewMenuModel(allOpen(), t, { lockFor: () => null }));
        for (const item of Object.values(items)) expect(item.locked).toBeNull();
    });

    it('never overrides a licence lock — the plan is the harder wall', () => {
        // Apps is outside a Community plan AND would be training-gated; the
        // upgrade hint has to survive, because finishing a course would not
        // unlock it and telling someone otherwise sends them on an errand.
        const items = byId(buildNewMenuModel(community(), t, { lockFor: () => ({ courseTitle: 'Internal Tools', lessonsDone: 0, lessonsTotal: 8 }) }));
        expect(items.apps.locked).toBe('ceiling');
        expect(items.apps.lockHint).toBe('Available on a higher plan');
    });
});
