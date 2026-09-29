import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CoworkEditForm from './CoworkEditForm';

/**
 * CHARACTERISATION — the edit form for one cowork schedule, exactly as it
 * behaves today.
 *
 * The schedule was INFERRED from one sentence, so this form is the correction
 * mechanism, and what it does with a half-filled field matters as much as the
 * happy path. Several tests below are named "wrat": they pin what happens when
 * a field is cleared, and none of it is what a user would expect.
 *
 * The apps catalogue is stubbed at the hook boundary; useCoworkApps and
 * AppsPicker are the real thing, as on the page.
 */

/**
 * The component's own source. The i18n wart below cannot be seen from the
 * rendered DOM — `t('key', 'Chat')` renders "Chat" as well — so the pin has to
 * read the module that produced it.
 */
const FORM_SOURCE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'CoworkEditForm.jsx'),
    'utf8',
);

const catalog = vi.hoisted(() => ({ state: null }));

vi.mock('../../hooks/useAppsCatalog', () => ({
    default: () => catalog.state,
}));

/**
 * The catalogue is stubbed above, but useCoworkApps reads the workspace
 * settings itself — that read is how it tells "you have no apps" from "we
 * could not ask". Default here is a read that answered; the unreadable case
 * flips `workspaceRead.unavailable`.
 */
const workspaceRead = vi.hoisted(() => ({ integrationStatus: { isGoogleUser: true }, unavailable: false }));

vi.mock('../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => workspaceRead,
}));

const app = (id, label, over = {}) => ({
    id,
    label,
    description: `${label} description`,
    iconSvg: () => <span data-testid={`icon-${id}`} />,
    ...over,
});

const APPS = [app('gmail', 'Gmail'), app('google-drive', 'Google Drive'), app('step_s1', 'Weekly report', { isStep: true })];

function setCatalog(over = {}) {
    catalog.state = {
        availableApps: APPS,
        isAppEnabled: (id) => id === 'gmail',
        toggleApp: vi.fn(),
        ...over,
    };
    return catalog.state;
}

// A concrete local moment, so date/time assertions hold in any TZ.
const NEXT_RUN = new Date(2026, 8, 14, 9, 30, 0);   // Mon 14 Sep 2026, 09:30

const item = (over = {}) => ({
    id: 'w1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    repeatInterval: 'weekly',
    daysOfWeek: null,
    nextRunAt: NEXT_RUN.toISOString(),
    agentId: '',
    ...over,
});

function setup(over = {}) {
    const props = {
        item: item(over.itemOver),
        agents: [],
        onSave: vi.fn(),
        onCancel: vi.fn(),
        saving: false,
        error: null,
        ...over,
    };
    delete props.itemOver;
    const utils = render(<CoworkEditForm {...props} />);
    return { ...utils, props };
}

const save = () => screen.getByTestId('cowork-edit-save');
const savedPayload = (props) => props.onSave.mock.calls[0][0];

beforeEach(() => {
    workspaceRead.integrationStatus = { isGoogleUser: true };
    workspaceRead.unavailable = false;
    setCatalog();
});

describe('CoworkEditForm — what it shows on open', () => {
    it('prefills the name and the instruction from the item', () => {
        setup();
        expect(screen.getByTestId('cowork-edit-title')).toHaveValue('Weekly digest');
        expect(screen.getByTestId('cowork-edit-prompt')).toHaveValue('Summarise the week');
    });

    it('prefills the next run as local date and time, not UTC', () => {
        setup();
        expect(screen.getByTestId('cowork-edit-date')).toHaveValue('2026-09-14');
        expect(screen.getByTestId('cowork-edit-time')).toHaveValue('09:30');
    });

    it('prefills the repeat, using the full server vocabulary', () => {
        setup({ itemOver: { repeatInterval: 'quarterly' } });
        expect(screen.getByTestId('cowork-edit-repeat')).toHaveValue('quarterly');
    });

    it('says out loud that the instruction runs unattended', () => {
        setup();
        expect(screen.getByText(/runs, unattended, at the scheduled moment/)).toBeInTheDocument();
    });

    it('falls back to an empty name and instruction rather than "undefined"', () => {
        setup({ itemOver: { title: undefined, prompt: undefined } });
        expect(screen.getByTestId('cowork-edit-title')).toHaveValue('');
        expect(screen.getByTestId('cowork-edit-prompt')).toHaveValue('');
    });

    it('drops a daysOfWeek that is not an array', () => {
        // A string 'mon' from an older row would otherwise reach .includes().
        setup({ itemOver: { repeatInterval: 'weekly', daysOfWeek: 'mon' } });
        expect(screen.getByTestId('cowork-edit-day-mon')).toHaveAttribute('aria-pressed', 'false');
    });
});

