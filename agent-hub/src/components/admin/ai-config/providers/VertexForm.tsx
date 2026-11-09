import React from 'react';
import DeleteConfirmButtons from '../ProviderCards/shared/DeleteConfirmButtons';
import { PRIMARY_BTN, INPUT } from '@/components/mcpLibrary/ui';
import Section from '@/components/shared/Section';
import { useVertexForm } from './useVertexForm';
import type { ProviderPaneProps } from './types';

const VertexForm = ({ onMessage }: ProviderPaneProps) => {
    const { t, project, setProject, location, setLocation, serviceAccountKey, setServiceAccountKey, showKeyInput, setShowKeyInput, saving, hasProject, hasKey, handleSave, handleDeleteProject, handleDeleteServiceKey } = useVertexForm({ onMessage });

    return (
        <Section title={t('admin_ai_config.vertex_section', 'Connection')}>
            <div className="space-y-3">
                {/* Project + Location row */}
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={project}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProject(e.target.value)}
                        placeholder={hasProject ? '••••••••••••••••' : t('admin_ai_config.vertex_project_placeholder', 'GCP Project ID')}
                        className={`flex-1 ${INPUT}`}
                    />
                    <input
                        type="text"
                        value={location}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocation(e.target.value)}
                        placeholder={t('admin_ai_config.vertex_location_placeholder', 'europe-west4')}
                        className={`w-40 ${INPUT}`}
                        title={t('admin_ai_config.vertex_location_title', 'GCP Location (e.g. europe-west4, us-central1)')}
                    />
                </div>

                {/* Service Account Key */}
                {!showKeyInput ? (
                    <button
                        onClick={() => setShowKeyInput(true)}
                        className="text-xs px-3 py-1.5 rounded-lg transition-all hover:bg-white/10 [background:var(--bg-secondary)]! [color:var(--text-muted)]! [border:1px_solid_var(--border-default)]"
                    >
                        {hasKey ? t('admin_ai_config.vertex_update_key', '🔑 Update Service Account Key') : t('admin_ai_config.vertex_add_key', '🔑 Add Service Account Key')}
                    </button>
                ) : (
                    <div>
                        <label className="block text-xs font-medium mb-1.5 text-[var(--text-muted)]">
                            {t('admin_ai_config.vertex_key_label', 'Service Account JSON Key')}
                        </label>
                        <textarea
                            value={serviceAccountKey}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setServiceAccountKey(e.target.value)}
                            placeholder={t('admin_ai_config.vertex_key_placeholder', 'Paste your service account JSON key here...')}
                            rows={4}
                            className="w-full px-4 py-2.5 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-xs font-mono resize-y [background:var(--bg-secondary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!"
                        />
                        <p className="text-[10px] mt-1 text-[var(--text-muted)]">
                            {t('admin_ai_config.vertex_key_hint', 'GCP Console → IAM → Service Accounts → Keys → Add Key → JSON')}
                        </p>
                    </div>
                )}

                {/* Save + Delete buttons */}
                <div className="flex justify-between items-center">
                    <div className="flex gap-2">
                        {hasProject && (
                            <DeleteConfirmButtons onConfirm={handleDeleteProject} label={t('admin_ai_config.vertex_delete_project', '🗑️ Project')} title={t('admin_ai_config.vertex_remove_project', 'Remove Vertex project')} size="xs" />
                        )}
                        {hasKey && (
                            <DeleteConfirmButtons onConfirm={handleDeleteServiceKey} label={t('admin_ai_config.delete_key', '🗑️ Key')} title={t('admin_ai_config.vertex_remove_key', 'Remove service account key')} size="xs" />
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || (!project.trim() && !serviceAccountKey.trim())}
                        className={PRIMARY_BTN}
                    >
                        {saving ? '...' : t('admin_ai_config.save', 'Save')}
                    </button>
                </div>
            </div>
        </Section>
    );
};


export default VertexForm;
