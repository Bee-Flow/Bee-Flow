import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '@/test/http';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/utils/helpers', () => ({ API_BASE: 'https://api.test', authFetch }));

import TranscriptionSection from './TranscriptionSection';
import type { TranscriptionSectionProps } from './adminPanel.types';

/**
 * Characterisation of the "Transcription" admin section: the provider picker,
 * the five provider panels with their credential saves (request body, the
 * status message, what the form keeps afterwards) and the pyannoteAI model and
 * voiceprint controls. The fields live in a small stateful harness so typing
 * works; the writers handed in from the parent are spies.
 */

type Fields = Pick<TranscriptionSectionProps,
    'transcriptionProvider' | 'hasAzureSpeechKey' | 'azureSpeechKey' | 'azureSpeechRegion' | 'whisperxUrl' | 'whisperxToken'
    | 'hasWhisperxUrl' | 'hasWhisperxToken' | 'scalewayApiKey' | 'hasScalewayKey' | 'pyannoteApiKey' | 'hasPyannoteKey'
    | 'pyannoteTranscriptionModel' | 'voiceprintMatchingEnabled' | 'pyannoteIdentifyThreshold'>;

const BASE: Fields = {
    transcriptionProvider: 'voxtral',
    hasAzureSpeechKey: false, azureSpeechKey: '', azureSpeechRegion: '',
    whisperxUrl: '', whisperxToken: '', hasWhisperxUrl: false, hasWhisperxToken: false,
    scalewayApiKey: '', hasScalewayKey: false,
    pyannoteApiKey: '', hasPyannoteKey: false,
    pyannoteTranscriptionModel: '', voiceprintMatchingEnabled: false, pyannoteIdentifyThreshold: 50,
};

const setMessage = vi.fn();
const saveTranscriptionModel = vi.fn();
const saveVoiceprintSettings = vi.fn();
const saving: Record<string, boolean[]> = {};

function Harness({ initial }: { initial: Partial<Fields> }) {
    const [f, setF] = useState<Fields>({ ...BASE, ...initial });
    const set = <K extends keyof Fields>(key: K) => (value: Fields[K]) => setF((prev) => ({ ...prev, [key]: value }));
    const flag = (name: string) => (value: boolean) => { (saving[name] ||= []).push(value); };
    return (
        <TranscriptionSection
            {...f}
            setTranscriptionProvider={set('transcriptionProvider')}
            savingTranscriptionProvider={false} setSavingTranscriptionProvider={flag('provider')}
            setHasAzureSpeechKey={set('hasAzureSpeechKey')} setAzureSpeechKey={set('azureSpeechKey')} setAzureSpeechRegion={set('azureSpeechRegion')}
            savingAzureSpeech={false} setSavingAzureSpeech={flag('azure')}
            setWhisperxUrl={set('whisperxUrl')} setWhisperxToken={set('whisperxToken')}
            setHasWhisperxUrl={set('hasWhisperxUrl')} setHasWhisperxToken={set('hasWhisperxToken')}
            savingWhisperx={false} setSavingWhisperx={flag('whisperx')}
            setScalewayApiKey={set('scalewayApiKey')} setHasScalewayKey={set('hasScalewayKey')}
            savingScaleway={false} setSavingScaleway={flag('scaleway')}
            setPyannoteApiKey={set('pyannoteApiKey')} setHasPyannoteKey={set('hasPyannoteKey')}
            savingPyannote={false} setSavingPyannote={flag('pyannote')}
            saveTranscriptionModel={saveTranscriptionModel} savingPyannoteModel={false}
            saveVoiceprintSettings={saveVoiceprintSettings} savingVoiceprint={false}
            setPyannoteIdentifyThreshold={(value) => setF((prev) => ({ ...prev, pyannoteIdentifyThreshold: value }))}
            setMessage={setMessage}
        />
    );
}

const renderSection = (initial: Partial<Fields> = {}) => render(<Harness initial={initial} />);
const lastBody = () => JSON.parse(String(authFetch.mock.calls.at(-1)?.[1]?.body));

