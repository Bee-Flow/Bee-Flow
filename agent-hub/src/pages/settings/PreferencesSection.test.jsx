import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('./SummaryTemplatesSection', () => ({ default: () => <div data-testid="summary-templates" /> }));
vi.mock('./VoiceprintSection', () => ({ default: () => <div data-testid="voiceprint" /> }));
vi.mock('./AiParticipationSection', () => ({ default: ({ enabled }) => <div data-testid="ai-participation" data-enabled={String(enabled)} /> }));

import LicenseContext from '../../components/licensing/LicenseContext';
import PreferencesSection from './PreferencesSection';
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

    it('shows an unmapped role as the raw role name, prettified (wart)', () => {
        // ROLE_LABELS is a hand-kept table; anything outside it — a custom
        // role, a DPO — is rendered by de-underscoring the stored identifier.
        // Whatever the server calls the role is what the user reads.
        mount({ user: { ...USER, orgRole: 'data_protection_officer' } });
        expect(screen.getByText('Data Protection Officer')).toBeInTheDocument();
    });

    it('prefers orgRole over role, and paints only admin roles green', () => {
        const { unmount } = mount({ user: { ...USER, orgRole: 'member', role: 'admin' } });
        const member = screen.getByText('Member');
        expect(member).toBeInTheDocument();
        expect(member.style.color).toBe('var(--text-muted)');
        unmount();

        mount({ user: { username: 'tom', role: 'admin' } });
        const admin = screen.getByText('Admin');
        expect(admin.style.color).toBe('rgb(5, 150, 105)');
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

    it('lifts a saved avatar to onUpdateUser', () => {
        const onUpdateUser = vi.fn();
        mount({ onUpdateUser });
        fireEvent.click(screen.getByTestId('avatar-picker'));
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
        serveLocales([{ code: 'en', name: 'English' }, { code: 'nl', name: 'Nederlands' }]);
        mount();
        await screen.findByText('Interface Language');

        fireEvent.click(rowTrigger('Interface Language'));
        fireEvent.click(screen.getByText('Nederlands'));
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

describe('PreferencesSection — chat history row', () => {
    it('defaults to "Per Agent" — the catalogue label, not the inline fallback', () => {
        mount();
        expect(screen.getByText('Chat History')).toBeInTheDocument();
        expect(screen.getByText('Choose how conversations appear in the sidebar')).toBeInTheDocument();
        // Source passes 'Per agent' / 'All chats' as fallbacks; the catalogue
        // wins, so the screen reads "Per Agent".
        expect(rowTrigger('Chat History').textContent).toContain('Per Agent');
    });

    it('persists a change to scoped storage and broadcasts it', () => {
        scopedStorage.setCurrentUser('u1');
        const events = [];
        const listener = e => events.push(e.detail);
        window.addEventListener('chatHistoryModeChanged', listener);

        mount();
        fireEvent.click(rowTrigger('Chat History'));
        fireEvent.click(screen.getByText('All Chats'));

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

    it('silently drops the preference when no user is scoped (wart)', () => {
        // scopedStorage no-ops without a current user: the dropdown shows the
        // new value, the broadcast fires, and nothing survives a reload.
        mount();
        fireEvent.click(rowTrigger('Chat History'));
        fireEvent.click(screen.getByText('All Chats'));
        expect(rowTrigger('Chat History').textContent).toContain('All Chats');
        expect(scopedStorage.getItem('chatHistoryMode')).toBeNull();
    });
});

describe('PreferencesSection — startup row', () => {
    it('shows the three startup options and reports the pick upward', () => {
        const setDefaultAgentMode = vi.fn();
        mount({ setDefaultAgentMode });
        expect(screen.getByText('Choose what opens when you launch Bee Flow')).toBeInTheDocument();
        expect(rowTrigger('Startup').textContent).toContain('Continue where you left off');

        fireEvent.click(rowTrigger('Startup'));
        expect(screen.getByText('Always open a specific agent')).toBeInTheDocument();
        expect(screen.getByText('Start with Direct Chat')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Start with Direct Chat'));
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
        expect(screen.getByText(/Show only New Chat, Search, Agents/).textContent)
            .not.toContain('Always on for small screens.');
    });

    it('saves the new value and lifts it, optimistically', async () => {
        const onUpdateUser = vi.fn();
        mount({ onUpdateUser });
        fireEvent.click(toggle());

        expect(onUpdateUser).toHaveBeenCalledWith({ simpleMode: true });
        expect(toggle()).toHaveAttribute('aria-pressed', 'true');
        await waitFor(() => {
            const post = authFetch.mock.calls.find(c => c[1]?.method === 'POST');
            expect(post[0]).toBe('/ai/user-settings');
            expect(JSON.parse(post[1].body)).toEqual({ simpleMode: true });
        });
    });

    it('reverts itself and the parent when the save throws', async () => {
        const onUpdateUser = vi.fn();
        authFetch.mockImplementation(async (url, init) => {
            if (init?.method === 'POST') throw new Error('offline');
            return { ok: true, json: async () => [] };
        });
        mount({ onUpdateUser });
        fireEvent.click(toggle());

        await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
        expect(onUpdateUser.mock.calls).toEqual([[{ simpleMode: true }], [{ simpleMode: false }]]);
        // No message, no retry — the revert is the entire feedback.
        expect(screen.queryByText(/failed/i)).toBeNull();
    });

    it('keeps the toggle ON when the server REFUSES the save (wart)', async () => {
        // The response status is never inspected: a 403/500 leaves the
        // optimistic value standing, so the screen claims a preference the
        // backend rejected. Only a thrown request is reverted.
        const onUpdateUser = vi.fn();
        authFetch.mockImplementation(async (url, init) => {
            if (init?.method === 'POST') return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
            return { ok: true, json: async () => [] };
        });
        mount({ onUpdateUser });
        fireEvent.click(toggle());

        await waitFor(() => expect(authFetch.mock.calls.some(c => c[1]?.method === 'POST')).toBe(true));
        expect(toggle()).toHaveAttribute('aria-pressed', 'true');
        expect(onUpdateUser.mock.calls).toEqual([[{ simpleMode: true }]]);
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
        viewport = { isMobile: true, isCompact: false, isDesktop: false, width: 390 };
        const onUpdateUser = vi.fn();
        mount({ onUpdateUser });
        fireEvent.click(toggle());
        expect(onUpdateUser).not.toHaveBeenCalled();
        expect(authFetch.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    });
});

describe('PreferencesSection — sign out and sub-sections', () => {
    it('renders the sign-out button only when a handler is passed', () => {
        const { unmount } = mount();
        expect(screen.queryByText('Sign out')).toBeNull();
        unmount();

        const onLogout = vi.fn();
        mount({ onLogout });
        fireEvent.click(screen.getByText('Sign out'));
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