describe('CoworkEditForm — an item with no next run', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 6, 13, 45, 0));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('offers "now" as the moment, rather than an empty date', () => {
        setup({ itemOver: { nextRunAt: null } });
        expect(screen.getByTestId('cowork-edit-date')).toHaveValue('2026-09-06');
        expect(screen.getByTestId('cowork-edit-time')).toHaveValue('13:45');
    });

    it('wrat: saving an untouched form therefore MOVES a run-less item to right now', () => {
        const { props } = setup({ itemOver: { nextRunAt: null } });
        fireEvent.click(save());
        const at = new Date(savedPayload(props).nextRunAt);
        expect(at.getFullYear()).toBe(2026);
        expect(at.getHours()).toBe(13);
        expect(at.getMinutes()).toBe(45);
    });
});

describe('CoworkEditForm — what a save sends', () => {
    it('trims the name and the instruction', () => {
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-title'), { target: { value: '  Monthly digest  ' } });
        fireEvent.change(screen.getByTestId('cowork-edit-prompt'), { target: { value: '\n Summarise the month \n' } });
        fireEvent.click(save());

        expect(savedPayload(props).title).toBe('Monthly digest');
        expect(savedPayload(props).prompt).toBe('Summarise the month');
    });

    it('turns "Once" into a null repeat, not an empty string', () => {
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-repeat'), { target: { value: '' } });
        fireEvent.click(save());
        expect(savedPayload(props).repeatInterval).toBeNull();
    });

    it('sends no day restriction as null — [] would read as "never runs"', () => {
        const { props } = setup();
        fireEvent.click(save());
        expect(savedPayload(props).daysOfWeek).toBeNull();
    });

    it('sends the picked days, and the wall-clock time beside the moment', () => {
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-time'), { target: { value: '07:05' } });
        fireEvent.click(screen.getByTestId('cowork-edit-day-mon'));
        fireEvent.click(save());

        const payload = savedPayload(props);
        expect(payload.daysOfWeek).toEqual(['mon']);
        expect(payload.timeOfDay).toBe('07:05');
        const at = new Date(payload.nextRunAt);
        expect(at.getHours()).toBe(7);
        expect(at.getMinutes()).toBe(5);
        expect(at.getDate()).toBe(14);
    });

    it('turns "no agent" into null', () => {
        const { props } = setup({ agents: [{ id: 'a1', name: 'Research bee' }] });
        fireEvent.click(save());
        expect(savedPayload(props).agentId).toBeNull();
    });

    it('sends the picked agent', () => {
        const { props } = setup({ agents: [{ id: 'a1', name: 'Research bee' }] });
        fireEvent.change(screen.getByTestId('cowork-edit-agent'), { target: { value: 'a1' } });
        fireEvent.click(save());
        expect(savedPayload(props).agentId).toBe('a1');
    });

    it('leaves enabledApps null while the picker is untouched', () => {
        const { props } = setup();
        fireEvent.click(save());
        expect(savedPayload(props).enabledApps).toBeNull();
    });

    it('does not reload the page — the submit is handled', () => {
        const { props } = setup();
        const form = screen.getByTestId('cowork-edit-form');
        const notPrevented = fireEvent.submit(form);
        expect(notPrevented).toBe(false);
        expect(props.onSave).toHaveBeenCalledTimes(1);
    });
});

