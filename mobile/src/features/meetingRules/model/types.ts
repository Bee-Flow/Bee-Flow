/**
 * One automation as the rules screen reads it: the fields of `rowToAutomation`
 * (server/stores/automationStore/rowMappers.js) the card uses. `definition`
 * is taken on trust as an object — rules.ts reads it defensively.
 */

export interface MeetingRule {
    id: string;
    title: string;
    userId: string | null;
    isActive: boolean | null;
    isDraft: boolean | null;
    definition: Record<string, unknown>;
}
