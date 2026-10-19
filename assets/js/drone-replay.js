// Replays a recorded drone rollout from drone_run_N.json. Same pattern as
// tetris-replay.js: fetch a recorded run, play it back frame by frame, only
// while the section is actually on screen. All the "intelligence" already
// happened once, offline, in export_drone_rollout.py -- this file contains
// ZERO reinforcement-learning logic, it just draws what got recorded.
//
// Needs THREE + THREE.OrbitControls loaded first (see index.html).

(function () {
  if (typeof THREE === "undefined") return; // three.js failed to load, nothing to do

  const container = document.getElementById("drone-canvas-wrap");
  const covCanvas = document.getElementById("drone-coverage-canvas");
  if (!container || !covCanvas) return; // section not present on this page

  const NUM_RUNS = 3;
  const FRAME_MS = 90;         // time between recorded steps during playback
  const END_PAUSE_MS = 2200;   // pause on the final frame before looping
  const SPRAY_FADE_MS = 260;   // how long a spray burst stays drawn after firing
  function randomRun(excluding) {
    if (NUM_RUNS <= 1) return 1;
    let n;
    do {
      n = Math.floor(Math.random() * NUM_RUNS) + 1;
    } while (n === excluding);
    return n;
  }

  // Same material palette as open3d_sim_env.py's material_colors, so the
  // browser view matches what the Open3D window looks like locally.
  const MATERIAL_COLORS = {
    1: 0x8b6a3e, // topsoil
    2: 0x737373, // rock
    3: 0x59321a, // path
    4: 0x99cc66, // needs-water crop
    5: 0x99404f, // no-water crop
  };

  const statEl = {
    step: document.getElementById("drone-stat-step"),
    coverage: document.getElementById("drone-stat-coverage"),
    reward: document.getElementById("drone-stat-reward"),
    status: document.getElementById("drone-stat-status"),
  };

  // ── three.js scene ─────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  controls.minDistance = 10;
  controls.maxDistance = 90;

  const droneMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xff2d55, emissive: 0x330008 })
  );
  scene.add(droneMesh);

  const sprayGeom = new THREE.BufferGeometry();
  const sprayMat = new THREE.LineBasicMaterial({ color: 0x2dff8a, transparent: true, opacity: 1 });
  const sprayLines = new THREE.LineSegments(sprayGeom, sprayMat);
  scene.add(sprayLines);

  const targetGeom = new THREE.BufferGeometry();
  const targetMat = new THREE.LineBasicMaterial({ color: 0xff1ad9 });
  const targetLine = new THREE.LineSegments(targetGeom, targetMat);
  scene.add(targetLine);

  const MAX_PATH_POINTS = 500;
  const pathPositions = new Float32Array(MAX_PATH_POINTS * 3);
  const pathGeom = new THREE.BufferGeometry();
  pathGeom.setAttribute("position", new THREE.BufferAttribute(pathPositions, 3));
  pathGeom.setDrawRange(0, 0);
  const pathLine = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({ color: 0x2a7bff }));
  scene.add(pathLine);

  // world coord convention: run.voxels store (x, y, z) with z = height.
  // three.js is y-up, so every position in this file maps (x, y, z) -> (x, z, y).
  function toThree(x, y, z, out) {
    out.set(x, z, y);
    return out;
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  // ── coverage heatmap (2D canvas) ────────────────────────────────────────
  // Drawn at native map resolution onto a tiny offscreen canvas, then
  // upscaled (nearest-neighbour, so cells stay crisp blocks) onto the
  // visible, CSS-responsive covCanvas -- putImageData can't target an
  // arbitrary rect directly, so the offscreen canvas is the easiest way
  // to get a blocky heatmap that still resizes cleanly with the page.
  const covCtx = covCanvas.getContext("2d");
  covCtx.imageSmoothingEnabled = false;
  const offCanvas = document.createElement("canvas");
  const offCtx = offCanvas.getContext("2d");
  let covImage = null; // ImageData sized to the run's map_shape
  let needGrid = null; // Float32Array[mapW * mapH], persistent, patched by need_diff

  // Rough viridis-ish stops: dark purple (untouched-but-not-needed) through
  // green to yellow (fully needs spraying) -- avoids importing a colormap
  // library for a 5-stop gradient.
  const STOPS = [
    [0.00, [20, 14, 40]],
    [0.25, [55, 30, 110]],
    [0.55, [33, 130, 120]],
    [0.80, [140, 200, 60]],
    [1.00, [250, 230, 60]],
  ];
  function colorForNeed(v) {
    v = Math.max(0, Math.min(1, v));
    for (let i = 0; i < STOPS.length - 1; i++) {
      const [t0, c0] = STOPS[i];
      const [t1, c1] = STOPS[i + 1];
      if (v >= t0 && v <= t1) {
        const t = (v - t0) / (t1 - t0 || 1);
        return [
          c0[0] + (c1[0] - c0[0]) * t,
          c0[1] + (c1[1] - c0[1]) * t,
          c0[2] + (c1[2] - c0[2]) * t,
        ];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }

  function redrawCoverage(dronePos) {
    if (!covImage || !needGrid || !run) return;
    const [mw, mh] = run.map_shape;
    const data = covImage.data;
    for (let x = 0; x < mw; x++) {
      for (let y = 0; y < mh; y++) {
        const v = needGrid[x * mh + y];
        const [r, g, b] = colorForNeed(v);
        // flip y so it matches the 3D view's orientation (origin='lower' in the
        // original matplotlib panel -> row 0 at the bottom of the canvas)
        const px = x;
        const py = mh - 1 - y;
        const idx = (py * mw + px) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
    offCtx.putImageData(covImage, 0, 0);

    covCtx.clearRect(0, 0, covCanvas.width, covCanvas.height);
    covCtx.drawImage(offCanvas, 0, 0, mw, mh, 0, 0, covCanvas.width, covCanvas.height);

    if (dronePos) {
      const scaleX = covCanvas.width / mw;
      const scaleY = covCanvas.height / mh;
      covCtx.fillStyle = "#ff2d55";
      covCtx.beginPath();
      covCtx.arc((dronePos[0] + 0.5) * scaleX, (mh - dronePos[1] - 0.5) * scaleY, 4, 0, Math.PI * 2);
      covCtx.fill();
    }
  }

  function applyNeedDiff(diff) {
    if (!run) return;
    const mh = run.map_shape[1];
    for (const [x, y, val] of diff) {
      needGrid[x * mh + y] = val;
    }
  }

  // ── data loading + scene build ──────────────────────────────────────────
  let run = null;
  let steps = null;
  let stepIndex = 0;
  let sprayFadeUntil = 0;
  let pathCount = 0;
  let visible = false;
  let timerId = null;
  let ready = false;
  let currentRunNumber = null;
  const terrainMeshes = [];

  function buildTerrain(run) {
    // tear down the previous run's terrain instances before building the
    // new one -- each run can have a different voxel layout entirely.
    for (const mesh of terrainMeshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    terrainMeshes.length = 0;

    const geom = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    const byMaterial = {};
    for (const [x, y, z, mat] of run.voxels) {
      (byMaterial[mat] = byMaterial[mat] || []).push([x, y, z]);
    }
    const tmp = new THREE.Vector3();
    const dummy = new THREE.Object3D();
    for (const matId in byMaterial) {
      const cells = byMaterial[matId];
      const mesh = new THREE.InstancedMesh(
        geom,
        new THREE.MeshStandardMaterial({ color: MATERIAL_COLORS[matId] || 0x999999 }),
        cells.length
      );
      cells.forEach(([x, y, z], i) => {
        toThree(x + 0.5, y + 0.5, z + 0.5, tmp);
        dummy.position.copy(tmp);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      terrainMeshes.push(mesh);
    }

    const [sx, sy, sz] = run.shape;
    const center = new THREE.Vector3(sx / 2, sz / 2, sy / 2);
    controls.target.copy(center);
    camera.position.set(center.x + sx * 0.9, center.y + sz * 1.1, center.z + sy * 0.9);
    camera.lookAt(center);
  }

  function setDronePos(pos) {
    const v = new THREE.Vector3();
    toThree(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5, v);
    droneMesh.position.copy(v);
    return v;
  }

  function drawSpray(dronePosVec, hits) {
    if (!hits || hits.length === 0) {
      sprayGeom.setDrawRange(0, 0);
      return;
    }
    const positions = new Float32Array(hits.length * 6);
    const v = new THREE.Vector3();
    hits.forEach(([x, y, z], i) => {
      toThree(x + 0.5, y + 0.5, z + 0.5, v);
      positions.set([dronePosVec.x, dronePosVec.y, dronePosVec.z, v.x, v.y, v.z], i * 6);
    });
    sprayGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    sprayGeom.setDrawRange(0, hits.length * 2);
    sprayMat.opacity = 1;
    sprayFadeUntil = performance.now() + SPRAY_FADE_MS;
  }

  function drawTarget(dronePosVec, targetXY) {
    if (!targetXY) {
      targetGeom.setDrawRange(0, 0);
      return;
    }
    // Drawn at the drone's own height (matches make_target_lineset in
    // open3d_sim_env.py) -- this is a directional pointer, not a ground hit.
    // target_xy from the export script already carries the +0.5 voxel-center
    // offset (see MapActorNet._target_xy_from_block), unlike spray_hits/pos.
    const tx = targetXY[0];
    const tz = targetXY[1]; // world y (footprint) maps to three.js z
    const positions = new Float32Array([
      dronePosVec.x, dronePosVec.y, dronePosVec.z,
      tx, dronePosVec.y, tz,
    ]);
    targetGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    targetGeom.setDrawRange(0, 2);
  }

  function extendPath(dronePosVec) {
    if (pathCount >= MAX_PATH_POINTS) return;
    pathPositions.set([dronePosVec.x, dronePosVec.y, dronePosVec.z], pathCount * 3);
    pathCount++;
    pathGeom.attributes.position.needsUpdate = true;
    pathGeom.setDrawRange(0, pathCount);
  }

  function resetPlayback() {
    stepIndex = 0;
    pathCount = 0;
    pathGeom.setDrawRange(0, 0);
    sprayGeom.setDrawRange(0, 0);
    targetGeom.setDrawRange(0, 0);
    needGrid.fill(0);
    const startVec = setDronePos(run.start);
    extendPath(startVec);
    applyNeedDiff(steps[0] ? steps[0].need_diff : []);
    redrawCoverage([run.start[0], run.start[1]]);
    updateStats(-1, 0, null);
  }

  let cumReward = 0;
  function updateStats(stepI, reward, status) {
    cumReward += reward || 0;
    if (statEl.step) statEl.step.textContent = stepI < 0 ? "0" : String(stepI + 1);
    if (statEl.reward) statEl.reward.textContent = cumReward.toFixed(1);
    if (statEl.status) statEl.status.textContent = status || "watering";
    if (statEl.coverage && stepI >= 0 && steps[stepI]) {
      const c = steps[stepI].active_completeness;
      statEl.coverage.textContent = c == null ? "100%" : `${Math.round(c * 100)}%`;
    }
  }

  function playStep() {
    if (stepIndex >= steps.length) {
      updateStats(steps.length - 1, 0, steps[steps.length - 1].crashed ? "crashed" : "complete");
      timerId = setTimeout(() => {
        cumReward = 0;
        ready = false; // pause playback while the next run loads
        loadRun(randomRun(currentRunNumber)).then(() => {
          ready = true;
          if (visible) scheduleNext();
        });
      }, END_PAUSE_MS);
      return;
    }
    const s = steps[stepIndex];
    const dronePosVec = setDronePos(s.pos);
    drawSpray(dronePosVec, s.spray_hits);
    drawTarget(dronePosVec, s.target_xy);
    extendPath(dronePosVec);
    applyNeedDiff(s.need_diff);
    redrawCoverage([s.pos[0], s.pos[1]]);
    updateStats(stepIndex, s.reward, s.crashed ? "crashed" : "watering");

    stepIndex++;
    scheduleNext();
  }

  function scheduleNext() {
    clearTimeout(timerId);
    timerId = setTimeout(playStep, FRAME_MS);
  }

  function start() {
    if (!ready || timerId) return;
    scheduleNext();
  }
  function stop() {
    clearTimeout(timerId);
    timerId = null;
  }

  function animate() {
    requestAnimationFrame(animate);
    // fade the spray lines out over SPRAY_FADE_MS instead of popping to invisible
    if (sprayGeom.drawRange.count > 0) {
      const remain = sprayFadeUntil - performance.now();
      sprayMat.opacity = Math.max(0, Math.min(1, remain / SPRAY_FADE_MS));
      if (remain <= 0) sprayGeom.setDrawRange(0, 0);
    }
    controls.update();
    renderer.render(scene, camera);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        visible = entry.isIntersecting;
        if (visible) start(); else stop();
      });
    },
    { threshold: 0.1 }
  );
  observer.observe(container);

  function loadRun(runNumber) {
    currentRunNumber = runNumber;
    return fetch(`assets/data/drone_run_${runNumber}.json`)
      .then((res) => res.json())
      .then((data) => {
        run = data;
        steps = data.steps;
        needGrid = new Float32Array(run.map_shape[0] * run.map_shape[1]);
        offCanvas.width = run.map_shape[0];
        offCanvas.height = run.map_shape[1];
        covImage = offCtx.createImageData(run.map_shape[0], run.map_shape[1]);
        // fixed backing resolution for a crisp heatmap; CSS controls the
        // displayed size responsively (see drone.css), same pattern as
        // tetris-replay.js's resizeCanvas() but this map doesn't need to
        // track element size since it's always square-cell uniform.
        const dpr = window.devicePixelRatio || 1;
        covCanvas.width = 360 * dpr;
        covCanvas.height = 360 * dpr;
        covCtx.imageSmoothingEnabled = false;

        buildTerrain(run);
        resize();
        resetPlayback();
      })
      .catch((err) => console.error("Failed to load drone_run.json:", err));
  }

  loadRun(randomRun()).then(() => {
    ready = true;
    animate();
    if (visible) start();
  });

  resize();
})();