const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

let USE_DELTA_TIME = true;

const MAX = 400000;
const px = new Float32Array(MAX);
const py = new Float32Array(MAX);
const vx = new Float32Array(MAX);
const vy = new Float32Array(MAX);
const age = new Float32Array(MAX);

const cr = new Uint8Array(MAX); // red 0-255
const cg = new Uint8Array(MAX); // green 0-255
const cb = new Uint8Array(MAX); // blue 0-255

const LINE_PER_FRAME = 15;

let speedMap = new Float32Array(0);
// 1 where the speed-map image is NOT black (the face), 0 where it is black.
let faceMask = new Uint8Array(0);
let imageData;
let data;

let orientation = 'vertical';     // toggle: 'horizontal' or 'vertical'

// --- Active-particle tracking -------------------------------------------
// Instead of scanning all MAX slots every frame and checking age[i] === 0,
// we keep a packed list of just the currently-alive particle indices
// (activeList[0..activeCount)). updateParticles() and render() then only
// ever touch exactly as many slots as are actually alive, instead of
// always doing MAX work regardless of how empty the screen is.
//
// freeList is a stack of currently-unused slot indices, so spawning a
// particle is an O(1) pop instead of a linear scan for the next age===0
// slot (which is what the old emitLine/emitCircle did).
const activeList = new Int32Array(MAX);
let activeCount = 0;
const slotOf = new Int32Array(MAX).fill(-1); // slotOf[i] = position of particle i within activeList, or -1 if dead

const freeList = new Int32Array(MAX);
let freeCount = MAX;
for (let i = 0; i < MAX; i++) freeList[i] = MAX - 1 - i; // order doesn't matter, just needs to cover 0..MAX-1

// Allocates a slot for a new particle. Returns its index, or -1 if every
// slot is currently in use (caller should just stop spawning early).
function spawnParticle() {
  if (freeCount === 0) return -1;
  const i = freeList[--freeCount];
  slotOf[i] = activeCount;
  activeList[activeCount] = i;
  activeCount++;
  age[i] = 1;
  return i;
}

// Frees slot i. Uses swap-removal so this is O(1) instead of shifting the
// whole array down.
function killParticle(i) {
  const slot = slotOf[i];
  if (slot === -1) return; // already dead
  const lastActiveIndex = activeList[activeCount - 1];
  activeList[slot] = lastActiveIndex;
  slotOf[lastActiveIndex] = slot;
  activeCount--;
  slotOf[i] = -1;
  age[i] = 0;
  freeList[freeCount++] = i;
}

// --- Letter mask ----------------------------------------------------------
// A 1-byte-per-pixel array, same width/height as the canvas, marking which
// canvas pixels fall inside the hero title's letter shapes (1) vs outside
// (0). render() uses this to decide whether a particle shows its real
// assigned colour (inside a letter) or the OUTSIDE_COLOUR (everywhere else).
//
// This has to be built in CANVAS pixel space, not DOM/CSS space, since the
// particle simulation only knows about px/py canvas coordinates. We get
// there by comparing the on-screen bounding boxes of the canvas element and
// the title element (both from getBoundingClientRect, so both are in the
// same viewport-relative coordinate space) and drawing the text at the
// equivalent offset into an offscreen canvas matching the main canvas's
// pixel grid 1:1.
let textMask = new Uint8Array(0);

