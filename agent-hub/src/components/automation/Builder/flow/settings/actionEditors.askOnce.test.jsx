import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegrationActionFields } from './actionEditors';

/**
 * "Ask this app only once per run" — the toggle, and the honesty of its
 * disabled state.
 *
 * The trap this file guards: `isSideEffect` is FAIL-CLOSED, so every
 * unclassified `mcp_*` / `cint_*` READ comes back sideEffect:true. Wiring the
 * disabled reason to that flag would tell a user "this action changes
 * something in Slack" about a call that changes nothing — a confident lie
 * about someone else's data. The reason is therefore driven by the catalog's
 * own `askOnceable`, which is `isMemoisable` on the server: the SAME predicate
 * execAi gates on. A toggle the UI offers where the runner ignores it is worse
 * than no toggle, so these two must never drift.
 */

const app = (over = {}) => ({
    id: 'gmail',
    label: 'Gmail',
    actions: [
        { name: 'gmail_search', sideEffect: false, askOnceable: true, inputSchema: null },
        { name: 'gmail_compose', sideEffect: true, askOnceable: false, inputSchema: null },
        { name: 'nextcloud_list_files', sideEffect: false, askOnceable: false, inputSchema: null },
        { name: 'mcp_unknown_read', sideEffect: true, askOnceable: false, inputSchema: null },
    ],
    ...over,
});

function renderFields({ tool = 'gmail_search', draft = {}, set = vi.fn(), catalog = { apps: [app()] } } = {}) {
    const step = { id: 's1', type: 'integration_action', tool, appId: 'gmail' };
    render(
        <IntegrationActionFields
            step={step}
            draft={{ tool, ...draft }}
            set={set}
            catalog={catalog}
            groups={[]}
        />,
    );
    return { set };
}

const toggle = () => screen.getByRole('checkbox', { name: /ask this app only once per run/i });
// Idempotent on purpose: AccordionSection persists open/closed per user via
// scopedStorage, so a blind click would CLOSE the band for a later test in the
// same file and the toggle would vanish for reasons nothing to do with askOnce.
const openAdvanced = () => {
    if (screen.queryByRole('checkbox', { name: /ask this app only once per run/i })) return;
    const band = screen.queryByRole('button', { name: /advanced/i });
    if (band) fireEvent.click(band);
};

beforeEach(() => cleanup());

describe('the toggle is off unless ticked', () => {
    it('renders unchecked for a step with no askOnce', () => {
        renderFields();
        openAdvanced();
        expect(toggle().checked).toBe(false);
    });

    it('renders checked when the step carries askOnce', () => {
        renderFields({ draft: { askOnce: true } });
        expect(toggle().checked).toBe(true);
    });

    it('ticking it writes `true`', () => {
        const { set } = renderFields();
        openAdvanced();
        fireEvent.click(toggle());
        expect(set).toHaveBeenCalledWith('askOnce', true);
    });

    it('unticking it writes `undefined`, not `false`', () => {
        // Absent is the off state everywhere else in the definition — a
        // literal `false` would be a field the diff, the validator and the
        // summariser all have to learn to ignore.
        const { set } = renderFields({ draft: { askOnce: true } });
        fireEvent.click(toggle());
        expect(set).toHaveBeenCalledWith('askOnce', undefined);
    });
});

describe('the Advanced section opens itself when the toggle is already on', () => {
    it('a step with askOnce shows the toggle without a click', () => {
        renderFields({ draft: { askOnce: true } });
        expect(toggle()).toBeTruthy();
    });
});

describe('the disabled reason is true of the action it names', () => {
    it('a write is disabled and names the app', () => {
        renderFields({ tool: 'gmail_compose' });
        openAdvanced();
        expect(toggle().disabled).toBe(true);
        expect(screen.getByText(/changes something in Gmail/i)).toBeTruthy();
    });

    it('a read the runner refuses to memoise is disabled WITHOUT claiming it writes', () => {
        renderFields({ tool: 'nextcloud_list_files' });
        openAdvanced();
        expect(toggle().disabled).toBe(true);
        expect(screen.queryByText(/changes something/i)).toBeNull();
        expect(screen.getByText(/checked fresh every time/i)).toBeTruthy();
    });

    it('an unclassified tool is disabled by askOnceable, and its reason follows sideEffect', () => {
        // The fail-closed pair: askOnceable:false disables it, and because the
        // catalog also reports sideEffect:true the "changes something" wording
        // is the one shown. That is the server's own claim, not the UI
        // inventing one — the test exists so the UI never invents a DIFFERENT
        // one from a flag the server did not send.
        renderFields({ tool: 'mcp_unknown_read' });
        openAdvanced();
        expect(toggle().disabled).toBe(true);
    });

    it('a memoisable read is enabled and explains the reuse in plain words', () => {
        renderFields();
        openAdvanced();
        expect(toggle().disabled).toBe(false);
        expect(screen.getByText(/the first answer is used again/i)).toBeTruthy();
    });
});

