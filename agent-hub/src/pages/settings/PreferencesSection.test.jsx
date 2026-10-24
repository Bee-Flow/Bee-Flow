import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of Settings → Preferences: the profile strip, the four
 * rows of the General container (language, chat history, startup, Simple
 * Mode) and the sign-out button.
 *
 * i18n is NOT stubbed — t() resolves against the real EN catalogue, so the
 * strings below are the strings a user reads. That matters here more than
 * usual: three rows pass an inline fallback that the catalogue overrides
 * ("Simple Mode" → "Enable Simple Mode", "Per agent" → "Per Agent"), so a
 * test written against the source's fallback string would assert something
 * nobody ever sees. `setLocale` is the one thing replaced with a spy — the
 * provider-less hook's setLocale is a no-op, and the language row's only
 * observable job is to call it.
 *
 * The self-hiding sub-sections (meeting notes, summary templates, voiceprint)
 * are stubbed; each has its own file.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const setLocale = vi.fn();
vi.mock('../../hooks/useTranslation', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useTranslation: () => ({ ...actual.useTranslation(), setLocale }),
    };
});

let viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };
vi.mock('../../hooks/useViewport', () => ({
    useViewport: () => viewport,
    default: () => viewport,
}));

vi.mock('./AvatarPicker', () => ({
    default: ({ user, onSaved }) => (
        <button data-testid="avatar-picker" data-user={user?.username || ''} onClick={() => onSaved('🐝', 'emoji')}>
            avatar
        </button>
    ),
}));
vi.mock('./MeetingNotesSection', () => ({ default: () => <div data-testid="meeting-notes" /> }));
vi.mock('./GoogleMeetNotesSection', () => ({ default: () => <div data-testid="google-meet-notes" /> }));
vi.mock('./TeamsMeetingNotesSection', () => ({ default: () => <div data-testid="teams-meeting-notes" /> }));
vi.mock('./SummaryTemplatesSection', () => ({ default: () => <div data-testid="summary-templates" /> }));
vi.mock('./VoiceprintSection', () => ({ default: () => <div data-testid="voiceprint" /> }));
vi.mock('./AiParticipationSection', () => ({ default: ({ enabled }) => <div data-testid="ai-participation" data-enabled={String(enabled)} /> }));

import PreferencesSection from './PreferencesSection';
import LicenseContext from '../../components/licensing/LicenseContext';
import { authFetch } from '../../utils/helpers';
import scopedStorage from '../../utils/scopedStorage';

const USER = { id: 'u1', username: 'tom', displayName: 'Tom Smit', email: 'tom@example.com', orgRole: 'org_admin' };
const AGENTS = [{ id: 'a1', name: 'Scribe' }, { id: 'a2', name: 'Analyst' }];

/** The locales endpoint is the only call the section makes on mount. */
function serveLocales(list) {
    authFetch.mockImplementation(async (url) => {
        if (String(url).includes('/api/languages/user/locales')) {
            return { ok: true, json: async () => list };
        }
        return { ok: true, json: async () => ({}) };
    });
}

function mount(props = {}) {
    return render(
        <PreferencesSection
            defaultAgentMode="last-used"
            setDefaultAgentMode={props.setDefaultAgentMode || vi.fn()}
            defaultAgentId=""
            setDefaultAgentId={props.setDefaultAgentId || vi.fn()}
            agents={AGENTS}
            user={USER}
            {...props}
        />,
    );
}

/** The dropdown trigger sitting in the row with this label. */
function rowTrigger(label) {
    return screen.getByText(label).closest('div.flex').querySelector('button');
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    scopedStorage.setCurrentUser(null);
    viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };
    serveLocales([]);
});

describe('PreferencesSection — page title', () => {
    it('names the page with an h2, like the other settings pages', () => {
        mount();
        expect(screen.getByRole('heading', { level: 2, name: 'Preferences' })).toBeInTheDocument();
    });
});

