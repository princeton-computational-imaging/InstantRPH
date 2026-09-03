// Interactive 3D visualization of the Instant RPH propagation pipeline.
//
// Markup contract (see index.html):
//   <div class="method-3d" data-method-3d>
//     <canvas class="method-3d-canvas"></canvas>
//     <div class="method-3d-hint">Drag to orbit</div>
//   </div>
//
// Every annotation -- SLM, viewer, random phase, C-RSD, ASM,
// amplitude/discard/phase, focal stack, and the "Diopter-Space MPI" heading --
// is a 3D object (a text canvas mounted on a plane, see createLabelPlate),
// not an HTML overlay. That is what lets each one sit in the scene's own
// perspective and share one visual language, rather than a flat pill
// re-projected on top of it every frame.
//
// WHAT IS DEPICTED
//
// A complex wavefront marches through a tightly-packed stack of 21 diopter-space
// MPI layers, then makes one long Angular Spectrum Method (ASM) hop to the SLM.
// At every layer the field is (1) injected with fresh random phase in [0, 2pi),
// and (2) propagated to the next layer by a small 5x5 C-RSD convolution.
//
// Geometry is deliberately non-uniform and that is the whole argument of the
// figure: 20 SHORT hops between closely-spaced layers are the cheap C-RSD
// convolutions, while the ONE LONG hop across the empty gap to the SLM is the
// expensive FFT-based ASM. See CONFIG.slmGapRatio and CONFIG.layerGap.
//
//   MPI: 21 closely-spaced layers                             SLM
//   |||||||||||||||||||||                                     ##
//  L21 ............... L1                                     ##
//   ^  o===> march L1 -> L21 (many short C-RSD hops)
//   \=========== ASM: L21 -> SLM, through stack + gap ======>
//
// Each layer is CONSUMED as the field passes it: once its content has been
// folded into the wavefield it fades out, so the stack empties as the march
// proceeds and is gone by the time the field lands on the SLM.
//
// At the SLM the complex field is split into amplitude and phase. A phase-only
// SLM cannot reproduce amplitude, so the amplitude branch collapses to a
// constant ("amplitude discard") and fades, and only the phase is fed to the
// display. The loop then holds on the focal stack -- the hologram reconstructed
// at several focus distances -- with a schematic eye in front of the far end of
// the stack, before looping.
//
// EVERY QUANTITY IS SHOWN AT FULL RESOLUTION, on its own full plane:
//
//   - the layer plane itself carries the AMPLITUDE,
//   - the RANDOM PHASE (HSV colormap over 0..2pi) sits on its own plane offset
//     slightly behind the layer along the propagation direction, so it reads as
//     that layer's back face rather than as a separate free-floating object.
//     It arrives from the RIGHT during the `inject` beat.
//
// The random-phase injection happens for EVERY layer at once, before any
// propagation begins, rather than being re-applied at each propagation step:
// it is a static per-layer property established up front. Showing all 21
// simultaneously is what makes it a property of the whole MPI rather than an
// accident of the moving front.
//
// Nothing is squeezed into a half-quad readout.
//
// PLACEHOLDER ASSETS
//
// Everything is generated procedurally in loadAssets(), which is the single
// swap point -- replace a makePlaceholder*() call with a loadTexture() call
// and nothing else changes. Filenames under assets/instantrph/ when real
// assets land:
//
//   layer_00.png .. layer_20.png          per-layer amplitude
//   crsd_kernel.png                       the 5x5 C-RSD kernel
//   focal_00.png .. focal_NN.png          focal stack, near focus -> far focus
//                                         (count set by CONFIG.focalCount)
//
// The focal stack is ALWAYS loaded from disk -- it is a result, so there is no
// meaningful procedural stand-in. Until those files exist each slot renders a
// labelled placeholder card naming the file it is waiting for.
//
// Random phase stays procedural by default -- it IS uniform random phase, so
// generating it is more honest than shipping a PNG of noise.
//
// A missing file falls back to its placeholder, so a partially-populated asset
// folder still renders correctly.
//
// Tunables, settable as data-attributes on the .method-3d element:
//
//   data-layers        number of MPI layers                        default: 21
//   data-slm-gap       SLM distance as a multiple of stack depth   default: 1.15
//   data-step-time     seconds per C-RSD hop                       default: 0.26
//   data-asm-time      seconds for the long ASM hop                default: 2.2
//   data-focal-count   focal-stack slices shown, evenly sampled
//                      from the full focal_NN.png set               default: 21

import * as THREE from 'three';

const CONFIG = {
    layers: 21,
    // SLM distance from L1, as a multiple of the total stack depth. The gap is
    // still the single longest span in the scene (the one expensive ASM hop),
    // but kept tight: the gap is empty, so every unit of it costs camera
    // distance and shrinks the layers and the SLM, which are what the viewer
    // actually needs to read.
    slmGapRatio: 0.58,
    stepTime: 0.26,     // seconds per short C-RSD hop
    asmTime: 2.2,       // seconds for the single long ASM hop
    // A calm establishing beat: the stack and the "Diopter-Space MPI" bracket
    // fade up on their own, before the busier `inject` beat starts flying
    // phase planes in. Kept generous now that intro is the ONLY quiet moment
    // before the march -- too short and it reads as a flicker rather than a
    // fade-in.
    introTime: 2.2,
    // Random phase injection, applied to EVERY layer at once before propagation
    // starts. This is a separate beat rather than something folded into the
    // march because it is a different kind of operation: the phase is a
    // static per-layer property of the scene decomposition, established up
    // front, not re-drawn at each propagation step.
    phaseInjectTime: 2.2,
    holdTime: 5.0,      // focal stack + eye held for 5s before looping
    outroTime: 0.9,

    // Tension to balance: the layers should read as TIGHT relative to the long
    // SLM gap (that contrast is the argument of the figure), but 21 planes any
    // closer than this merge into one opaque-looking slab at every camera angle.
    // This is the loosest spacing that still reads as a compact bundle, and the
    // tightest that keeps individual layers resolvable.
    layerGap: 0.60,     // world units between adjacent layers
    planeWidth: 3.4,    // 8:5 aspect, matching the 1280x800 source textures
    planeHeight: 2.125,
    textureSize: 128,   // placeholder texture resolution
    // How many focal_NN.png slots to look for under assets/instantrph/.
    // Missing files fall back to a labelled placeholder, so this can be set to
    // the intended count before the real images exist.
    focalCount: 5,
    // How many of those focalCount slices are actually shown in the final
    // hold. Sampled evenly across the full near-focus -> far-focus set (see
    // pickFocalIndices), so lowering this thins the stack out without
    // shrinking the range of focus distances it spans -- pure sparsity knob.
    focalVisibleCount: 21,
};

// Where the random phase sits relative to its layer, along Z (the in-plane
// horizontal axis after the geometry rotation). At this camera azimuth +Z
// projects toward screen-RIGHT.
//
// It stops CLEAR of the layer rather than landing on its face: a full-size
// plane parked on top of its layer would hide exactly the thing it belongs
// to, and 21 of them would hide the stack. Holding it alongside keeps the
// layer and its phase both visible at once. It is pulled in far enough to
// read as belonging to the layer, then fades in place.
const PHASE_LANE = 2.25;     // random phase rests to the RIGHT, as a multiple of W
const PHASE_APPLIED = 1.125;  // ...and settles here, still clear of the layer

// C-RSD kernel card size, as a fraction of a layer's width. Deliberately small:
// it is a 5x5 kernel against full-resolution layers, and drawing it large
// misrepresents that ratio -- it only has to stay countable. Shared with the
// camera-fit code, which has to know how far out of the layout the card sits.
const KERNEL_SIZE_RATIO = 0.18;

// Gap between the two 5x5 C-RSD kernel textures (hot star / HSV noise), as a
// fraction of one card's size. Small: they read as one kernel shown two ways,
// not two unrelated cards.
const KERNEL_GAP_RATIO = 0.16;

// Kernel card border size, as a multiple of KERNEL_SIZE, and how much the
// pulse (see the `march` kernel-update block) grows both card and border on
// top of that. Shared with the C-RSD label's vertical offset so the label
// clears the border even at the top of the pulse, not just at rest.
const KERNEL_BORDER_RATIO = 1.06;
const KERNEL_PULSE_MAX = 0.14;

// Palette lifted from the page's CSS custom properties so the canvas sits in the
// same visual family as the rest of the site.
const PALETTE = {
    background: 0xf7f7f7,
    border: 0x5f7ea4,
    borderActive: 0x224064,
    slmBody: 0x2a3a4e,
    slmBezel: 0x8fa0b5,
    field: 0x5f8fc4,
    kernel: 0xeb6b20,
};

// ---------------------------------------------------------------------------
// Placeholder texture generation (the single swap point -- see loadAssets)
// ---------------------------------------------------------------------------

function makeCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
}

function finishTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}

// Deterministic per-layer pseudo-random, so the scene looks identical on every
// reload rather than shimmering differently each time the page is opened.
function makeRandom(seed) {
    let state = (seed * 1664525 + 1013904223) >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

// Stand-in for an MPI layer's amplitude: a soft depth-tinted blob field, so
// successive layers read as visibly different slices of a scene.
function makePlaceholderAmplitude(index, total) {
    const size = CONFIG.textureSize;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const rand = makeRandom(index + 1);
    const depth = index / Math.max(1, total - 1);

    // Left transparent, not filled: a real MPI layer is sparse, and the
    // shader now reads coverage straight from this texture's alpha channel,
    // so the placeholder needs to be sparse in the same way to look right.

    // A handful of soft blobs; nearer layers get brighter, tighter features.
    const blobs = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < blobs; i += 1) {
        const cx = rand() * size;
        const cy = rand() * size;
        const r = size * (0.12 + rand() * 0.26) * (1.0 - depth * 0.35);
        const intensity = 0.45 + rand() * 0.55 * (1.0 - depth * 0.4);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const v = Math.round(255 * intensity);
        grad.addColorStop(0, `rgba(${v},${v},${v},0.95)`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // Fine grain so the surface does not look like flat vector art.
    const image = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < image.data.length; i += 4) {
        const n = (rand() - 0.5) * 26;
        image.data[i] = Math.max(0, Math.min(255, image.data[i] + n));
        image.data[i + 1] = Math.max(0, Math.min(255, image.data[i + 1] + n));
        image.data[i + 2] = Math.max(0, Math.min(255, image.data[i + 2] + n));
    }
    ctx.putImageData(image, 0, 0);

    return finishTexture(canvas);
}

// Uniform random phase in [0, 2pi), stored in the red channel. The HSV colormap
// is applied in the shader, not baked here, so the same texture can drive both
// the visible phase half and any future amplitude modulation.
function makePlaceholderPhase(seed) {
    const size = CONFIG.textureSize;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const rand = makeRandom(seed * 7919 + 13);
    const image = ctx.createImageData(size, size);

    for (let i = 0; i < image.data.length; i += 4) {
        const phase = Math.floor(rand() * 256);
        image.data[i] = phase;
        image.data[i + 1] = phase;
        image.data[i + 2] = phase;
        image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;   // raw data, not color
    // Mipmapped minification is what stops the speckle FLICKERING. The texture
    // itself is generated once and never changes, but per-pixel noise displayed
    // smaller than 1:1 aliases badly: with NearestFilter, the tiny sub-pixel
    // shifts from the idle camera drift resample different noise texels every
    // frame, so the field appears to crawl. Mipmaps average that neighbourhood
    // instead, giving a stable image that stays put as the camera moves.
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
}

// h in degrees [0, 360), s and v in [0, 1]. Returns [r, g, b] in [0, 255].
function hsvToRgb(h, s, v) {
    const c = v * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (hp < 1) { r1 = c; g1 = x; } else if (hp < 2) { r1 = x; g1 = c; }
    else if (hp < 3) { g1 = c; b1 = x; } else if (hp < 4) { g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; b1 = c; } else { r1 = c; b1 = x; }
    const m = v - c;
    return [
        Math.round((r1 + m) * 255),
        Math.round((g1 + m) * 255),
        Math.round((b1 + m) * 255),
    ];
}

// Standard "hot" colormap ramp (black -> red -> yellow -> white), matplotlib's
// piecewise-linear definition. v in [0, 1].
function hotColormap(v) {
    const c = clamp01(v);
    const r = Math.round(255 * clamp01(c * 3));
    const g = Math.round(255 * clamp01(c * 3 - 1));
    const b = Math.round(255 * clamp01(c * 3 - 2));
    return [r, g, b];
}

// Draws a `cells`x`cells` grid of flat-shaded cells into `canvas`, each cell's
// color from `colorAt(x, y)` -> [r, g, b]. Shared by both C-RSD kernel
// textures so their cell grid/spacing/separators stay identical.
function drawKernelGrid(canvas, cells, colorAt) {
    const scale = canvas.width / cells;
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < cells; y += 1) {
        for (let x = 0; x < cells; x += 1) {
            const [r, g, b] = colorAt(x, y);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x * scale, y * scale, scale, scale);
        }
    }
    ctx.strokeStyle = 'rgba(10, 20, 30, 0.55)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= cells; i += 1) {
        const p = i * scale;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, canvas.width);
        ctx.moveTo(0, p);
        ctx.lineTo(canvas.width, p);
        ctx.stroke();
    }
}

