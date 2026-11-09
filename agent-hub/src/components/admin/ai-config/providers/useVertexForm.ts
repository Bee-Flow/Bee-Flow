import { useState } from 'react';
import type { ProviderPaneProps } from './types';
import useProviderConfig from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';

/** The state and handlers of the form: what is typed, what is stored, save and the two removals. */
export function useVertexForm({ onMessage }: ProviderPaneProps) {
    const { t } = useTranslation();
    const [project, setProject] = useState('');
    const [location, setLocation] = useState('europe-west4');
    const [serviceAccountKey, setServiceAccountKey] = useState('');
    const [showKeyInput, setShowKeyInput] = useState(false);

    const { config, saving, save, deleteKey, deleteSetting, patchConfig } = useProviderConfig({
        onMessage,
        onLoaded: data => {
            if (data.googleVertexLocation) setLocation(data.googleVertexLocation);
        }
    });
    const hasProject = !!config?.hasGoogleVertexProject;
    const hasKey = !!config?.hasGoogleVertexServiceAccountKey;

    const handleSave = async () => {
        if (!project.trim() && !serviceAccountKey.trim()) return;
        const body: Record<string, string> = {};
        if (project.trim()) body.googleVertexProject = project;
        body.googleVertexLocation = location;
        if (serviceAccountKey.trim()) {
            // Validate JSON before sending
            try {
                JSON.parse(serviceAccountKey);
            } catch {
                onMessage?.({ type: 'error', text: t('admin_ai_config.vertex_invalid_json', 'Invalid JSON: please paste a valid service account key') });
                return;
            }
            body.googleVertexServiceAccountKey = serviceAccountKey;
        }

        const ok = await save(body, { success: t('admin_ai_config.vertex_saved', 'Google Vertex AI config saved!'), error: t('admin_ai_config.provider_save_failed', 'Failed to save config') });
        if (ok) {
            patchConfig({
                ...(project.trim() ? { hasGoogleVertexProject: true } : {}),
                ...(serviceAccountKey.trim() ? { hasGoogleVertexServiceAccountKey: true } : {})
            });
            setProject('');
            setServiceAccountKey('');
            setShowKeyInput(false);
        }
    };

    const handleDeleteProject = async () => {
        const ok = await deleteSetting('google_vertex_project', { success: t('admin_ai_config.vertex_project_removed', 'Vertex AI project removed'), error: t('admin_ai_config.vertex_project_delete_failed', 'Failed to delete project') });
        if (ok) {
            patchConfig({ hasGoogleVertexProject: false });
            setProject('');
        }
    };

    const handleDeleteServiceKey = async () => {
        const ok = await deleteKey('google_vertex_service_account_key', { success: t('admin_ai_config.vertex_key_removed', 'Vertex AI service account key removed'), error: t('admin_ai_config.vertex_key_delete_failed', 'Failed to delete service account key') });
        if (ok) {
            patchConfig({ hasGoogleVertexServiceAccountKey: false });
            setServiceAccountKey('');
        }
    };

    return { t, project, setProject, location, setLocation, serviceAccountKey, setServiceAccountKey, showKeyInput, setShowKeyInput, saving, hasProject, hasKey, handleSave, handleDeleteProject, handleDeleteServiceKey };
}
