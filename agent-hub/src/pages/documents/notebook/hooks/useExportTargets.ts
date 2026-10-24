/**
 * useExportTargets — probes which external export targets are configured.
 *
 * Used by NotebooksPage (it copied these two probes). The
 * results gate the SignRequest and Nextcloud entries in the export menu.
 */
import { useAiUserSettings, useAuthAppPasswordStatus } from '../../../../api/queries/notebook';

export default function useExportTargets() {

    const signRequestConfiguredQuery = useAiUserSettings();
    const signRequestConfigured = signRequestConfiguredQuery.data ?? false;

    const nextcloudConfiguredQuery = useAuthAppPasswordStatus();
    const nextcloudConfigured = nextcloudConfiguredQuery.data ?? false;

    return { signRequestConfigured, nextcloudConfigured };
}
