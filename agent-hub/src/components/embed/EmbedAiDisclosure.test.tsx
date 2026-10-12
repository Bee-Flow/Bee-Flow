import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import EmbedAiDisclosure from './EmbedAiDisclosure';

describe('EmbedAiDisclosure (AI Act Art. 50(1))', () => {
    it('says who answers, on its own, before anything is sent', () => {
        render(<EmbedAiDisclosure />);
        const note = screen.getByTestId('embed-ai-disclosure');
        expect(note.textContent).toBe('You are chatting with an AI assistant, not a person.');
        expect(note.getAttribute('role')).toBe('note');
    });
});
