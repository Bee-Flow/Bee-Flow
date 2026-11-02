/**
 * voiceTools.mts: which tools a voice turn offers, and the name gate on what
 * it dispatches.
 *
 * Tools whose output only makes sense visually are left out of voice mode.
 * A tool call is only dispatched when its name was offered this turn, the
 * same rule the streaming agent loop applies.
 */

interface ToolDef { function?: { name?: string } }

// Tools whose output only makes sense visually — filter them out of voice mode.
const VOICE_TOOL_BLOCKLIST: RegExp[] = [
    /^generate_(image|video|music|song|sfx|tts)$/,
    /^elevenlabs_(music|sfx|tts)$/,
    /^gamma_/,
    /^signrequest_/,
    /^maps_/,
    /^workspace_update$/,
    /^notebook_write$/,
    /^notebook_create$/,
];

function toolName(tool: unknown): string | undefined {
    return (tool as ToolDef | null | undefined)?.function?.name;
}

export function filterVoiceTools<T>(tools: T[] | null | undefined): T[] {
    return (tools || []).filter((tool) => {
        const name = toolName(tool) || '';
        return !VOICE_TOOL_BLOCKLIST.some((rx) => rx.test(name));
    });
}

/**
 * The model error for a call whose name was not offered this turn, or null
 * when the call may be dispatched.
 */
export function unofferedToolError(name: string, offered: readonly unknown[]): string | null {
    if (offered.some((tool) => toolName(tool) === name)) return null;
    return `Tool '${name}' is not available and was not called. Use only the tools you were given.`;
}