function buildTextMask() {
  const title = document.querySelector('.hero-title');
  if (!title || !canvas.width || !canvas.height) return;

  const canvasRect = canvas.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  const style = getComputedStyle(title);

  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const octx = off.getContext('2d');

  octx.fillStyle = '#fff';
  octx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  octx.textBaseline = 'middle';
  octx.textAlign = 'center';

  // titleRect.top is scroll-dependent (it shrinks/goes negative as you
  // scroll down), but canvasRect.top is NOT — the canvas is position:
  // fixed, so it never moves regardless of scroll. If buildTextMask() runs
  // while the page is scrolled away from the hero (e.g. a reload that
  // restores scroll position below the fold), using titleRect.top directly
  // bakes in the wrong offset — the mask ends up placed wherever the title
  // happened to be on screen at that scroll position, not where it sits
  // relative to the canvas when the hero is actually in view.
  //
  // Normalize by adding window.scrollY back, which converts the current
  // viewport-relative top into the same "as if scrollY were 0" position
  // that canvasRect.top is already expressed in.
  const normalizedTitleTop = titleRect.top + window.scrollY;

  // Title's center point, translated from viewport space into the canvas's
  // own pixel space by subtracting the canvas's viewport offset.
  const textX = titleRect.left + titleRect.width / 2 - canvasRect.left;
  const textY = normalizedTitleTop + titleRect.height / 2 - canvasRect.top;
  octx.fillText(title.textContent.trim(), textX, textY);

  const maskPixels = octx.getImageData(0, 0, off.width, off.height).data;

  textMask = new Uint8Array(canvas.width * canvas.height);
  for (let p = 0; p < textMask.length; p++) {
    textMask[p] = maskPixels[p * 4 + 3] > 0 ? 1 : 0; // alpha channel marks drawn text
  }
}

// --- Keep the name inside the face --------------------------------------
// The CSS font-size for .hero-title scales with viewport width (vw), but
// the face image is a FIXED pixel size that only gets cropped on resize,
// never scaled. Those two don't track each other, so at wide viewports the
// name can render wider than the face itself and spill onto the plain
// background on either side.
//
// This measures how wide the face actually is at the row the title sits
// on, then shrinks/grows the title's font-size (overriding the CSS clamp
// via an inline style, which always wins) so the rendered text width stays
// a fixed fraction of that face width — regardless of viewport size.
const TITLE_FACE_WIDTH_FRACTION = 1; // use ~82% of the face's width, leaving a margin
const TITLE_MIN_FONT_PX = 14;
const TITLE_MAX_FONT_PX = 170;

// Scans one canvas row and returns the leftmost/rightmost face-mask pixel.
function getFaceRowSpan(y) {
  const w = canvas.width;
  if (y < 0 || y >= canvas.height || !faceMask.length) return null;
  let minX = -1, maxX = -1;
  const rowStart = y * w;
  for (let x = 0; x < w; x++) {
    if (faceMask[rowStart + x] === 1) {
      if (minX === -1) minX = x;
      maxX = x;
    }
  }
  return minX === -1 ? null : { minX, maxX };
}

// Narrowest face width across the vertical band the title occupies — using
// the narrowest row (rather than just the center row) guarantees the text
// fits the face at every row it actually covers, not just its midline.
function getFaceWidthForBand(centerY, halfHeight) {
  const top = Math.max(0, Math.round(centerY - halfHeight));
  const bottom = Math.min(canvas.height - 1, Math.round(centerY + halfHeight));
  let minSpan = Infinity;
  let found = false;
  for (let y = top; y <= bottom; y += 2) { // step by 2: plenty of precision, half the scanning
    const span = getFaceRowSpan(y);
    if (span) {
      found = true;
      const width = span.maxX - span.minX;
      if (width < minSpan) minSpan = width;
    }
  }
  return found ? minSpan : canvas.width;
}

