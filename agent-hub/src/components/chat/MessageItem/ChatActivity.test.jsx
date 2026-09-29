import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import ChatActivity from './ChatActivity';

/**
 * The chat's activity card, modelled on automation/Builder/chat/
 * BuilderActivity.test.jsx: the same tool_start/tool_end shape
 * useChatEngine/sseEvents.js writes into `msg.toolHistory`.
 */
const done = (name, args = {}, extra = {}) => ({ name, args, status: 'done', startTime: 1000, endTime: 1750, ...extra });
const running = (name, args = {}) => ({ name, args, status: 'running', startTime: 1000 });

describe('ChatActivity', () => {
    it('renders nothing without tool calls, and never for sequential thinking alone', () => {
        expect(render(<ChatActivity msg={{}} />).container.firstChild).toBeNull();
        expect(render(<ChatActivity msg={{ toolHistory: [done('sequentialthinking')] }} />).container.firstChild).toBeNull();
    });

    it('one numbered row per call, named by the tool, with what it was asked', () => {
        render(<ChatActivity msg={{ toolHistory: [done('agent_search', { query: 'vat rate 2026' }), done('file_read', { path: '/Invoices/Q3.pdf' })] }} />);
        const rows = screen.getAllByTestId('chat-activity-row');
        expect(rows).toHaveLength(2);
        expect(screen.getByText('Agent Search')).toBeTruthy();
        expect(screen.getByText('vat rate 2026')).toBeTruthy();
        expect(screen.getByText('/Invoices/Q3.pdf')).toBeTruthy();
        expect(screen.getByText('Tools Used')).toBeTruthy();
        // The chat measures, so the duration is shown — per row and summed.
        expect(screen.getAllByTestId('duration-pill').length).toBeGreaterThanOrEqual(2);
    });

    it('while streaming, the header says Working and the live row spins', () => {
        const { container } = render(<ChatActivity msg={{ isStreaming: true, toolHistory: [done('agent_search'), running('file_read')] }} />);
        expect(screen.getByText('Working')).toBeTruthy();
        expect(container.querySelector('[data-testid="chat-activity"]').hasAttribute('data-running')).toBe(true);
        const rows = container.querySelectorAll('[data-testid="chat-activity-row"]');
        expect(rows[0].getAttribute('data-status')).toBe('done');
        expect(rows[1].getAttribute('data-status')).toBe('running');
    });

    it('a stopped stream leaves the unfinished row unticked', () => {
        const { container } = render(<ChatActivity msg={{ isStreaming: false, toolHistory: [running('file_read')] }} />);
        expect(container.querySelector('[data-testid="chat-activity-row"]').getAttribute('data-status')).toBe('interrupted');
    });

    it('a refusal opens with its reason in words and is counted in the header', () => {
        render(<ChatActivity msg={{
            toolHistory: [done('gmail_send', { to: 'x@y.z' })],
            toolResults: [{ name: 'gmail_send', result: { error: 'Gmail is not connected for this user.' } }],
        }} />);
        expect(screen.getAllByText(/Gmail is not connected/).length).toBeGreaterThan(0);
        expect(screen.getByText('1 failed')).toBeTruthy();
        expect(screen.getByTestId('chat-activity-row').hasAttribute('open')).toBe(true);
    });

    it('a session skill row carries the skill step name', () => {
        render(<ChatActivity
            msg={{ toolHistory: [done('activate_session_skill', { skill_ids: ['s2'] })] }}
            sessionSkills={[{ id: 's2', name: 'Draft the reply', order: 2 }]}
        />);
        expect(screen.getByText('Step 2: Draft the reply')).toBeTruthy();
    });
});
