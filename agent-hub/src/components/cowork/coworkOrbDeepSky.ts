// Distant arms share a vanishing point. Their tiny stars move less than the
// foreground as the viewer looks through the rotating neural volume.
const planes = Array.from({ length: 8 }, (_, i) => {
    const depth = 1.54 ** i;
    return { depth, dust: undefined as Path2D | undefined };
});

function starCloud(index: number) {
    const path = new Path2D();
    let seed = 4139 + index;
    function random() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    }
    const distance = planes[index].depth;
    for (let i = 0; i < 300; i++) {
        const t = (random() - .5) * 3.9;
        const spread = random() + random() + random() - 1.5;
        const x = (32 * t + 3 * spread) / distance;
        const y = (-11 * t + 7 * Math.sin(2 * t + index * .63) + 12 * spread) / distance;
        const size = .17 + .38 * random() / Math.sqrt(distance);
        path.rect(x, y, size, size);
    }
    return path;
}

export function drawDeepSky(ctx: CanvasRenderingContext2D, time: number) {
    const sway = Math.sin(time * .16), lift = Math.cos(time * .12);
    ctx.save();
    ctx.translate(-13, -8);
    for (let i = planes.length - 1; i >= 0; i--) {
        const plane = planes[i];
        const near = 1 / plane.depth;
        ctx.save();
        ctx.translate((12 + 5 * sway) * near, (7 + 3 * lift) * near);
        ctx.rotate(-.18 + .34 * i + .045 * near * sway);
        ctx.fillStyle = i < 3 ? '#b3c6e4' : '#909ac8';
        ctx.globalAlpha = .16 + .48 * Math.sqrt(near);
        ctx.fill(plane.dust ??= starCloud(i));
        ctx.restore();
    }
    ctx.restore();
}
