import type { OrbLook } from './coworkOrbAppearance';
import type { Point } from './coworkOrbGeometry';

function drawLightCore(ctx: CanvasRenderingContext2D, light: Point, palette: OrbLook) {
    // Keep the sky behind the fine fibres dense on a bright page. Offset
    // the inner shadow so only one side catches the reflected rim light.
    const body = ctx.createRadialGradient(20 + light.x * .10, 17 + light.y * .10, 9, 0, 0, 104);
    body.addColorStop(0, palette.coreColor);
    body.addColorStop(.58, palette.coreColor);
    body.addColorStop(.78, palette.rimColor);
    body.addColorStop(.87, palette.rimColor + 'ed');
    body.addColorStop(.945, palette.rimColor + '70');
    body.addColorStop(1, palette.mistColor + '00');
    ctx.save();
    ctx.globalAlpha = 1 - palette.transparency ** 1.55;
    ctx.fillStyle = body;
    ctx.fillRect(-105, -105, 210, 210);

    const reflection = ctx.createRadialGradient(-46, -41, 0, -46, -41, 42);
    reflection.addColorStop(0, palette.mistColor + '40');
    reflection.addColorStop(.55, palette.mistColor + '18');
    reflection.addColorStop(1, palette.mistColor + '00');
    ctx.fillStyle = reflection;
    ctx.fillRect(-88, -83, 84, 84);
    ctx.restore();
}

export function drawCore(ctx: CanvasRenderingContext2D, light: Point, palette: OrbLook) {
    if (palette.lightSurface) {
        drawLightCore(ctx, light, palette);
        return;
    }
    const mist = ctx.createRadialGradient(light.x * .78, light.y * .78, 3, 0, 0, 104);
    mist.addColorStop(0, palette.coreColor);
    mist.addColorStop(.48, palette.coreColor);
    mist.addColorStop(.79, palette.rimColor + 'dc');
    mist.addColorStop(.90, palette.rimColor + '5c');
    mist.addColorStop(1, palette.rimColor + '00');
    ctx.fillStyle = mist;
    ctx.fillRect(-105, -105, 210, 210);
}
