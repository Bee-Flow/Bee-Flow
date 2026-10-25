import { type CSSProperties } from 'react';
import { Activity, BarChart3, ThumbsUp, Clock, AlertTriangle } from 'lucide-react';
import { COLORS } from './shared/SvgAreaChart';

export const API = (import.meta.env.VITE_API_URL || '') + '/api/usage';

export const AI_API = (import.meta.env.VITE_API_URL || '') + '/ai';

export const FEEDBACK_API = (import.meta.env.VITE_API_URL || '') + '/api/feedback';

export const RANGES = [
    { id: 'today', labelKey: 'admin.mon_today' },
    { id: '7d', labelKey: 'admin.mon_7d' },
    { id: '30d', labelKey: 'admin.mon_30d' },
    { id: 'all', labelKey: 'admin.mon_all_time' },
    { id: 'custom', labelKey: 'admin_monitoring.range_custom', label: 'Custom' },
];

export const PAGES = [
    { id: 'overview', labelKey: 'admin.mon_overview', icon: BarChart3, descriptionKey: 'admin_monitoring.desc_overview', description: 'Dashboard & cost overview' },
    { id: 'usage', labelKey: 'admin.mon_usage_explorer', icon: Activity, descriptionKey: 'admin_monitoring.desc_usage', description: 'Explore models, agents, users & conversations' },
    { id: 'feedback', labelKey: 'admin.mon_feedback', icon: ThumbsUp, descriptionKey: 'admin_monitoring.desc_feedback', description: 'User feedback on AI responses' },
    { id: 'activity', labelKey: 'admin.mon_activity', icon: Clock, descriptionKey: 'admin_monitoring.desc_activity', description: 'Recent API call log' },
    { id: 'terminations', labelKey: 'admin.mon_terminations', icon: AlertTriangle, descriptionKey: 'admin_monitoring.desc_terminations', description: 'Prematurely ended tasks & errors' },
];

export const styles = {
    container: {
        display: 'flex', height: '100%', fontFamily: 'var(--font-sans)',
        background: 'var(--bg-primary, #0f0f1a)',
    },
    sidebar: {
        width: '200px', flexShrink: 0,
        background: 'var(--bg-secondary, #1a1a2e)',
        borderRight: '1px solid var(--border-default, rgba(255,255,255,0.08))',
        display: 'flex', flexDirection: 'column',
        padding: '16px 0',
    },
    sidebarHeader: {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '0 18px', marginBottom: '20px',
    },
    sidebarTitle: {
        fontSize: '16px', fontWeight: 800,
        color: 'var(--text-primary, #fff)',
        letterSpacing: '-0.3px',
    },
    nav: {
        display: 'flex', flexDirection: 'column', gap: '2px',
        padding: '0 8px', flex: 1,
    },
    navItem: {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '9px 12px', borderRadius: '10px',
        background: 'transparent', border: 'none',
        cursor: 'pointer', transition: 'all 0.15s',
        width: '100%',
    },
    navItemActive: {
        background: 'var(--accent-primary, #6366f1)' + '12',
    },
    main: {
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
    },
    topBar: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '16px 24px',
        borderBottom: '1px solid var(--border-default, rgba(255,255,255,0.06))',
        flexShrink: 0,
    },
    pageTitle: {
        fontSize: '18px', fontWeight: 700,
        color: 'var(--text-primary, #fff)', margin: 0,
    },
    pageDesc: {
        fontSize: '12px', color: 'var(--text-muted, #888)',
        margin: '2px 0 0', fontWeight: 400,
    },
    rangeGroup: {
        display: 'flex', borderRadius: '10px', overflow: 'hidden',
        border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
    },
    rangeBtn: {
        padding: '7px 14px', fontSize: '12px', fontWeight: 500,
        border: 'none', cursor: 'pointer', transition: 'all 0.15s',
        background: 'var(--bg-secondary, #1a1a2e)',
        color: 'var(--text-muted, #888)',
    },
    rangeBtnActive: {
        background: COLORS.primary, color: '#fff', fontWeight: 700,
    },
    datePickerRow: {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', borderRadius: '10px',
        background: 'var(--bg-secondary, #1a1a2e)',
        border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
        animation: 'fadeIn 0.2s ease',
    },
    datePickerField: {
        display: 'flex', flexDirection: 'column', gap: '1px',
    },
    datePickerLabel: {
        fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.05em', color: 'var(--text-muted, #666)',
        lineHeight: 1,
    },
    dateInput: {
        background: 'var(--bg-primary, #0f0f1a)',
        border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
        borderRadius: '6px', padding: '4px 8px',
        fontSize: '12px', fontWeight: 500, fontFamily: 'inherit',
        color: 'var(--text-primary, #fff)',
        outline: 'none', cursor: 'pointer',
        colorScheme: 'dark',
    },
    refreshBtn: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '34px', height: '34px', borderRadius: '10px',
        border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
        background: 'var(--bg-secondary, #1a1a2e)', cursor: 'pointer',
        color: 'var(--text-muted, #888)', transition: 'all 0.15s',
    },
    content: {
        flex: 1, overflow: 'auto', padding: '20px 24px',
    },
} satisfies Record<string, CSSProperties>;