// First of the two 5x5 C-RSD kernel textures: a symmetric star (diamond)
// footprint -- the classic compact-support convolution stencil -- lit with
// the "hot" colormap. Built from Manhattan distance to centre, which is
// invariant under both x- and y-reflection and under 90-degree rotation, so
// the star reads as a genuine symmetric stencil rather than a random blob.
function makeKernelHotTexture() {
    const cells = 5;
    const size = cells * 24;
    const canvas = makeCanvas(size);
    const centre = (cells - 1) / 2;

    drawKernelGrid(canvas, cells, (x, y) => {
        const dx = Math.abs(x - centre);
        const dy = Math.abs(y - centre);
        const star = Math.max(0, 1 - (dx + dy) / (centre + 1));
        return hotColormap(star);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
}

// Second of the two 5x5 C-RSD kernel textures: HSV noise, mirror-symmetric
// across both axes -- every cell shares its hue/saturation/value with its
// mirror across x AND across y, so only the 3x3 quadrant defined by
// (|dx|, |dy|) is actually random; the rest is reflected from it.
function makeKernelHsvNoiseTexture() {
    const cells = 5;
    const size = cells * 24;
    const canvas = makeCanvas(size);
    const centre = (cells - 1) / 2;
    const rand = makeRandom(917);

    const hsvByQuadrant = new Map();
    const hsvFor = (adx, ady) => {
        const key = adx * 10 + ady;
        if (!hsvByQuadrant.has(key)) {
            hsvByQuadrant.set(key, {
                h: rand() * 360,
                s: 0.55 + rand() * 0.45,
                v: 0.55 + rand() * 0.45,
            });
        }
        return hsvByQuadrant.get(key);
    };

    drawKernelGrid(canvas, cells, (x, y) => {
        const adx = Math.round(Math.abs(x - centre));
        const ady = Math.round(Math.abs(y - centre));
        const { h, s, v } = hsvFor(adx, ady);
        return hsvToRgb(h, s, v);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
}

// Placeholder for a focal-stack slot. Deliberately labelled rather than
// pretending to be a reconstruction: these are results that only real data can
// supply, so the stand-in should look like a waiting slot, not like an output.
function makeFocalPlaceholder(index, total) {
    const w = 256;
    const h = 160;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#e8eff7';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#8fa0b5';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.setLineDash([]);

    ctx.fillStyle = '#5f748d';
    ctx.font = '600 17px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('focal_' + String(index).padStart(2, '0') + '.png', w / 2, h / 2 - 6);
    ctx.font = '14px Helvetica, Arial, sans-serif';
    const where = index === 0 ? 'near focus'
        : index === total - 1 ? 'far focus'
        : `focus ${index + 1} of ${total}`;
    ctx.fillText(where, w / 2, h / 2 + 18);

    return finishTexture(canvas);
}

// CPU-side readout of a texture's current image, downsampled to `size` x
// `size`. Used by rebuildRecording() to find, per layer, which texels are
// opaque (amplitude alpha) and what phase they carry (phase red channel).
// Cached on the texture itself and only redrawn when .image has actually
// changed identity -- which happens exactly once, when loadWithFallback swaps
// a placeholder canvas for the real loaded PNG.
function sampleTexelData(texture, size) {
    const cache = texture.userData._texelCache;
    if (cache && cache.image === texture.image && cache.size === size) {
        return cache.data;
    }
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    if (texture.image) ctx.drawImage(texture.image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    texture.userData._texelCache = { image: texture.image, size, data };
    return data;
}

// Real textures are not fetched the moment loadAssets() builds the scene --
// they are queued (see below) and only actually requested once the section is
// about to be on screen. Left eager, ~26 requests for these used to start at
// DOMContentLoaded and lose the bandwidth race against the page's own hero
// video, so the figure sat on its placeholders indefinitely: not a rendering
// bug, a load-order one.
const assetQueue = [];
const MAX_CONCURRENT_LOADS = 6;
let activeLoads = 0;

function pumpAssetQueue() {
    while (activeLoads < MAX_CONCURRENT_LOADS && assetQueue.length > 0) {
        const job = assetQueue.shift();
        activeLoads += 1;
        job(() => {
            activeLoads -= 1;
            pumpAssetQueue();
        });
    }
}

// Start (or continue) working through whatever has been queued. Safe to call
// repeatedly -- e.g. once per IntersectionObserver firing -- since it is a
// no-op once the queue is empty.
function flushAssetQueue() {
    pumpAssetQueue();
}

// Try a real asset, fall back to a placeholder if it is missing. This is what
// lets a half-populated assets/instantrph/ folder still render. The fetch
// itself is deferred: this only reserves a queue slot and returns the
// placeholder texture immediately, so buildScene() always has something to
// mount regardless of when (or whether) the real asset arrives.
function loadWithFallback(loader, url, fallback) {
    const texture = fallback;
    assetQueue.push((done) => {
        loader.load(
            url,
            (loaded) => {
                loaded.colorSpace = THREE.SRGBColorSpace;
                texture.image = loaded.image;
                // The placeholder was already uploaded to the GPU at its own (smaller,
                // fixed) size. Three.js allocates immutable GL storage on first upload,
                // so swapping .image to a differently-sized real photo and merely
                // flagging needsUpdate tries to texSubImage2D into that old allocation
                // and silently fails (GL_INVALID_VALUE: offset overflows texture
                // dimensions), leaving the placeholder on screen. Disposing first drops
                // the GL texture so the next upload reallocates storage at the new size.
                texture.dispose();
                texture.needsUpdate = true;
                done();
            },
            undefined,
            () => { /* missing file: keep the placeholder, silently */ done(); },
        );
    });
    return texture;
}

// THE SWAP POINT. When real textures land in assets/instantrph/, flip
// USE_REAL_ASSETS to true (or delete the flag and always call loadWithFallback).
const USE_REAL_ASSETS = true;
const ASSET_DIR = 'assets/instantrph';

// layer_NN.png / focal_NN.png ship as .webp (see tools/convert-textures.py):
// downscaled to the plane's actual on-screen size and ~65x smaller, which is
// what makes it possible for the whole set to arrive during one scroll past
// the section instead of racing the rest of the page for bandwidth.
const TEXTURE_EXT = 'webp';

// crsd_kernel_hot/hsv have no shipped asset yet -- loading them would just be
// two guaranteed 404s (and two wasted queue slots) on every page view. The
// procedural placeholders are the real presentation until real kernel photos
// exist; flip this once they do.
const HAS_KERNEL_ASSETS = false;

// Resolution the travelling field's recording canvas is rebuilt at (see
// rebuildRecording in buildScene). Matches the placeholder texture size --
// plenty for a noise field that is never seen closer than the full stack.
const RECORD_SIZE = CONFIG.textureSize;
// Amplitude alpha above this counts as "opaque" when stamping a layer's
// phase into the recording canvas. The placeholder amplitude blobs are soft
// radial gradients with a very long, near-zero-alpha tail -- a low cutoff
// here lets that whole tail count as "recorded", so a handful of layers
// union into near-total coverage and the dark, not-yet-recorded look never
// shows. Kept fairly high so only each blob's genuinely opaque core stamps.
const RECORD_COVERAGE_THRESHOLD = 0.35;

function loadAssets(layerCount) {
    const loader = new THREE.TextureLoader();
    const pad = (i) => String(i).padStart(2, '0');

    const amplitude = [];
    const phase = [];

    for (let i = 0; i < layerCount; i += 1) {
        const amp = makePlaceholderAmplitude(i, layerCount);

        // Slot i sits at stack position i (L1 nearest the SLM, L21 farthest --
        // see buildScene). The shipped layer_NN.png files run the opposite way,
        // so reverse the file index here rather than touch the position math.
        const fileIndex = layerCount - 1 - i;
        amplitude.push(USE_REAL_ASSETS ? loadWithFallback(loader, `${ASSET_DIR}/layer_${pad(fileIndex)}.${TEXTURE_EXT}`, amp) : amp);
        phase.push(makePlaceholderPhase(i));
    }

    // The C-RSD kernel is shown as two 5x5 textures side by side: a hot-colormap
    // star stencil and an HSV-noise field, each mirror-symmetric in x and y.
    const kernelHotPlaceholder = makeKernelHotTexture();
    const kernelHot = USE_REAL_ASSETS && HAS_KERNEL_ASSETS
        ? loadWithFallback(loader, `${ASSET_DIR}/crsd_kernel_hot.png`, kernelHotPlaceholder)
        : kernelHotPlaceholder;
    const kernelHsvPlaceholder = makeKernelHsvNoiseTexture();
    const kernelHsv = USE_REAL_ASSETS && HAS_KERNEL_ASSETS
        ? loadWithFallback(loader, `${ASSET_DIR}/crsd_kernel_hsv.png`, kernelHsvPlaceholder)
        : kernelHsvPlaceholder;

    // Focal stack: reconstructions of the finished hologram at several focus
    // distances. Always attempted from disk -- these are results, so there is
    // no meaningful procedural stand-in; the placeholder is a labelled card so
    // the layout is correct and the slot is obviously waiting for real data.
    const focal = [];
    for (let i = 0; i < CONFIG.focalCount; i += 1) {
        const texture = loadWithFallback(
            loader,
            `${ASSET_DIR}/focal_${pad(i)}.${TEXTURE_EXT}`,
            makeFocalPlaceholder(i, CONFIG.focalCount),
        );
        // The shipped focal_NN.png renders come out mirrored left-right relative
        // to the rest of the scene. Flip in U rather than re-export the assets:
        // wrapS must allow it since a repeat of -1 samples outside [0, 1].
        texture.wrapS = THREE.RepeatWrapping;
        texture.repeat.x = -1;
        texture.offset.x = 1;
        focal.push(texture);
    }

    return { amplitude, phase, kernelHot, kernelHsv, focal };
}

// ---------------------------------------------------------------------------
// Complex-field material
//
// One quad carrying BOTH channels of the same complex field: amplitude on the
// left half (grayscale), phase on the right half (HSV colormap, hue = phase).
// A single plane, so amplitude and phase are unambiguously co-located at one
// physical depth -- the split is a readout convention, not two objects.
// ---------------------------------------------------------------------------

const COMPLEX_VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const COMPLEX_FRAGMENT = /* glsl */`
uniform sampler2D uAmplitude;
uniform float uOpacity;
uniform float uHighlight;   // active-layer emphasis
varying vec2 vUv;

void main() {
    // The layer plane carries AMPLITUDE at full resolution across its whole
    // face. Phase lives on its own plane offset behind this one -- so every
    // quantity is shown whole, never as a half-width readout.
    vec2 uv = vUv;

    // Colour and coverage both come straight from the layer's own image: RGB
    // is the layer's actual amplitude/colour, alpha is that layer's coverage
    // mask (where this depth slice actually holds scene content). No synthetic
    // tint or brightness floor -- an empty region of a sparse MPI layer should
    // read as genuinely transparent, not a uniform haze. Sampled with X
    // mirrored: the shipped layer_NN.png photos come in flipped horizontally
    // relative to the scene.
    vec4 texel = texture2D(uAmplitude, vec2(1.0 - uv.x, uv.y));
    // The shipped layer photos are quite dark -- visible-pixel brightness
    // averages roughly 10-30% of full scale -- and a straight read of
    // texel.rgb looks almost greyscale on screen. Boost with a flat exposure
    // multiply (not a per-channel gamma curve: pow() with an exponent < 1
    // *compresses* the ratio between channels, so it brightens but actually
    // flattens hue -- exactly the wrong direction here). A few rare, already-
    // bright pixels clip; that trade is worth it to make the photographed
    // colour legible at all.
    vec3 exposed = clamp(texel.rgb * 4.2, 0.0, 1.0);
    // Lift saturation on top of the exposure boost -- the source colour is
    // faint as well as dark, so even after exposure it reads as desaturated.
    float luma = dot(exposed, vec3(0.299, 0.587, 0.114));
    vec3 baseColor = clamp(mix(vec3(luma), exposed, 1.6), 0.0, 1.0);
    float coverage = texel.a;
    vec3 color = baseColor;

    // While the layer is at the front of the march, flash it warm so the
    // active layer reads as an event in the propagation.
    color = mix(color, color * vec3(1.18, 1.02, 0.86), uHighlight);
    color += uHighlight * 0.18;

    float alpha = uOpacity * coverage;
    gl_FragColor = vec4(color, alpha);
}
`;

// Full-resolution readout of a single scalar field: the random phase (HSV
// colormap over 0..2pi). Used for the plane that sits alongside each layer,
// so the quantity is shown whole rather than squeezed into part of the layer
// quad.
const FIELD_FRAGMENT = /* glsl */`
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uHsv;      // 1 -> HSV colormap (phase), 0 -> tinted grayscale
uniform float uFlat;     // 1 -> collapse to a constant (the amplitude discard)
uniform vec3  uTint;
varying vec2 vUv;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    float v = texture2D(uMap, vUv).r;
    // The amplitude discard: drive the whole field to one constant value. A
    // phase-only SLM cannot reproduce amplitude, so it is replaced by a uniform
    // level -- showing that collapse is showing the information being thrown
    // away.
    v = mix(v, 0.62, uFlat);
    // Phase: hue = phase / 2pi, so the full 0..2pi range is one complete hue
    // wheel and the wrap at 2pi -> 0 is seamless.
    vec3 hsvRGB = hsv2rgb(vec3(v, 0.72, 0.95));
    vec3 flatRGB = mix(vec3(0.12), vec3(1.0), v) * uTint;
    gl_FragColor = vec4(mix(flatRGB, hsvRGB, uHsv), uOpacity);
}
`;

function createComplexMaterial(assets, index) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uAmplitude: { value: assets.amplitude[index] },
            uPhase: { value: assets.phase[index] },
            uOpacity: { value: 0.0 },
            uHighlight: { value: 0.0 },
        },
        vertexShader: COMPLEX_VERTEX,
        fragmentShader: COMPLEX_FRAGMENT,
        transparent: true,
        depthWrite: false,   // translucent stack: never occlude layers behind
        side: THREE.DoubleSide,
    });
}

// Material for a full-resolution single-field plane (phase). `hsv` selects
// the phase colormap; otherwise the map is drawn as a tinted grayscale field.
function createFieldMaterial(map, hsv, tint) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uMap: { value: map },
            uOpacity: { value: 0.0 },
            uHsv: { value: hsv ? 1.0 : 0.0 },
            uFlat: { value: 0.0 },
            uTint: { value: new THREE.Color(tint) },
        },
        vertexShader: COMPLEX_VERTEX,
        fragmentShader: FIELD_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}

