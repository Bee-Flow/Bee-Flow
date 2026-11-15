/**
 * toolRoundDefaults.mts: how many tool-call rounds a chat turn may take on
 * each surface when the administrator set no cap (`max_tool_rounds_chat`,
 * AI configuration > Direct chat). One cap set there applies to every surface.
 *
 * The admin page showed its own copy of these numbers (5/5/10/10) while the
 * loops ran on 15/15/20/20, so GET /ai/config now serves this table and the
 * page reads it. The loops still carry the same literals:
 *   direct chat      routes/ai/directChat/toolLoopSetup.js
 *   notebook chat    usecases/ai/notebookChat/toolLoop.js
 *   webpage chat     routes/ai/webpageChat/toolLoop.js
 *   native loop      core/agentRuntime/chatStream/turnLoop.js
 * Until those loops read TOOL_ROUND_DEFAULTS from here, a change to one of
 * them belongs here too.
 */

export type ToolRoundSurface = 'directChat' | 'notebookChat' | 'webpageChat' | 'nativeLoop';

export const TOOL_ROUND_DEFAULTS: Readonly<Record<ToolRoundSurface, number>> = Object.freeze({
    directChat: 15,
    notebookChat: 15,
    webpageChat: 20,
    nativeLoop: 20,
});

