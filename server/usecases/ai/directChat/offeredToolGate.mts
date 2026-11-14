/**
 * offeredToolGate.mts: direct chat dispatches only a tool name that was
 * offered this turn (the agent chat's name gate). It runs ahead of the DLP
 * restore in ./toolExec.js, so a refused call gets no real values back.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface GateCtx {
    getOfferedToolNames?: () => Set<string | undefined>;
    send: (event: string, data: Record<string, unknown>) => void;
}

export interface RefusedToolMessage {
    role: 'tool';
    tool_call_id: string | undefined;
    content: string;
}

/** The refusal for a name not offered this turn, or null when it may run. */
export function refuseUnofferedTool(toolCall: { id?: string }, toolName: string | undefined, ctx: GateCtx): RefusedToolMessage | null {
    if (typeof ctx.getOfferedToolNames !== 'function' || ctx.getOfferedToolNames().has(toolName)) return null;
    const log = nodeRequire('../../../telemetry/log.js');
    log.warn(`[DirectChat] Refused tool '${toolName}': not offered this turn`);
    ctx.send('tool_start', { name: toolName, args: {} });
    ctx.send('tool_end', { name: toolName, result: '[Tool not available in this chat]' });
    return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: `Tool '${toolName}' is not available and was not called. Use only the tools you were given.` }) };
}