beforeEach(() => {
    authFetch.mockReset();
    setMessage.mockReset();
    saveTranscriptionModel.mockReset();
    saveVoiceprintSettings.mockReset();
    for (const k of Object.keys(saving)) delete saving[k];
    authFetch.mockImplementation(() => ok({}));
});
afterEach(() => { vi.restoreAllMocks(); });

/** The list of engines on the left. */
const list = (): HTMLElement => screen.getByRole('navigation', { name: 'Transcription providers' });

/** Select an engine in the list and return its detail pane. */
const open = async (name: string): Promise<HTMLElement> => {
    await userEvent.setup().click(within(list()).getByRole('button', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }));
    return screen.getByRole('region', { name });
};

describe('TranscriptionSection: layout', () => {
    it('shows the heading, the engines with the active one selected, and the how-it-works steps', () => {
        renderSection();
        expect(screen.getByRole('heading', { level: 2, name: /Meeting Transcription/ })).toBeInTheDocument();
        for (const name of ['Voxtral', 'Azure Speech', 'Azure Whisper', 'WhisperX', 'Scaleway (hybrid)', 'pyannoteAI']) {
            expect(within(list()).getByRole('button', { name: new RegExp(name.replace(/[()]/g, '\\$&')) })).toBeInTheDocument();
        }
        expect(within(list()).getByRole('button', { name: /Voxtral/ })).toHaveAttribute('aria-current', 'true');
        const detail = screen.getByRole('region', { name: 'Voxtral' });
        expect(within(detail).getByText('Mistral Cloud')).toBeInTheDocument();
        expect(within(detail).getByText('✓ Configured')).toBeInTheDocument();
        expect(within(detail).getByText('Active')).toBeInTheDocument();
        expect(within(detail).queryByRole('button', { name: 'Use this provider' })).toBeNull();
        expect(screen.getByText('Upload audio')).toBeInTheDocument();
        expect(screen.getAllByRole('listitem').filter(li => li.closest('ol'))).toHaveLength(4);
        expect(screen.getByText('Open Mistral Console').closest('a')).toHaveAttribute('href', 'https://console.mistral.ai');
    });

    it('says what an engine still needs', async () => {
        renderSection();
        expect(within(await open('Azure Speech')).getByText('⚠ Needs: Azure Speech key + region')).toBeInTheDocument();
        expect(within(await open('Scaleway (hybrid)')).getByText('⚠ Needs: Scaleway API key + WhisperX URL (for speakers)')).toBeInTheDocument();
        expect(within(await open('pyannoteAI')).getByText('⚠ Needs: pyannoteAI API key')).toBeInTheDocument();
    });

    it('marks configured engines, shows saved keys and drops the WhisperX hint from Scaleway', async () => {
        renderSection({ hasAzureSpeechKey: true, hasWhisperxUrl: true, hasScalewayKey: true, hasPyannoteKey: true, transcriptionProvider: 'azure' });
        const azure = screen.getByRole('region', { name: 'Azure Speech' });
        expect(within(azure).getByText('Active')).toBeInTheDocument();
        expect(within(azure).getByText('✓ Configured')).toBeInTheDocument();
        expect(within(azure).getByText('Key saved 🔒')).toBeInTheDocument();
        expect(within(await open('WhisperX')).getByText('URL saved 🔒')).toBeInTheDocument();
        const scaleway = await open('Scaleway (hybrid)');
        expect(within(scaleway).getByText('✓ Configured')).toBeInTheDocument();
        expect(within(scaleway).getByText('Key saved 🔒')).toBeInTheDocument();
        expect(screen.queryByText(/No WhisperX URL configured/)).toBeNull();
        expect(within(await open('pyannoteAI')).getByText('Key saved 🔒')).toBeInTheDocument();
        expect(within(await open('Voxtral')).queryByText('Active')).toBeNull();
    });

    it('warns on the Scaleway pane when no WhisperX URL is set', async () => {
        renderSection();
        expect(within(await open('Scaleway (hybrid)')).getByText(/No WhisperX URL configured/)).toBeInTheDocument();
    });

    it('shows the Azure Speech credentials for Azure Whisper too', async () => {
        renderSection();
        expect(within(await open('Azure Whisper')).getByRole('button', { name: 'Save credentials' })).toBeInTheDocument();
    });
});

