/**
 * CW-01 — the composer side of Cowork speaks through t(), not through English
 * baked into the JSX.
 *
 * The other suites in this folder stub t() as an IDENTITY translator (the
 * second argument, the English fallback, comes back out). That is the right
 * stub for asserting behaviour, but it cannot tell a translated string apart
 * from a hardcoded one: both render the same English.
 *
 * So this suite installs a translator that ECHOES THE KEY and throws the
 * fallback away. Under it anything that reached the screen through t() reads
 * as «some.key», and anything that did not still reads as English. Asserting
 * that the English is ABSENT is what makes these tests bite: paste a literal
 * back into the JSX and it reappears on screen.
 *
 * The keys themselves are asserted by shape (`cowork.*`), not one by one —
 * the property is "this string is reachable from the Languages panel", and a
 * list of forty exact keys would only pin today's spelling.
 */
import { act, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const echoT = (key) => `«${key}»`;
vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
}));

const api = vi.hoisted(() => ({ createCowork: null }));
vi.mock('./coworkApi', () => ({
    composeCowork: async () => null,
    createCowork: (...a) => api.createCowork(...a),
    listCoworkAgents: async () => [],
}));
vi.mock('../licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ loading: false, can: () => false }),
}));

const catalog = vi.hoisted(() => ({ state: null }));
vi.mock('../../hooks/useAppsCatalog', () => ({ default: () => catalog.state }));
vi.mock('../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => ({ integrationStatus: { isGoogleUser: true }, unavailable: false }),
}));

import CoworkComposer, { COWORK_PLACEHOLDER } from './CoworkComposer';
import CoworkEditForm from './CoworkEditForm';
import CoworkOptionsBar from './CoworkOptionsBar';
import { COWORK_REPEAT_OPTIONS, WHEN_PRESETS } from './coworkSchedule';
import CoworkWelcome, { COWORK_HEADING, COWORK_SUBHEADING, COWORK_STARTER_ITEMS } from './CoworkWelcome';
import useCoworkComposer from './useCoworkComposer';

beforeEach(() => {
    catalog.state = { availableApps: [], isAppEnabled: () => true, toggleApp: vi.fn() };
    api.createCowork = async (payload) => ({ id: 'cw1', ...payload });
});

const coworkStub = (over = {}) => ({
    when: { presetId: 'now', date: '', time: '' },
    setWhen: vi.fn(),
    repeatInterval: '',
    setRepeatInterval: vi.fn(),
    agentId: '',
    setAgentId: vi.fn(),
    agents: [],
    enabledApps: null,
    setEnabledApps: vi.fn(),
    submitting: false,
    error: null,
    scheduleReady: true,
    summary: 'Runs now',
    ...over,
});

/** Every «key» the render put on screen. */
const keysOnScreen = (container) =>
    [...(container.innerHTML.matchAll(/«([\w.-]+)»/g))].map(m => m[1]);

describe('CW-01 — CoworkWelcome', () => {
    it('translates the heading and the subheading', () => {
        const { container } = render(<CoworkWelcome />);
        expect(screen.getByText('«cowork.welcome.heading»')).toBeInTheDocument();
        expect(screen.getByText('«cowork.welcome.subheading»')).toBeInTheDocument();
        expect(container.textContent).not.toContain(COWORK_HEADING);
        expect(container.textContent).not.toContain(COWORK_SUBHEADING);
    });

    it('translates every starter', () => {
        const { container } = render(<CoworkWelcome />);
        const starters = screen.getAllByTestId('cowork-starter');
        expect(starters).toHaveLength(COWORK_STARTER_ITEMS.length);
        for (const { key, en } of COWORK_STARTER_ITEMS) {
            expect(starters.some(b => b.textContent === `«${key}»`)).toBe(true);
            expect(container.textContent).not.toContain(en);
        }
    });

    it('a starter fills the box with the TRANSLATED sentence, not the English behind it', () => {
        // The starter is a draft the user then edits. Handing over the English
        // while the button shows Dutch would put a language they are not
        // writing in into their own composer.
        const onStarterClick = vi.fn();
        render(<CoworkWelcome onStarterClick={onStarterClick} />);
        fireEvent.click(screen.getAllByTestId('cowork-starter')[0]);
        expect(onStarterClick).toHaveBeenCalledWith(`«${COWORK_STARTER_ITEMS[0].key}»`);
    });
});