// The travelling field's own plane: as it marches through the stack it picks
// up each layer's random phase wherever that layer is opaque, so the plane
// fills in as a noise field in the HSV phase colormap over the course of the
// march -- a visible record of "the wavefront now carries this layer's
// phase here". uMap is a CanvasTexture rebuilt by rebuildRecording() below;
// red holds the recorded phase (hue), green holds that layer's own amplitude
// brightness at the same texel, and alpha is 1 where a layer has stamped
// that texel and 0 where nothing has landed yet.
//
// The amplitude drives the texel's OWN alpha here, not just its colour value:
// this plane sits over the page's light background at a translucent uOpacity,
// and mixing amplitude into colour alone gets washed out by that blend (a
// dark, low-opacity colour over a near-white page still reads as pale). Fading
// dim texels toward transparent instead survives the blend -- weak amplitude
// shows mostly background, strong amplitude reads as fully vivid recorded
// noise -- so the noise is legibly "lit" by the amplitude it came from.
//
// Unstamped texels (alpha 0) are fully transparent -- the plane carries no
// base colour of its own, so it only ever shows the MPI regions it has
// actually recorded content for.
const RECORDING_FRAGMENT = /* glsl */`
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec4 texel = texture2D(uMap, vUv);
    vec3 hsvRGB = hsv2rgb(vec3(texel.r, 0.78, 1.0));
    // Unrecorded texels are fully invisible -- the plane starts black and
    // transparent, and only shows anything where a layer has actually
    // stamped recorded phase/amplitude into it.
    float strength = texel.a * mix(0.12, 1.0, texel.g);
    gl_FragColor = vec4(hsvRGB, uOpacity * strength);
}
`;

function createRecordingMaterial(map) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uMap: { value: map },
            uOpacity: { value: 0.0 },
        },
        vertexShader: COMPLEX_VERTEX,
        fragmentShader: RECORDING_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

// The reconstruction beam leaving the SLM and travelling to the eye.
//
// Drawn as a stack of camera-facing quads along the beam axis, each shaded with
// a radial Gaussian -- bright core falling off smoothly with radius. Composited
// at low per-slice alpha, the slices integrate into a continuous volumetric-
// looking shaft rather than reading as discrete cards. This is much cheaper and
// far more robust than real volume rendering, and it stays convincing from any
// angle because every slice turns to face the camera each frame.
//
// The beam waist grows along the path, so it reads as light spreading from the
// display toward the viewer.
const BEAM_FRAGMENT = /* glsl */`
uniform float uOpacity;
uniform vec3  uColor;
varying vec2 vUv;

void main() {
    // Radius from the slice centre, normalised so the quad edge is r = 1.
    vec2 d = vUv * 2.0 - 1.0;
    float r2 = dot(d, d);

    // Gaussian falloff. exp(-k r^2) with a soft outer cut so the quad's square
    // boundary never becomes visible as a hard edge. The exponent sets how much
    // of the quad the visible beam actually fills -- widening the quad alone
    // just grows the invisible tail, so this is loosened alongside it.
    float g = exp(-1.7 * r2);
    float edge = smoothstep(1.0, 0.25, r2);

    // A brighter, tighter core on top of the broad envelope gives the beam a
    // luminous centre instead of a flat disc.
    float core = exp(-6.0 * r2);

    // Brighten the colour toward the core so the centre reads as hot light
    // rather than just more of the same green.
    vec3 col = mix(uColor, mix(uColor, vec3(1.0), 0.72), core);

    float a = clamp(g * 0.55 + core * 0.75, 0.0, 1.0) * edge * uOpacity;
    gl_FragColor = vec4(col, a);
}
`;

function createBeam(length, startRadius, endRadius, slices) {
    const group = new THREE.Group();
    const material = new THREE.ShaderMaterial({
        uniforms: {
            uOpacity: { value: 0.0 },
            // Green, as the reconstruction wavelength.
            uColor: { value: new THREE.Color(0x46e07a) },
        },
        vertexShader: COMPLEX_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        depthWrite: false,      // never occlude the scene behind the beam
        depthTest: true,
        // NOT additive. The page background is near-white (#f7f7f7), and adding
        // light to that saturates to pure white almost immediately -- the beam
        // loses its colour and reads as a grey smear. Normal alpha blending
        // keeps it green and lets the Gaussian falloff actually be visible.
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
    });

    const quads = [];
    for (let i = 0; i < slices; i += 1) {
        const f = slices === 1 ? 0 : i / (slices - 1);
        const radius = startRadius + (endRadius - startRadius) * f;
        // Unrotated: these are billboarded to the camera every frame, so they
        // must NOT get the standard +90 deg Y rotation the fixed planes take.
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), material);
        // Travel is along -X, from the SLM toward the eye.
        mesh.position.x = -length * f;
        mesh.renderOrder = 4000 + i;
        group.add(mesh);
        quads.push(mesh);
    }

    group.userData.material = material;
    group.userData.quads = quads;
    return group;
}

// ---------------------------------------------------------------------------
// 3D text labels
//
// Every annotation in the scene -- from the "Diopter-Space MPI" heading down
// to the SLM/viewer/phase/amplitude/focal-stack tags -- is text drawn to a
// canvas and mounted on a plane, built by this one function. A 3D object can
// do something an HTML pill cannot: sit at a real depth and travel with the
// thing it names, so it reads in the scene's own perspective instead of being
// a flat readout pasted on top of it.
//
// The plane gets the same +90 degree Y rotation as every other plane in the
// scene (layers, SLM, eye -- see buildScene): normal along +X, lying in the
// YZ plane, so a label reads as flush with the optical train instead of as a
// flat card turned to face the opening camera position. No billboarding --
// it does not re-face the camera as it orbits -- so it stays legible only
// because the camera's azimuth is clamped to a narrow range (see the orbit
// clamp below) that never gets close to edge-on.
// ---------------------------------------------------------------------------

// World units per canvas pixel for labels sized by `scale` rather than an
// explicit target `height`. Chosen so a default (fontPx 44) single-line pill
// comes out a bit over a sixth of a layer's height -- readable next to a
// full-size plane without dominating it.
const LABEL_WORLD_SCALE = 0.0042;
const LABEL_RENDER_ORDER = 9000;   // draw last, on top of the whole scene

