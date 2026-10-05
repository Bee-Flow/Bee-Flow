import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { useEffect, useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The code step's face.
 *
 * What this file is defending, in the order it matters:
 *
 *   1. There is always a box you can type code into. Monaco is a lazily
 *      imported chunk that can be gone after a redeploy; it can load and then
 *      hand us no editor instance; and — the one an offline self-host actually
 *      hits — it can import fine while the editor runtime it fetches from a CDN
 *      never arrives, so nothing ever reports a failure at all. Three
 *      independent ways to end up with nothing, and in every one of them a
 *      plain textarea must take over, because the alternative is an author
 *      staring at a "Loading..." with their snippet still in the definition. The plain box is ALSO a choice a user can make
 *      on purpose: Monaco holds on to Tab, and "usable by a less technical
 *      person" is the entire justification for this product.
 *   2. The contract is on screen. The runner hands the snippet inputs,
 *      ctx.log, ctx.http and ctx.integrations, and refuses ctx.secrets — none
 *      of which this editor used to mention at all. readCodeContract reads the
 *      author's own source back so the panel can say what the step will reach.
 *   3. The inputs table is offered ONLY when a save can carry it. See
 *      codeInputsRoundTrip in codeFields.jsx: a draft key that buildPatch does
 *      not forward is not ignored, it is silently dropped by flushNow — the
 *      C12/C16/C18 failure, three times paid for already.
 *
 * Monaco itself does not run in jsdom (canvas, workers, measurements), so
 * `@monaco-editor/react` is always a stub here. What that CAN prove: which box
 * is on screen, what reaches it, and what happens when the module is gone.
 * What it CANNOT prove: that Monaco renders JavaScript nicely.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run \
 *   src/components/automation/Builder/flow/settings/actionEditors/codeFields.test.jsx
 */

// A stub that behaves like the real component in the ways this file reads:
// mounts once, reports onMount once, and reports edits through onChange.
// `mountsNothing` reproduces the second failure mode — Monaco loaded, no
// editor handed over. `neverMounts` reproduces the third and worst one: the
// wrapper chunk arrived, the editor RUNTIME (a CDN fetch, see
// MONACO_MOUNT_DEADLINE_MS) never did, so onMount is simply never called and
// the real component sits on its own "Loading..." indefinitely.
/** Every loader.config() call the code step made: where it told Monaco to load from. */
const loaderConfigs = [];
function monacoStub({ mountsNothing = false, neverMounts = false } = {}) {
    return {
        loader: { config: (c) => { loaderConfigs.push(c); } },
        default: function MonacoStub({ value, onChange, onMount, options }) {
            const mounted = useRef(false);
            useEffect(() => {
                if (neverMounts || mounted.current) return;
                mounted.current = true;
                onMount?.(mountsNothing ? null : { id: 'fake-editor' });
            }, [onMount]);
            return (
                <div data-testid="monaco-stub" data-aria={options?.ariaLabel} data-value={value}>
                    <button type="button" onClick={() => onChange?.('return 42;')}>stub-edit</button>
                </div>
            );
        },
    };
}

/**
 * Loads codeFields.jsx with a chosen Monaco and a chosen form round-trip.
 *
 * The module registry is reset per variant because React.lazy caches the
 * resolved module for the lifetime of the module instance: a Monaco that
 * failed once cannot be made to succeed again in the same instance, which is
 * exactly the behaviour the editor relies on (see the disabled switch).
 */
async function loadCodeFields({ monaco = 'ok', inputsRoundTrip = true } = {}) {
    vi.resetModules();
    if (monaco === 'missing') {
        vi.doMock('@monaco-editor/react', () => {
            throw new Error('Failed to fetch dynamically imported module: /assets/vendor-monaco-abc123.js');
        });
    } else {
        vi.doMock('@monaco-editor/react', () => monacoStub({
            mountsNothing: monaco === 'no-editor',
            neverMounts: monaco === 'never-mounts',
        }));
    }
    // The round trip is REAL now (formState carries `inputs` for code steps in
    // both directions), so the interesting mock is the opposite one: take it
    // away and check the editor closes the table again rather than offering a
    // control whose value a save would drop.
    if (inputsRoundTrip === false) {
        vi.doMock('../formState', async (importOriginal) => {
            const real = await importOriginal();
            return {
                ...real,
                // The READ half removed — the older of the two failure shapes:
                // the author types an input, watches it sit there, and finds it
                // gone on reopen with no error anywhere.
                extractFormState: (step) => {
                    const d = { ...real.extractFormState(step) };
                    delete d.inputs;
                    return d;
                },
            };
        });
    }
    return import('./codeFields');
}

// These tests pin the AUTHOR's view (no declared parameters, so no form):
// the server's analysis is pinned to "not available", which is also what an
// older server or an offline drawer gets.
vi.mock('../codeStep/useStepCodeAnalysis', () => ({
    ANALYZE_DEBOUNCE_MS: 400,
    useStepCodeAnalysis: () => ({ analysis: null, reading: false, failed: true }),
}));

// The settings read the server's analysis of the code through react-query.
// No server answers here, so the analysis fails quietly and the drawer shows
// the author's view, which is what these tests pin.
const renderUI = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const draftOf = (over = {}) => ({ label: '', icon: '', code: '', forEach: null, ...over });

const plainBox = () => screen.queryByRole('textbox', { name: /javascript code/i });

afterEach(() => { cleanup(); vi.doUnmock('@monaco-editor/react'); vi.doUnmock('../formState'); });

describe('there is always a box to type code into', () => {
    it('uses the real editor when the chunk is there, and edits reach the draft', async () => {
        const { CodeFields } = await loadCodeFields();
        const set = vi.fn();
        renderUI(<CodeFields draft={draftOf({ code: 'return 1;' })} set={set} />);

        const stub = await screen.findByTestId('monaco-stub');
        expect(stub.dataset.value).toBe('return 1;');
        // Monaco carries the visible label as its OWN accessible name: the
        // FormRow label has no control to point at, because which control
        // exists depends on the user's choice.
        expect(stub.dataset.aria).toBe('JavaScript code');
        expect(plainBox()).toBeNull();
        // The runtime comes from this app, never the CDN default (privacy, and
        // an offline self-host gets an editor too).
        expect(loaderConfigs.at(-1)?.paths?.vs).toMatch(/\/monaco\/vs$/);
        expect(loaderConfigs.at(-1)?.paths?.vs).not.toMatch(/jsdelivr|cdn/);

        fireEvent.click(screen.getByRole('button', { name: 'stub-edit' }));
        expect(set).toHaveBeenCalledWith('code', 'return 42;');
    });

    it('BITES — a missing Monaco chunk leaves a working textarea, not an empty panel', async () => {
        const { CodeFields } = await loadCodeFields({ monaco: 'missing' });
        const set = vi.fn();
        renderUI(<CodeFields draft={draftOf({ code: 'return 1;' })} set={set} />);

        // The whole point: the failure renders, it does not throw. A lazy
        // component resolving to `null` would blow up here instead.
        await waitFor(() => expect(plainBox()).not.toBeNull());
        expect(plainBox().value).toBe('return 1;');
        expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();

        fireEvent.change(plainBox(), { target: { value: 'return 2;' } });
        expect(set).toHaveBeenCalledWith('code', 'return 2;');
    });

    it('a Monaco that loads but hands over no editor falls back the same way', async () => {
        const { CodeFields } = await loadCodeFields({ monaco: 'no-editor' });
        renderUI(<CodeFields draft={draftOf({ code: 'x' })} set={vi.fn()} />);

        await waitFor(() => expect(plainBox()).not.toBeNull());
        expect(plainBox().value).toBe('x');
    });

    it('offers the plain box as a CHOICE, with a way out of the keyboard trap', async () => {
        const { CodeFields } = await loadCodeFields();
        const set = vi.fn();
        renderUI(<CodeFields draft={draftOf({ code: 'return 1;' })} set={set} />);

        await screen.findByTestId('monaco-stub');
        // Monaco holds Tab; the escape hatch has to be readable, not folklore.
        expect(screen.getByText(/Ctrl\+M/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('radio', { name: /plain text/i }));
        expect(screen.queryByTestId('monaco-stub')).toBeNull();
        expect(plainBox().value).toBe('return 1;');
        fireEvent.change(plainBox(), { target: { value: 'return 3;' } });
        expect(set).toHaveBeenCalledWith('code', 'return 3;');

        // Back again — the choice is a preference, not a one-way door.
        fireEvent.click(screen.getByRole('radio', { name: /code editor/i }));
        expect(await screen.findByTestId('monaco-stub')).toBeInTheDocument();
    });

    it('stops offering the choice once the chunk is gone — it cannot come back', async () => {
        const { CodeFields } = await loadCodeFields({ monaco: 'missing' });
        renderUI(<CodeFields draft={draftOf()} set={vi.fn()} />);

        await waitFor(() => expect(plainBox()).not.toBeNull());
        expect(screen.getByRole('radio', { name: /code editor/i })).toBeDisabled();
    });
});

// Split out of the block above only because that one had grown past the
// max-lines-per-function warning; it is the same promise — there is always
// a box — for the failure mode nothing ever reports.
describe('the editor that never arrives at all', () => {
    it('BITES — an editor that never finishes loading hands the box back on a deadline', async () => {
        // The offline/air-gapped self-host case, which is the deployment this
        // whole product is sold for: the import resolves (the chunk is in the
        // bundle), so neither the missing-chunk path nor the no-editor path
        // fires, and without a deadline the author waits forever on a CDN that
        // this install cannot reach. shouldAdvanceTime keeps real time moving
        // so the lazy import still resolves under fake timers.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { CodeFields } = await loadCodeFields({ monaco: 'never-mounts' });
            const set = vi.fn();
            renderUI(<CodeFields draft={draftOf({ code: 'return 1;' })} set={set} />);

            await screen.findByTestId('monaco-stub');
            // Still waiting: a slow CDN must not be mistaken for a dead one.
            await act(async () => { vi.advanceTimersByTime(4000); });
            expect(plainBox()).toBeNull();

            await act(async () => { vi.advanceTimersByTime(5000); });
            expect(plainBox()).not.toBeNull();
            expect(plainBox().value).toBe('return 1;');
            expect(screen.getByText(/did not finish loading/i)).toBeInTheDocument();

            fireEvent.change(plainBox(), { target: { value: 'return 9;' } });
            expect(set).toHaveBeenCalledWith('code', 'return 9;');
            // A stall is not the cached-module dead end, so the author may
            // still ask for the editor back — and asking must actually do
            // something, because `plain` is true while a failure is recorded.
            const again = screen.getByRole('radio', { name: /code editor/i });
            expect(again).not.toBeDisabled();
            fireEvent.click(again);
            expect(screen.getByTestId('monaco-stub')).toBeInTheDocument();
            expect(plainBox()).toBeNull();
            expect(screen.queryByText(/did not finish loading/i)).toBeNull();

            // ...and the deadline re-arms, so a second stall is caught too.
            await act(async () => { vi.advanceTimersByTime(9000); });
            expect(plainBox()).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a healthy editor is never taken away by the deadline', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { CodeFields } = await loadCodeFields();
            renderUI(<CodeFields draft={draftOf({ code: 'return 1;' })} set={vi.fn()} />);

            await screen.findByTestId('monaco-stub');
            // The stub being in the DOM is NOT the same thing as `mounted`.
            // The mock reports onMount from an effect (see the factory at the
            // top of this file), and it is that report which clears the
            // deadline. findBy* resolves on the render, one tick earlier. So
            // flush the effect before jumping the clock — otherwise, under
            // load, we advance 60s past a deadline that is still armed and
            // the component does exactly what it should: shows the plain box.
            // That is this test's entire flake, and it blamed the component.
            await act(async () => {});
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(screen.getByTestId('monaco-stub')).toBeInTheDocument();
            expect(plainBox()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the contract the sandbox enforces is on screen', () => {
    it('names the bridges and the budget above the editor', async () => {
        const { CodeFields } = await loadCodeFields();
        renderUI(<CodeFields draft={draftOf()} set={vi.fn()} />);

        // The old hint said only "Sandboxed." — every one of these was a
        // contract the runner honoured and the author had to read the server
        // to discover.
        const panel = document.body.textContent;
        expect(panel).toMatch(/ctx\.log/);
        expect(panel).toMatch(/ctx\.http/);
        expect(panel).toMatch(/ctx\.integrations/);
        expect(panel).toMatch(/HTTPS only/i);
        expect(panel).toMatch(/5 HTTP calls/);
    });

    it('BITES — a tool call an AI wrote into the snippet is named on screen', async () => {
        const { CodeFields } = await loadCodeFields();
        renderUI(<CodeFields draft={draftOf({ code: 'await ctx.integrations.gmail_send({ to });' })} set={vi.fn()} />);

        expect(screen.getByText('What this step may reach')).toBeInTheDocument();
        expect(screen.getByText('gmail_send')).toBeInTheDocument();
        expect(document.body.textContent).toMatch(/refused\s+at run time unless/i);
        // ...and the floor line now says there IS a way out, because there is.
        expect(document.body.textContent).toMatch(/the ways out this code does use/i);
    });

    it('warns about ctx.secrets, which this build always refuses', async () => {
        const { CodeFields } = await loadCodeFields();
        renderUI(<CodeFields draft={draftOf({ code: 'const k = await ctx.secrets("stripe_key");' })} set={vi.fn()} />);

        expect(document.body.textContent).toMatch(/not wired in this build/i);
    });

    it('says so plainly when the step reaches nothing at all', async () => {
        const { CodeFields } = await loadCodeFields();
        renderUI(<CodeFields draft={draftOf({ code: 'return 1 + 1;' })} set={vi.fn()} />);

        expect(screen.getByText(/Reads no step inputs/i)).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/Connected apps/);
        // The floor line must not point at bridges that are not on screen: a
        // panel whose job is to be believed cannot end on "the two bridges
        // below" with nothing below it.
        expect(document.body.textContent).toMatch(/no network of its own/i);
        expect(document.body.textContent).not.toMatch(/the ways out/i);
    });
});

describe('readCodeContract reads the author\'s own source back', () => {
    let readCodeContract;
    const contract = (code) => readCodeContract(code);

    // beforeAll, not a bookkeeping `it('loads')`: with the import hidden in a
    // test case, every assertion below depends on the runner keeping them in
    // file order, and a `-t` filter run of any single one of them reports
    // "readCodeContract is not a function" instead of the thing it checks.
    beforeAll(async () => { ({ readCodeContract } = await loadCodeFields()); });

    it('finds inputs read by name, by key and by destructuring', () => {
        expect(contract('return inputs.invoiceId;').inputNames).toEqual(['invoiceId']);
        expect(contract('return inputs["customer name"];').inputNames).toEqual(['customer name']);
        expect(contract('const { amount, due: d } = inputs;').inputNames).toEqual(['amount', 'due']);
        expect(contract('const { a = 1 } = inputs;').inputNames).toEqual(['a']);
    });

    it('admits when the list cannot be complete', () => {
        // A computed key means the panel is looking at a floor, not a list.
        // Hiding that would be worse than showing nothing.
        expect(contract('return inputs[key];').computedInputs).toBe(true);
        expect(contract('const { a, ...rest } = inputs;').computedInputs).toBe(true);
        expect(contract('return inputs.a;').computedInputs).toBe(false);
    });

    it('finds tool calls in both spellings, sorted and de-duplicated', () => {
        const c = contract('ctx.integrations.slack_post({}); ctx.integrations["gmail_send"]({}); ctx.integrations.slack_post({});');
        expect(c.toolNames).toEqual(['gmail_send', 'slack_post']);
    });

    it('notices the other three bridges', () => {
        expect(contract('await ctx.http("https://x")').usesHttp).toBe(true);
        expect(contract('ctx.log("hi")').usesLog).toBe(true);
        expect(contract('ctx.secrets("k")').usesSecrets).toBe(true);
        expect(contract('return 1;')).toMatchObject({ usesHttp: false, usesLog: false, usesSecrets: false });
    });

    it('survives an empty or missing snippet', () => {
        expect(contract('').inputNames).toEqual([]);
        expect(contract(undefined).toolNames).toEqual([]);
        expect(contract(null).usesHttp).toBe(false);
    });
});

describe('the inputs table is offered only when a save can carry it', () => {
    it('CLOSES AGAIN if the round trip is ever taken away', async () => {
        // This used to read "today it is not offered", and it was right: the
        // round trip did not exist. It does now (formState carries `inputs`
        // for code steps both ways), so the fact the test described has
        // changed — and what is still worth pinning is the PROTECTION, which
        // is why the gate was built rather than the table being mounted
        // unconditionally. Break either half of the round trip and the table
        // must disappear rather than promise a save that never happens, with
        // the panel saying where the value actually comes from instead.
        const { CodeFields } = await loadCodeFields({ inputsRoundTrip: false });
        renderUI(<CodeFields draft={draftOf({ code: 'return inputs.invoiceId;' })} set={vi.fn()} />);

        expect(screen.queryByRole('button', { name: /add field/i })).toBeNull();
        expect(document.body.textContent).toMatch(/this editor cannot set yet/i);
    });

    it('offers it, because the form round-trip exists', async () => {
        const { CodeFields } = await loadCodeFields();
        const set = vi.fn();
        renderUI(
            <CodeFields
                draft={draftOf({ code: 'return inputs.invoiceId;', inputs: { invoiceId: { kind: 'literal', value: 'INV-1' } } })}
                set={set}
            />,
        );

        expect(screen.getByDisplayValue('invoiceId')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^add field$/i })).toBeInTheDocument();
        // And the panel stops apologising, because the author can now act.
        expect(document.body.textContent).not.toMatch(/this editor cannot set yet/i);

        fireEvent.click(screen.getByRole('button', { name: /^add field$/i }));
        expect(set).toHaveBeenCalledWith('inputs', expect.objectContaining({
            invoiceId: { kind: 'literal', value: 'INV-1' },
        }));
    });
});

describe('what was already here keeps working', () => {
    it('still renders the run-once-per-item section', async () => {
        const { CodeFields } = await loadCodeFields();
        renderUI(<CodeFields draft={draftOf({ forEach: { overRef: 'trigger.output.rows', itemVar: 'item' } })} set={vi.fn()} />);
        await screen.findByTestId('monaco-stub');

        // Advanced settings show in the Advanced mode (no context = full view).
        expect(screen.getByRole('checkbox', { name: /run once per item/i })).toBeChecked();
    });
});
