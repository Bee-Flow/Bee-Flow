export interface MonitoringPanelProps {
    activeSection?: string;
    onNavigate?: (path: string) => void;
    /**
     * The viewer. Feedback is for a platform admin (every organisation) and an
     * organisation admin of their home organisation (`isHomeOrgAdmin`, the server's answer).
     */
    user?: { isAdmin?: boolean | null; role?: string | null; [key: string]: unknown } | null;
}
