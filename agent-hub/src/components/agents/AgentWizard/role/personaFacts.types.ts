/** Types of the persona facts (role/personaFacts.ts). */
import type { CallableAutomation } from '@/components/admin/Studio/SkillsStudio/skillModel.types';

/** The full persona as the editor holds it (`agents.persona`, after `personaShape`). */
export interface Persona {
    who: string;
    tone: { chips: string[]; text: string };
    does: string[];
    doesNot: string[];
    unknown: { mode: string; automationId: string | null };
    language: string | null;
    mode: string;
    freeText: string;
}

/** Why a bullet edit changed nothing; `null` = it went through. */
export type BulletRejection = 'empty' | 'duplicate' | 'full' | 'missing' | null;

/** The slice of an automation the hand-off picker reads (`GET /api/automation`), trigger fields included (isAgentCallable). */
export interface AutomationSummary extends CallableAutomation {
    id?: string;
    title?: string | null;
    name?: string | null;
    isActive?: boolean;
    is_active?: boolean;
}

export interface HandoffRow { id: string; title: string | null; active: boolean }
export interface HandoffSelection {
    id: string;
    title: string | null;
    readable: boolean;
    active: boolean | null;
    callable: boolean | null;
}