function createLabelPlate(lines, opts = {}) {
    const rows = (Array.isArray(lines) ? lines : [lines]).map((l) => l.toUpperCase());
    const {
        fontPx = 44,
        bg = 'rgba(14, 24, 34, 0.62)',
        color = '#f7fbff',
        height,       // explicit target world height; overrides `scale`
        scale = LABEL_WORLD_SCALE,
        tilt = false, // spin 90 deg about the plate's own normal, see below
    } = opts;

    const pad = Math.round(fontPx * 0.43);
    const lineH = Math.round(fontPx * 1.18);

    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `600 ${fontPx}px Helvetica, Arial, sans-serif`;
    const textW = Math.ceil(Math.max(...rows.map((r) => probe.measureText(r).width)));

    const cw = textW + pad * 2;
    // Multi-row labels get a rounded rectangle rather than a pill: a 999px
    // radius on a three-line box bulges into a lozenge.
    const ch = rows.length * lineH + pad * 2 - (lineH - fontPx);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');

    const r = rows.length === 1 ? ch / 2 : ch * 0.16;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(cw, 0, cw, ch, r);
    ctx.arcTo(cw, ch, 0, ch, r);
    ctx.arcTo(0, ch, 0, 0, r);
    ctx.arcTo(0, 0, cw, 0, r);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = color;
    ctx.font = `600 ${fontPx}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    rows.forEach((row, i) => {
        ctx.fillText(row, cw / 2, pad + lineH * i + fontPx * 0.78);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;

    const finalScale = height !== undefined ? height / ch : scale;
    const labelGeo = new THREE.PlaneGeometry(cw * finalScale, ch * finalScale);
    if (tilt) {
        // Leave this one in its default orientation instead of applying the
        // shared YZ rotation below: a PlaneGeometry starts with its width
        // along local/world X, height along Y, normal along +Z. Since world
        // X *is* the propagation axis (the layer stack advances along it),
        // that default already reads left-to-right along the axis the field
        // actually travels -- no rotation needed to get there. Every other
        // label instead rotates into the YZ plane (see the -90 below) so it
        // faces the camera edge-on to the axis; this one trades that
        // camera-facing for running parallel to the axis itself, which is
        // the whole point of a tilted heading like "Diopter-Space MPI".
    } else {
        // Lie in the YZ plane, like every other plane in the scene (see
        // buildScene's shared `geometry`), instead of the default XY -- so
        // the label sits flush with the layers/SLM/eye it names rather than
        // facing a different way than everything around it. Rotated the
        // OPPOSITE way from that shared geometry (-90 deg, not +90): the
        // camera's azimuth is always negative (see the orbit clamp below),
        // so it sits on the -X side of the scene, and the label's normal has
        // to point toward -X to face it -- matching the shared geometry's
        // sign would point the text away from the camera and read mirrored.
        labelGeo.rotateY(-Math.PI / 2);
    }
    const labelMat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        // Labels must never be occluded by nearby opaque/translucent scene
        // geometry (the SLM body, a layer plane at the same depth, ...):
        // they are annotations, not physical objects competing for the
        // z-buffer.
        depthTest: false,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(labelGeo, labelMat);
    mesh.renderOrder = LABEL_RENDER_ORDER;
    // Actual world-space extent along Y (vertical) -- callers that offset a
    // plate above/below something (e.g. createMpiBracket) need this rather
    // than assuming a fixed height, since multi-row labels are taller.
    mesh.userData.worldHeight = ch * finalScale;
    return mesh;
}

// The spec table for every free-standing label in the scene (everything
// except the "Diopter-Space MPI" heading, which travels with its bracket --
// see createMpiBracket). Colors mirror the roles the old HTML pills used:
// warm for the two costly/lossy steps (ASM, amplitude discard), blue for the
// two "read as HSV/complex-field" tags (C-RSD, phase-only), neutral dark
// elsewhere.
const LABEL_SPECS = [
    { key: 'phase', lines: ['Random phase'] },
    { key: 'crsd', lines: ['C-RSD'], bg: 'rgba(33, 82, 122, 0.78)' },
    // Tilted to lie flat along the propagation axis (world X) instead of
    // facing the camera edge-on to it -- see createLabelPlate.
    { key: 'asm', lines: ['ASM +', 'Amplitude discard'], bg: 'rgba(163, 76, 20, 0.82)', fontPx: 34, tilt: true },
    { key: 'focal', lines: ['Focal stack'], bg: 'rgba(34, 64, 100, 0.72)' },
    { key: 'eye', lines: ['Viewer'], bg: 'rgba(34, 64, 100, 0.72)' },
    { key: 'slm', lines: ['SLM'], fontPx: 64 },
];

function createSceneLabels() {
    const labels = {};
    LABEL_SPECS.forEach((spec) => {
        labels[spec.key] = createLabelPlate(spec.lines, { bg: spec.bg, fontPx: spec.fontPx, tilt: spec.tilt });
    });
    return labels;
}

// A square bracket spanning the layer stack, with "Diopter-Space MPI" above it.
//
// The bracket makes the selection explicit -- these layers, this many. `span`
// is the bracket's length along X; the label text uses the same
// createLabelPlate as every other annotation, sized as a fraction of the span
// instead of a fixed world height so it scales with the stack it names.
function createMpiBracket(span, text) {
    const group = new THREE.Group();

    const material = new THREE.LineBasicMaterial({
        color: PALETTE.borderActive,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
    });

    // Square bracket: a spine along X with a short drop at each end pointing
    // down toward the layers it selects.
    const half = span / 2;
    const tick = span * 0.045;
    const pts = [
        -half, 0, 0, half, 0, 0,       // spine
        -half, 0, 0, -half, -tick, 0,  // left drop, pointing at the layers
        half, 0, 0, half, -tick, 0,    // right drop
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    group.add(new THREE.LineSegments(geometry, material));

    // Scale so the pill's height is a fixed fraction of the bracket span,
    // keeping the text legible without dominating the stack. Tilted -- see
    // createLabelPlate -- so it lies flat along the propagation axis (world
    // X) instead of facing the camera edge-on to it, like the field itself.
    const labelH = span * 0.04;
    const label = createLabelPlate([text], { fontPx: 60, height: labelH, tilt: true });
    label.position.y = label.userData.worldHeight / 2 + labelH * 0.3;
    group.add(label);

    group.userData.lineMaterial = material;
    group.userData.labelMaterial = label.material;
    // How far the label's top edge reaches above the group's own origin (the
    // bracket spine) -- resize() needs this to keep the heading from
    // clipping the top of the frame, rather than assuming a fixed height.
    group.userData.labelTopReach = label.position.y + label.userData.worldHeight / 2;
    return group;
}

// A straight arrow marking the path of the one long ASM hop, from L21 back
// through the stack and across the gap to the SLM: a shaft with a chevron
// head pointing at the SLM. This is a fixed path in the scene, not something
// that itself travels -- the field is what moves, sliding along the arrow
// exactly as it always has (see the `asm` phase in createTimeline). The "ASM"
// label used to travel with the field instead; now it rides at a fixed point
// on this arrow, which is what "oriented along the propagation direction"
// means for a plate that does not rotate to begin with (see createLabelPlate).
function createAsmArrow(startX, endX) {
    const group = new THREE.Group();

    const lineMaterial = new THREE.LineBasicMaterial({
        color: PALETTE.kernel,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
    });

    const span = endX - startX;
    const dir = Math.sign(span) || 1;
    const headLen = Math.abs(span) * 0.045;
    // Slimmer than the old barbs (which were nearly as wide as they were
    // long, reading as a stubby hook): a proper arrowhead tapers to a point.
    const headHalf = headLen * 0.4;

    // Shaft stops at the head's base rather than running under it, so the
    // solid head reads as one clean tip instead of a line poking through it.
    const shaftEnd = endX - dir * headLen;
    const shaftGeometry = new THREE.BufferGeometry();
    shaftGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([startX, 0, 0, shaftEnd, 0, 0], 3),
    );
    group.add(new THREE.LineSegments(shaftGeometry, lineMaterial));

    // Solid, closed triangular head -- filled rather than the open two-barb
    // chevron this replaces, which read as a thin hook rather than an arrow.
    // Lies flat in the XY plane at z=0, same as the shaft and the MPI
    // bracket it runs alongside (see createMpiBracket); DoubleSide so it
    // reads correctly regardless of which way `dir` points.
    const headShape = new THREE.Shape();
    headShape.moveTo(endX, 0);
    headShape.lineTo(shaftEnd, headHalf);
    headShape.lineTo(shaftEnd, -headHalf);
    headShape.closePath();
    const headMaterial = new THREE.MeshBasicMaterial({
        color: PALETTE.kernel,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const head = new THREE.Mesh(new THREE.ShapeGeometry(headShape), headMaterial);
    group.add(head);

    group.userData.lineMaterial = lineMaterial;
    group.userData.headMaterial = headMaterial;
    return group;
}

// A schematic eye, drawn as line primitives rather than a texture or a model:
// it stays crisp at any zoom, needs no asset, and matches the line-drawn
// borders used everywhere else. Built in the XY plane then rotated to face
// along the propagation axis, like every other object here.
//
// The classic almond outline (two circular arcs meeting at the corners) plus an
// iris circle and a pupil dot, looking toward +X (back toward the SLM).
function createEye(size) {
    const group = new THREE.Group();
    const material = new THREE.LineBasicMaterial({
        color: PALETTE.borderActive,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
    });

    const pts = [];
    const SEG = 30;
    const halfW = size;
    const halfH = size * 0.55;

    // Upper and lower lids: parabolic arcs meeting at (+-halfW, 0).
    for (let lid = 0; lid < 2; lid += 1) {
        const sign = lid === 0 ? 1 : -1;
        for (let s = 0; s < SEG; s += 1) {
            const t0 = -1 + (2 * s) / SEG;
            const t1 = -1 + (2 * (s + 1)) / SEG;
            pts.push(t0 * halfW, sign * halfH * (1 - t0 * t0), 0);
            pts.push(t1 * halfW, sign * halfH * (1 - t1 * t1), 0);
        }
    }

    // Iris and pupil.
    for (const [radius, step] of [[size * 0.30, 24], [size * 0.13, 16]]) {
        for (let s = 0; s < step; s += 1) {
            const a0 = (s / step) * Math.PI * 2;
            const a1 = ((s + 1) / step) * Math.PI * 2;
            pts.push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0);
            pts.push(Math.cos(a1) * radius, Math.sin(a1) * radius, 0);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geometry.rotateY(Math.PI / 2);
    group.add(new THREE.LineSegments(geometry, material));
    group.userData.material = material;
    return group;
}

// Crisp outline delimiting a plane's extent. A real line primitive rather than
// a texture border, so it stays sharp at any zoom or grazing angle -- essential
// when 21 translucent planes are packed close together.
function createBorder(width, height, color, opacity) {
    const w = width / 2;
    const h = height / 2;
    const points = [
        -w, -h, 0, w, -h, 0,
        w, -h, 0, w, h, 0,
        w, h, 0, -w, h, 0,
        -w, h, 0, -w, -h, 0,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    // Same +90 degree Y rotation the plane geometries get, so an outline always
    // lies exactly on the face it delimits instead of cutting across it.
    geometry.rotateY(Math.PI / 2);
    const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
    });
    return new THREE.LineSegments(geometry, material);
}

// Evenly-spaced indices into a 0..count-1 range, `n` of them (endpoints
// included). Used to thin the focal stack down to `focalVisibleCount` slices
// while still spanning the same near-focus -> far-focus range as the full
// `focalCount` set.
function pickFocalIndices(count, n) {
    if (n >= count) return Array.from({ length: count }, (_, i) => i);
    if (n <= 1) return [0];
    const step = (count - 1) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * step));
}

function buildScene(assets, layerCount, slmGapRatio, focalVisibleCount) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.background);

    const { planeWidth: W, planeHeight: H, layerGap } = CONFIG;

    // Propagation runs along X, so every plane in the optical train must face
    // along X too -- its normal parallel to the direction of travel. A default
    // PlaneGeometry lies in XY facing +Z, i.e. edge-on to the propagation axis,
    // which is wrong. Bake the +90 degree Y rotation into the geometry rather
    // than setting .rotation on each mesh: the orientation then belongs to the
    // geometry itself, so every user of it is correct by construction and
    // anything added later inherits it.
    const geometry = new THREE.PlaneGeometry(W, H);
    geometry.rotateY(Math.PI / 2);

    // Layers run along -X: L1 (index 0) nearest the SLM, L21 farthest.
    // The SLM sits far off at +X across a deliberately dominant empty gap.
    const stackDepth = (layerCount - 1) * layerGap;
    const slmX = slmGapRatio * stackDepth;

    const layers = [];
    for (let i = 0; i < layerCount; i += 1) {
        const group = new THREE.Group();
        group.position.x = -i * layerGap;

        const material = createComplexMaterial(assets, i);
        const mesh = new THREE.Mesh(geometry, material);
        // Explicit back-to-front order for correct alpha blending: farthest
        // layer drawn first. Without this the translucent stack composites wrong.
        mesh.renderOrder = layerCount - i;
        group.add(mesh);

        const border = createBorder(W, H, PALETTE.border, 0.0);
        border.renderOrder = layerCount - i;
        group.add(border);

        // This layer's random phase, at full resolution on its own plane. It
        // stays at the layer's own X -- co-located in depth, offset only
        // sideways (see PHASE_LANE) -- so it reads as belonging to this layer
        // rather than floating in the gap between two of them.
        const phaseMaterial = createFieldMaterial(assets.phase[i], true, 0xffffff);
        const phaseMesh = new THREE.Mesh(geometry, phaseMaterial);
        phaseMesh.renderOrder = layerCount - i;   // drawn with its layer
        group.add(phaseMesh);

        const phaseBorder = createBorder(W, H, PALETTE.borderActive, 0.0);
        phaseBorder.renderOrder = layerCount - i;
        group.add(phaseBorder);

        scene.add(group);
        layers.push({
            group, mesh, material, border,
            phaseMesh, phaseMaterial, phaseBorder,
        });
    }

    // SLM: heavier and opaque, so it reads as hardware rather than another layer.
    const slm = new THREE.Group();
    slm.position.x = slmX;

    // The SLM faces the incoming field, so its thin axis is X (depth into the
    // display), not Z -- the box dimensions are ordered accordingly rather than
    // rotated after the fact.
    const slmPanel = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, H * 0.86, W * 0.86),
        new THREE.MeshBasicMaterial({ color: PALETTE.slmBody }),
    );
    slm.add(slmPanel);

    const slmBezel = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, H * 1.02, W * 1.02),
        new THREE.MeshBasicMaterial({ color: PALETTE.slmBezel }),
    );
    // Offset along +X: behind the panel, on the far side from the arriving field.
    slmBezel.position.x = 0.03;
    slm.add(slmBezel);

    const slmGlow = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
            color: PALETTE.field,
            transparent: true,
            opacity: 0.0,
            depthWrite: false,
        }),
    );
    // The shared geometry is already rotated into the YZ plane, so its local
    // width now runs along Z: scale Y and Z, and lift the glow off the panel
    // along -X (toward the arriving field) rather than along Z.
    slmGlow.scale.set(1, 0.84, 0.84);
    slmGlow.position.x = -0.05;
    slmGlow.renderOrder = layerCount + 4;
    slm.add(slmGlow);
    scene.add(slm);

    // The travelling recording plane: the complex field in flight. Its face is
    // a noise texture in the HSV phase colormap, built up progressively as the
    // field marches: each layer stamps ITS random phase into this canvas
    // wherever that layer is opaque, so the plane fills in with noise over the
    // course of the march instead of staying a flat colour card. See
    // rebuildRecording below.
    const recordingCanvas = makeCanvas(RECORD_SIZE);
    const recordingTexture = new THREE.CanvasTexture(recordingCanvas);
    recordingTexture.colorSpace = THREE.NoColorSpace;   // raw phase data, not colour
    // Unrecorded texels stay fully transparent: "nothing landed here yet"
    // means no draw at all, so only the actual recorded MPI regions show.
    const fieldMaterial = createRecordingMaterial(recordingTexture);
    const field = new THREE.Mesh(geometry, fieldMaterial);
    field.renderOrder = layerCount + 6;
    scene.add(field);

    // Rebuilds the recording canvas from scratch for a given count of
    // "recorded" layers (the layers the front has already passed -- see
    // `consumed` in the timeline). Pure function of `count`, like the rest of
    // the timeline: re-running it for the same count is a cheap no-op-ish
    // redraw, so scrubbing the progress bar backwards and forwards stays
    // correct instead of depending on frame-by-frame history.
    //
    // Later layers are stamped after earlier ones and simply overwrite them
    // where both are opaque -- the field's phase in a region is whatever the
    // LAST layer it passed through left there, which is what actually
    // happens physically as each layer re-modulates the field passing it.
    const recordingCtx = recordingCanvas.getContext('2d');
    let recordedCount = -1;
    function rebuildRecording(count) {
        if (count === recordedCount) return;
        recordedCount = count;
        const size = RECORD_SIZE;
        const out = recordingCtx.createImageData(size, size);
        for (let i = 0; i < count; i += 1) {
            const layerUniforms = layers[i].material.uniforms;
            const amp = sampleTexelData(layerUniforms.uAmplitude.value, size);
            const phase = sampleTexelData(layerUniforms.uPhase.value, size);
            for (let p = 0; p < size * size; p += 1) {
                const idx = p * 4;
                if (amp[idx + 3] / 255 <= RECORD_COVERAGE_THRESHOLD) continue;
                // Red: this layer's random phase (hue). Green: this layer's
                // OWN amplitude brightness at this texel (HSV value in the
                // shader) -- the recorded noise is lit by the amplitude it
                // came from, not painted at one flat brightness.
                out.data[idx] = phase[idx];
                out.data[idx + 1] = Math.round((amp[idx] + amp[idx + 1] + amp[idx + 2]) / 3);
                out.data[idx + 3] = 255;
            }
        }
        recordingCtx.putImageData(out, 0, 0);
        recordingTexture.needsUpdate = true;
    }
    rebuildRecording(0);

    const fieldBorder = createBorder(W * 1.03, H * 1.03, PALETTE.borderActive, 0.0);
    fieldBorder.renderOrder = layerCount + 7;
    scene.add(fieldBorder);

    // The 5x5 C-RSD kernel card, riding the propagation front. It is the
    // convolution applied between layers, so it faces the same way they do.
    // Shown as two textures side by side (hot-colormap star stencil, HSV-noise
    // field) rather than one -- see makeKernelHotTexture/makeKernelHsvNoiseTexture.
    // Centred vertically on the layers (Y=0, same as their own centre) rather
    // than floated above them, so it reads as sitting IN the stack it is
    // convolving with, not as a separate annotation card.
    const KERNEL_SIZE = W * KERNEL_SIZE_RATIO;
    const KERNEL_PAIR_OFFSET = KERNEL_SIZE * (0.5 + KERNEL_GAP_RATIO * 0.5);
    const kernelY = 0;
    function makeKernelCard(map, zOffset, order) {
        const geometry = new THREE.PlaneGeometry(KERNEL_SIZE, KERNEL_SIZE);
        geometry.rotateY(Math.PI / 2);
        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
                map,
                transparent: true,
                opacity: 0.0,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
        );
        mesh.position.y = kernelY;
        mesh.renderOrder = order;
        scene.add(mesh);

        const border = createBorder(KERNEL_SIZE * KERNEL_BORDER_RATIO, KERNEL_SIZE * KERNEL_BORDER_RATIO, PALETTE.kernel, 0.0);
        border.position.y = kernelY;
        border.renderOrder = order + 1;
        scene.add(border);

        return { mesh, border, zOffset };
    }
    const kernelHot = makeKernelCard(assets.kernelHot, -KERNEL_PAIR_OFFSET, layerCount + 8);
    const kernelHsv = makeKernelCard(assets.kernelHsv, KERNEL_PAIR_OFFSET, layerCount + 10);

    // --- Focal stack ---------------------------------------------------------
    // Reconstructions at a few focus distances, shown during the final hold in
    // front of the far end of the stack -- what the eye actually sees.
    const focalIndices = pickFocalIndices(assets.focal.length, focalVisibleCount).reverse();
    const focal = focalIndices.map((sourceIndex, i) => {
        const map = assets.focal[sourceIndex];
        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
                map,
                transparent: true,
                opacity: 0.0,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
        );
        // depthWrite is off (see above), so with transparent overlapping quads
        // draw order is the ONLY thing that determines what shows through what --
        // it must run back-to-front from the camera's fixed vantage point. The
        // camera always sits on the negative-X (eye) side of the stack (azimuth
        // is clamped to a narrow negative range on drag, see orbit below), and slot i
        // is positioned at x = -stackDepth * (0.1 + 0.8 * f) with f = 1 - i/n --
        // i.e. x grows (moves away from the camera) as i grows. So the slot
        // FARTHEST from the camera is the one with the HIGHEST i, and it must be
        // painted first (lowest renderOrder); reverse the index here or the
        // stack paints front-to-back and later slices wrongly cover earlier ones.
        const order = layerCount + 14 + (focalIndices.length - 1 - i);
        mesh.renderOrder = order;
        scene.add(mesh);
        const border = createBorder(W, H, PALETTE.border, 0.0);
        border.renderOrder = order;
        scene.add(border);
        return { mesh, border };
    });

    // --- Eye -----------------------------------------------------------------
    // Sits beyond the far end of the stack looking back toward the SLM, so the
    // focal stack is between the eye and the display: it is visualizing the
    // hologram, not merely decorating the scene.
    const eye = createEye(H * 0.42);
    const eyeX = -stackDepth - layerGap * 1.6;
    eye.position.x = eyeX;
    eye.renderOrder = layerCount + 20;
    scene.add(eye);

    // --- Reconstruction beam --------------------------------------------------
    // Green light leaving the SLM and converging on the eye. Starts roughly the
    // size of the display's active area and narrows to the pupil.
    // Slice count is a quality/appearance tradeoff: too few and the shaft reads
    // as a row of discrete blobs, too many and the alpha accumulates into an
    // opaque tube. Dense slices at low per-slice alpha give a smooth shaft.
    // Diverging, not converging: light leaves the SLM's active area and SPREADS
    // as it travels, so the waist grows from the display toward the viewer.
    const beam = createBeam(slmX - eyeX, H * 0.42, H * 0.95, 110);
    beam.position.x = slmX;
    scene.add(beam);

    // --- MPI bracket ----------------------------------------------------------
    // Spans the full layer stack and names it. Parented to nothing in
    // particular; positioned to sit above the layers it selects.
    const mpiBracket = createMpiBracket(stackDepth + layerGap, 'Diopter-Space MPI');
    mpiBracket.position.set(-stackDepth / 2, H * 1.35, 0);
    scene.add(mpiBracket);

    // --- ASM arrow -------------------------------------------------------
    // The path of the long ASM hop, fixed from L21 (-stackDepth) to the SLM.
    // See createAsmArrow: the field travels along this, the arrow itself does
    // not.
    const asmArrow = createAsmArrow(-stackDepth, slmX);
    scene.add(asmArrow);

    // --- Every other label -----------------------------------------------
    // SLM, viewer, random phase, C-RSD, ASM, amplitude/discard/phase and the
    // focal stack: all 3D text plates, built the same way and sharing the
    // MPI heading's orientation (see createLabelPlate).
    // Positioned and faded in updateLabels() each frame.
    const labels = createSceneLabels();
    Object.values(labels).forEach((mesh) => scene.add(mesh));

    return {
        scene, layers, slm, slmGlow, field, fieldMaterial, fieldBorder, rebuildRecording,
        kernelHot, kernelHsv,
        focal, eye, beam, mpiBracket, asmArrow, labels,
        slmX, stackDepth, eyeX,
    };
}

// ---------------------------------------------------------------------------
// Animation timeline
// ---------------------------------------------------------------------------

function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
}

function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

function createTimeline(world, layerCount, config) {
    const stepCount = layerCount - 1;
    const marchTime = stepCount * config.stepTime;

    // Phases in order, as a table rather than a chain of cumulative if/else
    // arithmetic -- adding or retiming a beat is then a one-line edit and the
    // offsets cannot drift out of sync.
    //
    //   intro   stack fades in
    //   inject  every layer's random phase slides in from the RIGHT and merges
    //           into it, then clears -- the phase is established for the whole
    //           MPI before any propagation happens
    //   march   L1 -> L21, one short C-RSD hop per layer
    //   asm     "ASM + Amplitude discard": the long hop from L21 across the
    //           gap to the SLM -- the amplitude-discard step is folded into
    //           this one label rather than shown as a separate visual, so the
    //           focal stack is free to fade in during the hop's tail instead
    //           of waiting behind it.
    //   hold    focal stack + eye: what the viewer actually sees
    //   outro   everything fades, loop
    const PHASES = [
        ['intro', config.introTime],
        ['inject', config.phaseInjectTime],
        ['march', marchTime],
        ['asm', config.asmTime],
        ['hold', config.holdTime],
        ['outro', config.outroTime],
    ];
    const total = PHASES.reduce((sum, [, d]) => sum + d, 0);

    const { planeWidth: W, layerGap } = CONFIG;
    const layerX = (i) => -i * layerGap;

    function apply(t) {
        const time = t % total;

        let phase = PHASES[PHASES.length - 1][0];
        let local = 1;
        let cursor = 0;
        for (const [name, duration] of PHASES) {
            if (time < cursor + duration) {
                phase = name;
                local = duration > 0 ? (time - cursor) / duration : 1;
                break;
            }
            cursor += duration;
        }

        // `asm` is now just the hop, so its local progress IS the hop's
        // progress -- no sub-beat remapping needed.
        const asmLocalHop = local;
        const inAsmHop = phase === 'asm';

        // Phases after the ASM hop has finished. Several blocks below need
        // "the march is over" rather than one specific phase.
        const afterAsm = ['hold', 'outro'].includes(phase);

        // --- Layer stack visibility -----------------------------------------
        // The front is the layer index the wavefield has reached. During the ASM
        // hop it is driven PAST the last layer, so that layer consumes and fades
        // like every other one -- by the time the field lands on the SLM the
        // whole stack has been used up and cleared away.
        const frontIndex = ['intro', 'inject'].includes(phase) ? 0
            : phase === 'march' ? local * stepCount
            : phase === 'asm' ? stepCount + easeInOut(asmLocalHop) * 2.2
            : stepCount + 2.2;

        const globalFade = phase === 'intro' ? easeOut(local)
            : phase === 'outro' ? 1 - easeInOut(local)
            : 1;

        // The travelling field's recording canvas: a layer counts as
        // "recorded" the instant it starts fading as consumed (frontIndex >
        // i + 0.35, same threshold `consumed` uses below), so the noise fills
        // in exactly as each layer's content is folded into the wavefield.
        const recordedCount = Math.max(0, Math.min(layerCount, Math.ceil(frontIndex - 0.35)));
        world.rebuildRecording(recordedCount);

        // The random phase is injected during `inject`, and present in every
        // layer from then on.
        const afterInject = !['intro', 'inject'].includes(phase);

        world.layers.forEach((layer, i) => {
            const u = layer.material.uniforms;
            const proximity = Math.max(0, 1 - Math.abs(frontIndex - i) / 3.2);

            // A layer is CONSUMED once the front has passed it: its content has
            // been folded into the wavefield, so it fades out and leaves the
            // scene rather than lingering as clutter. `consumed` ramps 0->1 over
            // roughly one layer's worth of travel past it.
            const consumed = clamp01(frontIndex - i - 0.35);

            // Where this layer sits in the stack, 0 (nearest the SLM) to 1.
            // Both injection beats stagger by it so the stack resolves
            // front-to-back instead of 21 planes flashing on together, which
            // reads as one undifferentiated event.
            const stagger = layerCount > 1 ? i / (layerCount - 1) : 0;

            // Ahead of the front the layer waits at moderate opacity; at the
            // front it lifts; behind the front it fades away entirely.
            const base = (0.7 + 0.55 * proximity) * (1 - consumed);
            u.uOpacity.value = base * globalFade;
            u.uHighlight.value = proximity * (phase === 'march' ? 1 : 0.25);

            layer.border.material.opacity =
                (0.20 + 0.55 * proximity) * (1 - consumed) * globalFade;
            layer.border.material.color.setHex(
                proximity > 0.55 ? PALETTE.borderActive : PALETTE.border,
            );

            // --- Random phase ------------------------------------------------
            // Injected during the `inject` beat: every layer's phase slides in
            // from the RIGHT (+Z) and merges into it, established before
            // anything propagates.
            //
            // Afterwards the phase stays with its layer as a thin back face at
            // low opacity: it is part of the layer now, not an event. During the
            // march the layer at the front lifts it briefly so the injection is
            // still legible as the wavefield picks it up.
            const injectLocal = phase === 'inject'
                ? clamp01((local - stagger * 0.42) / 0.48)
                : 0;
            const injectIn = easeOut(clamp01(injectLocal / 0.42));
            const injectMerged = clamp01((injectLocal - 0.58) / 0.34);

            // Comes in from the right lane and settles CLEAR of the layer, not
            // on it -- see the lane constants at the top of the file.
            const phaseZ = W * (PHASE_LANE + (PHASE_APPLIED - PHASE_LANE) * injectIn);
            layer.phaseMesh.position.z = afterInject ? W * PHASE_APPLIED : phaseZ;
            layer.phaseBorder.position.z = layer.phaseMesh.position.z;

            let phaseVisLayer;
            if (phase === 'inject') {
                // Fades as it merges, down to the faint resting level it keeps.
                // Held well below full: these are full-size noise planes, one
                // per layer, and at high opacity 21 of them in flight read as
                // one speckled slab rather than as a per-layer injection.
                const arriving = clamp01(injectLocal / 0.42);
                phaseVisLayer = arriving * (0.52 - 0.45 * injectMerged);
            } else if (afterInject) {
                // Settled. Kept very faint at rest and lifted only at the
                // front: 21 layers of per-pixel noise at any real opacity
                // composite into a speckled wall that buries the stack, so
                // essentially only the layer being consumed shows its phase.
                const atFront = Math.max(0, 1 - Math.abs(frontIndex + 0.5 - i) / 1.1);
                phaseVisLayer = (0.05 + 0.62 * atFront) * (1 - consumed);
            } else {
                phaseVisLayer = 0;
            }

            layer.phaseMaterial.uniforms.uOpacity.value = phaseVisLayer * globalFade;
            layer.phaseBorder.material.opacity = phaseVisLayer * 0.38 * globalFade;
        });

        // --- Travelling field ------------------------------------------------
        let fieldX;
        let fieldOpacity;

        if (phase === 'intro') {
            fieldX = layerX(0);
            fieldOpacity = easeOut(local) * 0.5;
        } else if (phase === 'march') {
            // Step-and-settle within each hop, so the discrete C-RSD
            // convolutions stay countable instead of blurring into a glide.
            const exact = local * stepCount;
            const stepIndex = Math.floor(exact);
            const within = easeInOut(clamp01(exact - stepIndex));
            fieldX = layerX(Math.min(stepIndex + within, stepCount));
            fieldOpacity = 0.55;
        } else if (inAsmHop) {
            // The one long hop: from L21, back through the whole translucent
            // stack and on across the empty gap to the SLM.
            const e = easeInOut(asmLocalHop);
            fieldX = layerX(stepCount) + (world.slmX - layerX(stepCount)) * e;
            fieldOpacity = 0.55 * (1 - Math.pow(asmLocalHop, 4));
        } else {
            fieldX = world.slmX;
            fieldOpacity = 0;
        }

        world.field.position.x = fieldX;
        world.fieldBorder.position.x = fieldX;
        world.fieldMaterial.uniforms.uOpacity.value = fieldOpacity * globalFade;
        world.fieldBorder.material.opacity = fieldOpacity * 1.5 * globalFade;

        // The field swells slightly mid-ASM, reading as one continuous sweep
        // rather than a teleport. The swell is in-plane (Y and Z): the flight
        // direction X is the plane's normal now, and scaling a plane along its
        // own normal does nothing visible.
        const asmSwell = inAsmHop ? 1 + Math.sin(asmLocalHop * Math.PI) * 0.10 : 1;
        world.field.scale.set(1, asmSwell, asmSwell);

        // --- C-RSD kernel ----------------------------------------------------
        // Present only during the short hops. Its absence during the ASM jump is
        // the point: that hop is FFT-based, not a compact convolution.
        if (phase === 'march') {
            const exact = local * stepCount;
            const stepIndex = Math.min(Math.floor(exact), stepCount - 1);
            const within = clamp01(exact - stepIndex);
            // Held at the midpoint of the current hop's two layers for the whole
            // hop (not slid with `within`), so it reads as centred between them
            // rather than drifting past centre toward the next pair; it then
            // jumps to the next pair's midpoint when the hop advances.
            const kernelX = layerX(stepIndex + 0.5);
            const pulse = Math.sin(within * Math.PI);
            const s = 1 + pulse * KERNEL_PULSE_MAX;
            [world.kernelHot, world.kernelHsv].forEach((card) => {
                card.mesh.position.x = kernelX;
                // Centred within the plane (Z is now an in-plane axis), so the
                // pair sits in the middle of the stack it is convolving with,
                // one card on either side of the shared centre line.
                card.mesh.position.z = card.zOffset;
                card.mesh.material.opacity = (0.35 + 0.3 * pulse) * globalFade;
                card.border.material.opacity = (0.3 + 0.35 * pulse) * globalFade;
                card.border.position.x = card.mesh.position.x;
                card.border.position.z = card.mesh.position.z;
                // Pulse within the plane: Y and Z, since X is now the normal.
                card.mesh.scale.set(1, s, s);
                card.border.scale.set(1, s, s);
            });
        } else {
            [world.kernelHot, world.kernelHsv].forEach((card) => {
                card.mesh.material.opacity = 0;
                card.border.material.opacity = 0;
            });
        }

        // --- Focal stack + eye ---------------------------------------------------
        // The amplitude discard is named by the "ASM + Amplitude discard" label
        // on the hop itself (see updateLabels) rather than shown as a separate
        // split/flatten visual, so the focal stack -- the finished hologram,
        // reconstructed at several focus distances -- fades in during the
        // hop's tail and is fully in place by the time `hold` begins, with the
        // eye in front of the far end of the stack looking back toward the SLM.
        let focalVis = 0;
        if (inAsmHop) focalVis = easeOut(clamp01((asmLocalHop - 0.55) / 0.45));
        else if (phase === 'hold') focalVis = 1;
        else if (phase === 'outro') focalVis = 1 - easeInOut(local);

        world.focal.forEach((slot, i) => {
            // Spread purely along X -- the propagation axis -- so the series
            // reads as receding straight back in front of the SLM, the way the
            // real focus distances line up along the beam. Any Z offset here
            // would drift the stack sideways off that axis and read as tilted.
            const n = Math.max(1, world.focal.length - 1);
            const f = world.focal.length === 1 ? 0.5 : 1 - i / n;
            slot.mesh.position.set(
                -world.stackDepth * (0.1 + 0.8 * f),
                0,
                0,
            );
            slot.border.position.copy(slot.mesh.position);
            // Stagger the fade-in so the stack assembles front-to-back. Scaled by
            // slot count so the last slot still finishes staggering in by the time
            // focalVis reaches 1, regardless of how many slots there are.
            const v = clamp01(focalVis * 1.4 - f * 1.1);
            // Lower ceiling than a small stack needs: 21 slices at high opacity
            // still read as one solid slab even when well spread out, since
            // successive slices still overlap heavily edge-on.
            slot.mesh.material.opacity = v * 1.5;
            slot.border.material.opacity = v * 0.6;
        });

        world.eye.userData.material.opacity = focalVis * 0.95 * globalFade;

        // The reconstruction beam comes up with the eye: it is the light the
        // viewer is actually receiving from the display. A slow breathe keeps it
        // feeling alive rather than pasted on.
        const breathe = 0.90 + 0.10 * Math.sin(t * 1.6);
        world.beam.userData.material.uniforms.uOpacity.value =
            focalVis * 0.055 * breathe * globalFade;

        // --- MPI bracket ----------------------------------------------------
        // Belongs to the stack, so it goes when the stack does -- and it goes
        // BEFORE the ASM hop rather than during it. The ASM is the beat where
        // the camera pulls out to the full geometry and the field crosses the
        // whole scene; an MPI annotation still hanging over an emptying stack
        // competes with that motion for attention. It clears out early in the
        // hop, so the long jump is the only thing left to watch.
        const bracketVis = inAsmHop ? clamp01(1 - asmLocalHop * 8)
            : afterAsm ? 0
            : globalFade;
        world.mpiBracket.userData.lineMaterial.opacity = bracketVis; // * 0.85;
        world.mpiBracket.userData.labelMaterial.opacity = bracketVis; // * 0.95;

        // --- SLM response ------------------------------------------------------
        // The display lights up as the field arrives and the amplitude is
        // discarded, ramping up smoothly across the hop rather than in
        // separate stages.
        let glow = 0;
        if (inAsmHop) glow = Math.pow(asmLocalHop, 3) * 0.80;
        else if (phase === 'hold') glow = 0.80;
        else if (phase === 'outro') glow = 0.80 * (1 - local);
        world.slmGlow.material.opacity = glow * globalFade;

        // --- What the camera is framing ---------------------------------------
        // ONE fixed framing for the whole loop, covering the full optical train
        // from beyond the eye to past the SLM.
        //
        // This was previously a per-phase region of interest that the camera
        // eased between, which kept each beat as large as possible but meant the
        // scene was almost never still -- a continuous drift in and out that
        // reads as the figure breathing. A static frame is worth more than the
        // extra size: the geometry stays put, so the eye can track the field
        // moving through it instead of re-locating everything each beat.
        //
        // [xMin, xMax] along the layout axis; the camera code turns it into a
        // target and a distance.
        const roi = [
            world.eyeX - W * 0.25,
            world.slmX + W * 0.25,
        ];

        return {
            phase, local, frontIndex, fieldX, globalFade, roi, focalVis,
            inAsmHop, asmLocalHop,
        };
    }

    return { apply, total };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function initMethod3D(root) {
    const canvas = root.querySelector('.method-3d-canvas');
    if (!canvas) return;

    // Progress bar for the whole loop. Lives outside .method-3d (it sits under
    // the animation window, not over it), so look for it as a sibling and fall
    // back to a descendant if a page nests it instead.
    const progressFill =
        root.parentElement?.querySelector('[data-method-3d-progress] .method-3d-progress-fill')
        || root.querySelector('.method-3d-progress-fill')
        || null;

    const layerCount = parseInt(root.dataset.layers, 10) || CONFIG.layers;
    const config = {
        introTime: CONFIG.introTime,
        phaseInjectTime: parseFloat(root.dataset.phaseInjectTime) || CONFIG.phaseInjectTime,
        holdTime: parseFloat(root.dataset.holdTime) || CONFIG.holdTime,
        outroTime: CONFIG.outroTime,
        stepTime: parseFloat(root.dataset.stepTime) || CONFIG.stepTime,
        asmTime: parseFloat(root.dataset.asmTime) || CONFIG.asmTime,
    };
    const slmGapRatio = parseFloat(root.dataset.slmGap) || CONFIG.slmGapRatio;
    const focalVisibleCount = parseInt(root.dataset.focalCount, 10) || CONFIG.focalVisibleCount;

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch (err) {
        // No WebGL: leave the section as-is rather than showing a broken canvas.
        root.classList.add('method-3d-unavailable');
        return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(PALETTE.background, 1);

    const assets = loadAssets(layerCount);
    const world = buildScene(assets, layerCount, slmGapRatio, focalVisibleCount);
    const timeline = createTimeline(world, layerCount, config);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

    // Centre on the midpoint of everything that must stay in frame: the stack
    // spans [-stackDepth, 0] and the SLM sits at +slmX. Vertically centred: the
    // layer planes are symmetric about y = 0, so the visual mass is balanced.
    const midX = (world.slmX - world.stackDepth) / 2;
    const target = new THREE.Vector3(midX, 0, 0);

    // Look ACROSS the stack at a strongly oblique angle, never near edge-on:
    // with 21 tightly-packed planes a shallow view collapses them into a single
    // unreadable slab. The stack runs along X, so the camera needs a large
    // azimuth to see the planes' faces separating in depth.
    const orbit = {
        // Oblique enough to separate the layers in depth, but shallow in
        // elevation: the layout is a long horizontal run in a wide, short box,
        // so a high camera wastes the frame on empty ground.
        azimuth: -0.95,
        elevation: 0.26,
        radius: 1,   // placeholder; resize() solves for the real fit distance
        dragging: false,
        lastX: 0,
        lastY: 0,
        idle: 0,
    };
    const AZIMUTH_HOME = orbit.azimuth;
    const AZIMUTH_DRIFT = 0.14;   // idle sway amplitude, in radians

    function updateCamera() {
        const { azimuth, elevation, radius } = orbit;
        camera.position.set(
            target.x + radius * Math.cos(elevation) * Math.sin(azimuth),
            target.y + radius * Math.sin(elevation),
            target.z + radius * Math.cos(elevation) * Math.cos(azimuth),
        );
        camera.lookAt(target);
    }

    // Pointer-drag orbit, clamped so the camera cannot reach a degenerate view.
    canvas.addEventListener('pointerdown', (e) => {
        orbit.dragging = true;
        orbit.idle = 0;
        orbit.lastX = e.clientX;
        orbit.lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        root.classList.add('is-dragging');
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!orbit.dragging) return;
        const dx = e.clientX - orbit.lastX;
        const dy = e.clientY - orbit.lastY;
        orbit.lastX = e.clientX;
        orbit.lastY = e.clientY;
        orbit.azimuth -= dx * 0.006;
        // Keep a minimum tilt so the stack never collapses to a line.
        orbit.elevation = Math.min(0.85, Math.max(-0.25, orbit.elevation + dy * 0.005));
        // Clamp away from the near-edge-on azimuths where the 21 tightly-packed
        // layers collapse into a single unreadable slab.
        orbit.azimuth = Math.min(-0.45, Math.max(-1.45, orbit.azimuth));
    });

    function endDrag(e) {
        if (!orbit.dragging) return;
        orbit.dragging = false;
        if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
        }
        root.classList.remove('is-dragging');
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // The region of interest along the layout axis that the camera frames.
    // Fixed for the whole loop (see the `roi` the timeline returns) so the
    // scene never drifts in or out of scale; seeded to the same values the
    // timeline reports, so the very first frame is already correct.
    let roiMin = world.eyeX - CONFIG.planeWidth * 0.25 - 5.0;
    let roiMax = world.slmX + CONFIG.planeWidth * 0.25 + 5.0;
    let roiPrimed = false;

    function resize() {
        const rect = root.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        renderer.setSize(rect.width, rect.height, false);
        camera.aspect = rect.width / rect.height;
        camera.updateProjectionMatrix();

        // Solve for the distance that actually fits the content. Rather than
        // trying to reason about foreshortening analytically (easy to get wrong
        // -- the layout axis, the plane widths and the camera azimuth all
        // interact), just project the scene's corner points at a unit distance
        // and measure what the fit has to be.
        //
        // Fit for the WIDEST azimuth the idle drift reaches, not the current
        // one: a radius recomputed per frame from the drifting azimuth makes the
        // whole scene visibly breathe in and out.
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);

        // Plane width runs along Z (the geometries are rotated so their normals
        // face along the X propagation axis). The kernel cards are centred
        // within that width now, so they never reach past the planes' own
        // edge and don't factor into the horizontal extent.
        // The random phase planes come in from the right lane, stopping clear
        // of the layers. Their outer edge at the rest distance is the furthest
        // anything reaches along Z, and it is reserved for the whole loop --
        // the framing is fixed, so the widest moment sets the frame for every
        // moment.
        const laneZ = CONFIG.planeWidth * (PHASE_LANE + 0.5);
        const hw = Math.max(
            CONFIG.planeWidth * 0.5,
            laneZ,
        );
        // Vertical extent is set by whatever reaches furthest off the layout
        // axis -- the planes themselves, or what hangs off them (the kernel
        // card above, the beam). Fitting to any one of those alone lets the
        // others clip at the frame edges.
        // The MPI bracket and its label sit above everything else, so they set
        // the top of the frame during the intro and march. labelTopReach
        // (see createMpiBracket) depends on the heading text's own length --
        // tilted 90 degrees, it now reads top-to-bottom, so a longer phrase
        // reaches further above the spine, not just further sideways.
        const bracketReach = CONFIG.planeHeight * 1.35 + world.mpiBracket.userData.labelTopReach;
        // The reconstruction beam diverges toward the viewer, so its widest
        // point -- at the eye end -- is the lowest-reaching thing in the scene
        // during the hold, wider than the layer planes themselves.
        const beamReach = CONFIG.planeHeight * 0.95;
        // Floor everything at the layers' own half-height so the planes can
        // never be clipped by a fit driven only by their satellites.
        const hFloor = CONFIG.planeHeight * 0.5;
        const hTop = Math.max(
            hFloor,
            beamReach,
            bracketReach,
        );
        const hBottom = Math.max(hFloor, beamReach);
        // Z must cover the amplitude/phase pair pulling apart at the SLM during
        // the discard, which reaches past the layer planes themselves.
        const discardZ = hw + CONFIG.planeWidth * 0.40;
        // Look at the middle of whatever is currently being framed.
        target.x = (roiMin + roiMax) / 2 - 3.0;
        const corners = [];
        [roiMin, roiMax].forEach((x) => {
            [-discardZ, discardZ].forEach((z) => {
                [-hBottom, hTop].forEach((y) => corners.push(new THREE.Vector3(x, y, z)));
            });
        });

        let need = 0;
        [orbit.azimuth - AZIMUTH_DRIFT, orbit.azimuth + AZIMUTH_DRIFT].forEach((az) => {
            // Camera basis at this azimuth/elevation, looking at target.
            const dir = new THREE.Vector3(
                Math.cos(orbit.elevation) * Math.sin(az),
                Math.sin(orbit.elevation),
                Math.cos(orbit.elevation) * Math.cos(az),
            );
            const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
            const up = new THREE.Vector3().crossVectors(right, dir).normalize();

            corners.forEach((c) => {
                const v = c.clone().sub(target);
                // Distance at which this corner sits exactly on a frustum plane.
                // Taking the max over every corner and both frustum planes gives
                // the smallest radius that contains the whole scene.
                const depth = v.dot(dir);
                need = Math.max(
                    need,
                    Math.abs(v.dot(right)) / Math.tan(hFov / 2) + depth,
                    Math.abs(v.dot(up)) / Math.tan(vFov / 2) + depth,
                );
            });
        });

        // Tight margin: labels are small 3D plates near what they annotate,
        // not a screen-space layer that needs its own reserved border.
        orbit.radius = Math.max(need * 0.5, CONFIG.planeWidth);
    }

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const labelWorld = {
        phase: new THREE.Vector3(0, CONFIG.planeHeight * 0.60, 0),
        crsd: new THREE.Vector3(0, CONFIG.planeHeight * 0.52, 0),
        // Fixed at the midpoint of the ASM arrow (see createAsmArrow) rather
        // than tracking the field: during the hop sub-beat the label rides on
        // the static path, not on the thing travelling along it.
        asm: new THREE.Vector3(
            (-world.stackDepth + world.slmX) / 2,
            CONFIG.planeHeight * 0.62,
            0,
        ),
        slm: new THREE.Vector3(world.slmX, CONFIG.planeHeight * 0.72, 0),
        focal: new THREE.Vector3(-world.stackDepth * 0.5, CONFIG.planeHeight * 0.70, 0),
        eye: new THREE.Vector3(
            -world.stackDepth - CONFIG.layerGap * 1.6,
            -CONFIG.planeHeight * 0.42,
            0,
        ),
    };

    // Every label is a 3D plate living in world.labels (see createSceneLabels):
    // this just drives its position and opacity each frame, exactly as it
    // drove a projected screen position and CSS opacity before -- there is no
    // camera projection left to do.
    function setLabel(mesh, worldPos, opacity) {
        mesh.position.copy(worldPos);
        mesh.material.opacity = opacity;
    }

    function updateLabels(state) {
        const L = world.labels;
        const { phase, local, fieldX, globalFade, frontIndex } = state;

        setLabel(L.slm, labelWorld.slm, 0.9 * globalFade);

        // --- Random phase label -----------------------------------------------
        // Belongs to the `inject` beat, anchored out to the RIGHT where the
        // phase planes come in from.
        if (phase === 'inject') {
            const injectZ = CONFIG.planeWidth * PHASE_APPLIED;
            const injectLabelVis = Math.min(1, local * 5) * clamp01((1 - local) * 4);
            labelWorld.phase.set(
                -world.stackDepth * 0.5,
                CONFIG.planeHeight * 0.62,
                injectZ,
            );
            setLabel(L.phase, labelWorld.phase, injectLabelVis * 0.9 * globalFade);
        } else {
            setLabel(L.phase, labelWorld.phase, 0);
        }

        if (phase === 'march') {
            // Rides just above the kernel cards themselves (same X as the pair
            // in updateFrame, held at the current hop's midpoint; same Z as
            // their shared centre line), clear of the layers it passes. The
            // cards are centred on the layers' own Y=0, so the label floats a
            // margin above that centre rather than above the old top-offset.
            // Cleared against the border's height AT THE TOP OF THE PULSE
            // (see KERNEL_PULSE_MAX in updateFrame's kernel block), not its
            // resting size, plus a further 15% so the label never brushes the
            // border even at peak pulse.
            const kernelSize = CONFIG.planeWidth * KERNEL_SIZE_RATIO;
            const kernelHalfHeightAtPeak = 0.5 * kernelSize * KERNEL_BORDER_RATIO * (1 + KERNEL_PULSE_MAX);
            // frontIndex === local * stepCount during `march` (see the `march`
            // branch of frontIndex above) -- reuse it rather than re-deriving
            // stepCount, which only exists inside createTimeline's closure.
            const stepIndex = Math.min(Math.floor(frontIndex), layerCount - 2);
            labelWorld.crsd.set(
                -(stepIndex + 0.5) * CONFIG.layerGap,
                kernelHalfHeightAtPeak * 1.15,
                0,
            );
            setLabel(L.crsd, labelWorld.crsd, 0.95 * globalFade);
        } else {
            setLabel(L.crsd, labelWorld.crsd, 0);
        }

        const { inAsmHop, asmLocalHop, focalVis } = state;

        // "ASM + Amplitude discard" names the whole hop -- the amplitude
        // discard happens at the SLM as part of this one operation rather than
        // as a separate visual beat -- so the label fades in early in the hop
        // and fades out again toward its end, just as the focal stack starts
        // taking over as the thing to look at.
        const asmLabelVis = inAsmHop
            ? Math.min(1, asmLocalHop * 6) * Math.min(1, (1 - asmLocalHop) * 4)
            : 0;
        setLabel(L.asm, labelWorld.asm, asmLabelVis * globalFade);
        const arrowVis = inAsmHop ? Math.min(1, asmLocalHop * 4) * Math.min(1, (1 - asmLocalHop) * 5) : 0;
        world.asmArrow.userData.lineMaterial.opacity = arrowVis * 0.9 * globalFade;
        world.asmArrow.userData.headMaterial.opacity = arrowVis * 0.9 * globalFade;

        // --- Focal stack + eye labels -----------------------------------------
        setLabel(L.focal, labelWorld.focal, focalVis * 0.95 * globalFade);
        setLabel(L.eye, labelWorld.eye, focalVis * 0.9 * globalFade);
    }

    function renderFrame(elapsed) {
        const state = timeline.apply(elapsed);

        // Ease the framing toward what this beat wants to show. The smoothing
        // is what turns a set of per-phase framings into one continuous camera
        // move; snapping straight to each would read as hard cuts.
        if (state.roi) {
            const [wantMin, wantMax] = state.roi;
            // Jump on the first frame (and when driven out of order by
            // renderAt), ease otherwise.
            // The framing is fixed now, so this lands on the same value every
            // frame. Kept as an assignment rather than hoisted out because
            // resize() reads roiMin/roiMax and must stay in sync with them.
            roiMin = wantMin;
            roiMax = wantMax;
            roiPrimed = true;
            resize();
        }

        updateCamera();

        // Billboard the beam slices. Each quad turns to face the camera, so the
        // stack of slices integrates into a solid-looking shaft from any angle
        // instead of revealing itself as a row of flat cards edge-on.
        world.beam.userData.quads.forEach((q) => q.quaternion.copy(camera.quaternion));

        // Labels are now WebGL objects in world.labels, not HTML overlays, so
        // they must be positioned/faded BEFORE the render call that draws
        // them -- updating them afterward (fine when this only touched CSS)
        // would leave every label one frame stale.
        updateLabels(state);
        renderer.render(world.scene, camera);
        if (progressFill) {
            const through = (elapsed % timeline.total) / timeline.total;
            progressFill.style.width = `${through * 100}%`;
        }
    }

    resize();

    // Debug surface, exposed on the element for use from the browser console.
    // Worth keeping: the pacing and framing will need re-tuning once the real
    // MPI/kernel textures replace the placeholders, and these make that a
    // console exercise rather than an edit-reload loop. Example:
    //   const v = document.querySelector('[data-method-3d]');
    //   v.renderAt(4.2);            // jump to an exact second of the timeline
    //   v.setOrbit(-0.8, 0.3);      // try a different resting camera angle
    // Snap the framing rather than easing: renderAt jumps to an arbitrary point
    // in the timeline, so easing from wherever the camera happened to be would
    // show a framing that belongs to a different beat.
    root.renderAt = (seconds) => {
        roiPrimed = false;
        renderFrame(seconds);
    };
    root.timelineDuration = timeline.total;
    // The camera and the scene graph, for checking where something actually
    // lands on screen rather than inferring it from the render. Projecting a
    // world point is the only reliable way to settle questions about which
    // screen direction a scene axis points in at the current azimuth.
    root.debugScene = () => ({ camera, world, THREE });
    root.setOrbit = (azimuth, elevation) => {
        if (Number.isFinite(azimuth)) orbit.azimuth = azimuth;
        if (Number.isFinite(elevation)) orbit.elevation = elevation;
        resize();
    };

    if (reduceMotion) {
        // A representative frame: mid-march, kernel visible, stack populated.
        // Derived from the phase durations rather than hardcoded, so retiming a
        // beat cannot silently move this to a moment that shows nothing.
        const REPRESENTATIVE_FRAME = config.introTime
            + config.phaseInjectTime + (layerCount - 1) * config.stepTime * 0.55;
        renderFrame(REPRESENTATIVE_FRAME);
        new ResizeObserver(() => {
            resize();
            renderFrame(REPRESENTATIVE_FRAME);
        }).observe(root);
        return;
    }

    let rafId = null;
    let startTime = null;
    let pausedAt = 0;

    function tick(now) {
        if (startTime === null) startTime = now;
        const elapsed = (now - startTime) / 1000 + pausedAt;

        // Gentle drift when the user is not driving the camera, so the 3D-ness
        // is apparent without demanding interaction.
        if (!orbit.dragging) {
            orbit.idle += 1 / 60;
            orbit.azimuth = AZIMUTH_HOME + Math.sin(orbit.idle * 0.16) * AZIMUTH_DRIFT;
        }

        renderFrame(elapsed);
        rafId = requestAnimationFrame(tick);
    }

    function start() {
        if (rafId !== null) return;
        startTime = null;
        rafId = requestAnimationFrame(tick);
    }

    function stop() {
        if (rafId === null) return;
        cancelAnimationFrame(rafId);
        rafId = null;
    }

    // Do not burn GPU on an offscreen canvas.
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                start();
            } else {
                // Remember where the loop was, so scrolling back does not restart it.
                if (startTime !== null && rafId !== null) {
                    pausedAt += (performance.now() - startTime) / 1000;
                }
                stop();
            }
        });
    }, { threshold: 0.05 });
    observer.observe(root);

    // Kick the queued texture fetches (see loadWithFallback/flushAssetQueue)
    // well before the section reaches the viewport, so the real layers have
    // time to arrive before the reader scrolls to them -- a much wider margin
    // than the render loop's own observer above, which intentionally waits
    // until the canvas is actually visible before spending any GPU time.
    // Disconnects itself once fired: nothing more to gate after that.
    const assetObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                flushAssetQueue();
                assetObserver.disconnect();
            }
        });
    }, { rootMargin: '600px 0px' });
    assetObserver.observe(root);

    new ResizeObserver(resize).observe(root);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (startTime !== null && rafId !== null) {
                pausedAt += (performance.now() - startTime) / 1000;
            }
            stop();
        } else if (root.getBoundingClientRect().top < window.innerHeight) {
            start();
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-method-3d]').forEach(initMethod3D);
});
