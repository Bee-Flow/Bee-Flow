import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PickSentence from './PickSentence';

describe('PickSentence', () => {
    it('a list into text: one muted sentence and a Change link', async () => {
        const onChange = vi.fn();
        render(<PickSentence intent={{ take: 'all', as: 'text', join: 'lines' }} count={12} onChange={onChange} />);
        const p = screen.getByTestId('pick-sentence');
        expect(p).toHaveTextContent('Comes as text: all 12, one per line.');
        expect(p).toHaveAttribute('data-tone', 'muted');
        await userEvent.click(screen.getByRole('button', { name: 'Change' }));
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ take: 'all', as: 'text', join: 'comma' }, 4, 'Comes as text: all 4, separated by commas.'],
        [{ take: 'all', as: 'text', join: 'bullets' }, null, 'Comes as text: all of them, as a bulleted list.'],
        [{ take: 'all', as: 'list' }, 12, 'Comes as a list of 12.'],
        [{ take: 'one', as: 'list' }, null, 'Comes as a list of 1.'],
        [{ take: 'all', as: 'list' }, undefined, 'Comes as a list.'],
        [{ take: 'last', as: 'native' }, 3, 'Only the last.'],
        [{ take: 'count', as: 'number' }, 3, 'The number of them (3).'],
        [{ take: 'each', as: 'text' }, 3, 'One value per run, for each item.'],
        [{ take: 'all', as: 'native' }, 2, 'Comes as it is: all 2.'],
    ] as const)('%j → %s', (intent, count, text) => {
        render(<PickSentence intent={intent} count={count} />);
        expect(screen.getByTestId('pick-sentence')).toHaveTextContent(text);
    });

    it('many values into a number field: "Only the first", in amber', () => {
        render(<PickSentence intent={{ take: 'first', as: 'number' }} count={5} warning />);
        const p = screen.getByTestId('pick-sentence');
        expect(p).toHaveTextContent('Only the first.');
        expect(p).toHaveAttribute('data-tone', 'amber');
    });

    it('one value used as it is says nothing', () => {
        const { container } = render(<PickSentence intent={{ take: 'one', as: 'text' }} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('a table into a list field asks which column, preselected when one matches', async () => {
        const onColumn = vi.fn();
        const columns = [{ key: 'email', label: 'E-mail' }, { key: 'name', label: 'Naam' }];
        const { rerender } = render(<PickSentence intent={{ take: 'all', as: 'list' }} columns={columns} column="email" onColumn={onColumn} />);
        expect(screen.getByTestId('pick-sentence')).toHaveAttribute('data-tone', 'muted');
        const select = screen.getByRole('combobox', { name: 'Which column?' });
        expect(select).toHaveValue('email');
        await userEvent.selectOptions(select, 'name');
        expect(onColumn).toHaveBeenCalledWith('name');

        rerender(<PickSentence intent={{ take: 'all', as: 'list' }} columns={columns} column={null} onColumn={onColumn} />);
        expect(screen.getByTestId('pick-sentence')).toHaveAttribute('data-tone', 'amber');
        expect(screen.getByText('No column matches this field. Which column?')).toBeInTheDocument();
    });
});
