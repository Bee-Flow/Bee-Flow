import { createRef } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { IdentitySection } from './IdentitySection';
import type { DesignerSectionProps } from './sectionProps';

function props(over: Partial<DesignerSectionProps> = {}): DesignerSectionProps {
    const base: Partial<DesignerSectionProps> = {
        selectedAgent: null, API_BASE: '/api',
        name: 'Alpha', setName: vi.fn(), description: '', setDescription: vi.fn(),
        systemPrompt: 'Be brief.', setSystemPrompt: vi.fn(),
        avatar: '🤖', setAvatar: vi.fn(), showEmojiPicker: false, setShowEmojiPicker: vi.fn(),
        emojiCategory: 'smileys', setEmojiCategory: vi.fn(), emojiPickerRef: createRef<HTMLDivElement>(),
        model: 'tier:auto', setModel: vi.fn(), modelTiers: {},
        categoryId: null, setCategoryId: vi.fn(), agentCategories: [], setAgentCategories: vi.fn(),
    };
    return { ...base, ...over } as DesignerSectionProps;
}

describe('IdentitySection', () => {
    it('labels its fields and passes edits on', async () => {
        const p = props();
        renderWithClient(<IdentitySection {...p} />);
        expect(screen.getByRole('heading', { level: 2, name: 'Agent Identity' })).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Alpha');
        expect(screen.getByRole('textbox', { name: 'System Prompt' })).toHaveValue('Be brief.');
        await userEvent.type(screen.getByRole('textbox', { name: 'Role Description' }), 'x');
        expect(p.setDescription).toHaveBeenCalledWith('x');
    });

    it('without categories offers to add one, which opens the name field', async () => {
        renderWithClient(<IdentitySection {...props()} />);
        await userEvent.click(screen.getByRole('button', { name: 'Add to category' }));
        expect(screen.getByPlaceholderText('Category name...')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByRole('button', { name: 'Add to category' })).toBeInTheDocument();
    });

    it('with categories shows the select, and the avatar tile opens the picker', async () => {
        const p = props({ agentCategories: [{ id: 'c1', name: 'Sales' }], categoryId: 'c1' });
        renderWithClient(<IdentitySection {...p} />);
        expect(screen.getByRole('combobox')).toHaveValue('c1');
        await userEvent.click(screen.getByTitle('Click to change avatar'));
        expect(p.setShowEmojiPicker).toHaveBeenCalledWith(true);
    });
});
