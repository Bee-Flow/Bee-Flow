/**
 * Contract readers for the two JSON voice responses (server/routes/ai/voice.js
 * — GET /availability and POST /session). The turn stream's frames have their
 * own readers, in model/events.ts.
 */

import { field, nullable, shapeOf } from '@/core/api/contract';

import type { VoiceAvailability, VoiceSession } from '../model/types';

/** A 500 answers `{enabled:false, reason:'error'}`, which reads the same way. */
export const readAvailability: (raw: unknown) => VoiceAvailability | null = nullable(
    shapeOf({
        enabled: field.bool(false),
        reason: field.str(''),
        sttProvider: field.str(''),
        ttsProvider: field.str(''),
        defaultModel: field.str(''),
    }),
);

export const readSession: (raw: unknown) => VoiceSession | null = nullable(
    shapeOf({
        sessionId: field.str(''),
        model: field.str(''),
        voice: field.strOrNull,
        language: field.strOrNull,
        systemPrompt: field.str(''),
        agentId: field.strOrNull,
        agentName: field.strOrNull,
        maxTurnSeconds: field.num(60),
        // Zero when absent: a session with no stated lifetime is refreshed
        // before every turn, which is what an undefined lifetime did before.
        sessionTimeoutMs: field.num(0),
    }),
);
