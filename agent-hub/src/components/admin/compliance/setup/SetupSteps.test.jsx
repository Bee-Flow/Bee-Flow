import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SetupStepBody, {
    SETUP_STEPS, SETUP_STEP_COUNT, LEGAL_BASES,
    applyAutoDetect, canProceed, firstOpenStep, initialSetupData, setupBody, stepIsComplete,
} from './SetupSteps';

// The legacy OnboardingWizard test mocked `t` to the raw key; these assertions
// are ported onto the English fallbacks the redesign passes explicitly.
function tr(key, fallbackOrParams, paramsArg) {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let value = hasFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
    }
    return value;
}
vi.mock('../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: tr, locale: 'en', resolvedLocale: 'en' }),
}));

const DETECTED = {
    legal_bases: ['contract', 'consent'],
    data_residency: 'hybrid',
    default_retention_days: 180,
    privacy_notice_url: null,
    breach_recipients: ['admin@acme.example'],
};

const ORG_USERS = [
    { id: 'jan', displayName: 'Jan Janssen', email: 'jan@acme.nl', phone: '0611111111', orgRole: 'org_admin' },
    { id: 'zoe', displayName: 'Zoë de Vries', email: 'zoe@acme.nl', phone: null, orgRole: 'dpo' },
];

// A controlled host: the SetupCard owns the flat data object, so the step
// bodies are tested the same way it drives them.
function Host({ settings = {}, orgUsers = null, step = 0, onData }) {
    const [data, setData] = React.useState(() => initialSetupData(settings));
    React.useEffect(() => { onData?.(data); }, [data, onData]);
    return <SetupStepBody step={step} data={data} onChange={(patch) => setData(prev => ({ ...prev, ...patch }))} orgUsers={orgUsers} />;
}

describe('applyAutoDetect — the prefill rule', () => {
    it('prefills fields the org never saved', () => {
        const { patch, hit } = applyAutoDetect(DETECTED, {});
        expect(patch.legal_bases).toEqual(['contract', 'consent']);
        expect(patch.data_residency).toBe('hybrid');
        expect(patch.default_retention_days).toBe(180);
        expect(patch.breach_recipients).toEqual(['admin@acme.example']);
        expect(hit).toContain('legal_bases');
        // A null in the payload is not a value — nothing is filled from it.
        expect(patch).not.toHaveProperty('privacy_notice_url');
    });

    it('never overwrites a setting the org already saved', () => {
        const stored = { legal_bases: ['legal_obligation'], breach_recipients: ['dpo@saved.example'], data_residency: 'eu', default_retention_days: 730 };
        const { patch, hit } = applyAutoDetect(DETECTED, stored);
        expect(patch).not.toHaveProperty('legal_bases');
        expect(patch).not.toHaveProperty('breach_recipients');
        expect(patch).not.toHaveProperty('data_residency');
        expect(patch).not.toHaveProperty('default_retention_days');
        expect(hit).toEqual([]);
    });

    it('survives a failing or junk auto-detect payload', () => {
        for (const bad of [null, undefined, 'nope', 42, []]) {
            expect(applyAutoDetect(bad, {})).toEqual({ patch: {}, hit: [] });
        }
    });

    it('fills the DPO only from an address that looks like one, and only when nothing is stored', () => {
        expect(applyAutoDetect({ dpo_email: 'not-an-email', dpo_name: 'X' }, {}).patch).toEqual({});
        const { patch } = applyAutoDetect({ dpo_email: 'dpo@acme.nl', dpo_name: 'M. de Vries' }, {});
        expect(patch).toEqual({ dpo_email: 'dpo@acme.nl', dpo_name: 'M. de Vries' });
        expect(applyAutoDetect({ dpo_email: 'dpo@acme.nl' }, { dpo_email: 'own@acme.nl' }).patch).toEqual({});
    });
});

describe('validation and progress', () => {
    it('step 1 needs a name and something that looks like an e-mail address', () => {
        expect(canProceed(0, { dpo_name: 'Jane' })).toBe(false);
        expect(canProceed(0, { dpo_email: 'jane@acme.example' })).toBe(false);
        expect(canProceed(0, { dpo_name: 'Jane', dpo_email: 'nope' })).toBe(false);
        expect(canProceed(0, { dpo_name: 'Jane', dpo_email: 'jane@acme.example' })).toBe(true);
    });

    it('step 2 needs at least one legal basis; steps 3 and 4 always pass', () => {
        expect(canProceed(1, { legal_bases: [] })).toBe(false);
        expect(canProceed(1, { legal_bases: ['contract'] })).toBe(true);
        expect(canProceed(2, {})).toBe(true);
        expect(canProceed(3, {})).toBe(true);
    });

    it('a step counts as complete only with a real answer', () => {
        expect(stepIsComplete(2, { data_residency: 'eu' })).toBe(true);
        expect(stepIsComplete(2, {})).toBe(false);
        expect(stepIsComplete(3, { breach_recipients: [] })).toBe(false);
        expect(stepIsComplete(3, { breach_recipients: ['a@b.nl'] })).toBe(true);
    });

    it('firstOpenStep points at the first gap, and past the last step when nothing is open', () => {
        expect(firstOpenStep(initialSetupData({}))).toBe(0);
        expect(firstOpenStep(initialSetupData({ dpo_name: 'Jane', dpo_email: 'jane@acme.nl' }))).toBe(3);
        expect(firstOpenStep(initialSetupData({
            dpo_name: 'Jane', dpo_email: 'jane@acme.nl', breach_recipients: ['a@b.nl'],
        }))).toBe(SETUP_STEP_COUNT);
    });

    it('defaults are the wizard defaults', () => {
        const d = initialSetupData(null);
        expect(d.legal_bases).toEqual(['contract', 'legitimate_interests']);
        expect(d.data_residency).toBe('eu');
        expect(d.default_retention_days).toBe(365);
        expect(SETUP_STEPS).toHaveLength(4);
    });
});

