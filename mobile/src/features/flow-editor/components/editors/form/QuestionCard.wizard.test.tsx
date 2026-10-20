/**
 * The question types the phone offers are the ones it can configure: choice
 * buttons and several-choice questions get the choices editor, a text block
 * gets a text box (not the file picker of a download).
 */

import { screen } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowNode } from '@/features/flow-editor/bindings';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue([]);
});

const page = (fields: unknown[]) =>
    ({ id: 'p1', type: 'form_page', label: 'More', mode: 'input', form: { title: 'More', fields } }) as unknown as FlowNode;

describe('QuestionCard on a wizard page', () => {
    it.each(['radio', 'multiselect', 'select'])('%s has a choices editor', async (type) => {
        await renderEditor(page([{ name: 'pick', type, label: 'Pick', options: ['a', 'b'] }]));
        expect(await screen.findByTestId('question-1-choices')).toBeTruthy();
    });

    it('a text block has a text box and no file picker', async () => {
        await renderEditor(page([{ name: 'note', type: 'info', label: 'Note', content: 'Read this first' }]));
        expect(await screen.findByTestId('question-1-content')).toBeTruthy();
        expect(screen.queryByText('File to offer')).toBeNull();
        expect(screen.queryByText('Required')).toBeNull();
    });

    it('a download still has the file picker', async () => {
        await renderEditor(page([{ name: 'get', type: 'download', label: 'Get', fileId: '' }]));
        expect(await screen.findByText('File to offer')).toBeTruthy();
        expect(screen.queryByTestId('question-1-content')).toBeNull();
    });
});
