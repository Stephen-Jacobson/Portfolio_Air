// Replays a recorded game from tetris_run.json. This file contains ZERO
// game logic and ZERO machine learning — it fetches an array of frames
// (each one a full board snapshot) and just draws them in sequence. All
// the "intelligence" already happened once, locally, in record_game.py.

(function () {
  const runNumber = Math.floor(Math.random() * 3) + 1;
  const DATA_URL = `assets/data/tetris_run_${runNumber}.json`;
  const FRAME_MS = 110;       // time between recorded frames during playback
  const END_PAUSE_MS = 2000;  // pause on the final frame before looping
  const COLS = 10;
  const ROWS = 24;            // matches Tetris.py's board shape (20 visible + 4 hidden)
  const HIDDEN_ROWS = 4;      // top spawn rows, not shown
  const VISIBLE_ROWS = ROWS - HIDDEN_ROWS;

  // Same mapping as Tetris.py's COLORS dict.
  const COLORS = {
    0: "#14161a", // empty cell
    1: "#00ffff", // I
    2: "#ffff00", // O
    3: "#a000a0", // T
    4: "#00ff00", // S
    5: "#ff0000", // Z
    6: "#0000ff", // J
    7: "#ffa500", // L
  };

  const canvas = document.getElementById("tetris-canvas");
  if (!canvas) return; // section not present on this page, nothing to do
  const ctx = canvas.getContext("2d");

  const scoreEl = document.getElementById("tetris-score");
  const linesEl = document.getElementById("tetris-lines");

  let frames = null;
  let frameIndex = 0;
  let visible = false;
  let timerId = null;

  function cellSize() {
    // Square cells sized to fill the canvas's own CSS box, recomputed on
    // resize rather than hardcoded, so this stays crisp at any layout size.
    return canvas.clientWidth / COLS;
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const size = cellSize();
    canvas.width = Math.round(size * COLS * dpr);
    canvas.height = Math.round(size * VISIBLE_ROWS * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCurrentFrame();
  }

  function drawFrame(frame) {
    const size = cellSize();

    ctx.clearRect(0, 0, COLS * size, VISIBLE_ROWS * size);

    // Faint grid lines for every cell (just the outline, no fill).
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    for (let r = 0; r < VISIBLE_ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        //ctx.strokeRect(c * size + 0.5, r * size + 0.5, size - 1, size - 1);
      }
    }

    // Locked cells — coloured outline only, no fill. Rows [0, HIDDEN_ROWS)
    // are the offscreen spawn buffer and are skipped entirely.
    ctx.lineWidth = 2;
    for (let r = HIDDEN_ROWS; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const val = frame.board[r][c];
        if (val === 0) continue;
        ctx.strokeStyle = COLORS[val] || "#ffffff";
        const y = (r - HIDDEN_ROWS) * size;
        ctx.strokeRect(c * size + 1, y + 1, size - 2, size - 2);
      }
    }

    // Currently-falling piece (not baked into the board array until it locks)
    if (frame.piece && frame.piece.cells) {
      ctx.strokeStyle = COLORS[frame.piece.type] || "#ffffff";
      for (const [r, c] of frame.piece.cells) {
        if (r >= HIDDEN_ROWS && r < ROWS && c >= 0 && c < COLS) {
          const y = (r - HIDDEN_ROWS) * size;
          ctx.strokeRect(c * size + 1, y + 1, size - 2, size - 2);
        }
      }
    }

    if (scoreEl) scoreEl.textContent = frame.points;
    if (linesEl) linesEl.textContent = frame.lines;
  }

  function drawCurrentFrame() {
    if (frames && frames.length) drawFrame(frames[frameIndex]);
  }

  function tick() {
    if (!visible || !frames) return;
    frameIndex++;
    if (frameIndex >= frames.length) {
      frameIndex = frames.length - 1;
      drawCurrentFrame();
      timerId = setTimeout(() => {
        frameIndex = 0;
        drawCurrentFrame();
        scheduleNext();
      }, END_PAUSE_MS);
      return;
    }
    drawCurrentFrame();
    scheduleNext();
  }

  function scheduleNext() {
    clearTimeout(timerId);
    timerId = setTimeout(tick, FRAME_MS);
  }

  function start() {
    if (!frames || timerId) return;
    scheduleNext();
  }

  function stop() {
    clearTimeout(timerId);
    timerId = null;
  }

  // Only play while the demo is actually on screen — same pattern as the
  // hero background animation, no point spending CPU on an offscreen replay.
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        visible = entry.isIntersecting;
        if (visible) start();
        else stop();
      });
    },
    { threshold: 0 }
  );
  observer.observe(canvas);

  window.addEventListener("resize", resizeCanvas);

  fetch(DATA_URL)
    .then((res) => res.json())
    .then((data) => {
      frames = data;
      resizeCanvas();
      if (visible) start();
    })
    .catch((err) => console.error("Failed to load tetris_run.json:", err));
})();