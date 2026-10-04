import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Studio → Forms (Track H2).
 *
 * The four rules this suite exists for, all of them the same shape — an
 * unknown state must not round to the comfortable answer:
 *
 *   1. a failed read is not an empty organisation (and a 200 in the wrong
 *      shape is a failed read);
 *   2. the header count is only ever rendered from a list that arrived;
 *   3. `mine` is checked for TRUE — an absent field is not permission to open
 *      somebody else's automation;
 *   4. an absent `live` gets its own pill instead of "Live" or "Not live".
 */

const { fetchMock, listOrgForms, getForm } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    listOrgForms: vi.fn(),
    getForm: vi.fn(),
}));

// A `t` that behaves like the real one: string fallback + {placeholder}
// interpolation, so "{count} forms" is asserted as a sentence rather than as
// a key.
vi.mock('../../../../hooks/useTranslation', () => {
    const t = (key, fallbackOrParams, paramsArg) => {
        const hasFallback = typeof fallbackOrParams === 'string';
        const params = hasFallback ? paramsArg : fallbackOrParams;
        let value = hasFallback ? fallbackOrParams : key;
        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
        return value;
    };
    const useTranslation = () => ({ t, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
// STABLE object, like the real hook's useMemo: FormsStudio's load effect is
// keyed on `api`, so a fresh literal per render would refetch forever.
const apiStub = { listOrgForms, getForm };
vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => apiStub }));
// createFormAutomation's own dependencies: the API layer it posts through and
// the builder module it import()s at call time.
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../../automation/Builder/flow/settings/FormBuilderFields', () => ({
    defaultFormDeclaration: () => ({ title: 'New form', fields: [{ name: 'q1' }] }),
}));

import FormsStudio, { canOpenAutomation, formLiveness, publicFormPath, readFormsPayload } from './FormsStudio';
import { takeSeed } from '../studioAi/handoff';

const TOKEN = 'a'.repeat(48);

/** One row exactly as GET /api/automation/forms sends it (crud.js). */
const form = (over = {}) => ({
    id: TOKEN,
    url: `/f/${TOKEN}`,
    automationId: 'au1',
    triggerStepId: null,
    title: 'Quote request',
    description: 'Ask for a quote',
    live: true,
    submissions: 28,
    lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    mine: true,
    ...over,
});

const renderStudio = (props = {}) => render(<FormsStudio user={{}} onNavigate={vi.fn()} {...props} />);

describe('formLiveness — three states, because "unknown" is one of them', () => {
    it('reads only a real boolean; everything else is unknown', () => {
        expect(formLiveness(form({ live: true }))).toBe('live');
        expect(formLiveness(form({ live: false }))).toBe('off');
        // A row that does not say. Calling this "live" promises a working
        // public link; calling it "not live" tells someone a form that may be
        // collecting submissions is switched off. Neither is available.
        expect(formLiveness(form({ live: undefined }))).toBe('unknown');
        expect(formLiveness({})).toBe('unknown');
        expect(formLiveness(null)).toBe('unknown');
        // Truthy is not true: a stringly-typed row is still an unknown one.
        expect(formLiveness(form({ live: 'true' }))).toBe('unknown');
        expect(formLiveness(form({ live: 1 }))).toBe('unknown');
    });
});

describe('publicFormPath — the token is a credential, so the path is checked', () => {
    it('takes the route\'s own url, and rebuilds it from the id when absent', () => {
        expect(publicFormPath(form())).toBe(`/f/${TOKEN}`);
        expect(publicFormPath(form({ url: undefined }))).toBe(`/f/${TOKEN}`);
    });

    it('refuses anything that is not a same-origin absolute path', () => {
        // A row is data from the server. A "public link" pointing somewhere
        // else is not this organisation's form, whatever the row claims — and
        // a protocol-relative `//host` is the version that looks like a path.
        expect(publicFormPath({ url: 'https://evil.example/f/x', id: 'tok' })).toBe('/f/tok');
        expect(publicFormPath({ url: '//evil.example/f/x', id: 'tok' })).toBe('/f/tok');
        expect(publicFormPath({ url: 'javascript:alert(1)', id: 'tok' })).toBe('/f/tok');
        // …and with no id to fall back on there is simply no link.
        expect(publicFormPath({ url: 'https://evil.example/f/x' })).toBeNull();
        expect(publicFormPath({})).toBeNull();
        expect(publicFormPath(null)).toBeNull();
    });
});

