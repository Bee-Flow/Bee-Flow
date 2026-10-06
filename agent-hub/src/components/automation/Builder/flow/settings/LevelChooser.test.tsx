import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LevelChooser from './LevelChooser';

/** Pretend the window is `width` px wide for `(max-width: …)` queries. */
function setWidth(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => {
        const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity);
        return { matches: width <= max, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    });
}

const LEVELS = [
    { path: 'steps.g.output.messages[*].attachments', label: 'Attachment', countLabel: '64 attachments in 4 messages (last run)' },
    { path: 'steps.g.output.messages[*].labels', label: 'Label', countLabel: '8 labels in 4 messages (last run)' },
];
const sentence = (label: string) => `One row per ${label.toLowerCase()}`;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LevelChooser', () => {
    it('is a sentence with one option', () => {
        setWidth(1200);
        render(<LevelChooser levels={LEVELS.slice(0, 1)} value={LEVELS[0].path} onChange={() => {}} label="One row per" sentence={sentence} />);
        expect(screen.getByText('One row per attachment')).toBeTruthy();
        expect(screen.getByText('64 attachments in 4 messages (last run)')).toBeTruthy();
        expect(screen.queryByRole('radiogroup')).toBeNull();
    });

    it('is a segmented control with two, the current one checked', async () => {
        setWidth(1200);
        const onChange = vi.fn();
        render(<LevelChooser levels={LEVELS} value={LEVELS[0].path} onChange={onChange} label="One row per" sentence={sentence} />);
        expect(screen.getByRole('radio', { name: /Attachment/ }).getAttribute('aria-checked')).toBe('true');
        await userEvent.click(screen.getByRole('radio', { name: /Label/ }));
        expect(onChange).toHaveBeenCalledWith(LEVELS[1].path);
    });

    it('is a select with the same label at 479px', async () => {
        setWidth(479);
        const onChange = vi.fn();
        render(<LevelChooser levels={LEVELS} value={LEVELS[0].path} onChange={onChange} label="One row per" sentence={sentence} />);
        expect(screen.queryByRole('radiogroup')).toBeNull();
        await userEvent.selectOptions(screen.getByRole('combobox', { name: 'One row per' }), LEVELS[1].path);
        expect(onChange).toHaveBeenCalledWith(LEVELS[1].path);
    });

    it('renders nothing without options', () => {
        setWidth(1200);
        const { container } = render(<LevelChooser levels={[]} value="" onChange={() => {}} label="One row per" sentence={sentence} />);
        expect(container.textContent).toBe('');
    });
});