describe('PreferencesSection — profile strip', () => {
    it('shows display name, mapped role label and email', async () => {
        mount();
        expect(screen.getByText('Tom Smit')).toBeInTheDocument();
        expect(screen.getByText('Organisation Admin')).toBeInTheDocument();
        expect(screen.getByText('tom@example.com')).toBeInTheDocument();
        expect(screen.getByTestId('avatar-picker')).toHaveAttribute('data-user', 'tom');
    });

    it('falls back to the username, then to "User"', () => {
        const { unmount } = mount({ user: { username: 'tom' } });
        expect(screen.getByText('tom')).toBeInTheDocument();
        unmount();
        mount({ user: { id: 'x' } });
        expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('names the org roles as the role pickers do (ORG_ROLES), not as prettified ids', () => {
        const { unmount } = mount({ user: { ...USER, orgRole: 'dpo' } });
        expect(screen.getByText('Data Protection Officer')).toBeInTheDocument();
        expect(screen.queryByText('Dpo')).toBeNull();
        unmount();
        mount({ user: { ...USER, orgRole: 'isms_auditor' } });
        expect(screen.getByText('ISMS Internal Auditor')).toBeInTheDocument();
        expect(screen.queryByText('Isms Auditor')).toBeNull();
    });

    it('shows a role outside ORG_ROLES as the raw role name, prettified', () => {
        mount({ user: { ...USER, orgRole: 'team_lead' } });
        expect(screen.getByText('Team Lead')).toBeInTheDocument();
    });

    it('prefers orgRole over role, and paints only admin roles in the success colour', () => {
        const { unmount } = mount({ user: { ...USER, orgRole: 'member', role: 'admin' } });
        const member = screen.getByText('Member');
        expect(member).toBeInTheDocument();
        expect(member).toHaveClass('text-[var(--text-muted)]');
        unmount();

        mount({ user: { username: 'tom', role: 'admin' } });
        const admin = screen.getByText('Admin');
        expect(admin).toHaveClass('text-[var(--success-ink)]');
    });

    it('omits the badge when the account carries no role at all', () => {
        mount({ user: { username: 'tom' } });
        expect(screen.queryByText('User')).toBeNull();   // no role badge…
        expect(screen.getByText('tom')).toBeInTheDocument();  // …but the strip is there
    });

    it('drops the whole strip when there is no user', () => {
        mount({ user: null });
        expect(screen.queryByTestId('avatar-picker')).toBeNull();
        // The General container still renders.
        expect(screen.getByText('General')).toBeInTheDocument();
    });

    it('keeps the previous user on screen when the prop goes null (wart)', () => {
        // The sync effect is `if (user) setLocalUser(user)` — clearing the
        // session leaves the old name, role and e-mail address rendered until
        // the screen unmounts.
        const { rerender } = mount();
        rerender(
            <PreferencesSection defaultAgentMode="last-used" setDefaultAgentMode={vi.fn()}
                defaultAgentId="" setDefaultAgentId={vi.fn()} agents={AGENTS} user={null} />,
        );
        expect(screen.getByText('Tom Smit')).toBeInTheDocument();
        expect(screen.getByText('tom@example.com')).toBeInTheDocument();
    });

    it('follows a user prop that changes to another account', () => {
        const { rerender } = mount();
        rerender(
            <PreferencesSection defaultAgentMode="last-used" setDefaultAgentMode={vi.fn()}
                defaultAgentId="" setDefaultAgentId={vi.fn()} agents={AGENTS}
                user={{ username: 'ann', displayName: 'Ann', orgRole: 'member' }} />,
        );
        expect(screen.getByText('Ann')).toBeInTheDocument();
        expect(screen.queryByText('Tom Smit')).toBeNull();
    });

    it('lifts a saved avatar to onUpdateUser', async () => {
        const user = userEvent.setup();
        const onUpdateUser = vi.fn();
        mount({ onUpdateUser });
        await user.click(screen.getByTestId('avatar-picker'));
        expect(onUpdateUser).toHaveBeenCalledWith({ avatar: '🐝', avatarType: 'emoji' });
    });
});

describe('PreferencesSection — interface language row', () => {
    it('is hidden when the deployment offers a single locale', async () => {
        serveLocales([{ code: 'en', name: 'English' }]);
        mount();
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByText('Interface Language')).toBeNull();
    });

    it('appears once a second locale exists and calls setLocale on pick', async () => {
        const user = userEvent.setup();
        serveLocales([{ code: 'en', name: 'English' }, { code: 'nl', name: 'Nederlands' }]);
        mount();
        await screen.findByText('Interface Language');

        await user.click(rowTrigger('Interface Language'));
        await user.click(screen.getByText('Nederlands'));
        expect(setLocale).toHaveBeenCalledWith('nl');
    });

    it('stays hidden when the locales call fails, and warns', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        authFetch.mockRejectedValue(new Error('offline'));
        mount();
        await waitFor(() => expect(warn).toHaveBeenCalledWith('[Preferences] load locales failed', expect.any(Error)));
        expect(screen.queryByText('Interface Language')).toBeNull();
        warn.mockRestore();
    });

    it('stays hidden when the endpoint answers with a non-array body', async () => {
        authFetch.mockResolvedValue({ ok: true, json: async () => ({ locales: ['en', 'nl'] }) });
        mount();
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByText('Interface Language')).toBeNull();
    });
});