describe('CW-01 — CoworkComposer', () => {
    const setup = (over = {}) => render(
        <CoworkComposer
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            cowork={coworkStub(over.coworkOver)}
            {...over}
        />,
    );

    it('translates the placeholder and both accessible names', () => {
        const { container } = setup();
        const brief = screen.getByTestId('cowork-brief-input');
        expect(brief.getAttribute('placeholder')).toBe('«cowork.composer.placeholder»');
        expect(brief.getAttribute('aria-label')).toBe('«cowork.composer.brief_aria»');
        expect(screen.getByTestId('cowork-composer').getAttribute('aria-label'))
            .toBe('«cowork.composer.form_aria»');
        expect(container.innerHTML).not.toContain(COWORK_PLACEHOLDER);
    });

    it('picks a different KEY for Run and for Schedule — not one key with two English strings', () => {
        // A ternary around the string leaves a single key that can only ever
        // hold one of the two words; the choice has to be a key choice.
        setup();
        expect(screen.getByTestId('cowork-send').textContent).toContain('«cowork.composer.run»');

        setup({ coworkOver: { when: { presetId: 'custom', date: '2026-01-01', time: '09:00' } } });
        const [, later] = screen.getAllByTestId('cowork-send');
        expect(later.textContent).toContain('«cowork.composer.schedule»');
    });

    it('translates the pending label while it is starting', () => {
        setup({ coworkOver: { submitting: true } });
        expect(screen.getByTestId('cowork-send').textContent).toContain('«cowork.composer.starting»');
    });
});

describe('CW-01 — CoworkOptionsBar', () => {
    const setup = (over = {}) => render(
        <CoworkOptionsBar
            when={{ presetId: 'now', date: '', time: '' }}
            onWhenChange={vi.fn()}
            repeatInterval=""
            onRepeatChange={vi.fn()}
            agentId=""
            onAgentChange={vi.fn()}
            agents={[]}
            {...over}
        />,
    );

    it('translates all three chips', () => {
        setup({ agents: [{ id: 'a1', name: 'Sales bot' }] });
        expect(screen.getByTestId('cowork-when-chip').textContent).toContain('«cowork.when.chip_now»');
        expect(screen.getByTestId('cowork-repeat-chip').textContent).toContain('«cowork.repeat.once»');
        expect(screen.getByTestId('cowork-agent-chip').textContent).toContain('«cowork.agent.none»');
    });

    it('translates the When sheet and every preset in it', () => {
        const { container } = setup();
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        expect(screen.getByText('«cowork.when.sheet_title»')).toBeInTheDocument();
        expect(screen.getByText('«cowork.when.sheet_subtitle»')).toBeInTheDocument();
        for (const p of WHEN_PRESETS) {
            expect(screen.getAllByText(`«${p.labelKey}»`).length).toBeGreaterThan(0);
            expect(container.textContent).not.toContain(p.label);
        }
    });

    it('translates the Repeat sheet and every interval in it', () => {
        const { container } = setup();
        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));
        expect(screen.getByText('«cowork.repeat.sheet_title»')).toBeInTheDocument();
        for (const o of COWORK_REPEAT_OPTIONS) {
            // "Once" also sits on the chip behind the sheet, hence getAllByText.
            expect(screen.getAllByText(`«${o.labelKey}»`).length).toBeGreaterThan(0);
            expect(container.textContent).not.toContain(o.label);
        }
    });

    it('translates the agent sheet but leaves the agent NAMES alone', () => {
        // An agent's name is the user's own data. Running it through t() would
        // turn "Sales bot" into a key lookup that can never hit.
        setup({ agents: [{ id: 'a1', name: 'Sales bot', description: 'Handles quotes' }] });
        fireEvent.click(screen.getByTestId('cowork-agent-chip'));
        expect(screen.getByText('«cowork.agent.sheet_title»')).toBeInTheDocument();
        expect(screen.getByText('«cowork.agent.sheet_hint»')).toBeInTheDocument();
        expect(screen.getByText('«cowork.agent.none_hint»')).toBeInTheDocument();
        expect(screen.getByText('Sales bot')).toBeInTheDocument();
        expect(screen.getByText('Handles quotes')).toBeInTheDocument();
    });

    it('an unnamed agent falls back to a TRANSLATED placeholder name', () => {
        setup({ agents: [{ id: 'a1', name: '' }] });
        fireEvent.click(screen.getByTestId('cowork-agent-chip'));
        expect(screen.getByText('«cowork.agent.untitled»')).toBeInTheDocument();
    });
});