describe('CoworkEditForm — the days row', () => {
    it('is hidden for a one-off item', () => {
        setup({ itemOver: { repeatInterval: '' } });
        expect(screen.queryByTestId('cowork-edit-day-mon')).not.toBeInTheDocument();
    });

    it('appears the moment a repeat is chosen', () => {
        setup({ itemOver: { repeatInterval: '' } });
        fireEvent.change(screen.getByTestId('cowork-edit-repeat'), { target: { value: 'daily' } });
        expect(screen.getByTestId('cowork-edit-day-mon')).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Only on' })).toBeInTheDocument();
    });

    it('offers all seven days, Monday first, and says what "none picked" means', () => {
        setup();
        const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        days.forEach(d => expect(screen.getByTestId(`cowork-edit-day-${d}`)).toBeInTheDocument());
        expect(screen.getByTestId('cowork-edit-day-mon')).toHaveTextContent('Mo');
        expect(screen.getByText('Leave all off to use the repeat as-is.')).toBeInTheDocument();
    });

    it('toggles a day on and off again', () => {
        const { props } = setup();
        const mon = screen.getByTestId('cowork-edit-day-mon');
        expect(mon).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(mon);
        expect(mon).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(mon);
        expect(mon).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(save());
        expect(savedPayload(props).daysOfWeek).toBeNull();
    });

    it('wrat: the days are stored in click order, not in week order', () => {
        // "Fri, Mon" goes to the server as ['fri','mon'] — anything that
        // renders the list back reads the week starting on Friday.
        const { props } = setup();
        fireEvent.click(screen.getByTestId('cowork-edit-day-fri'));
        fireEvent.click(screen.getByTestId('cowork-edit-day-mon'));
        fireEvent.click(save());
        expect(savedPayload(props).daysOfWeek).toEqual(['fri', 'mon']);
    });

    it('wrat: switching back to Once hides the days but still saves them', () => {
        // The row disappears, so the user cannot see or clear what is about
        // to be sent with a non-repeating item.
        const { props } = setup();
        fireEvent.click(screen.getByTestId('cowork-edit-day-mon'));
        fireEvent.change(screen.getByTestId('cowork-edit-repeat'), { target: { value: '' } });
        expect(screen.queryByTestId('cowork-edit-day-mon')).not.toBeInTheDocument();

        fireEvent.click(save());
        expect(savedPayload(props).repeatInterval).toBeNull();
        expect(savedPayload(props).daysOfWeek).toEqual(['mon']);
    });
});

describe('CoworkEditForm — a cleared or unreadable moment', () => {
    it('wrat: clearing the date saves a run in the year 1900 instead of keeping the old one', () => {
        // `new Date(0, 0, 1, …)` — years 0-99 map to 1900-1999, so the date is
        // never NaN and the `item.nextRunAt` fallback below it is unreachable.
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-date'), { target: { value: '' } });
        fireEvent.click(save());

        const payload = savedPayload(props);
        expect(payload.nextRunAt).not.toBe(item().nextRunAt);
        expect(new Date(payload.nextRunAt).getFullYear()).toBe(1900);
    });

    it('wrat: clearing the time silently means midnight, and drops timeOfDay', () => {
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-time'), { target: { value: '' } });
        fireEvent.click(save());

        const payload = savedPayload(props);
        const at = new Date(payload.nextRunAt);
        expect(at.getHours()).toBe(0);
        expect(at.getMinutes()).toBe(0);
        expect(payload.timeOfDay).toBeNull();
    });

    it('wrat: an unparseable nextRunAt opens the form with an empty date and time', () => {
        setup({ itemOver: { nextRunAt: 'yesterday-ish' } });
        expect(screen.getByTestId('cowork-edit-date')).toHaveValue('');
        expect(screen.getByTestId('cowork-edit-time')).toHaveValue('');
    });

    it('wrat: a repeat the <select> has no option for shows as blank while the draft keeps it', () => {
        // The row still says "repeating" (the days appear) but the control
        // shows nothing, and an untouched save sends the unknown value on.
        const { props } = setup({ itemOver: { repeatInterval: 'fortnightly' } });
        expect(screen.getByTestId('cowork-edit-repeat')).toHaveValue('');
        expect(screen.getByTestId('cowork-edit-day-mon')).toBeInTheDocument();

        fireEvent.click(save());
        expect(savedPayload(props).repeatInterval).toBe('fortnightly');
    });
});

