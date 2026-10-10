import type { TranslateFn } from '../../../hooks/useTranslation';

/** English fallbacks for the memory type labels; the keys are `chat.memory.type_<type>`. */
const TYPE_EN: Record<string, string> = {
    instruction: 'Instruction',
    person: 'Person',
    project: 'Project',
    preference: 'Preference',
    workflow: 'Workflow',
    fact: 'Fact',
    context: 'Context',
};

export function memoryTypeLabel(t: TranslateFn, type: string): string {
    return t(`chat.memory.type_${type}`, TYPE_EN[type] ?? type);
}

/** One line of a memory for a chip: collapsed whitespace, cut at `max` characters. */
export function shortMemory(text: string, max = 60): string {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
