import type { ComponentType } from 'react';
import McpLogoJs from '../../utils/mcpLogos';

// A .jsx module; its inferred props do not know the server shape.
const McpLogo = McpLogoJs as unknown as ComponentType<{ server: Record<string, unknown>; size?: number; className?: string }>;

interface ServerLogoProps {
    /** Anything with a name; id/repository/homepage/icon improve the logo. */
    server: { id?: string | null; name: string; repository?: string | null; homepage?: string | null; icon?: string | null };
    size?: number;
}

/**
 * The server's logo in a neutral tile, Studio-style. McpLogo walks its own
 * fallbacks (catalogue logo → GitHub owner avatar → emoji → letter), so the
 * tile is never empty.
 */
export default function ServerLogo({ server, size = 32 }: ServerLogoProps) {
    const inner = Math.round(size * 0.66);
    const tile = size >= 36
        ? 'w-10 h-10 rounded-[10px]'
        : 'w-8 h-8 rounded-lg';
    return (
        <span className={`${tile} grid place-items-center flex-shrink-0 overflow-hidden bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]`} aria-hidden="true">
            <McpLogo server={server as Record<string, unknown>} size={inner} />
        </span>
    );
}
