import type { LucideIcon } from 'lucide-react';

export interface PageDef {
    id: string;
    labelKey: string;
    icon: LucideIcon;
    descriptionKey: string;
    description: string;
}

export interface UsageSummary {
    total_calls: number;
    total_tokens: number;
    total_estimated_cost: number;
    total_billed_cost: number;
    avg_duration_ms: number;
}

export interface RangeDef {
    id: string;
    labelKey: string;
    label?: string;
}

export interface MonitoringPanelProps {
    activeSection?: string;
    onNavigate?: (path: string) => void;
}
