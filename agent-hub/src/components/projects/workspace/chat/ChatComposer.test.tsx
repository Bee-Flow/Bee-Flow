// The composer's keyboard manners: ArrowUp in an empty box edits your latest
// message, Escape drops a quote-reply, and a starter chip's prefill lands in
// the box with its @mentions live.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatComposer, { type ChatComposerProps } from './ChatComposer';
import { clearDrafts } from './drafts';

const props = (extra: Partial<ChatComposerProps> = {}): ChatComposerProps => ({
    candidates: [], aiEnabled: true, reply: null,
    onCancelReply: vi.fn(), onSend: vi.fn(), onTyping: vi.fn(),
    ...extra,
});

const box = () => screen.getByRole('textbox', { name: 'Message' });

beforeEach(() => clearDrafts());

describe('ArrowUp in an empty composer', () => {
    it('asks to edit your latest message', async () => {
        const onEditLastOwn = vi.fn();
        const user = userEvent.setup();
        render(<ChatComposer {...props({ onEditLastOwn })} />);
        await user.click(box());
        await user.keyboard('{ArrowUp}');
        expect(onEditLastOwn).toHaveBeenCalledTimes(1);
    });

    it('does nothing once there is text', async () => {
        const onEditLastOwn = vi.fn();
        const user = userEvent.setup();
        render(<ChatComposer {...props({ onEditLastOwn })} />);
        await user.type(box(), 'half a thought');
        await user.keyboard('{ArrowUp}');
        expect(onEditLastOwn).not.toHaveBeenCalled();
        expect(box()).toHaveValue('half a thought');
    });
});

describe('Escape with a quote-reply', () => {
    it('cancels the reply and keeps the text', async () => {
        const onCancelReply = vi.fn();
        const user = userEvent.setup();
        render(<ChatComposer {...props({ reply: { author: 'Ada', excerpt: 'quoted words' }, onCancelReply })} />);
        await user.type(box(), 'my answer');
        await user.keyboard('{Escape}');
        expect(onCancelReply).toHaveBeenCalledTimes(1);
        expect(box()).toHaveValue('my answer');
    });

    it('does not fire without a reply to cancel', async () => {
        const onCancelReply = vi.fn();
        const user = userEvent.setup();
        render(<ChatComposer {...props({ onCancelReply })} />);
        await user.click(box());
        await user.keyboard('{Escape}');
        expect(onCancelReply).not.toHaveBeenCalled();
    });
});

describe('a starter prefill', () => {
    it('drops the text into the box and turns @ai into a real mention', async () => {
        const onSend = vi.fn();
        const user = userEvent.setup();
        render(<ChatComposer {...props({
            candidates: [{ key: 'ai', kind: 'ai', label: 'AI assistant', token: 'ai' }],
            prefill: { text: '@ai Can you summarise?', nonce: 1 },
            onSend,
        })} />);
        expect(box()).toHaveValue('@ai Can you summarise?');
        await user.keyboard('{Enter}');
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ content: '@ai Can you summarise?', askAi: true }));
    });
});

describe('the box', () => {
    it('is the shared composer shell, on the 760 px column', () => {
        render(<ChatComposer {...props()} />);
        const shell = screen.getByRole('form', { name: 'Message the team' });
        expect(shell).toHaveAttribute('data-composer-shell');
        expect(shell.className).toContain('chat-composer');
        expect(shell.className).toContain('max-w-[760px]');
    });
});