describe('CoworkEditForm — the apps this cowork may use', () => {
    it('is not offered at all when the user has no apps', () => {
        setCatalog({ availableApps: [] });
        setup();
        expect(screen.queryByText('Apps it may use')).not.toBeInTheDocument();
        expect(screen.queryByTestId('apps-picker-button')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cowork-apps-unavailable')).not.toBeInTheDocument();
    });

    it('says so instead when the list could not be loaded — empty is not unreadable', () => {
        // Same zero apps, a different answer: hiding the row here would present
        // a failed read as "nothing to worry about", on a form whose whole
        // subject is what runs unattended with your credentials.
        setCatalog({ availableApps: [] });
        workspaceRead.integrationStatus = {};
        workspaceRead.unavailable = true;
        setup();

        expect(screen.getByTestId('cowork-apps-unavailable')).toBeInTheDocument();
        expect(screen.getByText('Apps it may use')).toBeInTheDocument();
    });

    it('offers nothing at all while the list is unreadable', () => {
        // The catalogue would answer "on" for all of these; an unreadable
        // workspace read must not be presented as permission — and must not be
        // presented as an offer either. Without a readable workspace read there
        // is no org allow-list to apply, so what the catalogue offers includes
        // apps the organisation switched off, and one toggle stores them on
        // this schedule as an explicit permission.
        setCatalog({ availableApps: APPS, isAppEnabled: () => true });
        workspaceRead.integrationStatus = {};
        workspaceRead.unavailable = true;
        setup();

        expect(screen.getByTestId('cowork-apps-unavailable')).toBeInTheDocument();
        expect(screen.queryByTestId('apps-picker-button')).not.toBeInTheDocument();
        expect(screen.queryByText(/enabled$/)).not.toBeInTheDocument();
    });

    it('still says so when the list is NOT empty and the read failed', () => {
        // The gap the length test hid. Steps, MCP servers and n8n workflows
        // come from their own fetches and survive a failed workspace read, so
        // "zero apps AND unreadable" is the one case that never happens in the
        // situation the warning exists for. Tied to the length, the form
        // replaced the warning with a hard claim — a count plus "following
        // your workspace-wide list" — about a list it could not read.
        setCatalog({ availableApps: APPS, isAppEnabled: () => true });
        workspaceRead.integrationStatus = {};
        workspaceRead.unavailable = true;
        setup();

        expect(screen.getByTestId('cowork-apps-unavailable')).toBeInTheDocument();
        expect(screen.queryByText(/Following your workspace-wide list/)).not.toBeInTheDocument();
    });

    it('says it is following the workspace list while the item has none of its own', () => {
        setup();
        expect(screen.getByText(/Following your workspace-wide list/)).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-apps-reset')).not.toBeInTheDocument();
    });

    it('counts steps as always on, alongside the workspace answer', () => {
        // gmail is on, drive is off, the Step counts regardless.
        setup();
        expect(screen.getByText('2 of 3 enabled')).toBeInTheDocument();
    });

    it('switches to the item\'s own list, with its own wording and a way back', () => {
        setup({ itemOver: { enabledApps: ['google-drive'] } });
        expect(screen.getByText(/Only these apps are available to this cowork/)).toBeInTheDocument();
        expect(screen.getByTestId('cowork-apps-reset')).toBeInTheDocument();
        expect(screen.getByText('2 of 3 enabled')).toBeInTheDocument();
    });

    it('hands the item back to the workspace list, and the wording follows', () => {
        const { props } = setup({ itemOver: { enabledApps: ['google-drive'] } });
        fireEvent.click(screen.getByTestId('cowork-apps-reset'));

        expect(screen.getByText(/Following your workspace-wide list/)).toBeInTheDocument();
        fireEvent.click(save());
        expect(savedPayload(props).enabledApps).toBeNull();
    });

    it('materialises the inherited set on the first toggle', () => {
        const { props } = setup();
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        fireEvent.click(screen.getByLabelText('Enable Google Drive'));
        fireEvent.click(save());

        // gmail was globally on and stays on; the step is never stored.
        expect(savedPayload(props).enabledApps.sort()).toEqual(['gmail', 'google-drive']);
    });

    it('renders the picker field as a div, not a <label>, so the row cannot toggle the first app', () => {
        // `as="div"` — pinned because reverting it makes a click anywhere in
        // the row flip whatever checkbox the overlay opens with. Not a wart:
        // this is the deliberate fix, and the pin is here to keep it.
        setup();
        const heading = screen.getByText('Apps it may use');
        expect(heading.closest('label')).toBeNull();
    });
});

describe('CoworkEditForm — the agent picker', () => {
    it('is hidden when there are no agents to choose from', () => {
        setup({ agents: [] });
        expect(screen.queryByTestId('cowork-edit-agent')).not.toBeInTheDocument();
    });

    it('lists "No agent" first and explains what an agent brings', () => {
        setup({ agents: [{ id: 'a1', name: 'Research bee' }] });
        const select = screen.getByTestId('cowork-edit-agent');
        expect(select.options[0].textContent).toBe('No agent');
        expect(select.options[0].value).toBe('');
        expect(screen.getByText(/brings its own skills, knowledge and connected apps/)).toBeInTheDocument();
    });

    it('names a nameless agent rather than showing a blank row', () => {
        setup({ agents: [{ id: 'a1', name: '' }] });
        expect(screen.getByTestId('cowork-edit-agent').options[1].textContent).toBe('Untitled agent');
    });

    it('wrat: an agentId whose agent is not in the list hides the choice and the value both', () => {
        // Exactly what an in-flight agents fetch looks like. The item is
        // pinned to an agent, nothing on screen says so, and an untouched
        // save keeps it.
        const { props } = setup({ agents: [], itemOver: { agentId: 'a1' } });
        expect(screen.queryByTestId('cowork-edit-agent')).not.toBeInTheDocument();
        fireEvent.click(save());
        expect(savedPayload(props).agentId).toBe('a1');
    });
});

describe('CoworkEditForm — saving, cancelling and failing', () => {
    it('refuses to save without a name', () => {
        setup({ itemOver: { title: '   ' } });
        expect(save()).toBeDisabled();
    });

    it('refuses to save without an instruction', () => {
        setup({ itemOver: { prompt: '' } });
        expect(save()).toBeDisabled();
    });

    it('refuses a second save while one is in flight, and says so', () => {
        setup({ saving: true });
        expect(save()).toBeDisabled();
        expect(save()).toHaveTextContent('Saving…');
    });

    it('says Save when idle', () => {
        setup();
        expect(save()).toBeEnabled();
        expect(save()).toHaveTextContent('Save');
    });

    it('cancels without saving', () => {
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-title'), { target: { value: 'Changed my mind' } });
        fireEvent.click(screen.getByTestId('cowork-edit-cancel'));

        expect(props.onCancel).toHaveBeenCalledTimes(1);
        expect(props.onSave).not.toHaveBeenCalled();
    });

    it('shows a rejected save as an alert, keeping the form up', () => {
        setup({ error: 'Unknown timezone: Mars/Olympus' });
        expect(screen.getByRole('alert')).toHaveTextContent('Unknown timezone: Mars/Olympus');
        expect(screen.getByTestId('cowork-edit-form')).toBeInTheDocument();
    });

    it('keeps the draft local — nothing is saved while typing', () => {
        const { props } = setup();
        fireEvent.change(screen.getByTestId('cowork-edit-title'), { target: { value: 'M' } });
        fireEvent.change(screen.getByTestId('cowork-edit-title'), { target: { value: 'Mo' } });
        fireEvent.change(screen.getByTestId('cowork-edit-time'), { target: { value: '07:00' } });
        expect(props.onSave).not.toHaveBeenCalled();
    });

    it('every label, hint and button in this form goes through t(), with the English as fallback', () => {
        // CW-01. Same split as the composer suite: here the English fallback
        // is what a reader without a translation still gets; the keys and the
        // disappearance of the English live in cowork.i18n.test.jsx.
        setup();
        expect(screen.getByText('Name')).toBeInTheDocument();
        expect(screen.getByText('What it does')).toBeInTheDocument();
        expect(screen.getByText('Next run')).toBeInTheDocument();
        expect(save().textContent).toContain('Save');
        expect(FORM_SOURCE).toMatch(/useTranslation/);
        expect(FORM_SOURCE).toMatch(/\bt\('cowork\./);
    });
});