describe('TranscriptionSection: provider picker', () => {
    it('saves another provider and reports it, then clears the message after 3 s', async () => {
        const timeouts = vi.spyOn(globalThis, 'setTimeout');
        const user = userEvent.setup();
        renderSection();
        await user.click(within(await open('Azure Speech')).getByRole('button', { name: 'Use this provider' }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'Active provider set to Azure Speech' }));
        expect(authFetch).toHaveBeenCalledWith('https://api.test/ai/config', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }));
        expect(lastBody()).toEqual({ transcriptionProvider: 'azure' });
        expect(saving.provider).toEqual([true, false]);
        const clear = timeouts.mock.calls.find(([, ms]) => ms === 3000);
        expect(clear).toBeDefined();
        (clear?.[0] as () => void)();
        expect(setMessage).toHaveBeenLastCalledWith(null);
        // the new provider is now the active one
        expect(within(screen.getByRole('region', { name: 'Azure Speech' })).getByText('Active')).toBeInTheDocument();
        expect(within(list()).getByRole('button', { name: /Azure Speech/ })).toHaveTextContent('Active');
    });

    it('offers no switch on the active provider, and selecting it saves nothing', async () => {
        renderSection();
        const voxtral = await open('Voxtral');
        expect(within(voxtral).queryByRole('button', { name: 'Use this provider' })).toBeNull();
        expect(authFetch).not.toHaveBeenCalled();
        expect(saving.provider).toBeUndefined();
    });

    it('keeps the provider and stays silent when the server refuses', async () => {
        authFetch.mockImplementation(() => fail(500));
        const user = userEvent.setup();
        renderSection();
        const pane = await open('WhisperX');
        await user.click(within(pane).getByRole('button', { name: 'Use this provider' }));
        await waitFor(() => expect(saving.provider).toEqual([true, false]));
        expect(setMessage).not.toHaveBeenCalled();
        expect(within(screen.getByRole('region', { name: 'WhisperX' })).queryByText('Active')).toBeNull();
    });

    it('reports a request that throws', async () => {
        authFetch.mockImplementation(() => Promise.reject(new Error('down')));
        const user = userEvent.setup();
        renderSection();
        await user.click(within(await open('pyannoteAI')).getByRole('button', { name: 'Use this provider' }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save provider' }));
    });
});

describe('TranscriptionSection: Azure Speech', () => {
    const save = async () => within(await open('Azure Speech')).getByRole('button', { name: 'Save credentials' });

    it('normalises the region, starts disabled and saves trimmed credentials', async () => {
        const user = userEvent.setup();
        renderSection();
        const box = within(await open('Azure Speech'));
        expect(await save()).toBeDisabled();
        const region = box.getByPlaceholderText('westeurope');
        await user.type(region, ' West_Europe-1 ');
        expect(region).toHaveValue('westeurope-1');
        await user.type(box.getByPlaceholderText('Paste your subscription key'), '  k3y ');
        expect(await save()).toBeEnabled();
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'Azure Speech credentials saved securely' }));
        expect(lastBody()).toEqual({ azureSpeechRegion: 'westeurope-1', azureSpeechKey: 'k3y' });
        expect(saving.azure).toEqual([true, false]);
        expect(screen.getByText('Key saved 🔒')).toBeInTheDocument();
        expect(box.getByPlaceholderText('••••••••••••••••')).toHaveValue('');
    });

    it('sends only the region when no key is typed, and does not mark a key as saved', async () => {
        const user = userEvent.setup();
        renderSection();
        await user.type(within(await open('Azure Speech')).getByPlaceholderText('westeurope'), 'eastus');
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
        expect(lastBody()).toEqual({ azureSpeechRegion: 'eastus' });
        expect(screen.queryByText('Key saved 🔒')).toBeNull();
    });

    it('shows the server error text, or the fallback', async () => {
        authFetch.mockImplementation(() => fail(400, { error: 'bad region' }));
        const user = userEvent.setup();
        renderSection({ azureSpeechRegion: 'x' });
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'bad region' }));
        authFetch.mockImplementation(() => fail(400));
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save credentials' }));
        authFetch.mockImplementation(() => Promise.reject(new Error('x')));
        await user.click(await save());
        await waitFor(() => expect(setMessage.mock.calls.filter(([m]) => m?.text === 'Failed to save credentials')).toHaveLength(2));
    });
});