describe('PreferencesSection — dropdown semantics', () => {
    it('announces a listbox popup, its state and the row it belongs to', async () => {
        const user = userEvent.setup();
        mount();
        const trigger = rowTrigger('Chat History');
        expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveAccessibleName('Chat History: Per Agent');

        await user.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const listbox = screen.getByRole('listbox', { name: 'Chat History' });
        expect(listbox).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Per Agent' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('option', { name: 'All Chats' })).toHaveAttribute('aria-selected', 'false');
    });

    it('closes on Escape and returns focus to the trigger', async () => {
        const user = userEvent.setup();
        mount();
        const trigger = rowTrigger('Startup');
        await user.click(trigger);
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveFocus();
    });
});

describe('PreferencesSection — chat history row', () => {
    it('defaults to "Per Agent" — the catalogue label, not the inline fallback', () => {
        mount();
        expect(screen.getByText('Chat History')).toBeInTheDocument();
        expect(screen.getByText('Choose how conversations appear in the sidebar')).toBeInTheDocument();
        // Source passes 'Per agent' / 'All chats' as fallbacks; the catalogue
        // wins, so the screen reads "Per Agent".
        expect(rowTrigger('Chat History').textContent).toContain('Per Agent');
    });

    it('persists a change to scoped storage and broadcasts it', async () => {
        const user = userEvent.setup();
        scopedStorage.setCurrentUser('u1');
        const events = [];
        const listener = e => events.push(e.detail);
        window.addEventListener('chatHistoryModeChanged', listener);

        mount();
        await user.click(rowTrigger('Chat History'));
        await user.click(screen.getByText('All Chats'));

        expect(scopedStorage.getItem('chatHistoryMode')).toBe('all-chats');
        expect(events).toEqual(['all-chats']);
        expect(rowTrigger('Chat History').textContent).toContain('All Chats');
        window.removeEventListener('chatHistoryModeChanged', listener);
    });

    it('reads the stored value on mount', () => {
        scopedStorage.setCurrentUser('u1');
        scopedStorage.setItem('chatHistoryMode', 'all-chats');
        mount();
        expect(rowTrigger('Chat History').textContent).toContain('All Chats');
    });

    it('silently drops the preference when no user is scoped (wart)', async () => {
        const user = userEvent.setup();
        // scopedStorage no-ops without a current user: the dropdown shows the
        // new value, the broadcast fires, and nothing survives a reload.
        mount();
        await user.click(rowTrigger('Chat History'));
        await user.click(screen.getByText('All Chats'));
        expect(rowTrigger('Chat History').textContent).toContain('All Chats');
        expect(scopedStorage.getItem('chatHistoryMode')).toBeNull();
    });
});

