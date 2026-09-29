import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CoworkComposer, { COWORK_PLACEHOLDER } from './CoworkComposer';

/**
 * CHARACTERISATION — the one Cowork input box, exactly as it behaves today.
 *
 * The apps catalogue is stubbed at the hook boundary (`useAppsCatalog`) so the
 * list is a fixture rather than four best-effort fetches; everything below it
 * — useCoworkApps, AppsPicker, CoworkOptionsBar, TierSlider — is the real
 * component, because the point of this box is that both surfaces get the same
 * controls and a mock of those would pin nothing.
 *
 * Tests named "wrat" pin behaviour that is wrong today and must fail loudly
 * the day it is fixed.
 */

/**
 * The component's own source. The i18n wart below cannot be seen from the
 * rendered DOM — `t('key', 'Chat')` renders "Chat" as well — so the pin has to
 * read the module that produced it.
 */
const COMPOSER_SOURCE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'CoworkComposer.jsx'),
    'utf8',
);

const catalog = vi.hoisted(() => ({ state: null, calls: [] }));

vi.mock('../../hooks/useAppsCatalog', () => ({
    default: (opts) => { catalog.calls.push(opts); return catalog.state; },
}));

// The catalogue is stubbed above, but useCoworkApps reads the workspace
// settings itself to tell "we have no apps" from "we could not ask" — an
// unmocked read here would leave every app reading as not-allowed.
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

const APPS = [app('gmail', 'Gmail'), app('google-drive', 'Google Drive')];

function setCatalog(over = {}) {
    catalog.state = {
        availableApps: APPS,
        isAppEnabled: () => true,
        toggleApp: vi.fn(),
        ...over,
    };
    return catalog.state;
}

/** The `cowork` slot the composer reads — useCoworkComposer's return shape. */
function coworkStub(over = {}) {
    return {
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
    };
}

function setup(over = {}) {
    const props = {
        value: '',
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        cowork: coworkStub(over.coworkOver),
        ...over,
    };
    delete props.coworkOver;
    const utils = render(<CoworkComposer {...props} />);
    return { ...utils, props };
}

const brief = () => screen.getByTestId('cowork-brief-input');
const send = () => screen.getByTestId('cowork-send');
/** Click a row in the open Apps overlay. */
const pickApp = (id) => fireEvent.click(
    screen.getByTestId('apps-picker-panel').querySelector(`[data-app-id="${id}"]`),
);

beforeEach(() => {
    catalog.calls.length = 0;
    workspaceRead.integrationStatus = { isGoogleUser: true };
    workspaceRead.unavailable = false;
    setCatalog();
});