function fitTitleFontSize() {
  const title = document.querySelector('.hero-title');
  if (!title || !canvas.width || !canvas.height || !faceMask.length) return;

  const text = title.textContent.trim();
  if (!text) return;

  const style = getComputedStyle(title);
  const fontFamily = style.fontFamily;
  const fontWeight = style.fontWeight;

  // Same "as if scrollY were 0" normalization buildTextMask() uses, so this
  // lines up with where the mask actually gets drawn.
  const canvasRect = canvas.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  const normalizedTitleTop = titleRect.top + window.scrollY;
  const centerYInCanvas = (normalizedTitleTop + titleRect.height / 2) - canvasRect.top;

  const measureCtx = document.createElement('canvas').getContext('2d');
  const REF = 100; // measure at a fixed reference size, then scale proportionally
  measureCtx.font = `${fontWeight} ${REF}px ${fontFamily}`;
  const refWidth = measureCtx.measureText(text).width;
  if (!refWidth) return;

  // A couple of passes since the row-band we check shifts slightly as the
  // font-size (and therefore the title's own height) changes.
  let fontSize = parseFloat(style.fontSize) || REF;
  for (let i = 0; i < 3; i++) {
    const halfHeight = fontSize * 0.45;
    const faceWidth = getFaceWidthForBand(centerYInCanvas, halfHeight);
    const targetWidth = faceWidth * TITLE_FACE_WIDTH_FRACTION;
    fontSize = (targetWidth / refWidth) * REF;
    fontSize = Math.max(TITLE_MIN_FONT_PX, Math.min(TITLE_MAX_FONT_PX, fontSize));
  }

  title.style.fontSize = fontSize + 'px';
}

function syncTitleToFace() {
  fitTitleFontSize(); // shrink/grow the font first...
  buildTextMask();    // ...then rebuild the mask at that final size/position
}

// Rebuild whenever layout could have shifted the title's position/size
// relative to the canvas (e.g. the window being resized).
window.addEventListener('resize', syncTitleToFace);

// Runs ONCE, when the image loads. Canvas is sized to match the image
// exactly, and this size is never changed again — no resize listener
// touches canvas.width/height. Centering as the browser window changes
// size is handled entirely by CSS (see background.css) via an
// overflow:hidden container that crops the fixed-size canvas.
function buildSpeedMap(img) {
  canvas.width = img.width;
  canvas.height = img.height;

  const offscreen = document.createElement("canvas");
  offscreen.width = canvas.width;
  offscreen.height = canvas.height;
  const offCtx = offscreen.getContext("2d");
  offCtx.drawImage(img, 0, 0);
  const pixels = offCtx.getImageData(0, 0, canvas.width, canvas.height).data;

  speedMap = new Float32Array(canvas.width * canvas.height);
  faceMask = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < speedMap.length; i++) {
    const brightness = pixels[i * 4] / 255;
    speedMap[i] = 0.20 + (1.0 - brightness) * 0.80;
    faceMask[i] = pixels[i * 4] > BLACK_THRESHOLD ? 1 : 0;
  }

  imageData = ctx.createImageData(canvas.width, canvas.height);
  data = imageData.data;
}


// =========================================================================
//  PARTICLE STYLE — the main switch
// =========================================================================
//  'both'   : TWO simulations run at once, each visible only in its own area,
//             decided by the speed-map image (removed_me.png):
//               - pure BLACK parts of the image  -> falling Tetris blocks
//               - everything else (your face)    -> small line-particles in
//                                                   the Tetris colours
//  'tetris' : only the Tetris blocks, shown everywhere.
//  'lines'  : only the line-particles, shown everywhere.
//
//  Both simulations use the same speed map, so the particles still slow
//  down and build up your face.
//
//  You can also change these live from the browser console, e.g.
//    setParticleStyle('lines')
//    setTetrisBlockSize(10)
//    setNameColour(255, 255, 255)    // or setNameColour(null) to turn it off
let PARTICLE_STYLE = 'both';

// --- Name colour -----------------------------------------------------------
// Anything (blocks OR particles) that is over the title letters is drawn in
// this single colour: [red, green, blue], each 0-255. Set to null to let
// them keep their own Tetris colours inside the letters instead.
let NAME_COLOUR = [255, 255, 255];

// --- Which parts of the image count as "black" (block area) ---------------
// A pixel of removed_me.png is "black" when its brightness is <= this value
// (0 = pure black only, 255 = everything). Raise it a little (e.g. 10-30)
// if you see stray blocks creeping onto the soft edge of the face.
let BLACK_THRESHOLD = 0.2;