describe('CW-01 — CoworkEditForm', () => {
    const item = {
        id: 'c1',
        title: 'Monthly digest',
        prompt: 'Summarise the month',
        repeatInterval: 'weekly',
        daysOfWeek: [],
        nextRunAt: '2026-02-03T09:00:00.000Z',
    };
    const setup = (over = {}) => render(
        <CoworkEditForm item={item} onSave={vi.fn()} onCancel={vi.fn()} {...over} />,
    );

    it('translates every field label and both buttons', () => {
        const { container } = setup();
        for (const key of [
            'cowork.edit.name', 'cowork.edit.what_it_does', 'cowork.edit.what_it_does_hint',
            'cowork.edit.next_run', 'cowork.edit.at', 'cowork.edit.repeat',
            'cowork.edit.save', 'cowork.edit.cancel',
        ]) {
            expect(screen.getAllByText(`«${key}»`).length).toBeGreaterThan(0);
        }
        // The user's own title and prompt are values, not copy.
        expect(screen.getByTestId('cowork-edit-title')).toHaveValue('Monthly digest');
        expect(container.textContent).not.toContain('What it does');
    });

    it('translates the day buttons — "Mo" is copy, "mon" is the stored token', () => {
        const { container } = setup();
        const mon = screen.getByTestId('cowork-edit-day-mon');
        expect(mon.textContent).toBe('«cowork.day.mon»');
        expect(container.textContent).not.toMatch(/\bMo\b/);
    });

    it('the repeat <select> shows translated options', () => {
        setup();
        const opts = [...screen.getByTestId('cowork-edit-repeat').options].map(o => o.textContent);
        expect(opts).toEqual(COWORK_REPEAT_OPTIONS.map(o => `«${o.labelKey}»`));
    });

    it('the saving label is its own key, not one key holding two words', () => {
        setup({ saving: true });
        expect(screen.getByTestId('cowork-edit-save').textContent).toContain('«cowork.edit.saving»');
    });

    it('the apps counter interpolates rather than concatenating English around numbers', () => {
        catalog.state = {
            availableApps: [{ id: 'gmail', label: 'Gmail' }, { id: 'drive', label: 'Drive' }],
            isAppEnabled: () => true,
            toggleApp: vi.fn(),
        };
        const { container } = setup();
        expect(screen.getByText('«cowork.edit.apps_enabled_count»')).toBeInTheDocument();
        expect(container.textContent).not.toContain(' of ');
    });

    it('the two apps hints are two KEYS, chosen by whether the item has its own list', () => {
        catalog.state = {
            availableApps: [{ id: 'gmail', label: 'Gmail' }],
            isAppEnabled: () => true,
            toggleApp: vi.fn(),
        };
        const inherited = setup();
        expect(keysOnScreen(inherited.container)).toContain('cowork.edit.apps_inherit_hint');
        inherited.unmount();

        const own = setup({ item: { ...item, enabledApps: ['gmail'] } });
        expect(keysOnScreen(own.container)).toContain('cowork.edit.apps_own_hint');
    });
});

describe('CW-01 — useCoworkComposer', () => {
    /** Drives the hook without a UI. */
    function harness() {
        const out = {};
        function Probe() {
            Object.assign(out, useCoworkComposer({ onCreated: () => {} }));
            return null;
        }
        render(<Probe />);
        return out;
    }

    it('translates the "no moment picked" error it raises itself', async () => {
        const hook = harness();
        // 'custom' with empty inputs is the one unschedulable state.
        await act(async () => { hook.setWhen({ presetId: 'custom', date: '', time: '' }); });
        await act(async () => { await hook.submit('Do the thing'); });
        expect(hook.error).toBe('«cowork.error.pick_moment»');
    });

    it('translates its own create failure, but keeps a server sentence verbatim', async () => {
        // The server's message says WHY. Replacing it with a key of our own
        // would throw the only specific information away.
        api.createCowork = async () => { throw new Error('Quota reached for this workspace'); };
        const withServerMessage = harness();
        await act(async () => { await withServerMessage.submit('Do the thing'); });
        expect(withServerMessage.error).toBe('Quota reached for this workspace');

        api.createCowork = async () => { throw new Error(''); };
        const withoutMessage = harness();
        await act(async () => { await withoutMessage.submit('Do the thing'); });
        expect(withoutMessage.error).toBe('«cowork.error.create_failed»');
    });
});
