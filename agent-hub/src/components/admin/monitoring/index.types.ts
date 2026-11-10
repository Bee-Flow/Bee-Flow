export interface MonitoringPanelProps {
    activeSection?: string;
    onNavigate?: (path: string) => void;
    /** The viewer; the pages about the whole server are for a platform admin only. */
    user?: { isAdmin?: boolean | null; role?: string | null } | null;
}
