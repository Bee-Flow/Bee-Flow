/**
 * The Preview's device switch: the canvas column as it always was ('fit'), or
 * a frame at a desktop, tablet or phone width (DeviceFrame). Shown only while
 * the Preview is open; the choice lives in the editor store, never in the
 * definition.
 */
import { Maximize2, Monitor, Smartphone, Tablet } from 'lucide-react';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import { useAppEditorState } from '../../state/appEditorState';
import type { PreviewDevice } from '../../state/appEditorState';
import { DEVICE_WIDTH, deviceLabel } from '../DeviceFrame';

const ICON = 'h-3 w-3';

export default function DeviceSwitch() {
    const { t } = useTranslation();
    const { previewDevice, dispatch } = useAppEditorState();
    const framed = (device: Exclude<PreviewDevice, 'fit'>) => (
        <span className="sr-only">
            {t('studio_apps_device.option', '{device}, {width} px', { device: deviceLabel(device, t), width: DEVICE_WIDTH[device] })}
        </span>
    );
    return (
        <div className="shrink-0" data-testid="device-switch">
            <SegmentedControl<PreviewDevice>
                size="sm"
                ariaLabel={t('studio_apps_device.switch_aria', 'Preview width')}
                value={previewDevice}
                onChange={(device) => dispatch({ type: 'set_preview_device', device })}
                options={[
                    { value: 'fit', label: <span className="sr-only">{t('studio_apps_device.fit', 'Fit to canvas')}</span>, icon: <Maximize2 className={ICON} aria-hidden="true" /> },
                    { value: 'desktop', label: framed('desktop'), icon: <Monitor className={ICON} aria-hidden="true" /> },
                    { value: 'tablet', label: framed('tablet'), icon: <Tablet className={ICON} aria-hidden="true" /> },
                    { value: 'phone', label: framed('phone'), icon: <Smartphone className={ICON} aria-hidden="true" /> },
                ]}
            />
        </div>
    );
}