// --- Face particle options (the non-black area) ---------------------------
let PARTICLE_COLOUR_PER = 'line';   // 'line': each emitted line is one Tetris colour (cycling). 'particle': random colour per particle
let PARTICLE_OUTSIDE_COLOURED = true; // true: Tetris colours outside the name. false: use OUTSIDE_COLOUR
let PARTICLE_OUTSIDE_BRIGHTNESS = 0.5; // 0-1, brightness of those particles outside the name

// --- Tetris options (only used when PARTICLE_STYLE === 'tetris') ----------
let TETRIS_BLOCK_SIZE = 24;          // size of ONE square of a tetromino, in canvas pixels
let TETRIS_SPAWN_DENSITY = 0.04;       // 1 = default, 2 = twice as many blocks, 0.5 = half
let TETRIS_FALL_SPEED = 1;        // base fall speed (same units as the old vy = 1.4)
let TETRIS_SNAP_TO_GRID = true;     // true: blocks snap to a grid (retro stepped look). false: smooth
let TETRIS_CELL_BORDER = true;      // darker edge on each square so the 4 cells of a piece read clearly
let TETRIS_OUTSIDE_COLOURED = true; // true: blocks outside the name keep their Tetris colour (dimmed). false: use OUTSIDE_COLOUR
let TETRIS_OUTSIDE_BRIGHTNESS = 0.35; // 0-1, how bright blocks are outside the title letters
const TETRIS_MAX_PIECES = 120000;

// Same colours as tetris-replay.js (index = piece type).
const TETRIS_COLOURS = [
  [0, 255, 255],   // I - cyan
  [255, 255, 0],   // O - yellow
  [160, 0, 160],   // T - purple
  [0, 255, 0],     // S - green
  [255, 0, 0],     // Z - red
  [0, 0, 255],     // J - blue
  [255, 165, 0],   // L - orange
];

