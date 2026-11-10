import { resolveBinding } from '../../resolveBinding';
import { closeAppModal, openAppModal } from '../../components/AppModal';
import { setUiState } from '../../uiState';
import type { BrowserStepModule } from '../browserSteps';

/**
 * set_ui (server/appStudio/componentSpecs/steps/set_ui.js). `open` goes through
 * the modal's own open bus, exactly like open_modal / close_modal; activeTab and
 * selection through the ui state store, which hands the value to the mounted
 * component (or keeps it for the next one to mount).
 */
const entry: BrowserStepModule = {
    kind: 'set_ui',
    run: ({ liveBag }, step, st) => {
        const nodeId = typeof step.nodeId === 'string' ? step.nodeId : '';
        if (!nodeId) return;
        const { value } = resolveBinding(step.value, liveBag(st));
        if (step.state === 'open') {
            if (value === true || value === 'true') openAppModal(nodeId);
            else closeAppModal(nodeId);
        } else if (step.state === 'activeTab' || step.state === 'selection') {
            setUiState(nodeId, step.state, value);
        }
    },
};

export default entry;
