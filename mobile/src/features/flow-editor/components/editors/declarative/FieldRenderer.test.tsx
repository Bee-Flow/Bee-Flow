/**
 * A spec field's empty-state words: an example with data in it reads as its
 * pills will ("‹Previous step ▸ Delta›"), never as the `{{…}}` under them,
 * and a list to pick points at Insert data rather than showing a path.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { renderEditor } from '../testing';
import { ForEachRow } from './rows/ForEachRow';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.setTimeout(30_000);

describe('a spec field’s example', () => {
    it('reads as its pills will in a text field', async () => {
        await renderEditor({ id: 'e1', type: 'stop_error', message: '' } as unknown as FlowNode);
        expect(await screen.findByPlaceholderText('Budget exceeded by ‹Previous step ▸ Delta›')).toBeTruthy();
    });

    it('reads as its pill will in a path field', async () => {
        await renderEditor({ id: 'd1', type: 'datetime', op: 'diff', input: '' } as unknown as FlowNode);
        expect(await screen.findByPlaceholderText('‹Trigger ▸ Ends at›')).toBeTruthy();
    });
});

describe('ForEachRow', () => {
    it('asks for the list with Insert data, not with a path', async () => {
        await renderWithProviders(<ForEachRow value={{ overRef: '', itemVar: 'item', maxIterations: 100 }} onChange={jest.fn()} sampleRoot={null} />);
        expect(screen.getByPlaceholderText('Tap Insert data to pick a list')).toBeTruthy();
    });
});