describe('TranscriptionSection: WhisperX', () => {
    const save = async () => within(await open('WhisperX')).getByRole('button', { name: 'Save server config' });
    const box = async () => within(await open('WhisperX'));

    it('saves the URL and token and clears the form', async () => {
        const user = userEvent.setup();
        renderSection();
        expect(await save()).toBeDisabled();
        await user.type((await box()).getByPlaceholderText('http://whisperx:9000'), ' http://w:9000 ');
        await user.type((await box()).getByPlaceholderText('Leave empty if your server is internal-only'), ' tok ');
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'WhisperX server URL saved securely' }));
        expect(lastBody()).toEqual({ whisperxUrl: 'http://w:9000', whisperxToken: ' tok ' });
        expect(saving.whisperx).toEqual([true, false]);
        expect(screen.getByText('URL saved 🔒')).toBeInTheDocument();
        expect((await box()).getAllByPlaceholderText('••••••••••••••••')).toHaveLength(2);
    });

    it('sends only the URL when the token stays empty, and reports a refusal', async () => {
        authFetch.mockImplementation(() => fail(400, { error: 'no' }));
        const user = userEvent.setup();
        renderSection();
        await user.type((await box()).getByPlaceholderText('http://whisperx:9000'), 'http://w');
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'no' }));
        expect(lastBody()).toEqual({ whisperxUrl: 'http://w' });
        expect(screen.queryByText('URL saved 🔒')).toBeNull();
    });

    it('does not mark a token as saved when only the URL was sent', async () => {
        const user = userEvent.setup();
        renderSection();
        await user.type((await box()).getByPlaceholderText('http://whisperx:9000'), 'http://w');
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
        expect((await box()).getByPlaceholderText('Leave empty if your server is internal-only')).toBeInTheDocument();
        expect((await box()).getByPlaceholderText('••••••••••••••••')).toBeInTheDocument();
    });

    it('reports a request that throws', async () => {
        authFetch.mockImplementation(() => Promise.reject(new Error('x')));
        const user = userEvent.setup();
        renderSection({ whisperxToken: 't' });
        await user.click(await save());
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save WhisperX settings' }));
    });
});

describe('TranscriptionSection: Scaleway and pyannoteAI keys', () => {
    it('saves the Scaleway key trimmed and marks it saved', async () => {
        const user = userEvent.setup();
        renderSection();
        const box = within(await open('Scaleway (hybrid)'));
        const save = box.getByRole('button', { name: 'Save API key' });
        expect(save).toBeDisabled();
        await user.type(box.getByPlaceholderText('Paste your Scaleway secret key'), '  sk ');
        await user.click(save);
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'Scaleway API key saved securely' }));
        expect(lastBody()).toEqual({ scalewayApiKey: 'sk' });
        expect(saving.scaleway).toEqual([true, false]);
        expect(screen.getByText('Key saved 🔒')).toBeInTheDocument();
    });

    it('reports a Scaleway refusal and a throw', async () => {
        authFetch.mockImplementation(() => fail(400));
        const user = userEvent.setup();
        renderSection({ scalewayApiKey: 'sk' });
        const save = within(await open('Scaleway (hybrid)')).getByRole('button', { name: 'Save API key' });
        await user.click(save);
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save Scaleway key' }));
        authFetch.mockImplementation(() => Promise.reject(new Error('x')));
        await user.click(save);
        await waitFor(() => expect(setMessage.mock.calls.filter(([m]) => m?.text === 'Failed to save Scaleway key')).toHaveLength(2));
    });

    it('saves the pyannoteAI key trimmed and reports failures', async () => {
        const user = userEvent.setup();
        renderSection();
        const box = within(await open('pyannoteAI'));
        await user.type(box.getByPlaceholderText('Paste your pyannoteAI API key'), ' pk ');
        await user.click(box.getByRole('button', { name: 'Save API key' }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'pyannoteAI API key saved securely' }));
        expect(lastBody()).toEqual({ pyannoteApiKey: 'pk' });
        expect(saving.pyannote).toEqual([true, false]);
        expect(screen.getByText('Key saved 🔒')).toBeInTheDocument();
        authFetch.mockImplementation(() => fail(400, { error: 'invalid' }));
        await user.type(box.getByPlaceholderText('••••••••••••••••'), 'z');
        await user.click(box.getByRole('button', { name: 'Save API key' }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'invalid' }));
    });

    it('reports a pyannoteAI request that throws', async () => {
        authFetch.mockImplementation(() => Promise.reject(new Error('x')));
        const user = userEvent.setup();
        renderSection({ pyannoteApiKey: 'pk' });
        await user.click(within(await open('pyannoteAI')).getByRole('button', { name: 'Save API key' }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save pyannoteAI key' }));
    });
});

