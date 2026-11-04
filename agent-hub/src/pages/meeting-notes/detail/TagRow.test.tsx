/**
 * The add-tag field (MN-131): a typed tag survives clicking away; only Escape
 * cancels, and closing the field never saves the same draft twice.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import TagRow from './TagRow';

function setup(tags: string[] = []) {
    const onAddTag = vi.fn();
    render(
        <div>
            <TagRow tags={tags} canEdit onAddTag={onAddTag} />
            <button type="button">elsewhere</button>
        </div>,
    );
    return { onAddTag, user: userEvent.setup() };
}

describe('TagRow add-tag field', () => {
    it('saves a typed tag when focus leaves the field', async () => {
        const { onAddTag, user } = setup();
        await user.click(screen.getByText('Add tag'));
        await user.type(screen.getByLabelText('Add tag'), 'budget');
        await user.click(screen.getByText('elsewhere'));
        expect(onAddTag).toHaveBeenCalledTimes(1);
        expect(onAddTag).toHaveBeenCalledWith('budget');
        expect(screen.queryByLabelText('Add tag')).toBeNull();
    });

    it('saves once on Enter', async () => {
        const { onAddTag, user } = setup();
        await user.click(screen.getByText('Add tag'));
        await user.type(screen.getByLabelText('Add tag'), 'budget{Enter}');
        await user.click(screen.getByText('elsewhere'));
        expect(onAddTag).toHaveBeenCalledTimes(1);
        expect(onAddTag).toHaveBeenCalledWith('budget');
    });

    it('does not save on Escape', async () => {
        const { onAddTag, user } = setup();
        await user.click(screen.getByText('Add tag'));
        await user.type(screen.getByLabelText('Add tag'), 'budget{Escape}');
        await user.click(screen.getByText('elsewhere'));
        expect(onAddTag).not.toHaveBeenCalled();
    });

    it('does not save an empty draft or a tag the note already has on blur', async () => {
        const { onAddTag, user } = setup(['sales']);
        await user.click(screen.getByText('Add tag'));
        await user.click(screen.getByText('elsewhere'));
        await user.click(screen.getByText('Add tag'));
        await user.type(screen.getByLabelText('Add tag'), 'sales');
        await user.click(screen.getByText('elsewhere'));
        expect(onAddTag).not.toHaveBeenCalled();
    });
});