describe('canOpenAutomation — TRUE, never "not false"', () => {
    it('opens only for the owner of the automation behind the form', () => {
        expect(canOpenAutomation(form({ mine: true }))).toBe(true);
        expect(canOpenAutomation(form({ mine: false }))).toBe(false);
        // The failure this pins: /api/automation/:id is still per-user, so an
        // absent or stringly-typed `mine` must not open a colleague's automation.
        expect(canOpenAutomation(form({ mine: undefined }))).toBe(false);
        expect(canOpenAutomation(form({ mine: 'yes' }))).toBe(false);
        expect(canOpenAutomation(form({ mine: 1 }))).toBe(false);
        expect(canOpenAutomation({})).toBe(false);
        // Mine, but nothing to open.
        expect(canOpenAutomation(form({ mine: true, automationId: null }))).toBe(false);
    });
});

describe('readFormsPayload — a body it cannot read is a FAILED read', () => {
    it('returns the rows of a well-shaped body', () => {
        expect(readFormsPayload({ forms: [form()] })).toHaveLength(1);
        expect(readFormsPayload({ forms: [] })).toEqual([]);
        expect(readFormsPayload({ forms: [form(), null] })).toHaveLength(1);
    });

    it('throws on every body that is not the promised shape', () => {
        // `Array.isArray(body?.forms) ? body.forms : []` is what this replaces:
        // it turns a 200 nobody can read into "no forms yet" over an
        // organisation that may have twenty.
        for (const body of [null, undefined, {}, { forms: null }, { forms: {} }, { forms: 'nope' }, []]) {
            expect(() => readFormsPayload(body), JSON.stringify(body)).toThrow();
        }
    });
});

