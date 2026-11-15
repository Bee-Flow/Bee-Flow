import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatModelTiersConfig from './ChatModelTiersConfig';

/**
 * The "Claude models" block (recommended Claude defaults, Apply all, the
 * empty-answer retry) belongs on a server that has Claude models, whichever
 * provider serves them. On a server with only other providers it stays away:
 * its Apply buttons would point tiers at models that server cannot run.
 */

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

const MISTRAL = { id: 'mistral-large-latest', providerName: 'Mistral', providerType: 'mistral' };
const LOCAL = { id: 'qwen3:8b', providerName: 'Ollama', providerType: 'ollama', local: true };

describe('ChatModelTiersConfig: the Claude models block', () => {
    it('is hidden when no configured chat model is a Claude model', async () => {
        render(<ChatModelTiersConfig allModels={[MISTRAL, LOCAL]} />);
        expect(await screen.findByText('Background models')).toBeTruthy();
        expect(screen.queryByText('Claude models')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Apply all recommended' })).toBeNull();
    });

    it('is shown once one Claude model is configured, also when it comes through another provider', async () => {
        render(<ChatModelTiersConfig allModels={[MISTRAL, { id: 'claude-sonnet-4-6@20250929', providerName: 'Vertex', providerType: 'vertex' }]} />);
        expect(await screen.findByText('Claude models')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Apply all recommended' })).toBeTruthy();
    });
});