describe('PreferencesSection — startup row', () => {
    it('shows the three startup options and reports the pick upward', async () => {
        const user = userEvent.setup();
        const setDefaultAgentMode = vi.fn();
        mount({ setDefaultAgentMode });
        expect(screen.getByText('Choose what opens when you launch Bee Flow')).toBeInTheDocument();
        expect(rowTrigger('Startup').textContent).toContain('Continue where you left off');

        await user.click(rowTrigger('Startup'));
        expect(screen.getByText('Always open a specific agent')).toBeInTheDocument();
        expect(screen.getByText('Start with Direct Chat')).toBeInTheDocument();
        await user.click(screen.getByText('Start with Direct Chat'));
        expect(setDefaultAgentMode).toHaveBeenCalledWith('direct-chat');
    });

    it('reveals the agent picker only in "specific" mode, listing the agents passed in', () => {
        const setDefaultAgentId = vi.fn();
        const { unmount } = mount();
        expect(screen.queryByText('Select agent')).toBeNull();
        unmount();

        const { container } = mount({ defaultAgentMode: 'specific', setDefaultAgentId });
        expect(screen.getByText('Select agent')).toBeInTheDocument();
        const select = container.querySelector('select');
        expect([...select.options].map(o => o.textContent)).toEqual(['Select an agent...', 'Scribe', 'Analyst']);

        fireEvent.change(select, { target: { value: 'a2' } });
        expect(setDefaultAgentId).toHaveBeenCalledWith('a2');
    });
});

describe('PreferencesSection — Simple Mode', () => {
    const toggle = () => screen.getByText('Enable Simple Mode').closest('div.flex').querySelector('button[aria-pressed]');

    it('reads "Enable Simple Mode", off by default, with no mobile note on desktop', () => {
        mount();
        expect(screen.getByText('Enable Simple Mode')).toBeInTheDocument();
        expect(toggle()).toHaveAttribute('aria-pressed', 'false');
        // The switch carries the row title as its name.
        expect(screen.getByRole('button', { name: 'Enable Simple Mode', pressed: false })).toBe(toggle());
        expect(screen.getByText(/Show only New Chat, Search, Agents/).textContent)
            .not.toContain('Always on for small screens.');
    });

    it('saves the new value and lifts it, optimistically', async () => {
        const user = userEvent.setup();
        const onUpdateUser = vi.fn();
        mount({ onUpdateUser });
        await user.click(toggle());

        expect(onUpdateUser).toHaveBeenCalledWith({ simpleMode: true });
        expect(toggle()).toHaveAttribute('aria-pressed', 'true');
        await waitFor(() => {
            const post = authFetch.mock.calls.find(c => c[1]?.method === 'POST');
            expect(post[0]).toBe('/ai/user-settings');
            expect(JSON.parse(post[1].body)).toEqual({ simpleMode: true });
        });
    });

    it('reverts itself and the parent when the save throws', async () => {
        const user = userEvent.setup();
        const onUpdateUser = vi.fn();
        authFetch.mockImplementation(async (url, init) => {
            if (init?.method === 'POST') throw new Error('offline');
            return { ok: true, json: async () => [] };
        });
        mount({ onUpdateUser });
        await user.click(toggle());

        await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
        expect(onUpdateUser.mock.calls).toEqual([[{ simpleMode: true }], [{ simpleMode: false }]]);
        // No message, no retry — the revert is the entire feedback.
        expect(screen.queryByText(/failed/i)).toBeNull();
    });

    it('reverts the toggle when the server REFUSES the save', async () => {
        const user = userEvent.setup();
        // The save goes through mutate(), which throws on a 403/500, so a
        // refused save is reverted like a failed request instead of leaving
        // the optimistic value standing on screen.
        const onUpdateUser = vi.fn();
        authFetch.mockImplementation(async (url, init) => {
            if (init?.method === 'POST') return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
            return { ok: true, json: async () => [] };
        });
        mount({ onUpdateUser });
        await user.click(toggle());

        await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
        expect(authFetch.mock.calls.some(c => c[1]?.method === 'POST')).toBe(true);
        expect(onUpdateUser.mock.calls).toEqual([[{ simpleMode: true }], [{ simpleMode: false }]]);
    });

    it('hides Chat History and Startup while Simple Mode is on', () => {
        mount({ user: { ...USER, simpleMode: true } });
        expect(toggle()).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByText('Chat History')).toBeNull();
        expect(screen.queryByText('Startup')).toBeNull();
        expect(screen.getByText('General')).toBeInTheDocument();
    });

    it('shows on + locked on a phone, whatever the stored preference says', () => {
        viewport = { isMobile: true, isCompact: false, isDesktop: false, width: 390 };
        mount();   // user.simpleMode is falsy
        expect(toggle()).toHaveAttribute('aria-pressed', 'true');
        expect(toggle()).toBeDisabled();
        expect(screen.getByText(/Show only New Chat, Search, Agents/).textContent)
            .toContain('Always on for small screens.');
        // …and the rows it hides on desktop stay visible, because the stored
        // preference is still off.
        expect(screen.getByText('Chat History')).toBeInTheDocument();
        expect(screen.getByText('Startup')).toBeInTheDocument();
    });

    it('saves nothing from a phone — the lock is client-side only', async () => {
        const user = userEvent.setup();
        viewport = { isMobile: true, isCompact: false, isDesktop: false, width: 390 };
        const onUpdateUser = vi.fn();
        mount({ onUpdateUser });
        await user.click(toggle());
        expect(onUpdateUser).not.toHaveBeenCalled();
        expect(authFetch.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    });
});

