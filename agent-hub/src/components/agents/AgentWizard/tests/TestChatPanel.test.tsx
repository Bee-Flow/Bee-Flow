import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TestChatPanel from './TestChatPanel';
import type { TranslateParams } from '@/hooks/useTranslation';

const t = (key: string, fallback?: string, _params?: TranslateParams) => (typeof fallback === 'string' ? fallback : key);

function setup(over: Partial<React.ComponentProps<typeof TestChatPanel>> = {}) {
    const props = {
        t: t as never,
        messages: [],
        isLoading: false,
        onSend: vi.fn(),
        onStop: vi.fn(),
        onToolDecision: vi.fn(),
        toolDecisions: {},
        ...over,
    };
    render(<TestChatPanel {...props} />);
    return props;
}

describe('TestChatPanel', () => {
    it('says that nothing asked here is saved while the chat is empty', () => {
        setup();
        expect(screen.getByTestId('agent-test-chat-empty').textContent).toMatch(/Nothing you ask here is saved/);
    });

    it('sends the typed question with Enter and clears the field', async () => {
        const props = setup();
        const input = screen.getByTestId('agent-test-chat-input') as HTMLTextAreaElement;
        await userEvent.type(input, 'What is the return policy?{Enter}');
        expect(props.onSend).toHaveBeenCalledWith('What is the return policy?');
        expect(input.value).toBe('');
    });

    it('does not send an empty question', async () => {
        const props = setup();
        expect((screen.getByTestId('agent-test-chat-send') as HTMLButtonElement).disabled).toBe(true);
        await userEvent.type(screen.getByTestId('agent-test-chat-input'), '   {Enter}');
        expect(props.onSend).not.toHaveBeenCalled();
    });

    it('shows Stop instead of Send while an answer is coming', async () => {
        const props = setup({ isLoading: true });
        expect(screen.queryByTestId('agent-test-chat-send')).toBeNull();
        await userEvent.click(screen.getByTestId('agent-test-chat-stop'));
        expect(props.onStop).toHaveBeenCalled();
    });

    it('has no input when read-only', () => {
        setup({ ro: true });
        expect(screen.queryByTestId('agent-test-chat-input')).toBeNull();
    });

    it('draws the messages it is given', () => {
        setup({ messages: [
            { id: 'u1', role: 'user', content: 'Hello there' },
            { id: 'a1', role: 'assistant', content: 'General Kenobi' },
        ] });
        expect(screen.getByText('Hello there')).toBeTruthy();
        expect(screen.getByText('General Kenobi')).toBeTruthy();
    });
});
