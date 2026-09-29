import type React from 'react';
import Modal from '../../../shared/Modal';
import DiagramPaneJs from '../DiagramPane';
import useTranslation from '../../../../hooks/useTranslation';
import { useVersionDefinitionQuery } from '../../../../api/queries/automation/versions';

// DiagramPane is JavaScript; say which props this read-only use passes.
const DiagramPane = DiagramPaneJs as unknown as React.ComponentType<{
    definition: Record<string, unknown>;
    readOnly: boolean;
}>;

interface Props {
    automationId: string;
    versionId: string;
    version: number;
    title: string;
    onClose: () => void;
}

/** "Open (read-only)": the stored version on the ordinary canvas, pan and zoom off. */
export default function VersionOpenDialog({ automationId, versionId, version, title, onClose }: Props) {
    const { t } = useTranslation();
    const def = useVersionDefinitionQuery(automationId, versionId);
    return (
        <Modal
            open
            onClose={onClose}
            size="auto"
            zIndex={1000}
            title={t('routines.versions.openTitle', 'v{version} · {title}', { version, title })}
            description={t('routines.versions.openHint', 'Read-only. Restore this version to edit it again.')}
            className="max-w-6xl w-[92vw]"
        >
            <div className="h-[70vh] min-h-[320px] rounded-lg border border-[var(--border-default)] overflow-hidden">
                {def.isError ? (
                    <div role="alert" className="p-4 text-[12px] text-[var(--error)]">
                        {t('routines.versions.loadFailed', 'This version could not be loaded.')}
                    </div>
                ) : def.data ? (
                    <DiagramPane definition={def.data} readOnly />
                ) : (
                    <div className="p-4 text-[12px] text-[var(--text-tertiary)]">{t('common.loading', 'Loading…')}</div>
                )}
            </div>
        </Modal>
    );
}
