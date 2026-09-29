import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import MessageActionsRowJs from './MessageActionsRow';

/**
 * The status next to the timestamp of a turn that ended in an error.
 *
 * BFSF-349: when some of the turn's tools finished before the error, the
 * message was sent and those actions happened. "Failed to send" said the
 * opposite and invited a retry that repeats them.
 */

// Untyped .jsx with a long prop list; only `msg` and the thumbs handler matter.
const MessageActionsRow = MessageActionsRowJs as unknown as React.ComponentType<Record<string, unknown>>;

const ERR = 'Chat error: API error 400: invalid_request_error';

const status = (msg: Record<string, unknown>) => {
    render(<MessageActionsRow msg={{ id: 'a-1', role: 'assistant', isError: true, ...msg }} handleThumbClick={() => {}} />);
    return screen.getByTestId('msg-error-status');
};

describe('MessageActionsRow — error status', () => {
    it('says how far the turn got when one action completed', () => {
        const el = status({ content: `Done before the error: Create Issue.\n\n${ERR}`, errorDetail: ERR, completedToolCount: 1 });
        expect(el).toHaveTextContent('Stopped after 1 action');
        expect(el).not.toHaveTextContent('Failed to send');
    });

    it('counts several completed actions', () => {
        expect(status({ content: ERR, errorDetail: ERR, completedToolCount: 3 })).toHaveTextContent('Stopped after 3 actions');
    });

    it('takes its tone from the error, not from the names of the actions', () => {
        // A tool label with "subscription" in it is no usage-limit problem.
        const el = status({ content: `Done before the error: Cancel Subscription.\n\n${ERR}`, errorDetail: ERR, completedToolCount: 1 });
        expect(el.className).toContain('text-red-500');
    });

    it('still reads "Failed to send" for a turn where nothing ran', () => {
        expect(status({ content: ERR })).toHaveTextContent('Failed to send');
    });

    it('still reads "Usage limit reached" for a limit error', () => {
        expect(status({ content: 'You have reached your monthly token limit.' })).toHaveTextContent('Usage limit reached');
    });
});