describe('TranscriptionSection: pyannoteAI model and voiceprints', () => {
    it('hands the chosen speech model to the writer', async () => {
        const user = userEvent.setup();
        renderSection({ pyannoteTranscriptionModel: '' });
        const select = within(await open('pyannoteAI')).getByRole('combobox');
        expect(select).toHaveValue('');
        await user.selectOptions(select, 'parakeet-tdt-0.6b-v3');
        expect(saveTranscriptionModel).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3');
    });

    it('toggles voiceprint matching and shows the threshold only while it is on', async () => {
        const user = userEvent.setup();
        renderSection();
        const box = within(await open('pyannoteAI'));
        const toggle = box.getByRole('checkbox', { name: 'Recognise speakers by voice' });
        expect(toggle).not.toBeChecked();
        expect(box.queryByRole('spinbutton')).toBeNull();
        await user.click(toggle);
        expect(saveVoiceprintSettings).toHaveBeenCalledWith({ voiceprintMatchingEnabled: true });
    });

    it('shows the switch as on, and a click turns it off', async () => {
        const user = userEvent.setup();
        renderSection({ voiceprintMatchingEnabled: true });
        const toggle = within(await open('pyannoteAI')).getByRole('checkbox', { name: 'Recognise speakers by voice' });
        expect(toggle).toBeChecked();
        await user.click(toggle);
        expect(saveVoiceprintSettings).toHaveBeenCalledWith({ voiceprintMatchingEnabled: false });
    });

    it('saves the threshold on blur', async () => {
        const user = userEvent.setup();
        renderSection({ voiceprintMatchingEnabled: true });
        const input = within(await open('pyannoteAI')).getByRole('spinbutton');
        expect(input).toHaveValue(50);
        await user.clear(input);
        await user.type(input, '70');
        expect(saveVoiceprintSettings).not.toHaveBeenCalled();
        await user.tab();
        expect(saveVoiceprintSettings).toHaveBeenCalledWith({ pyannoteIdentifyThreshold: 70 });
    });

    it('does not save 0 when the threshold field is emptied', async () => {
        const user = userEvent.setup();
        renderSection({ voiceprintMatchingEnabled: true });
        const input = within(await open('pyannoteAI')).getByRole('spinbutton');
        await user.clear(input);
        await user.tab();
        expect(saveVoiceprintSettings).not.toHaveBeenCalled();
        expect(input).toHaveValue(50);
    });

    it('clamps an out-of-range threshold to 0-100 before saving', async () => {
        const user = userEvent.setup();
        renderSection({ voiceprintMatchingEnabled: true });
        const input = within(await open('pyannoteAI')).getByRole('spinbutton');
        await user.clear(input);
        await user.type(input, '250');
        await user.tab();
        expect(saveVoiceprintSettings).toHaveBeenCalledWith({ pyannoteIdentifyThreshold: 100 });
    });
});
