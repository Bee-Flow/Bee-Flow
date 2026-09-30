/**
 * What the composer offers depends on the surface: the thread banner and its
 * placeholder, and in the ＋ sheet only the tools this person can use —
 * media when a generator is allowed, apps, voice mode.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { _reset, setCatalogue } from '@/core/i18n';
import type { ComposerExtras } from '@/features/chat/model/composerExtras';
import type { ComposerSettings } from '@/features/chat/model/types';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { Composer } from './Composer';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('@/features/skills', () => ({ useActiveSkills: () => ({ activeSkillIds: [] }) }));
jest.mock('@/features/knowledge', () => ({ useKnowledgeBases: () => ({ data: [], isLoading: false }) }));
jest.mock('@/features/integrations', () => ({
    INTEGRATION_CATALOG: [{ id: 'gmail', label: 'Gmail', description: 'Send and read emails', category: 'Google Workspace' }],
    allowedByOrg: (catalogue: unknown[]) => catalogue,
    useUserSettings: () => ({ data: { enabledApps: null, orgEnabledIntegrations: null } }),
    useSaveEnabledApps: () => ({ mutate: jest.fn() }),
}));

const SETTINGS: ComposerSettings = { modelTier: 'auto', webSearchEnabled: true, knowledgeBaseIds: [], reasoningEffort: null };
const NO_MEDIA = { image: false, music: false, elevenlabs: false, video: false };

async function show(extras: ComposerExtras, onVoice?: () => void) {
    await renderScreen(
        <Composer
            onSend={jest.fn()}
            onStop={jest.fn()}
            streaming={false}
            settings={SETTINGS}
            onSettingsChange={jest.fn()}
            tiers={{}}
            onVoice={onVoice}
            extras={extras}
        />,
    );
}

it('says a send goes into a thread, with the way out', async () => {
    const onExit = jest.fn();
    await show({ thread: { title: 'Q3 planning', onExit } });
    expect(screen.getByText('Q3 planning')).toBeTruthy();
    expect(screen.getByPlaceholderText('Reply to thread...')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Leave this thread'));
    expect(onExit).toHaveBeenCalled();
});

it('lists only the tools this person can use', async () => {
    await show({ mediaGates: NO_MEDIA, apps: true }, jest.fn());
    await fireEvent.press(screen.getByLabelText('Message tools'));
    expect(screen.getByText('Apps')).toBeTruthy();
    expect(screen.getByText('Voice mode')).toBeTruthy();
    expect(screen.queryByText('Create image, music, video')).toBeNull();
});

it('opens the media panel for an allowed generator, with its settings', async () => {
    await show({ mediaGates: { ...NO_MEDIA, image: true } });
    await fireEvent.press(screen.getByLabelText('Message tools'));
    await fireEvent.press(screen.getByText('Create image, music, video'));
    expect(screen.getByText('Image Generation')).toBeTruthy();
    expect(screen.getByText('Aspect Ratio')).toBeTruthy();
    expect(screen.getByText('Flash Image (Fast)')).toBeTruthy();
});

it('shows why a knowledge base did not stick', async () => {
    await show({ notice: 'Some of those knowledge bases are not available to you. Nothing was changed.' });
    expect(screen.getByText('Some of those knowledge bases are not available to you. Nothing was changed.')).toBeTruthy();
});

describe('in the app’s language', () => {
    afterEach(() => _reset());

    it('asks with the web’s own placeholder, which the catalogue translates', async () => {
        setCatalogue('nl', { 'chat.composer.placeholder_direct': 'Bericht aan AI...' });
        await show({});
        expect(screen.getByPlaceholderText('Bericht aan AI...')).toBeTruthy();
    });

    it('says the ＋ sheet’s sections and the web-search privacy line through the catalogue', async () => {
        setCatalogue('nl', {
            'chat.composer.tools_web_search': 'Zoeken op het web',
            'mobile.chat.web_search_hint': 'Als dit aan staat, kan deze vraag je server verlaten.',
            'chat.composer.kb_panel_title': 'Kennisbanken',
            'chat.composer.skills': 'Vaardigheden',
            'mobile.chat.skills_none': 'Geen ingeschakeld.',
        });
        await show({});
        await fireEvent.press(screen.getByLabelText('Message tools'));
        expect(screen.getByText('Zoeken op het web')).toBeTruthy();
        expect(screen.getByText('Als dit aan staat, kan deze vraag je server verlaten.')).toBeTruthy();
        expect(screen.getByText('KENNISBANKEN')).toBeTruthy();
        expect(screen.getByText('VAARDIGHEDEN')).toBeTruthy();
        expect(screen.getByText('Geen ingeschakeld.')).toBeTruthy();
    });
});