// Each shape is a list of 4 [col, row] cells.
const TETRIS_SHAPES = [
  [[0, 0], [1, 0], [2, 0], [3, 0]], // I
  [[0, 0], [1, 0], [0, 1], [1, 1]], // O
  [[1, 0], [0, 1], [1, 1], [2, 1]], // T
  [[1, 0], [2, 0], [0, 1], [1, 1]], // S
  [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
  [[0, 0], [0, 1], [1, 1], [2, 1]], // J
  [[2, 0], [0, 1], [1, 1], [2, 1]], // L
];

// --- Piece pool (same swap-removal idea as the particle pool) -------------
const tx = new Float32Array(TETRIS_MAX_PIECES);   // top-left of the piece's bounding box
const ty = new Float32Array(TETRIS_MAX_PIECES);
const tType = new Uint8Array(TETRIS_MAX_PIECES);
const tCells = new Int8Array(TETRIS_MAX_PIECES * 8); // 4 cells * (col,row), already rotated
const tW = new Uint8Array(TETRIS_MAX_PIECES);     // bounding box in cells
const tH = new Uint8Array(TETRIS_MAX_PIECES);
const tSize = new Uint8Array(TETRIS_MAX_PIECES);  // block size this piece was spawned with
const tFall = new Float32Array(TETRIS_MAX_PIECES);// per-piece speed multiplier (the "random" feel)
const tActive = new Int32Array(TETRIS_MAX_PIECES);
let tCount = 0;
let spawnAccumulator = 0;

function spawnTetromino(yJitter) {
  if (tCount >= TETRIS_MAX_PIECES) return;
  const i = tCount++;
  tActive[i] = i; // pieces are stored densely, slot == index

  const type = (Math.random() * 7) | 0;
  const rot = (Math.random() * 4) | 0;
  let cells = TETRIS_SHAPES[type].map(c => [c[0], c[1]]);
  for (let r = 0; r < rot; r++) cells = cells.map(c => [-c[1], c[0]]); // rotate 90°
  const minC = Math.min(...cells.map(c => c[0]));
  const minR = Math.min(...cells.map(c => c[1]));
  let w = 0, h = 0;
  for (let k = 0; k < 4; k++) {
    const c = cells[k][0] - minC, r = cells[k][1] - minR;
    tCells[i * 8 + k * 2] = c;
    tCells[i * 8 + k * 2 + 1] = r;
    if (c + 1 > w) w = c + 1;
    if (r + 1 > h) h = r + 1;
  }

  const size = Math.max(1, TETRIS_BLOCK_SIZE | 0);
  tType[i] = type;
  tW[i] = w;
  tH[i] = h;
  tSize[i] = size;
  tFall[i] = 0.7 + Math.random() * 0.6; // 0.7x - 1.3x speed

  let x = Math.random() * (canvas.width - w * size);
  if (TETRIS_SNAP_TO_GRID) x = Math.round(x / size) * size;
  tx[i] = x;
  ty[i] = -h * size + yJitter;
}

function updateTetrominoes(dt) {
  const w = canvas.width;
  const h = canvas.height;
  for (let i = 0; i < tCount; i++) {
    const size = tSize[i];
    // Speed is sampled at the piece's centre so the whole piece moves rigidly.
    const cx = Math.min(w - 1, Math.max(0, (tx[i] + tW[i] * size / 2) | 0));
    const cy = Math.min(h - 1, Math.max(0, (ty[i] + tH[i] * size / 2) | 0));
    const speed = speedMap[cy * w + cx];
    ty[i] += TETRIS_FALL_SPEED * tFall[i] * speed * dt;

    if (ty[i] > h) {
      // swap-remove: move the last piece into slot i
      const last = --tCount;
      if (i !== last) {
        tx[i] = tx[last]; ty[i] = ty[last]; tType[i] = tType[last];
        tW[i] = tW[last]; tH[i] = tH[last]; tSize[i] = tSize[last]; tFall[i] = tFall[last];
        for (let k = 0; k < 8; k++) tCells[i * 8 + k] = tCells[last * 8 + k];
      }
      i--; // recheck the piece that was swapped in
    }
  }
}

// Spawns pieces at random times/positions. Called every frame with that
// frame's dt; fractional spawns are carried over in spawnAccumulator.
function emitTetrominoes(dt) {
  const size = Math.max(1, TETRIS_BLOCK_SIZE | 0);
  const perFrame = TETRIS_SPAWN_DENSITY * canvas.width / (size * 2 * LINE_PER_FRAME);
  spawnAccumulator += perFrame * dt;
  const fallPerStep = TETRIS_FALL_SPEED * dt;
  while (spawnAccumulator >= 1) {
    spawnAccumulator -= 1;
    spawnTetromino(Math.random() * fallPerStep); // jitter so pieces don't spawn in a visible row
  }
}

function renderTetrominoes() {
  const w = canvas.width;
  const h = canvas.height;
  const hasMask = textMask.length === w * h;
  // In 'both' mode blocks only show in the black part of the speed map.
  const clipToBlack = PARTICLE_STYLE === 'both' && faceMask.length === w * h;

  for (let i = 0; i < tCount; i++) {
    const size = tSize[i];
    const base = TETRIS_COLOURS[tType[i]];
    const ox = tx[i];
    let oy = ty[i];
    if (TETRIS_SNAP_TO_GRID) oy = Math.round(oy / size) * size;

    for (let k = 0; k < 4; k++) {
      const x0 = (ox + tCells[i * 8 + k * 2] * size) | 0;
      const y0 = (oy + tCells[i * 8 + k * 2 + 1] * size) | 0;
      const cxp = x0 + (size >> 1);
      const cyp = y0 + (size >> 1);
      if (x0 >= w || y0 >= h || x0 + size <= 0 || y0 + size <= 0) continue;

      let inside = false;
      if (hasMask && cxp >= 0 && cxp < w && cyp >= 0 && cyp < h) {
        inside = textMask[cyp * w + cxp] === 1;
      }

      let r, g, b;
      if (inside) {
        if (NAME_COLOUR) { r = NAME_COLOUR[0]; g = NAME_COLOUR[1]; b = NAME_COLOUR[2]; }
        else { r = base[0]; g = base[1]; b = base[2]; }
      } else if (TETRIS_OUTSIDE_COLOURED) {
        r = base[0] * TETRIS_OUTSIDE_BRIGHTNESS;
        g = base[1] * TETRIS_OUTSIDE_BRIGHTNESS;
        b = base[2] * TETRIS_OUTSIDE_BRIGHTNESS;
      } else {
        r = OUTSIDE_COLOUR[0]; g = OUTSIDE_COLOUR[1]; b = OUTSIDE_COLOUR[2];
      }

      const useBorder = TETRIS_CELL_BORDER && size >= 4;
      const br = r * 0.55, bg = g * 0.55, bb = b * 0.55;

      for (let yy = 0; yy < size; yy++) {
        const y = y0 + yy;
        if (y < 0 || y >= h) continue;
        for (let xx = 0; xx < size; xx++) {
          const x = x0 + xx;
          if (x < 0 || x >= w) continue;
          const p = y * w + x;
          if (clipToBlack && faceMask[p] === 1) continue; // face area belongs to the particles
          const edge = useBorder && (xx === size - 1 || yy === size - 1);
          const idx = p * 4;
          data[idx] = edge ? br : r;
          data[idx + 1] = edge ? bg : g;
          data[idx + 2] = edge ? bb : b;
          data[idx + 3] = 255;
        }
      }
    }
  }
}

// --- Runtime switches (callable from the console) --------------------------
function clearAllParticles() {
  while (activeCount > 0) killParticle(activeList[activeCount - 1]);
  tCount = 0;
  spawnAccumulator = 0;
}

function restartAnimation() {
  clearAllParticles();
  if (speedMap.length) fastForward(1500);
}

function setParticleStyle(style) {
  PARTICLE_STYLE = (style === 'lines' || style === 'tetris') ? style : 'both';
  restartAnimation();
}

function setNameColour(r, g, b) {
  NAME_COLOUR = (r === null || r === undefined) ? null : [r, g, b];
}
window.setNameColour = setNameColour;

function usesLines() { return PARTICLE_STYLE !== 'tetris'; }
function usesTetris() { return PARTICLE_STYLE !== 'lines'; }

function setTetrisBlockSize(px) {
  TETRIS_BLOCK_SIZE = Math.max(1, px | 0);
  restartAnimation();
}
window.setParticleStyle = setParticleStyle;
window.setTetrisBlockSize = setTetrisBlockSize;

let lineIndex = 0;

function emitLine() {
  const lineColour = TETRIS_COLOURS[lineIndex % TETRIS_COLOURS.length];
  lineIndex++;
  const perParticle = PARTICLE_COLOUR_PER === 'particle';

  const isHorizontal = orientation === 'horizontal';
  const limit = isHorizontal ? canvas.height : canvas.width;

  for (let pos = 0; pos < limit; pos++) {
    const i = spawnParticle();
    if (i === -1) break; // no free slots left, stop early instead of scanning further

    if (isHorizontal) {
      px[i] = 0;
      py[i] = pos;
      vx[i] = 2;
      vy[i] = 0;
    } else {
      px[i] = pos;
      py[i] = 0;
      vx[i] = 0;
      vy[i] = 1.4;
    }

    const colour = perParticle
      ? TETRIS_COLOURS[(Math.random() * TETRIS_COLOURS.length) | 0]
      : lineColour;
    cr[i] = colour[0];
    cg[i] = colour[1];
    cb[i] = colour[2];
  }
}

let mouseX = 0;
let mouseY = 0;
let mouseDown = false;
let emitting = false;

canvas.addEventListener("click", (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  emitting = !emitting; // toggle on/off
});

function emitCircle() {
  const numParticles = 500;
  const radius = 10;

  for (let spawned = 0; spawned < numParticles; spawned++) {
    const i = spawnParticle();
    if (i === -1) break; // no free slots left

    const angle = (spawned / numParticles) * Math.PI * 2;
    px[i] = mouseX + Math.cos(angle) * radius;
    py[i] = mouseY + Math.sin(angle) * radius;
    vx[i] = Math.cos(angle) * 2.0;
    vy[i] = Math.sin(angle) * 2.0;
  }
}

let frameCount = 0;

let lastTime = performance.now();
let lastEmitTime = performance.now();
const EMIT_FRAME = LINE_PER_FRAME
const EMIT_INTERVAL = EMIT_FRAME * 16.67;

// The animation only runs while BOTH of these are true:
//  - the browser tab is actually visible (tabVisible)
//  - the #hero section is on screen (heroVisible) — once you scroll past
//    it into the black filler content, there's no reason to keep spending
//    CPU animating something no longer being looked at
let tabVisible = !document.hidden;
let heroVisible = true;
let running = false;

function updateRunning() {
  const shouldRun = tabVisible && heroVisible;
  if (shouldRun && !running) {
    running = true;
    lastTime = performance.now();
    lastEmitTime = performance.now();
    requestAnimationFrame(loop);
  } else if (!shouldRun) {
    running = false;
  }
}

document.addEventListener("visibilitychange", () => {
  tabVisible = !document.hidden;
  updateRunning();
});

const heroEl = document.getElementById("hero");
if (heroEl) {
  const heroObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        heroVisible = entry.isIntersecting;
        if (heroVisible) syncTitleToFace(); // re-sync font size + mask position in case layout shifted while scrolled away
        updateRunning();
      });
    },
    { threshold: 0 }
  );
  heroObserver.observe(heroEl);
}