describe('CoworkComposer — the box itself', () => {
    it('announces itself as one labelled form, in cowork mode', () => {
        setup();
        const box = screen.getByTestId('cowork-composer');
        expect(box).toHaveAttribute('role', 'form');
        expect(box).toHaveAttribute('aria-label', 'Cowork brief input');
        expect(box).toHaveAttribute('data-cowork-mode', 'cowork');
        expect(box).toHaveAttribute('data-tour', 'cowork-composer');
    });

    it('uses the one shared placeholder, exported so both surfaces cannot drift', () => {
        setup();
        expect(COWORK_PLACEHOLDER).toBe('Describe the work — Bee Flow runs it and reports back');
        expect(brief()).toHaveAttribute('placeholder', COWORK_PLACEHOLDER);
        expect(brief()).toHaveAttribute('aria-label', 'Cowork brief');
    });

    it('reports every keystroke as the raw string', () => {
        const { props } = setup();
        fireEvent.change(brief(), { target: { value: 'Send the digest' } });
        expect(props.onChange).toHaveBeenCalledWith('Send the digest');
    });

    it('hands the caller\'s ref the textarea itself', () => {
        const ref = React.createRef();
        render(
            <CoworkComposer value="" onChange={vi.fn()} onSubmit={vi.fn()} cowork={coworkStub()} textareaRef={ref} />,
        );
        expect(ref.current).toBe(screen.getByTestId('cowork-brief-input'));
    });

    it('every label in this box goes through t(), with the English as fallback', () => {
        // CW-01. The rendered strings alone cannot pin this — t('k', 'Run')
        // renders "Run" too — so the DOM half asserts the fallback still
        // reaches a reader with no translation, and the source half asserts
        // the hook is actually there. What the KEYS are, and that the English
        // disappears once a translation exists, is pinned under an echoing
        // translator in cowork.i18n.test.jsx.
        setup();
        expect(brief().getAttribute('placeholder')).toBe(COWORK_PLACEHOLDER);
        expect(brief().getAttribute('aria-label')).toBe('Cowork brief');
        expect(send().textContent).toContain('Run');
        expect(COMPOSER_SOURCE).toMatch(/useTranslation/);
        expect(COMPOSER_SOURCE).toMatch(/\bt\('cowork\./);
    });
});

describe('CoworkComposer — minRows and the auto-resize floor', () => {
    it('gives the page its three rows, as an inline height the `rows` attribute cannot undo', () => {
        setup({ minRows: 3 });
        const el = brief();
        expect(el).toHaveAttribute('rows', '3');
        // 3 rows × the 24px line-height fallback, with no padding in jsdom.
        expect(el.style.height).toBe('72px');
    });

    it('leaves the chat on one row', () => {
        setup();
        const el = brief();
        expect(el).toHaveAttribute('rows', '1');
        expect(el.style.height).toBe('24px');
    });

    it('keeps the scrollbar hidden until the content passes the 180px cap', () => {
        setup({ minRows: 3 });
        expect(brief().style.overflowY).toBe('hidden');
    });
});

describe('CoworkComposer — the send button', () => {
    it('says Run for "now" and carries the schedule summary as its tooltip', () => {
        setup({ value: 'x' });
        expect(send()).toHaveTextContent('Run');
        expect(send()).toHaveAttribute('title', 'Runs now');
    });

    it('says Schedule for anything that is not "now"', () => {
        setup({ value: 'x', coworkOver: { when: { presetId: 'tomorrow', date: '', time: '' } } });
        expect(send()).toHaveTextContent('Schedule');
    });

    it('says Starting… while a submit is in flight, and is disabled', () => {
        setup({ value: 'x', coworkOver: { submitting: true } });
        expect(send()).toHaveTextContent('Starting…');
        expect(send()).toBeDisabled();
    });

    it('is disabled for an empty brief', () => {
        setup({ value: '' });
        expect(send()).toBeDisabled();
    });

    it('is disabled for whitespace only', () => {
        setup({ value: '   \n\t ' });
        expect(send()).toBeDisabled();
    });

    it('is disabled while the schedule is unresolvable ("Pick a moment…" with nothing picked)', () => {
        setup({ value: 'x', coworkOver: { scheduleReady: false } });
        expect(send()).toBeDisabled();
    });

    it('is enabled, and submits, once there is text and a resolvable moment', () => {
        const { props } = setup({ value: 'Send the digest' });
        expect(send()).toBeEnabled();
        fireEvent.click(send());
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
    });

    it('does not fall over without an onSubmit — the click is guarded, not thrown', () => {
        // `not.toThrow()` alone would pass without the `onSubmit &&` guard:
        // React catches a handler that throws and re-reports it to
        // window.onerror, so the uncaught-error listener is the half that
        // actually pins the guard.
        const uncaught = vi.fn();
        window.addEventListener('error', uncaught);
        try {
            render(<CoworkComposer value="x" onChange={vi.fn()} cowork={coworkStub()} />);
            expect(() => fireEvent.click(send())).not.toThrow();
        } finally {
            window.removeEventListener('error', uncaught);
        }
        expect(uncaught).not.toHaveBeenCalled();
    });
});

describe('CoworkComposer — the keyboard', () => {
    it('sends on Enter and swallows the newline', () => {
        const { props } = setup({ value: 'Send the digest' });
        const prevented = fireEvent.keyDown(brief(), { key: 'Enter' }) === false;
        expect(prevented).toBe(true);
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
    });

    it('breaks the line on Shift+Enter instead of sending', () => {
        const { props } = setup({ value: 'Send the digest' });
        const notPrevented = fireEvent.keyDown(brief(), { key: 'Enter', shiftKey: true });
        expect(notPrevented).toBe(true);
        expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('sends on Cmd/Ctrl+Enter too — the page used to be modifier-only', () => {
        const { props } = setup({ value: 'Send the digest' });
        fireEvent.keyDown(brief(), { key: 'Enter', metaKey: true });
        fireEvent.keyDown(brief(), { key: 'Enter', ctrlKey: true });
        expect(props.onSubmit).toHaveBeenCalledTimes(2);
    });

    it('ignores every other key', () => {
        const { props } = setup({ value: 'Send the digest' });
        fireEvent.keyDown(brief(), { key: 'a' });
        fireEvent.keyDown(brief(), { key: 'Escape' });
        expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('wrat: Enter is swallowed even when it cannot send, so the empty box eats the newline', () => {
        // preventDefault runs before the canSend check.
        const { props } = setup({ value: '' });
        const prevented = fireEvent.keyDown(brief(), { key: 'Enter' }) === false;
        expect(prevented).toBe(true);
        expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('wrat: Enter sends mid-IME-composition — nothing checks isComposing', () => {
        // Typing Japanese/Chinese/Korean, the first Enter confirms the
        // candidate word. Here it fires the brief off instead.
        const { props } = setup({ value: 'こんにち' });
        fireEvent.keyDown(brief(), { key: 'Enter', isComposing: true, keyCode: 229 });
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
    });
});

describe('CoworkComposer — the model tier pickers', () => {
    const TIERS = { auto: {}, thinking: { modelId: 'm1' }, pro: { modelId: 'm2' } };

    it('renders nothing tier-shaped when the surface has no tiers', () => {
        setup({ value: 'x' });
        expect(screen.queryByTestId('tier-slider')).not.toBeInTheDocument();
    });

    it('renders the slider once tiers are handed in, on the current tier', () => {
        setup({ value: 'x', modelTiers: TIERS, selectedTier: 'thinking', onTierChange: vi.fn() });
        expect(screen.getByTestId('tier-slider')).toBeInTheDocument();
        expect(screen.getByTestId('tier-slider-trigger')).toHaveAttribute('aria-label', 'Response depth: Think');
    });

    it('reports a new depth to the caller', () => {
        const onTierChange = vi.fn();
        setup({ value: 'x', modelTiers: TIERS, selectedTier: 'thinking', onTierChange });
        fireEvent.click(screen.getByTestId('tier-slider-trigger'));
        fireEvent.click(screen.getByTestId('tier-slider-stop-pro'));
        expect(onTierChange).toHaveBeenCalledWith('pro');
    });

    it('hides the tier control in simple mode, tiers or not', () => {
        setup({ value: 'x', modelTiers: TIERS, simpleMode: true, onTierChange: vi.fn() });
        expect(screen.queryByTestId('tier-slider')).not.toBeInTheDocument();
    });

    it('defaults the tier to auto when the caller says nothing', () => {
        setup({ value: 'x', modelTiers: TIERS, onTierChange: vi.fn() });
        expect(screen.getByTestId('tier-slider-trigger')).toHaveAttribute('aria-label', 'Response depth: Auto');
    });
});

describe('CoworkComposer — the Apps picker', () => {
    it('is offered by default', () => {
        setup({ value: 'x' });
        expect(screen.getByTestId('apps-picker-button')).toBeInTheDocument();
    });

    it('is hidden in simple mode', () => {
        setup({ value: 'x', simpleMode: true });
        expect(screen.queryByTestId('apps-picker-button')).not.toBeInTheDocument();
    });

    it('is hidden when external tools are switched off for this surface', () => {
        setup({ value: 'x', disableExternalTools: true });
        expect(screen.queryByTestId('apps-picker-button')).not.toBeInTheDocument();
    });

    it('disappears entirely when the user has no apps — not an empty overlay', () => {
        setCatalog({ availableApps: [] });
        setup({ value: 'x' });
        expect(screen.queryByTestId('apps-picker-button')).not.toBeInTheDocument();
    });

    it('lists what the catalogue offers, with the active count', () => {
        setup({ value: 'x' });
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        const panel = screen.getByTestId('apps-picker-panel');
        expect(within(panel).getAllByTestId('apps-picker-item')).toHaveLength(2);
        expect(panel).toHaveTextContent('2/2 active');
    });

    it('routes a toggle through the item\'s own list, not the workspace one', () => {
        const setEnabledApps = vi.fn();
        setup({ value: 'x', coworkOver: { enabledApps: ['gmail'], setEnabledApps } });
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        fireEvent.click(screen.getByLabelText('Enable Google Drive'));
        expect(setEnabledApps).toHaveBeenCalledWith(['gmail', 'google-drive']);
        // The workspace-wide toggle stays untouched.
        expect(catalog.state.toggleApp).not.toHaveBeenCalled();
    });

    it('picking an app KEEPS the brief you already typed and adds the seed to it', () => {
        // Was a wart: `onChange(seed)` replaced the box outright, so half a
        // paragraph of brief disappeared on one click, with no undo.
        const typed = 'Summarise last week and mail it to the team';
        const { props } = setup({ value: typed });
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('gmail');
        const next = props.onChange.mock.calls.at(-1)[0];
        expect(next).toContain(typed);
        expect(next).toContain('Show my recent emails');
        expect(next.indexOf(typed)).toBeLessThan(next.indexOf('Show my recent emails'));
    });

    it('seeds an empty box with the seed alone — no leading blank line', () => {
        const { props } = setup({ value: '' });
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('gmail');
        expect(props.onChange).toHaveBeenCalledWith('Show my recent emails');
    });

    it('treats a box holding only whitespace as empty', () => {
        const { props } = setup({ value: '   \n ' });
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('gmail');
        expect(props.onChange).toHaveBeenCalledWith('Show my recent emails');
    });

    it('leaves the brief alone for an app with nothing sensible to type', () => {
        setCatalog({ availableApps: [app('mystery-tool', 'Mystery')] });
        const { props } = setup({ value: 'Keep this' });
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('mystery-tool');
        expect(props.onChange).not.toHaveBeenCalled();
    });

    it('leaves the box holding both, with the caret behind the seed', () => {
        // Needs a real controlled host: the value the picker produces only
        // reaches the textarea through the parent.
        //
        // The caret half is proven in "the caret after a seed" below, by
        // spying on setSelectionRange: jsdom parks the caret at the end of a
        // reassigned value by itself, so THIS assertion documents the intent
        // rather than proving it. What this test pins is that the box ends up
        // holding the brief AND the seed.
        function Host() {
            const [value, setValue] = React.useState('Mail the team');
            return <CoworkComposer value={value} onChange={setValue} onSubmit={vi.fn()} cowork={coworkStub()} />;
        }
        render(<Host />);
        // Caret parked mid-brief, which is what React would restore to.
        const box = brief();
        box.focus();
        box.setSelectionRange(4, 4);
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('gmail');
        const el = brief();
        expect(el.value).toContain('Mail the team');
        expect(el.value).toContain('Show my recent emails');
        expect(el.selectionStart).toBe(el.value.length);
        expect(el.selectionEnd).toBe(el.value.length);
    });

    it('hands the catalogue the agent\'s integrations, and nothing else about the item', () => {
        // Only `agentIntegrations` reaches the workspace-wide catalogue; the
        // item's own list is layered on top of it by useCoworkApps.
        setup({
            value: 'x',
            agentIntegrations: ['gmail'],
            coworkOver: { enabledApps: ['gmail'], setEnabledApps: vi.fn() },
        });
        expect(catalog.calls.at(-1)).toEqual({ agentIntegrations: ['gmail'] });
    });

    it('passes no agent filter on the page surface', () => {
        setup({ value: 'x' });
        expect(catalog.calls.at(-1).agentIntegrations).toBeNull();
    });
});

describe('CoworkComposer — the slots around the picker', () => {
    it('renders the chat\'s own buttons in the left group, exactly as handed in', () => {
        // The composer applies no hiding of its own — the caller decides that,
        // which is why a switch back to Chat keeps popover state.
        setup({ value: 'x', chatTools: <button type="button" data-testid="chat-attach">Attach</button> });
        const tools = screen.getByTestId('chat-attach');
        expect(tools).toBeVisible();
        expect(tools.closest('.flex-wrap')).not.toBeNull();
    });

    it('renders no chat tools on the page surface', () => {
        setup({ value: 'x' });
        expect(screen.queryByTestId('chat-attach')).not.toBeInTheDocument();
    });

    it('always shows the When and Repeat chips', () => {
        setup({ value: 'x' });
        expect(screen.getByTestId('cowork-when-chip')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-repeat-chip')).toBeInTheDocument();
    });

    it('passes the agents through, so the agent chip appears when there are any', () => {
        setup({ value: 'x', coworkOver: { agents: [{ id: 'a1', name: 'Research bee' }] } });
        expect(screen.getByTestId('cowork-agent-chip')).toBeInTheDocument();
    });
});

describe('CoworkComposer — errors', () => {
    it('shows nothing when there is no error', () => {
        setup({ value: 'x' });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the composer state\'s own error', () => {
        setup({ value: 'x', coworkOver: { error: 'Could not create this work' } });
        expect(screen.getByRole('alert')).toHaveTextContent('Could not create this work');
    });

    it('shows the surface\'s error prop', () => {
        setup({ value: 'x', error: 'You have used all 10 cowork slots' });
        expect(screen.getByRole('alert')).toHaveTextContent('You have used all 10 cowork slots');
    });

    it('wrat: with both set the prop wins and the state error is never shown', () => {
        setup({ value: 'x', error: 'Quota reached', coworkOver: { error: 'Network unreachable' } });
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Quota reached');
        expect(alert).not.toHaveTextContent('Network unreachable');
    });
});

describe('CoworkComposer — when the app list cannot be read', () => {
    // The composer creates an item that runs unattended. If the workspace read
    // failed, the picker's own "0/2 active" is indistinguishable from "the
    // user switched everything off" — while the item this box posts carries no
    // per-item list at all, which the server reads as "follow the workspace
    // list": the widest answer there is. Claiming the narrowest on screen and
    // sending the widest over the wire is the one thing this box must not do.

    it('says the list is unavailable instead of drawing an empty picker', () => {
        workspaceRead.integrationStatus = {};
        workspaceRead.unavailable = true;
        setup();

        expect(screen.getByTestId('cowork-apps-unavailable')).toBeInTheDocument();
        expect(screen.queryByTestId('apps-picker-button')).not.toBeInTheDocument();
    });

    it('does not say it while the read succeeded', () => {
        setup();
        expect(screen.queryByTestId('cowork-apps-unavailable')).not.toBeInTheDocument();
        expect(screen.getByTestId('apps-picker-button')).toBeInTheDocument();
    });
});

describe('CoworkComposer — the caret after a seed', () => {
    /**
     * The caret half of the seed behaviour used to be untestable by its own
     * admission: jsdom parks the caret at the end of a reassigned value on its
     * own, so asserting on `selectionStart` proves nothing.
     *
     * `setSelectionRange` is observable, though, and it is the only thing the
     * effect does. Spying on it turns "did the composer MOVE the caret" into a
     * question with an answer — which is a different question from "where did
     * the caret end up".
     */
    let moves;
    beforeEach(() => {
        moves = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange');
    });
    afterEach(() => { moves.mockRestore(); });

    function Host({ dropFirstChange = false }) {
        const [value, setValue] = React.useState('Mail the team');
        const dropped = React.useRef(false);
        const onChange = (next) => {
            if (dropFirstChange && !dropped.current) { dropped.current = true; return; }
            setValue(next);
        };
        return <CoworkComposer value={value} onChange={onChange} onSubmit={vi.fn()} cowork={coworkStub()} />;
    }

    it('moves the caret once, after a seed lands', () => {
        render(<Host />);
        moves.mockClear();
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('gmail');

        const el = brief();
        expect(moves).toHaveBeenCalledWith(el.value.length, el.value.length);
    });

    it('does not move the caret on ordinary typing', () => {
        render(<Host />);
        moves.mockClear();
        fireEvent.change(brief(), { target: { value: 'Mail the team about' } });
        expect(moves).not.toHaveBeenCalled();
    });

    it('forgets the seed when the host ignored it, instead of jumping the caret later', () => {
        // A caller may drop an onChange — a disabled parent, a race, a guard.
        // The flag would then still be set at the NEXT keystroke, and the
        // caret would leap to the end in the middle of someone's sentence,
        // long after the app they picked.
        render(<Host dropFirstChange />);
        fireEvent.click(screen.getByTestId('apps-picker-button'));
        pickApp('gmail');
        expect(brief().value).toBe('Mail the team');  // the host really dropped it

        moves.mockClear();
        fireEvent.change(brief(), { target: { value: 'Mail the team about' } });
        expect(moves).not.toHaveBeenCalled();
    });
});
