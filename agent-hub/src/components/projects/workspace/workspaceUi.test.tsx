import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Plus } from 'lucide-react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Card, LoadingRow, Notice, PrimaryButton, RemoveButton, SecondaryButton, SelectField, Skeleton, WorkspaceColumn } from './workspaceUi';

describe('workspaceUi buttons', () => {
    it('renders a leading icon, a testId, and disables while busy', () => {
        render(<PrimaryButton icon={Plus} testId="new-thing" busy>New</PrimaryButton>);
        const b = screen.getByTestId('new-thing');
        expect(b).toBeDisabled();
        expect(b.querySelector('svg')).not.toBeNull();
        expect(b).toHaveAttribute('type', 'button');
    });
    it('secondary accepts the same props', async () => {
        const onClick = vi.fn();
        render(<SecondaryButton icon={Plus} onClick={onClick}>Add</SecondaryButton>);
        await userEvent.click(screen.getByRole('button', { name: 'Add' }));
        expect(onClick).toHaveBeenCalled();
    });
    it('RemoveButton is named by its label and stops the row click', async () => {
        const row = vi.fn(); const remove = vi.fn();
        render(<div onClick={row}><RemoveButton label="Remove from project" onClick={remove} /></div>);
        await userEvent.click(screen.getByRole('button', { name: 'Remove from project' }));
        expect(remove).toHaveBeenCalled(); expect(row).not.toHaveBeenCalled();
    });
});

describe('workspaceUi surfaces', () => {
    it('Card as="h3" shows a description under the title', () => {
        render(<Card as="h3" title="Files" description="What the AI may read">x</Card>);
        expect(screen.getByRole('heading', { level: 3, name: 'Files' })).toBeInTheDocument();
        expect(screen.getByText('What the AI may read')).toBeInTheDocument();
    });
    it('Notice with an action is an alert that keeps the action', () => {
        render(<Notice tone="error" role="alert" action={<button type="button">Try again</button>}>Could not load</Notice>);
        expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
    it('LoadingRow centered is a status with the label as its name', () => {
        render(<LoadingRow label="Opening…" centered />);
        expect(screen.getByRole('status', { name: 'Opening…' })).toBeInTheDocument();
    });
    it('WorkspaceColumn keeps the first child as the fixed header', () => {
        render(<WorkspaceColumn testId="col"><header data-testid="h" /><p>body</p></WorkspaceColumn>);
        expect(screen.getByTestId('col').firstElementChild).toBe(screen.getByTestId('h'));
    });
});

describe('SelectField', () => {
    it('is a native select that keeps its id, label and value', async () => {
        const onChange = vi.fn();
        render(<><label htmlFor="s">Status</label><SelectField id="s" value="todo" onChange={onChange}><option value="todo">To do</option><option value="done">Done</option></SelectField></>);
        const select = screen.getByLabelText('Status');
        expect(select.tagName).toBe('SELECT');
        await userEvent.selectOptions(select, 'done');
        expect(onChange).toHaveBeenCalled();
    });
});
describe('Skeleton', () => {
    it('is one status with the label and the requested number of silent bars', () => {
        render(<Skeleton rows={4} label="Loading tasks" />);
        const s = screen.getByRole('status', { name: 'Loading tasks' });
        expect(s.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
        expect(s.textContent).toBe('');
    });
});
