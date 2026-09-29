import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import MessageContentBody from './MessageContentBody';

/**
 * The error card's title (BFSF-184).
 *
 * A provider error relayed as `Chat error: API error 400: {"type":"error",...}`
 * contains both "Chat" and "type", and an old branch keyed on exactly those two
 * words titled it "Chat Agent Limit Reached". No limit was involved: it was a
 * prefill 400. The real per-type limit message still gets its own title.
 */
const errorMsg = (content: string) => ({ id: 'e-1', role: 'assistant', isError: true, content });

const PREFILL_400 = 'Chat error: API error 400: {"type":"error","error":{"type":"invalid_request_error",'
    + '"message":"This model does not support assistant message prefill. The conversation must end with a user message."}}';
const RATE_LIMIT = 'Chat error: API error 429: {"type":"error","error":{"type":"rate_limit_error",'
    + '"message":"Number of request tokens has exceeded your per-minute rate limit"}}';
const TYPE_LIMIT = 'You have reached your monthly Chat message limit (100 messages). Upgrade to an organization plan for higher limits.';

describe('MessageContentBody — error card title', () => {
    it('titles a relayed provider 400 as a generic error, not an agent limit', () => {
        render(<MessageContentBody msg={errorMsg(PREFILL_400)} reasoningVisible={false} sessionSkills={[]} />);
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
        expect(screen.queryByText('Chat Agent Limit Reached')).not.toBeInTheDocument();
    });

    it('never titles a relayed provider rate-limit error "Chat Agent Limit Reached"', () => {
        render(<MessageContentBody msg={errorMsg(RATE_LIMIT)} reasoningVisible={false} sessionSkills={[]} />);
        expect(screen.queryByText('Chat Agent Limit Reached')).not.toBeInTheDocument();
    });

    it('keeps the monthly message-limit title for the real per-type limit', () => {
        render(<MessageContentBody msg={errorMsg(TYPE_LIMIT)} reasoningVisible={false} sessionSkills={[]} />);
        expect(screen.getByText('Monthly Message Limit Reached')).toBeInTheDocument();
    });
});

/**
 * BFSF-349: the turn failed AFTER some of its tools ran. The reply so far and
 * the "done before the error" line render as the answer; the card holds only
 * the error and says how far the turn got instead of "Something went wrong".
 */
describe('MessageContentBody — error after completed actions', () => {
    const LEAD = 'Filing the ticket now.\n\nDone before the error: Create Issue.';
    const afterActions = {
        ...errorMsg(`${LEAD}\n\n${PREFILL_400}`),
        errorDetail: PREFILL_400,
        completedToolCount: 1,
    };

    it('titles the card with the completed actions, not a generic failure', () => {
        render(<MessageContentBody msg={afterActions} reasoningVisible={false} sessionSkills={[]} />);
        expect(screen.getByText('Stopped after 1 action')).toBeInTheDocument();
        expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });

    it('keeps the reply so far and the completed actions outside the error card', () => {
        render(<MessageContentBody msg={afterActions} reasoningVisible={false} sessionSkills={[]} />);
        expect(screen.getByText('Filing the ticket now.')).toBeInTheDocument();
        expect(screen.getByText(/Done before the error: Create Issue\./)).toBeInTheDocument();
        // The card body is the error alone.
        expect(screen.getByText(PREFILL_400)).toBeInTheDocument();
    });
});
