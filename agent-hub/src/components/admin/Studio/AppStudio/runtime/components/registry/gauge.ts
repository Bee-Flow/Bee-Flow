import { Gauge } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppGauge from '../AppGauge';

const entry: ComponentExtension = {
    Component: AppGauge,
    icon: Gauge,
    sample: { props: { label: 'Score', value: { kind: 'static', value: 72 }, min: 0, max: 100 } },
};

export default entry;