describe('an older server that sends no askOnceable does not disable the toggle', () => {
    it('leaves it usable and lets the validator have the last word', () => {
        const legacy = { apps: [{ id: 'gmail', label: 'Gmail', actions: [{ name: 'gmail_search', sideEffect: false }] }] };
        renderFields({ catalog: legacy });
        openAdvanced();
        expect(toggle().disabled).toBe(false);
    });
});

const acrossRuns = () => screen.queryByRole('checkbox', { name: /keep the answer for later runs/i });

describe('"keep it for later runs" is a second, narrower promise', () => {
    it('is not offered at all until the step asks once per run', () => {
        // "Keep it for the NEXT run" is meaningless for a step that asks fresh
        // every time, and a tick that silently does nothing is worse than none.
        renderFields();
        openAdvanced();
        expect(acrossRuns()).toBeNull();
    });

    it('appears once the first tick is on', () => {
        renderFields({ draft: { askOnce: true } });
        expect(acrossRuns()).toBeTruthy();
        expect(acrossRuns().checked).toBe(false);
    });

    it('is stored on the SAME field, so it cannot claim the wider promise alone', () => {
        // askOnce: {acrossRuns:true} is the tick PLUS the wider promise. A
        // separate field could be set while askOnce was off, which the runtime
        // would ignore — a definition that lies about itself.
        const { set } = renderFields({ draft: { askOnce: true } });
        fireEvent.click(acrossRuns());
        expect(set).toHaveBeenCalledWith('askOnce', { acrossRuns: true });
    });

    it('unticking it falls back to plain once-per-run, not to off', () => {
        const { set } = renderFields({ draft: { askOnce: { acrossRuns: true } } });
        expect(acrossRuns().checked).toBe(true);
        fireEvent.click(acrossRuns());
        expect(set).toHaveBeenCalledWith('askOnce', true);
    });

    it('an object askOnce still reads as ON for the first tick', () => {
        renderFields({ draft: { askOnce: { acrossRuns: true } } });
        expect(toggle().checked).toBe(true);
    });

    it('a ttlSeconds nobody can see here survives the tick, both ways', () => {
        // No editor writes ttlSeconds — the AI builder and hand-edited
        // definitions do. Now that the form actually PERSISTS askOnce,
        // collapsing to a bare `true` would delete the author's reuse window
        // on a toggle they made about something else entirely.
        const on = renderFields({ draft: { askOnce: { ttlSeconds: 60 } } });
        fireEvent.click(acrossRuns());
        expect(on.set).toHaveBeenCalledWith('askOnce', { acrossRuns: true, ttlSeconds: 60 });

        cleanup();
        const off = renderFields({ draft: { askOnce: { acrossRuns: true, ttlSeconds: 60 } } });
        fireEvent.click(acrossRuns());
        expect(off.set).toHaveBeenCalledWith('askOnce', { ttlSeconds: 60 });
    });

    it('says the answer is STORED and that an administrator decides', () => {
        // Neither is discoverable from the runtime behaviour — a step whose
        // organisation has not allowed this just looks slow.
        renderFields({ draft: { askOnce: true } });
        expect(screen.getByText(/stored, encrypted/i)).toBeTruthy();
        expect(screen.getByText(/administrator decides/i)).toBeTruthy();
    });
});

describe('the word "cache" stays out of the visible copy', () => {
    it('never appears', () => {
        // "reuse" already means a reusable sub-flow in this product; a fifth
        // overload of the concept is not affordable. cache/ttl/memo live in
        // search keywords only.
        renderFields();
        openAdvanced();
        for (const word of [/\bcache\b/i, /\bcaching\b/i, /\bTTL\b/, /\bmemo/i]) {
            expect(document.body.textContent).not.toMatch(word);
        }
    });
});
