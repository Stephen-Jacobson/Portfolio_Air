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

  let row = 0;
  for (let i = 0; i < MAX && row < canvas.height; i++) {
    if (age[i] === 0) {
      px[i] = 0;
      py[i] = row;
      vx[i] = 1.2;
      vy[i] = 0;
      age[i] = 1;

      cr[i] = colour[0];
      cg[i] = colour[1];
      cb[i] = colour[2];
      row++;
    }
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
  let spawned = 0;
  for (let i = 0; i < MAX && spawned < numParticles; i++) {
    if (age[i] === 0) {
      const angle = (spawned / numParticles) * Math.PI * 2;
      px[i] = mouseX + Math.cos(angle) * radius;
      py[i] = mouseY + Math.sin(angle) * radius;
      vx[i] = Math.cos(angle) * 2.0;
      vy[i] = Math.sin(angle) * 2.0;
      age[i] = 1;
      spawned++;
    }
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

function updateParticles(dt) {
  for (let i = 0; i < MAX; i++) {
    if (age[i] === 0) continue;
    let speed = speedMap[Math.floor(py[i]) * canvas.width + Math.floor(px[i])];
    px[i] += vx[i] * speed * dt;
    py[i] += vy[i] * speed * dt;

    age[i]++;

    if (
      age[i] > 200000 ||
      px[i] > canvas.width ||
      px[i] < 0 ||
      py[i] > canvas.height ||
      py[i] < 0
    ) {
      age[i] = 0;
    }
  }
}

function render() {
  data.fill(0);

  for (let i = 0; i < MAX; i++) {
    if (age[i] === 0) continue;
    const ix = Math.floor(px[i]);
    const iy = Math.floor(py[i]);
    const idx = (iy * canvas.width + ix) * 4;
    data[idx] = cr[i];
    data[idx + 1] = cg[i];
    data[idx + 2] = cb[i];
    data[idx + 3] = 255;
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