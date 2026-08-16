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

let speedMap = new Float32Array(0);
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
  for (let i = 0; i < speedMap.length; i++) {
    const brightness = pixels[i * 4] / 255;
    speedMap[i] = 0.05 + (1.0 - brightness) * 0.95;
  }

  imageData = ctx.createImageData(canvas.width, canvas.height);
  data = imageData.data;
}

const COLOURS = [
  [255, 0, 0], // red
  [0, 255, 0], // green
  [0, 0, 255], // blue
];
// const COLOURS = [
//   [0, 255, 255],   // I - cyan
//   [255, 255, 0],   // O - yellow
//   [160, 0, 160],   // T - purple
//   [0, 255, 0],     // S - green
//   [255, 0, 0],     // Z - red
//   [0, 0, 255],     // J - blue
//   [255, 165, 0],   // L - orange
// ];

let lineIndex = 0;

function emitLine() {
  const colour = COLOURS[lineIndex % COLOURS.length];
  lineIndex++;

  const isHorizontal = orientation === 'horizontal';
  const limit = isHorizontal ? canvas.height : canvas.width;

  for (let pos = 0; pos < limit; pos++) {
    const i = spawnParticle();
    if (i === -1) break; // no free slots left, stop early instead of scanning further

    if (isHorizontal) {
      px[i] = 0;
      py[i] = pos;
      vx[i] = 1.2;
      vy[i] = 0;
    } else {
      px[i] = pos;
      py[i] = 0;
      vx[i] = 0;
      vy[i] = 1.2;
    }

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
const EMIT_FRAME = 15
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

let PARTICLE_SIZE = 2; // toggle: 1 = single pixel, 2 = 2x2, 3 = 3x3, etc.

// Only iterates over currently-alive particles instead of all MAX slots.
function render() {
  data.fill(0);

  const w = canvas.width;
  const h = canvas.height;
  const half = PARTICLE_SIZE >> 1;

  for (let n = 0; n < activeCount; n++) {
    const i = activeList[n];
    const ix = px[i] | 0;
    const iy = py[i] | 0;

    if (PARTICLE_SIZE <= 1) {
      // Fast path for the common single-pixel case, skips the nested loop entirely.
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
      const idx = (iy * w + ix) * 4;
      data[idx] = cr[i];
      data[idx + 1] = cg[i];
      data[idx + 2] = cb[i];
      data[idx + 3] = 255;
      continue;
    }

    for (let oy = -half; oy < PARTICLE_SIZE - half; oy++) {
      const y = iy + oy;
      if (y < 0 || y >= h) continue;

      for (let ox = -half; ox < PARTICLE_SIZE - half; ox++) {
        const x = ix + ox;
        if (x < 0 || x >= w) continue;

        const idx = (y * w + x) * 4;
        data[idx] = cr[i];
        data[idx + 1] = cg[i];
        data[idx + 2] = cb[i];
        data[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// Instantly advances the simulation before the user ever sees it, so the
// canvas already looks "complete" on first paint instead of building up
// from blank. Uses a bigger dt per step than a real frame would, so far
// fewer full passes over the particle array are needed to cover the same
// distance — keeps this fast enough to not freeze the page on load.
function fastForward(totalSimulatedFrames) {
  const stepDt = 12; // each fast-forward step covers ~12 real frames' worth of movement
  const steps = Math.ceil(totalSimulatedFrames / stepDt);
  const emitEveryNSteps = Math.max(1, Math.round(EMIT_FRAME / stepDt));

  for (let s = 0; s < steps; s++) {
    if (s % emitEveryNSteps === 0) emitLine();
    updateParticles(stepDt);
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

  if (now - lastEmitTime >= EMIT_INTERVAL) {
    emitLine();
    lastEmitTime = now;
  }

  updateParticles(dt);
  render();
}

const img = new Image();
img.src = "assets/images/removed_me.png";
img.onload = () => {
  buildSpeedMap(img);

  // 1200 simulated frames ≈ 20 seconds of "normal speed" animation,
  // done instantly. Raise this number if the image still looks sparse
  // when the page first loads, lower it if the initial paint feels slow.
  fastForward(2500);

  // starts the live loop only if hero is currently in view and the tab
  // is visible — on a normal page load at the top, both are true
  updateRunning();
};

// No resize listener at all — the canvas never changes size after load.
// The browser window resizing only affects how much of it is visible,
// via the CSS crop in background.css.