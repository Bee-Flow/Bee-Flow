import { ChevronsDownUp } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppAccordion from '../AppAccordion';

const entry: ComponentExtension = {
    Component: AppAccordion,
    icon: ChevronsDownUp,
    sample: { props: { items: [{ title: 'Section 1' }, { title: 'Section 2' }] } },
};

export default entry;