// Only iterates over currently-alive particles (activeCount of them)
// instead of always scanning all MAX slots.
function updateParticles(dt) {
  const w = canvas.width;
  const h = canvas.height;

  for (let n = 0; n < activeCount; n++) {
    const i = activeList[n];

    const speed = speedMap[(py[i] | 0) * w + (px[i] | 0)];
    px[i] += vx[i] * speed * dt;
    py[i] += vy[i] * speed * dt;

    age[i]++;

    if (
      age[i] > 200000 ||
      px[i] > w ||
      px[i] < 0 ||
      py[i] > h ||
      py[i] < 0
    ) {
      killParticle(i);
      n--; // swap-removal moved a different particle into slot n, recheck it next iteration
    }
  }
}

let INSIDE_PARTICLE_SIZE = 4;  // size of particles while inside a letter: 1 = single pixel, 2 = 2x2, etc.
let OUTSIDE_PARTICLE_SIZE = 2; // size of particles everywhere else
const OUTSIDE_COLOUR = [49, 46, 86]; // colour particles show outside the letters — change this

// Only iterates over currently-alive particles instead of all MAX slots.
// Each particle's CENTER pixel is checked against textMask once: if it's
// inside a letter, the particle is drawn at INSIDE_PARTICLE_SIZE using its
// real assigned colour; otherwise it's drawn at OUTSIDE_PARTICLE_SIZE using
// OUTSIDE_COLOUR. (The size decision is made once per particle from its
// center, not re-checked per pixel of its block — so a large "inside"
// particle can visually bleed slightly past the exact letter edge, same as
// a paintbrush stamped at that point.)
function render() {
  data.fill(0);

  const w = canvas.width;
  const h = canvas.height;
  const hasMask = textMask.length === w * h;
  // In 'both' mode the line-particles only show on the face (non-black) area.
  const clipToFace = PARTICLE_STYLE === 'both' && faceMask.length === w * h;

  for (let n = 0; n < activeCount; n++) {
    const i = activeList[n];
    const ix = px[i] | 0;
    const iy = py[i] | 0;

    if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;

    const isInside = hasMask && textMask[iy * w + ix] === 1;
    const size = isInside ? INSIDE_PARTICLE_SIZE : OUTSIDE_PARTICLE_SIZE;

    let r, g, b;
    if (isInside) {
      if (NAME_COLOUR) { r = NAME_COLOUR[0]; g = NAME_COLOUR[1]; b = NAME_COLOUR[2]; }
      else { r = cr[i]; g = cg[i]; b = cb[i]; }
    } else if (PARTICLE_OUTSIDE_COLOURED) {
      r = cr[i] * PARTICLE_OUTSIDE_BRIGHTNESS;
      g = cg[i] * PARTICLE_OUTSIDE_BRIGHTNESS;
      b = cb[i] * PARTICLE_OUTSIDE_BRIGHTNESS;
    } else {
      r = OUTSIDE_COLOUR[0]; g = OUTSIDE_COLOUR[1]; b = OUTSIDE_COLOUR[2];
    }

    const half = size >> 1;
    for (let oy = -half; oy < Math.max(size, 1) - half; oy++) {
      const y = iy + oy;
      if (y < 0 || y >= h) continue;

      for (let ox = -half; ox < Math.max(size, 1) - half; ox++) {
        const x = ix + ox;
        if (x < 0 || x >= w) continue;

        const p = y * w + x;
        if (clipToFace && faceMask[p] === 0) continue; // black area belongs to the Tetris blocks

        const idx = p * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
  }

  if (usesTetris()) renderTetrominoes();

  ctx.putImageData(imageData, 0, 0);
}

// Instantly advances the simulation before the user ever sees it, so the
// canvas already looks "complete" on first paint instead of building up
// from blank. Uses a bigger dt per step than a real frame would, so far
// fewer full passes over the particle array are needed to cover the same
// distance — keeps this fast enough to not freeze the page on load.
function fastForward(totalSimulatedFrames) {
  const stepDt = LINE_PER_FRAME; // each fast-forward step covers ~12 real frames' worth of movement
  const steps = Math.ceil(totalSimulatedFrames / stepDt);
  const emitEveryNSteps = Math.max(1, Math.round(EMIT_FRAME / stepDt));

  for (let s = 0; s < steps; s++) {
    if (usesTetris()) {
      emitTetrominoes(stepDt);
      updateTetrominoes(stepDt);
    }
    if (usesLines()) {
      if (s % emitEveryNSteps === 0) emitLine();
      updateParticles(stepDt);
    }
  }

  render();
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);

  let dt = 1;
  const now = performance.now();

  if (USE_DELTA_TIME) {
    dt = (now - lastTime) / 16.67;
    dt = Math.min(dt, 3);
    lastTime = now;
  }

  if (usesTetris()) {
    emitTetrominoes(dt);
    updateTetrominoes(dt);
  }
  if (usesLines()) {
    if (now - lastEmitTime >= EMIT_INTERVAL) {
      emitLine();
      lastEmitTime = now;
    }
    updateParticles(dt);
  }
  render();
}

const img = new Image();
img.src = "assets/images/removed_me.png";
img.onload = () => {
  buildSpeedMap(img);

  // Build the letter mask once fonts are ready and the canvas has its
  // final pixel dimensions, so the fillText() call above uses the exact
  // font that's actually rendering on screen.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncTitleToFace);
  } else {
    syncTitleToFace();
  }

  // 1200 simulated frames ≈ 20 seconds of "normal speed" animation,
  // done instantly. Raise this number if the image still looks sparse
  // when the page first loads, lower it if the initial paint feels slow.
  fastForward(1500);

  // starts the live loop only if hero is currently in view and the tab
  // is visible — on a normal page load at the top, both are true
  updateRunning();
};

// No resize listener at all — the canvas never changes size after load.
// The browser window resizing only affects how much of it is visible,
// via the CSS crop in background.css.