describe('PreferencesSection — sign out and sub-sections', () => {
    it('renders the sign-out button only when a handler is passed', async () => {
        const { unmount } = mount();
        expect(screen.queryByRole('button', { name: 'Sign Out' })).toBeNull();
        unmount();

        const onLogout = vi.fn();
        mount({ onLogout });
        // The same words (sidebar.sign_out) as the profile menu's sign-out.
        await userEvent.setup().click(screen.getByRole('button', { name: 'Sign Out' }));
        expect(onLogout).toHaveBeenCalledTimes(1);
    });

    it('always mounts the four self-hiding sub-sections, Simple Mode included', () => {
        mount({ user: { ...USER, simpleMode: true } });
        for (const id of ['meeting-notes', 'google-meet-notes', 'summary-templates', 'voiceprint']) {
            expect(screen.getByTestId(id)).toBeInTheDocument();
        }
    });
});

describe('PreferencesSection — AI in team chats', () => {
    // The setting acts only in project team chats and comment threads.
    const withPlan = (hasProjects, user = USER) => render(
        <LicenseContext.Provider value={{ hasFeature: (name) => hasProjects && name === 'projects' }}>
            <PreferencesSection defaultAgentMode="last-used" setDefaultAgentMode={vi.fn()} defaultAgentId="" setDefaultAgentId={vi.fn()} agents={AGENTS} user={user} />
        </LicenseContext.Provider>,
    );

    it('is offered where Projects can be used', () => {
        withPlan(true);
        expect(screen.getByTestId('ai-participation')).toHaveAttribute('data-enabled', 'true');
    });

    it('is not offered on a plan without Projects, or where the operator switched them off', () => {
        const { unmount } = withPlan(false);
        expect(screen.getByTestId('ai-participation')).toHaveAttribute('data-enabled', 'false');
        unmount();
        withPlan(true, { ...USER, featureFlags: { projects: false } });
        expect(screen.getByTestId('ai-participation')).toHaveAttribute('data-enabled', 'false');
    });
});
