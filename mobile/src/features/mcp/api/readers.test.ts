/** The MCP readers: the raw snake_case registry row, and the token that is shown once. */

import { readMcpServers, readMintedToken, readTokenStatus } from './readers';

describe('readMcpServers', () => {
    it('maps the raw row, counting the cached tools', () => {
        const [server] = readMcpServers({
            servers: [
                {
                    id: 'm1',
                    name: 'Files',
                    enabled: true,
                    status: 'ready',
                    transport: 'http',
                    url: 'https://mcp.example',
                    tools_cache: [{ name: 'read' }, { name: 'write', description: 'Writes' }],
                    updated_at: '2026-09-01',
                },
            ],
        });
        expect(server).toMatchObject({ id: 'm1', toolCount: 2, updatedAt: '2026-09-01', description: '', icon: '' });
        expect(server?.tools.map((t) => t.name)).toEqual(['read', 'write']);
    });

    it('fills the column defaults for a row that was never probed', () => {
        const [server] = readMcpServers({ servers: [{ id: 'm2', name: 'Local' }] });
        expect(server).toMatchObject({ enabled: true, status: 'disconnected', transport: 'stdio', toolCount: 0 });
        expect(readMcpServers({ servers: [{ id: 'm3', enabled: false }] })[0]?.enabled).toBe(false);
    });
});

describe('the token readers', () => {
    it('counts `exists` only when it is exactly true', () => {
        expect(readTokenStatus({ exists: 'yes' }).exists).toBe(false);
        expect(readTokenStatus(null)).toEqual({ exists: false, url: '/mcp', transport: 'streamable_http' });
    });

    it('reads a minted token, or nothing', () => {
        expect(readMintedToken({ token: 'bfmcp.u.abc', url: '/mcp', transport: 'http' })?.token).toBe('bfmcp.u.abc');
        expect(readMintedToken(null)).toBeNull();
    });
});
