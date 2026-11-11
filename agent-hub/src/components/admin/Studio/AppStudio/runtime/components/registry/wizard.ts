import { ListOrdered } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppWizard from '../AppWizard';

const entry: ComponentExtension = {
    Component: AppWizard,
    icon: ListOrdered,
    // Drop a container (or anything else) into the wizard for each step's body.
    sample: { props: { steps: [{ title: 'Step 1' }, { title: 'Step 2' }] } },
};

export default entry;