describe('setupBody — an allow-list, not a filtered form state', () => {
    it('sends exactly the eight settings fields and drops the form scratch field', () => {
        const body = setupBody({ ...initialSetupData({}), dpo_name: 'Jane', dpo_email: 'jane@acme.nl', newRecipient: 'typed-but-not-added@acme.nl' });
        expect(Object.keys(body).sort()).toEqual([
            'breach_recipients', 'data_residency', 'default_retention_days',
            'dpo_email', 'dpo_name', 'dpo_phone', 'legal_bases', 'privacy_notice_url',
        ]);
        expect(JSON.stringify(body)).not.toContain('typed-but-not-added');
    });

    it('turns an empty retention box into null, not 0', () => {
        expect(setupBody({ ...initialSetupData({}), default_retention_days: '' }).default_retention_days).toBeNull();
        expect(setupBody({ ...initialSetupData({}), default_retention_days: '180' }).default_retention_days).toBe(180);
    });
});

describe('SetupStepBody — the four bodies', () => {
    beforeEach(cleanup);

    it('DPO step: picking a member fills the fields, which stay editable', async () => {
        const user = userEvent.setup();
        render(<Host orgUsers={ORG_USERS} step={0} />);
        await user.selectOptions(screen.getByRole('combobox'), 'zoe');
        expect(screen.getByLabelText('Name').value).toBe('Zoë de Vries');
        expect(screen.getByLabelText('E-mail').value).toBe('zoe@acme.nl');
        expect(screen.getByLabelText('Phone').value).toBe('');
        // External-DPO path: the plain inputs remain writable after a pick.
        await user.clear(screen.getByLabelText('E-mail'));
        await user.type(screen.getByLabelText('E-mail'), 'extern@dpo.example');
        expect(screen.getByLabelText('E-mail').value).toBe('extern@dpo.example');
    });

    it('renders no picker without a directory — free text is the only path', () => {
        render(<Host step={0} />);
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });

    it('legal-bases step toggles a basis on and off', async () => {
        const user = userEvent.setup();
        let latest = null;
        render(<Host step={1} onData={(d) => { latest = d; }} />);
        expect(screen.getByTestId('setup-step-lb-contract')).toHaveAttribute('aria-pressed', 'true');
        await user.click(screen.getByTestId('setup-step-lb-contract'));
        expect(latest.legal_bases).not.toContain('contract');
        await user.click(screen.getByTestId('setup-step-lb-consent'));
        expect(latest.legal_bases).toContain('consent');
        expect(LEGAL_BASES).toHaveLength(6);
    });

    it('residency step edits residency and retention', async () => {
        const user = userEvent.setup();
        let latest = null;
        render(<Host step={2} onData={(d) => { latest = d; }} />);
        await user.selectOptions(screen.getByTestId('setup-step-residency-select'), 'hybrid');
        await user.clear(screen.getByTestId('setup-step-retention'));
        await user.type(screen.getByTestId('setup-step-retention'), '180');
        expect(latest.data_residency).toBe('hybrid');
        expect(latest.default_retention_days).toBe('180');
    });

    it('breach step: picking a member appends their address, and they leave the dropdown', async () => {
        const user = userEvent.setup();
        render(<Host orgUsers={ORG_USERS} step={3} />);
        await user.selectOptions(screen.getByRole('combobox'), 'jan');
        expect(await screen.findByText('jan@acme.nl')).toBeInTheDocument();
        expect(screen.queryByText('Jan Janssen — jan@acme.nl')).not.toBeInTheDocument();
    });

    it('breach step: free text adds a recipient once and the remove button takes it off', async () => {
        const user = userEvent.setup();
        let latest = null;
        render(<Host step={3} onData={(d) => { latest = d; }} />);
        const input = screen.getByTestId('setup-step-recipient-input');
        await user.clear(input);
        await user.type(input, 'security@example.com');
        await user.click(screen.getByTestId('setup-step-recipient-add'));
        expect(latest.breach_recipients).toEqual(['security@example.com']);
        expect(input.value).toBe('');
        await user.clear(input);
        await user.type(input, 'security@example.com');
        await user.click(screen.getByTestId('setup-step-recipient-add'));
        expect(latest.breach_recipients).toEqual(['security@example.com']);
        await user.click(screen.getByLabelText('Remove'));
        expect(latest.breach_recipients).toEqual([]);
    });

    it('an index outside the four steps renders nothing', () => {
        const { container } = render(<Host step={9} />);
        expect(container.firstChild).toBeNull();
    });
});
