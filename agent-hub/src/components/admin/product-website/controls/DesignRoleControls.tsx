import ColorRolesControls from './ColorRolesControls';
import IconTileControls from './IconTileControls';
import type { DesignColors, DesignComponents } from '../../../../marketing/ProductWebsite.types';

/** The Design tab's colour roles, label style and icon tiles, in one block. */
export default function DesignRoleControls({ colors, components, onColor, onComponent }: {
    colors: DesignColors;
    components: DesignComponents;
    onColor: (key: 'cta' | 'link' | 'highlight' | 'tile', value: string) => void;
    onComponent: (key: string, value: string) => void;
}) {
    return (
        <>
            <ColorRolesControls colors={colors} components={components} onColor={onColor} onComponent={onComponent} />
            <IconTileControls components={components} onChange={onComponent} />
        </>
    );
}
