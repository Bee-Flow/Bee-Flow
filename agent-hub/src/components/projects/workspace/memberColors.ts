// The colour a person has in a project: the one the project gave them, or an
// automatic one from their name, so everybody has a colour without anyone
// choosing. The palette is the server's (server/projects/memberColors.js).

import { hueOf } from './projectVisuals';

export const MEMBER_COLORS: readonly { hex: string; labelKey: string; label: string }[] = [
    { hex: '#3b82f6', labelKey: 'project_home.color.blue', label: 'Blue' },
    { hex: '#0ea5e9', labelKey: 'project_home.color.sky', label: 'Sky' },
    { hex: '#14b8a6', labelKey: 'project_home.color.teal', label: 'Teal' },
    { hex: '#22c55e', labelKey: 'project_home.color.green', label: 'Green' },
    { hex: '#f59e0b', labelKey: 'project_home.color.amber', label: 'Amber' },
    { hex: '#f97316', labelKey: 'project_home.color.orange', label: 'Orange' },
    { hex: '#f43f5e', labelKey: 'project_home.color.rose', label: 'Rose' },
    { hex: '#ec4899', labelKey: 'project_home.color.pink', label: 'Pink' },
    { hex: '#8b5cf6', labelKey: 'project_home.color.violet', label: 'Violet' },
    { hex: '#64748b', labelKey: 'project_home.color.slate', label: 'Slate' },
];

/** The colour to paint a person in: theirs when set, else one from their name. */
export function personColor(explicit: string | null | undefined, name: string | null | undefined): string {
    if (typeof explicit === 'string' && MEMBER_COLORS.some(c => c.hex === explicit.toLowerCase())) return explicit;
    return `hsl(${hueOf(name)} 60% 50%)`;
}

/** Text in a person's colour, pulled towards the theme's ink so it reads on every theme. */
export const inkOf = (color: string): string => `color-mix(in srgb, ${color} 72%, var(--text-primary))`;

/** A quiet wash of a person's colour, for a bubble or an edge. */
export const washOf = (color: string, percent: number): string => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