describe('<FormsStudio>', () => {
    beforeEach(() => {
        cleanup();
        listOrgForms.mockReset();
        fetchMock.mockReset();
    });

    it('lists the organisation\'s forms with a count, a status pill and the submission line', async () => {
        listOrgForms.mockResolvedValue({ forms: [form(), form({ id: 'b'.repeat(48), title: 'Report a fault', submissions: 1, live: false, mine: false })] });
        renderStudio();
        await screen.findByTestId('forms-list');
        expect(screen.getAllByTestId('form-row')).toHaveLength(2);
        expect(screen.getByTestId('forms-count').textContent).toBe('2 forms');
        const pills = screen.getAllByTestId('form-status');
        expect(pills[0].getAttribute('data-status')).toBe('live');
        expect(pills[0].textContent).toBe('Live');
        expect(pills[1].getAttribute('data-status')).toBe('off');
        // Singular and plural are a KEY choice, not a letter choice.
        const meta = screen.getAllByTestId('form-meta');
        expect(meta[0].textContent).toContain('28 submissions');
        expect(meta[0].textContent).toContain('2h ago');
        expect(meta[1].textContent).toContain('1 submission');
        expect(meta[1].textContent).not.toContain('1 submissions');
    });

    it('a row that does not say whether it is live gets its own pill', async () => {
        listOrgForms.mockResolvedValue({ forms: [form({ live: undefined })] });
        renderStudio();
        const pill = await screen.findByTestId('form-status');
        expect(pill.getAttribute('data-status')).toBe('unknown');
        expect(pill.textContent).toBe('Status unknown');
    });

    it('offers "open the automation" only to the owner, and says so on the others', async () => {
        listOrgForms.mockResolvedValue({
            forms: [
                form({ id: '1'.repeat(48), title: 'Mine', mine: true }),
                form({ id: '2'.repeat(48), title: 'Theirs', mine: false }),
                form({ id: '3'.repeat(48), title: 'Unsaid', mine: undefined }),
            ],
        });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate });
        await screen.findByTestId('forms-list');
        // One button for three rows: the owner's. `mine: undefined` is NOT a
        // door — the automation endpoints would 403 it.
        expect(screen.getAllByTestId('form-open-automation')).toHaveLength(1);
        expect(screen.getAllByTestId('form-not-mine')).toHaveLength(2);
        fireEvent.click(screen.getByTestId('form-open-automation'));
        // An AUTOMATION id in the URL, never the page token.
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/au1');
        expect(onNavigate.mock.calls.flat().join(' ')).not.toContain('1'.repeat(48));
    });

    it('copies the ABSOLUTE public address, not the bare /f path', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        listOrgForms.mockResolvedValue({ forms: [form()] });
        renderStudio();
        fireEvent.click(await screen.findByTestId('form-copy-link'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/f/${TOKEN}`));
    });

});

describe('<FormsStudio> — an empty list and a failed read are different screens', () => {
    beforeEach(() => {
        cleanup();
        listOrgForms.mockReset();
        fetchMock.mockReset();
    });

    it('a refused read is an error with a retry — never "No forms yet", never a count', async () => {
        listOrgForms.mockRejectedValueOnce(new Error('Forbidden'));
        renderStudio();
        expect((await screen.findByTestId('forms-error')).textContent).toContain('Forbidden');
        expect(screen.queryByTestId('forms-count')).toBeNull();
        expect(screen.queryByText('No forms yet')).toBeNull();
        expect(screen.queryByTestId('forms-list')).toBeNull();

        listOrgForms.mockResolvedValueOnce({ forms: [form()] });
        fireEvent.click(screen.getByTestId('forms-retry'));
        await screen.findByTestId('forms-list');
        expect(screen.queryByTestId('forms-error')).toBeNull();
        expect(screen.getByTestId('forms-count').textContent).toBe('1 form');
    });

    it('a 200 in an unreadable shape is a failed read too, not an empty organisation', async () => {
        listOrgForms.mockResolvedValue({ ok: true });
        renderStudio();
        const banner = await screen.findByTestId('forms-error');
        expect(screen.queryByText('No forms yet')).toBeNull();
        expect(screen.queryByTestId('forms-count')).toBeNull();
        // The reader gets the screen's own sentence, not the wire shape.
        expect(banner.textContent).toContain('this is not an empty list');
        expect(banner.textContent).not.toContain('forms: [...]');
    });

    it('withdraws the count when a LATER read fails, rather than leaving the number standing', async () => {
        // The rows stay — they are the last thing anyone actually knew, and
        // blanking them would put a wrong answer under a banner that says the
        // read failed. The COUNT does not, because a count is a claim about
        // the whole organisation and this app no longer knows the whole of it.
        listOrgForms.mockResolvedValueOnce({ forms: [form(), form({ id: 'b'.repeat(48) })] });
        renderStudio();
        expect((await screen.findByTestId('forms-count')).textContent).toBe('2 forms');

        listOrgForms.mockRejectedValueOnce(new Error('gone'));
        fireEvent.click(screen.getByTestId('forms-refresh'));
        await screen.findByTestId('forms-error');
        expect(screen.queryByTestId('forms-count')).toBeNull();
        expect(screen.getAllByTestId('form-row')).toHaveLength(2);
    });

    it('an organisation with no forms gets the empty state and an honest 0', async () => {
        listOrgForms.mockResolvedValue({ forms: [] });
        renderStudio();
        expect(await screen.findByText('No forms yet')).toBeTruthy();
        expect(screen.getByTestId('forms-count').textContent).toBe('0 forms');
        expect(screen.queryByTestId('forms-error')).toBeNull();
    });

    it('"New form" opens the dialog; "Collect answers in a table" creates a collecting form automation and lands on the Form page', async () => {
        listOrgForms.mockResolvedValue({ forms: [] });
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ automation: { id: 'au-form' }, answers: { datatableId: 'tbl_a', created: true } }) });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate });
        await screen.findByTestId('forms-new');
        fireEvent.click(screen.getByTestId('forms-new'));
        // the dialog, not a POST
        expect(fetchMock).not.toHaveBeenCalled();
        expect(onNavigate).toHaveBeenCalledWith('studio/forms/new');
        const dialog = await screen.findByTestId('new-form-dialog');
        expect(dialog).toBeTruthy();
        // collect is the default choice
        const radios = screen.getAllByRole('radio');
        expect(radios[0]).toBeChecked();
        fireEvent.change(screen.getByTestId('new-form-name'), { target: { value: 'Customer feedback' } });
        fireEvent.click(screen.getByTestId('new-form-create'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/forms/au-form/questions'));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/automation');
        const body = JSON.parse(init.body);
        expect(body.title).toBe('Customer feedback');
        expect(body.definition.trigger).toMatchObject({ kind: 'form', type: 'trigger', form: { title: 'Customer feedback', collect: true } });
    });

    it('a brief typed in the dialog is parked under the NEW form\'s id for its Questions tab — and only for a collecting form', async () => {
        listOrgForms.mockResolvedValue({ forms: [] });
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ automation: { id: 'au-form' } }) });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate });
        fireEvent.click(await screen.findByTestId('forms-new'));
        await screen.findByTestId('new-form-dialog');
        fireEvent.change(screen.getByTestId('new-form-brief'), { target: { value: 'A vacation request form' } });
        // the brief box belongs to the collecting choice only
        fireEvent.click(screen.getAllByRole('radio')[1]);
        expect(screen.queryByTestId('new-form-brief')).toBeNull();
        fireEvent.click(screen.getAllByRole('radio')[0]);
        expect(screen.getByTestId('new-form-brief').value).toBe('A vacation request form');
        fireEvent.click(screen.getByTestId('new-form-create'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/forms/au-form/questions'));
        // not in the create body …
        expect(JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body))).not.toContain('vacation');
        // … but parked for THIS form, once
        expect(takeSeed('form:au-form')).toBe('A vacation request form');
        expect(takeSeed('form:au-form')).toBe(null);
    });

    it('"Form that starts an automation" creates the automation without a table and opens the builder', async () => {
        listOrgForms.mockResolvedValue({ forms: [] });
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ automation: { id: 'au-form' } }) });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate });
        fireEvent.click(await screen.findByTestId('forms-new'));
        await screen.findByTestId('new-form-dialog');
        fireEvent.click(screen.getAllByRole('radio')[1]);
        fireEvent.click(screen.getByTestId('new-form-create'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/automations/au-form'));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.definition.trigger.form.collect).toBeUndefined();
        expect(body.title).toBe('Untitled form');
    });

    it('a refused create says so in the dialog instead of failing silently', async () => {
        listOrgForms.mockResolvedValue({ forms: [] });
        fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'feature_locked' });
        renderStudio();
        fireEvent.click(await screen.findByTestId('forms-new'));
        await screen.findByTestId('new-form-dialog');
        fireEvent.click(screen.getByTestId('new-form-create'));
        expect((await screen.findByRole('alert')).textContent).toContain('Could not create the form.');
    });
});

// ── The words on this screen are coupled to a server flag ────────────
//
// This directory shipped calling `/f/<token>` a PUBLIC link. It is not one:
// server/routes/automation/formPublic.js sets `PUBLIC_FORMS_ENABLED = false`
// and puts `requireAuth` in front of the whole form surface, after which
// `callerMayOpen` narrows again to the organisation that owns the form. So the
// screen promised a customer a link that a customer cannot open, and nothing
// would ever have gone red about it — the copy and the flag live in different
// languages, in different halves of the repo.
//
// This test is the wire between them. Flip the flag and it fails, which is the
// point: whoever turns public forms on has to come back and say so here.
describe('the copy matches what the server actually allows', () => {
    const serverSrc = readFileSync(
        resolve(__dirname, '../../../../../../server/routes/automation/formPublic.js'),
        'utf8',
    );

    it('public forms are still off on the server', () => {
        expect(serverSrc).toMatch(/const PUBLIC_FORMS_ENABLED = false;/);
        expect(serverSrc).toMatch(/if \(!PUBLIC_FORMS_ENABLED\) router\.use\(requireAuth\)/);
    });

    it('…so nothing on this screen calls the address public', () => {
        // Not a style rule: with the flag off, every one of these words is a
        // promise the product does not keep.
        const ownSrc = readFileSync(resolve(__dirname, './FormsStudio.jsx'), 'utf8');
        for (const claim of ['public link', 'public address', 'Anyone with the link']) {
            expect(ownSrc, `FormsStudio.jsx still claims "${claim}"`).not.toContain(claim);
        }
    });

    it('…and the live pill says who can actually open it', () => {
        const ownSrc = readFileSync(resolve(__dirname, './FormsStudio.jsx'), 'utf8');
        expect(ownSrc).toContain('after signing in');
    });
});

// ── The Form page behind a row ───────────────────────────────────────
//
// A row opens the Form page for its owner and for a colleague the answers
// TABLE is shared with (`answers.grade`), never for anyone else. The page is
// addressed by the AUTOMATION id — the token never travels.
vi.mock('./FormPage', () => ({
    default: ({ form, tab }) => <div data-testid="form-page-stub" data-form={form.automationId} data-tab={tab || ''} />,
}));

describe('<FormsStudio> — rows open the Form page by the automation id, by grade', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cleanup();
    });

    it('the owner\'s row is a button that opens the page; "Answers" opens its Answers tab', async () => {
        listOrgForms.mockResolvedValue({ forms: [form({ answers: { collecting: true, datatableId: 'tbl_a', grade: 'owner', rowCount: 28 } })] });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate });
        const answers = await screen.findByTestId('form-answers');
        expect(answers.textContent).toContain('Answers · 28 responses');
        expect(screen.getByTestId('form-collects')).toBeTruthy();
        fireEvent.click(screen.getByTestId('form-open'));
        expect(onNavigate).toHaveBeenCalledWith('studio/forms/au1');
        expect(screen.getByTestId('form-page-stub').getAttribute('data-form')).toBe('au1');
        // the token is in no navigation call
        for (const [target] of onNavigate.mock.calls) expect(target).not.toContain(TOKEN);
    });

    it('the owner\'s row says who can fill it in; a colleague\'s row does not', async () => {
        listOrgForms.mockResolvedValue({
            forms: [
                form({ automationId: 'a', audience: { mode: 'restricted', groups: [], users: [] } }),
                form({ automationId: 'b', id: 'b'.repeat(48), audience: { mode: 'restricted', groups: ['g1'], users: ['u1', 'u2'] } }),
                form({ automationId: 'c', id: 'c'.repeat(48), audience: { mode: 'org', groups: [], users: [] } }),
                form({ automationId: 'd', id: 'd'.repeat(48), mine: false, audience: { mode: 'restricted' } }),
            ],
        });
        renderStudio();
        const chips = await screen.findAllByTestId('form-audience-chip');
        expect(chips.map(c => c.textContent)).toEqual(['Only you — not shared yet', 'Shared with 3 people and groups', 'Everyone in the organisation']);
    });

    it('a colleague with a grade on the answers table gets the Answers button and the page; without one, neither', async () => {
        listOrgForms.mockResolvedValue({
            forms: [
                form({ automationId: 'au-shared', mine: false, title: 'Shared', answers: { collecting: true, datatableId: 'tbl_s', grade: 'viewer', rowCount: 3 } }),
                form({ automationId: 'au-other', id: 'b'.repeat(48), mine: false, title: 'Other', answers: { collecting: true, datatableId: null, grade: null, rowCount: null } }),
            ],
        });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate });
        await screen.findByText('Shared');
        expect(screen.getAllByTestId('form-answers').length).toBe(1);
        expect(screen.getAllByTestId('form-open').length).toBe(1);
        expect(screen.getAllByTestId('form-not-mine').length).toBe(2);
        fireEvent.click(screen.getByTestId('form-answers'));
        expect(onNavigate).toHaveBeenCalledWith('studio/forms/au-shared/answers');
        expect(screen.getByTestId('form-page-stub').getAttribute('data-tab')).toBe('answers');
    });

    it('a deep link to a form nobody shared with this account goes back to the list with a word', async () => {
        listOrgForms.mockResolvedValue({ forms: [form({ automationId: 'au-other', mine: false, answers: null })] });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate, initialFormId: 'au-other' });
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/forms'));
        expect(screen.queryByTestId('form-page-stub')).toBeNull();
    });

    it('a form NEWER than the list (just created by the dialog) is looked up by itself and opens', async () => {
        // the list was fetched before the form existed
        listOrgForms.mockResolvedValue({ forms: [] });
        getForm.mockResolvedValue({ form: form({ automationId: 'au-new', title: 'Fresh', answers: { collecting: true, datatableId: 'tbl_n', grade: 'owner', rowCount: 0 } }) });
        const onNavigate = vi.fn();
        renderStudio({ onNavigate, initialFormId: 'au-new', initialFormTab: 'questions' });
        const page = await screen.findByTestId('form-page-stub');
        expect(page.getAttribute('data-form')).toBe('au-new');
        expect(page.getAttribute('data-tab')).toBe('questions');
        expect(getForm).toHaveBeenCalledWith('au-new');
        expect(onNavigate).not.toHaveBeenCalledWith('studio/forms');
    });

    it('a deep link to a form that is in neither the list nor the lookup goes back with a word', async () => {
        listOrgForms.mockResolvedValue({ forms: [form()] });
        getForm.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
        const onNavigate = vi.fn();
        renderStudio({ onNavigate, initialFormId: 'au-gone' });
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/forms'));
        expect(getForm).toHaveBeenCalledWith('au-gone');
        expect(screen.queryByTestId('form-page-stub')).toBeNull();
    });

    it('a deep link with a tab lands on that tab', async () => {
        listOrgForms.mockResolvedValue({ forms: [form({ answers: { collecting: true, datatableId: 'tbl_a', grade: 'owner', rowCount: 0 } })] });
        renderStudio({ initialFormId: 'au1', initialFormTab: 'settings' });
        const page = await screen.findByTestId('form-page-stub');
        expect(page.getAttribute('data-tab')).toBe('settings');
    });
});
