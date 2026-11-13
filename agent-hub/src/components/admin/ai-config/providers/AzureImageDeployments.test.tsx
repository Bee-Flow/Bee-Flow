import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import AzureImageDeployments from './AzureImageDeployments';
import { rowsFromConfig, rowsToConfig } from './azureImageRows';
import type { AzureImageRow } from './azureImageRows';

let latest: AzureImageRow[] = [];

function Harness({ initial }: { initial: AzureImageRow[] }) {
    const [rows, setRows] = useState(initial);
    latest = rows;
    return <AzureImageDeployments rows={rows} onChange={setRows} />;
}

describe('the Azure image deployments list', () => {
    beforeEach(() => cleanup());

    it('shows the stored deployments with their model and price', () => {
        render(<Harness initial={rowsFromConfig([{ deployment: 'images-prod', model: 'gpt-image-1.5', pricePerImage: 0.04 }])} />);
        expect(screen.getByLabelText('Deployment name 1')).toHaveValue('images-prod');
        expect(screen.getByLabelText('Model 1')).toHaveValue('gpt-image-1.5');
        expect(screen.getByLabelText('Price per image (€) 1')).toHaveValue(0.04);
    });

    it('adds a row that is sent once it has a name', async () => {
        render(<Harness initial={[]} />);
        await userEvent.click(screen.getByRole('button', { name: 'Add image deployment' }));
        expect(rowsToConfig(latest)).toEqual({ ok: true, value: [] });
        await userEvent.type(screen.getByLabelText('Deployment name 1'), 'mai');
        await userEvent.type(screen.getByLabelText('Model 1'), 'MAI-Image-2.6');
        await userEvent.type(screen.getByLabelText('Price per image (€) 1'), '0.03');
        expect(rowsToConfig(latest)).toEqual({ ok: true, value: [{ deployment: 'mai', model: 'MAI-Image-2.6', pricePerImage: 0.03 }] });
    });

    it('removes a row', async () => {
        render(<Harness initial={rowsFromConfig([{ deployment: 'a' }, { deployment: 'b' }])} />);
        await userEvent.click(screen.getByRole('button', { name: 'Remove deployment 1' }));
        expect(latest.map(r => r.deployment)).toEqual(['b']);
    });
});
