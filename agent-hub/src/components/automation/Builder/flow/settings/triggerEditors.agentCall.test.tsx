// The agent tool trigger: the description field takes no more than the server
// hands an agent (MAX_TOOL_DESCRIPTION_LEN in server/automation/agentCallContract.js),
// so a value the canvas stores is never one the validator or the runtime cuts.

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TriggerFields } from './triggerEditors';

describe('the agent tool trigger editor', () => {
    it('caps the description at the length the server gives an agent', () => {
        render(<TriggerFields draft={{ kind: 'agent_call', params: [] }} set={() => {}} setNested={() => {}} />);
        const description = screen.getByPlaceholderText(/Summarise the user's unread email/i) as HTMLTextAreaElement;
        expect(description.maxLength).toBe(1000);
    });
});
