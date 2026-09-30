/**
 * A brief parked for ONE form by the "New form" screen — the web's
 * studioAi/handoff parkSeed/takeSeed. The form is created first and the brief
 * handed to its Questions tab, which drafts from it at once: creating and
 * drafting stay two steps, so a slow or failing model never leaves the person
 * without a form — only without drafted questions, with the box still filled.
 *
 * In memory on purpose: a brief is only meaningful to the screen that is
 * about to open, and read once (taking it removes it), so a brief for another
 * form can never land on this one.
 */

const parked = new Map<string, string>();

const keyFor = (automationId: string) => `form:${automationId}`;

export function parkSeed(automationId: string, brief: string): void {
    const text = brief.trim();
    if (automationId && text) parked.set(keyFor(automationId), text);
}

export function takeSeed(automationId: string): string | null {
    const key = keyFor(automationId);
    const brief = parked.get(key) ?? null;
    parked.delete(key);
    return brief;
}
