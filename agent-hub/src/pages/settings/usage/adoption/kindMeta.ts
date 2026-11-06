/**
 * What the Adoption report shows for a Studio kind: its icon, its colour and
 * its name, plus the noun of its usage signal. Icons and colours come from the
 * one kind register (components/shared/kindColors); cowork is not a Studio
 * kind there, so it carries its own glyph and a neutral ink.
 */
import type { LucideIcon } from 'lucide-react';
import { Users } from 'lucide-react';
import { KIND_ICON, kindColorVar } from '@/components/shared/kindColors';
import type { UsageLabel } from './adoption.types';

type Translate = (key: string, fallback: string) => string;

interface KindEntry { labelKey: string; label: string }

const KIND_TABLE: Readonly<Record<string, KindEntry>> = Object.freeze({
    agent: { labelKey: 'adoption.kind_agent', label: 'Agents' },
    automation: { labelKey: 'adoption.kind_automation', label: 'Automations' },
    form: { labelKey: 'adoption.kind_form', label: 'Forms' },
    app: { labelKey: 'adoption.kind_app', label: 'Apps' },
    datatable: { labelKey: 'adoption.kind_datatable', label: 'Datatables' },
    kb: { labelKey: 'adoption.kind_kb', label: 'Knowledge bases' },
    skill: { labelKey: 'adoption.kind_skill', label: 'Skills' },
    webpage: { labelKey: 'adoption.kind_webpage', label: 'Webpages' },
    document: { labelKey: 'adoption.kind_document', label: 'Documents' },
    meeting: { labelKey: 'adoption.kind_meeting', label: 'Meeting notes' },
    playbook: { labelKey: 'adoption.kind_playbook', label: 'Playbooks' },
    solution: { labelKey: 'adoption.kind_solution', label: 'Solutions' },
    cowork: { labelKey: 'adoption.kind_cowork', label: 'Cowork' },
});

const USAGE_TABLE: Readonly<Record<UsageLabel, KindEntry>> = Object.freeze({
    conversations: { labelKey: 'adoption.usage_conversations', label: 'conversations' },
    runs: { labelKey: 'adoption.usage_runs', label: 'runs' },
    submissions: { labelKey: 'adoption.usage_submissions', label: 'submissions' },
    action_runs: { labelKey: 'adoption.usage_action_runs', label: 'action runs' },
    activations: { labelKey: 'adoption.usage_activations', label: 'activations' },
    public_views: { labelKey: 'adoption.usage_public_views', label: 'public views' },
    recordings: { labelKey: 'adoption.usage_recordings', label: 'recordings' },
    activities: { labelKey: 'adoption.usage_activities', label: 'activities' },
    cowork_runs: { labelKey: 'adoption.usage_cowork_runs', label: 'runs' },
});

export interface KindMeta { kind: string; icon: LucideIcon; color: string; label: string }

/** Icon, colour and translated name of a kind; an unknown kind keeps its raw id. */
export function kindMeta(kind: string, t: Translate): KindMeta {
    const entry = KIND_TABLE[kind];
    const icon = kind === 'cowork' ? Users : (KIND_ICON[kind] ?? Users);
    return {
        kind,
        icon,
        color: kindColorVar(kind),
        label: entry ? t(entry.labelKey, entry.label) : kind,
    };
}

/** The noun of a usage signal ("conversations", "runs", …). */
export function usageNoun(label: UsageLabel | string, t: Translate): string {
    const entry = (USAGE_TABLE as Record<string, KindEntry | undefined>)[label];
    return entry ? t(entry.labelKey, entry.label) : String(label);
}
