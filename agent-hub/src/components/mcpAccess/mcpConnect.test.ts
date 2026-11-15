import { describe, expect, it } from 'vitest';

import { MCP_SERVERS } from './mcpAccessLib';
import { TOKEN_PLACEHOLDER, authHeader, clientConfigJson, mcpOrigin, serverUrl } from './mcpConnect';

const cms = MCP_SERVERS.find(s => s.id === 'cms')!;
const integrations = MCP_SERVERS.find(s => s.id === 'integrations')!;

describe('mcpOrigin', () => {
    it('prefers the address the server names, without a trailing slash', () => {
        expect(mcpOrigin('https://mcp.example/', '', 'https://page.example')).toBe('https://mcp.example');
    });
    it('falls back to an absolute API base, then to the page', () => {
        expect(mcpOrigin(undefined, 'https://api.example//', 'https://page.example')).toBe('https://api.example');
        expect(mcpOrigin('relative/path', '/api', 'https://page.example')).toBe('https://page.example');
    });
});

describe('the generic connect block', () => {
    it('gives each server its address and the token header', () => {
        expect(serverUrl(cms, 'https://bee.example/')).toBe('https://bee.example/mcp/cms');
        expect(authHeader('bfmcp_x')).toBe('Authorization: Bearer bfmcp_x');
    });

    it('writes the mcpServers block a client configuration file reads', () => {
        const json = JSON.parse(clientConfigJson([integrations, cms], 'https://bee.example', TOKEN_PLACEHOLDER));
        expect(json).toEqual({
            mcpServers: {
                beeflow: { type: 'http', url: 'https://bee.example/mcp', headers: { Authorization: 'Bearer <token>' } },
                'beeflow-cms': { type: 'http', url: 'https://bee.example/mcp/cms', headers: { Authorization: 'Bearer <token>' } },
            },
        });
    });
});
