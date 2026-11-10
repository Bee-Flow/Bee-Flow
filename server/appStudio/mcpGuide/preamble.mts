/**
 * The first section of studio_get_guide: where the guide differs over MCP.
 *
 * The guide is the in-product builder prompt, word for word (mcpBuilder.runGetGuide), and that
 * prompt speaks to a model inside the builder chat: a draft state injected every turn, a plan
 * the user approves in the chat, a checklist on the canvas. None of that exists on this
 * surface. Rather than fork the prompt, this section says once what to read differently; it
 * comes FIRST so the reader has it before the sentences it corrects.
 */

import { createRequire } from 'node:module';

const { SHOT_WINDOW_MS, SHOT_MAX_PER_WINDOW } = createRequire(import.meta.url)('../mcpScreenshotBudget.js') as { SHOT_WINDOW_MS: number; SHOT_MAX_PER_WINDOW: number };

export const MCP_GUIDE_PREAMBLE = `## Reading this guide over MCP

What follows is the guide of the App Studio builder inside Bee Flow, word for word. You work through MCP, not in that builder chat, so read these points first. Where the guide below says otherwise, this section is right.

- NO DRAFT STATE IS SENT TO YOU. The guide speaks of ids, tables, fields, row counts and connectors that are "in the draft state", "in the data block" or "injected each turn". Here nothing is injected: call app_get_draft for the ids and the tree (section "tables" for the data block), app_get_data_model for the tables, and keep the ids the tools return.
- EVERY app_* CALL TAKES appId and re-reads the app from the database. There are no turns and nothing is remembered between calls: "per turn" limits in the guide do not apply as written.
- PLANNING IS YOURS. app_propose_plan and app_mark_phase do not exist here, no plan is shown to anyone for approval and no PLAN POLICY or other machine message arrives: agree the plan with the person you work for, in your own conversation. app_set_plan is accepted and does nothing (no checklist is displayed anywhere), so skip the "PLAN AS YOU BUILD" step.
- OWNER LISTS COME FROM TOOLS: app_list_automations, app_search_documents and app_list_connectors. There is no OWNER CONTEXT note.
- SCREENSHOTS: the budget is ${SHOT_MAX_PER_WINDOW} per ${SHOT_WINDOW_MS / 60000} minutes for your account, not 8 per turn. The before/after habit the guide teaches still holds.
- NOTHING YOU WRITE IS SHOWN IN BEE FLOW. "Tell the user" and "keep replies short" are about your own conversation; the app is the only thing the owner sees in Studio.`;
