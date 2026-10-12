// The shared composer shell, and the old chat import path that must keep working.

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import LegacyComposerBox from '../chat/InputArea/ComposerBox';
import ComposerBox, { ComposerShell } from './ComposerBox';

describe('ComposerShell', () => {
    it('is a labelled form with the chat-composer card classes', () => {
        render(<ComposerShell label="Box" squareTop><span>x</span></ComposerShell>);
        const shell = screen.getByRole('form', { name: 'Box' });
        expect(shell).toHaveAttribute('data-testid', 'composer-box');
        expect(shell.className).toContain('chat-composer');
        expect(shell.className).toContain('rounded-t-none');
    });
});

describe('the chat import path', () => {
    it('still resolves to the same ComposerBox', () => {
        expect(LegacyComposerBox).toBe(ComposerBox);
    });
});
