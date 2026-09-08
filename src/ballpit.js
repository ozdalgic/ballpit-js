/**
 * ballpit-js — an interactive pit of spheres for hero sections.
 *
 * Balls rain into the container, settle into a physical pile, and get shoved
 * around by the pointer. Verlet integration with positional relaxation, a
 * uniform-grid broadphase, and an orthographic camera so every sphere reads
 * the same wherever it sits.
 *
 * Requires three.js as a peer dependency (r150+ for `outputColorSpace`).
 *
 * @license MIT
 */

import * as THREE from 'three';

const DEFAULTS = {
  /** How many balls. The auto-quality pass may lower this on slow devices. */
  count: 180,
  /** Ball diameters in CSS pixels. Re-derived whenever the container resizes. */
  minSize: 25,
  maxSize: 60,
  /** Downward acceleration, world units/s². Higher = heavier, snappier drops. */
  gravity: 11,
  /** Sideways acceleration. Negative drifts the pile left, positive right. */
  drift: 0,
  /** Sphere colours, cycled across the balls. */
  palette: ['#eaf1ff', '#2957ff', '#00509f'],
  /**
   * Fresnel makes a dielectric's rim mirror the environment, which reads as a
   * white outline drawn around every sphere. These three damp it. Raise them
   * together for wetter, more mirror-like balls.
   */
  envIntensity: 0.45,
  specular: 0.3,
  clearcoat: 0.12,
  /** Pointer interaction. `strength` is displacement per step, in world units. */
  pointer: { radius: 1.45, strength: 0.02 },
  /** Cap the device pixel ratio. The retina pass is the biggest fragment cost. */
  maxPixelRatio: 1.5,
  /** Shed balls if a frame costs more than `budgetMs`. Set false to disable. */
  autoQuality: true,
  budgetMs: 8,
  /** Fixed seed keeps the pour identical on every load. */
  seed: 20260907,
  /** Render one settled frame instead of animating when the OS asks for it. */
  respectReducedMotion: true,
  /** Show the tuning panel. Handy while dialling a design in. */
  controls: false,
  /**
   * Where to mount that panel. Leave null and the library picks: the container
   * itself, or — when the container is its own stacking context, as the
   * documented CSS makes it — the container's positioned ancestor, so the
   * panel is not trapped underneath content drawn over the pit.
   */
  controlsTarget: null,
  labels: {
    title: 'Ballpit',
    count: 'Count',
    maxSize: 'Max size (px)',
    minSize: 'Min size (px)',
    strength: 'Cursor push',
    radius: 'Cursor radius',
    repour: 'Re-pour',
  },
};

/** Deterministic PRNG, so a given seed always produces the same pour. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A small studio environment, built in code.
 *
 * three ships `RoomEnvironment`, but on a CDN that addon imports the bare
 * specifier "three", which needs an import map the host page may not have —
 * it throws, and the spheres silently fall back to flat lighting. Four
 * emissive panels in a box get the same job done with no addon.
 */
function buildEnvironment(renderer) {
  const scene = new THREE.Scene();
  const box = new THREE.BoxGeometry();
  box.deleteAttribute('uv');

  const room = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ side: THREE.BackSide }));
  room.scale.set(20, 14, 20);
  scene.add(room);

  const panel = (color, intensity, sx, sy, sz, px, py, pz) => {
    const material = new THREE.MeshBasicMaterial({ color });
    material.color.multiplyScalar(intensity);
    const mesh = new THREE.Mesh(box, material);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    scene.add(mesh);
  };
  panel(0xffffff, 6.0, 7, 1, 7, 0, 6.5, 0);
  panel(0xbfd4ff, 3.0, 1, 6, 7, -8.5, 1.5, 0);
  panel(0xffffff, 4.0, 1, 6, 7, 8.5, 1.5, 0);
  panel(0x9fc2ff, 2.0, 7, 6, 1, 0, 1.5, -8.5);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.04).texture;
  pmrem.dispose();
  return texture;
}

/** Fine speckle, used as a roughness map so some balls read as frosted. */
function buildGrainTexture(rand) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 140 + Math.floor(rand() * 115);
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  return texture;
}

/**
 * @param {HTMLElement} target  Container. Give it a size in CSS; the canvas fills it.
 * @param {object} [userOptions]
 * @returns {{destroy():void, repour():void, setCount(n:number):void, setSizes(min:number,max:number):void, canvas:HTMLCanvasElement}}
 */
export function createBallpit(target, userOptions = {}) {
  if (!target) throw new Error('ballpit: a target element is required');

  const options = {
    ...DEFAULTS,
    ...userOptions,
    pointer: { ...DEFAULTS.pointer, ...(userOptions.pointer || {}) },
    labels: { ...DEFAULTS.labels, ...(userOptions.labels || {}) },
  };

  const reducedMotion =
    options.respectReducedMotion &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch (error) {
    console.warn('[ballpit] WebGL unavailable, nothing rendered.', error);
    return {
      destroy() {},
      repour() {},
      setCount() {},
      setSizes() {},
      canvas: null,
    };
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.display = 'block';
  target.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  /**
   * Orthographic, not perspective. Under perspective the balls near the edges
   * are seen at an angle and read as stretched ellipses; orthographic gives
   * every one the same head-on projection.
   */
  const VIEW_HALF_H = 2.6933797335698973;
  const camera = new THREE.OrthographicCamera(-4, 4, VIEW_HALF_H, -VIEW_HALF_H, 0.1, 100);
  camera.position.set(0, 0, 10);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x03060a, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  try {
    scene.environment = buildEnvironment(renderer);
  } catch (error) {
    console.warn('[ballpit] environment map failed, using basic lighting.', error);
  }

  const rand = mulberry32(options.seed);
  const grainTexture = buildGrainTexture(rand);

  const materials = options.palette.flatMap((color, index) => [
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: index === 0 ? 0.07 : 0.12,
      metalness: 0,
      clearcoat: options.clearcoat,
      clearcoatRoughness: 0.15,
      specularIntensity: options.specular,
      envMapIntensity: options.envIntensity,
    }),
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.6,
      metalness: 0,
      specularIntensity: options.specular,
      envMapIntensity: options.envIntensity,
      roughnessMap: grainTexture,
    }),
  ]);

  /** One unit sphere, scaled per ball: 1 geometry and a handful of materials. */
  const geometry = new THREE.SphereGeometry(1, 24, 16);

  let count = options.count;
  let minSize = options.minSize;
  let maxSize = options.maxSize;

  const balls = [];
  function makeBall(index) {
    const mesh = new THREE.Mesh(geometry, materials[index % materials.length]);
    mesh.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
    scene.add(mesh);
    return { mesh, sizeT: rand(), r: 0.2, x: 0, y: 0, px: 0, py: 0, spin: 0 };
  }
  for (let i = 0; i < count; i++) balls.push(makeBall(i));

  let halfW = 4;
  let halfH = VIEW_HALF_H;
  let maxR = 0.24;

  function applySizes() {
    const heightPx = target.clientHeight || 1;
    const worldPerPx = (halfH * 2) / heightPx;
    const rMax = (maxSize / 2) * worldPerPx;
    const rMin = (Math.min(minSize, maxSize) / 2) * worldPerPx;
    maxR = rMax;
    for (const ball of balls) {
      ball.r = rMin + ball.sizeT * (rMax - rMin);
      ball.mesh.scale.setScalar(ball.r);
    }
  }

  function spawn(ball, index) {
    ball.x = -halfW + ball.r + rand() * Math.max(0.2, halfW * 2 - ball.r * 2);
    ball.y = halfH + 0.5 + index * 0.16;
    ball.px = ball.x - (rand() - 0.5) * 0.04;
    ball.py = ball.y;
  }

  function resize() {
    const w = target.clientWidth || 1;
    const h = target.clientHeight || 1;
    renderer.setSize(w, h, true);
    halfH = VIEW_HALF_H;
    halfW = halfH * (w / h);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    applySizes();
  }

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(target);
  } else {
    window.addEventListener('resize', resize);
  }
  resize();
  balls.forEach(spawn);

  // --- pointer -------------------------------------------------------------
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false };

  function onPointerMove(event) {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((((event.clientY - rect.top) / rect.height) * 2) - 1);
    if (nx < -1.3 || nx > 1.3 || ny < -1.3 || ny > 1.3) {
      pointer.active = false;
      return;
    }
    pointer.tx = nx * halfW;
    pointer.ty = ny * halfH;
    if (!pointer.active) {
      pointer.x = pointer.tx;
      pointer.y = pointer.ty;
    }
    pointer.active = true;
  }
  function onPointerOut() {
    pointer.active = false;
  }
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerleave', onPointerOut);
  document.addEventListener('mouseleave', onPointerOut);

  // --- solver --------------------------------------------------------------
  const DAMPING = 0.988;
  const ITERATIONS = 7;
  const STEP = 1 / 60;
  const MAX_SPEED = 14;

  let gridCell = 0;
  let gridCols = 0;
  let gridRows = 0;
  let gridHeads = null;
  let gridNext = new Int32Array(balls.length);

  function rebuildGrid() {
    gridCell = Math.max(maxR * 2, 0.05);
    gridCols = Math.max(1, Math.ceil((halfW * 2) / gridCell));
    gridRows = Math.max(1, Math.ceil((halfH * 2) / gridCell));
    const cells = gridCols * gridRows;
    if (!gridHeads || gridHeads.length !== cells) gridHeads = new Int32Array(cells);
    gridHeads.fill(-1);
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      let cx = ((b.x + halfW) / gridCell) | 0;
      let cy = ((b.y + halfH) / gridCell) | 0;
      cx = cx < 0 ? 0 : cx >= gridCols ? gridCols - 1 : cx;
      cy = cy < 0 ? 0 : cy >= gridRows ? gridRows - 1 : cy;
      const cell = cy * gridCols + cx;
      gridNext[i] = gridHeads[cell];
      gridHeads[cell] = i;
    }
  }

  function step(dt) {
    if (pointer.active) {
      pointer.x += (pointer.tx - pointer.x) * 0.28;
      pointer.y += (pointer.ty - pointer.y) * 0.28;
    }

    for (const b of balls) {
      let vx = (b.x - b.px) * DAMPING;
      let vy = (b.y - b.py) * DAMPING;
      const speed = Math.sqrt(vx * vx + vy * vy) / dt;
      if (speed > MAX_SPEED) {
        const k = MAX_SPEED / speed;
        vx *= k;
        vy *= k;
      }
      b.px = b.x;
      b.py = b.y;
      b.x += vx + options.drift * dt * dt;
      b.y += vy - options.gravity * dt * dt;
    }

    /**
     * The cursor carve runs once per step with a capped displacement. Inside
     * the relaxation loop it compounds against neighbour contacts and launches
     * balls off screen; and because Verlet turns a one-step correction straight
     * into velocity, that cap is the entire shove budget.
     */
    if (pointer.active) {
      const R = options.pointer.radius;
      const maxPush = options.pointer.strength;
      for (const b of balls) {
        const dx = b.x - pointer.x;
        const dy = b.y - pointer.y;
        const minDist = b.r + R;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const push = Math.min(minDist - d, maxPush);
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }

    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      rebuildGrid();
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i];
        let cx = ((a.x + halfW) / gridCell) | 0;
        let cy = ((a.y + halfH) / gridCell) | 0;
        cx = cx < 0 ? 0 : cx >= gridCols ? gridCols - 1 : cx;
        cy = cy < 0 ? 0 : cy >= gridRows ? gridRows - 1 : cy;
        for (let oy = -1; oy <= 1; oy++) {
          const yy = cy + oy;
          if (yy < 0 || yy >= gridRows) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = cx + ox;
            if (xx < 0 || xx >= gridCols) continue;
            for (let j = gridHeads[yy * gridCols + xx]; j !== -1; j = gridNext[j]) {
              if (j <= i) continue;
              const b = balls[j];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const minDist = a.r + b.r;
              const d2 = dx * dx + dy * dy;
              if (d2 >= minDist * minDist || d2 < 1e-9) continue;
              const d = Math.sqrt(d2);
              const push = (minDist - d) * 0.5;
              const ux = dx / d;
              const uy = dy / d;
              a.x -= ux * push;
              a.y -= uy * push;
              b.x += ux * push;
              b.y += uy * push;
            }
          }
        }
      }
      for (const b of balls) {
        if (b.x - b.r < -halfW) b.x = -halfW + b.r;
        if (b.x + b.r > halfW) b.x = halfW - b.r;
        if (b.y - b.r < -halfH) b.y = -halfH + b.r;
      }
    }

    for (const b of balls) {
      b.spin -= (b.x - b.px) / b.r;
      b.mesh.position.set(b.x, b.y, 0);
      b.mesh.rotation.z = b.spin;
    }
  }

  // --- controls ------------------------------------------------------------
  let countInput = null;
  let countTouched = false;
  let panel = null;

  function setCount(next) {
    const n = Math.max(4, Math.min(600, Math.round(next)));
    if (n === balls.length) return;
    if (n < balls.length) {
      for (let i = n; i < balls.length; i++) scene.remove(balls[i].mesh);
      balls.length = n;
    } else {
      for (let i = balls.length; i < n; i++) {
        const ball = makeBall(i);
        balls.push(ball);
        applySizes();
        spawn(ball, (i % 40) + 1);
      }
    }
    count = n;
    gridNext = new Int32Array(balls.length);
    applySizes();
  }

  function repour() {
    balls.forEach(spawn);
  }

  function setSizes(nextMin, nextMax) {
    minSize = nextMin;
    maxSize = nextMax;
    applySizes();
  }

  /**
   * Where the panel is mounted.
   *
   * Not `target`, by default. The container CSS this library asks for
   * (`position:absolute; inset:0; z-index:0`) makes the container its own
   * stacking context, and a panel inside it can never paint above content
   * drawn over the pit however high its own z-index is. Anywhere that content
   * overlaps the panel, the panel stops receiving clicks — visible, but dead.
   *
   * So when the container is a stacking context, mount into its positioned
   * ancestor instead: in the documented layout that is the same box, and the
   * panel is then a sibling of the content rather than trapped beneath it.
   * `controlsTarget` overrides all of this.
   */
  function resolveControlsHost() {
    if (options.controlsTarget) return options.controlsTarget;
    const parent = target.parentElement;
    if (!parent) return target;
    if (getComputedStyle(target).zIndex === 'auto') return target;
    return getComputedStyle(parent).position !== 'static' ? parent : target;
  }

  /** Keep the panel over the pit when it is mounted on a larger ancestor. */
  function placePanel() {
    if (!panel || panel.host === target) return;
    const t = target.getBoundingClientRect();
    const h = panel.host.getBoundingClientRect();
    panel.root.style.top = t.top - h.top + PANEL_INSET + 'px';
    panel.root.style.left = t.left - h.left + PANEL_INSET + 'px';
  }

  const PANEL_INSET = 14;
  let panelObserver = null;

  if (options.controls) {
    panel = buildPanel();
    panel.host = resolveControlsHost();
    panel.host.appendChild(panel.root);
    placePanel();
    // Only needed when the panel sits on an ancestor: the offset between the
    // two boxes can change without either of them being replaced.
    if (panel.host !== target && typeof ResizeObserver === 'function') {
      panelObserver = new ResizeObserver(placePanel);
      panelObserver.observe(target);
      panelObserver.observe(panel.host);
    }
  }

  function buildPanel() {
    const root = document.createElement('div');
    root.className = 'ballpit-panel';
    Object.assign(root.style, {
      position: 'absolute',
      top: '14px',
      left: '14px',
      zIndex: '5',
      width: '232px',
      font: '11px ui-monospace, Menlo, monospace',
      color: '#dbe6ff',
      background: 'rgba(4,10,16,.82)',
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(41,87,255,.45)',
      borderRadius: '10px',
      overflow: 'hidden',
      pointerEvents: 'auto',
      userSelect: 'none',
    });

    const head = document.createElement('button');
    head.type = 'button';
    Object.assign(head.style, {
      all: 'unset',
      display: 'flex',
      justifyContent: 'space-between',
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      cursor: 'pointer',
      letterSpacing: '.04em',
      textTransform: 'uppercase',
      fontSize: '10px',
      color: '#9db8ff',
      background: 'rgba(41,87,255,.14)',
    });
    const caret = document.createElement('span');
    caret.textContent = '−';
    head.append(options.labels.title, caret);

    const body = document.createElement('div');
    Object.assign(body.style, { padding: '10px', display: 'grid', gap: '9px' });
    head.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? 'grid' : 'none';
      caret.textContent = hidden ? '−' : '+';
    });

    function slider(label, min, max, stepSize, value, onInput) {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'grid', gap: '3px' });
      const caption = document.createElement('label');
      Object.assign(caption.style, { display: 'flex', justifyContent: 'space-between', color: '#9db8ff' });
      const name = document.createElement('span');
      name.textContent = label;
      const readout = document.createElement('b');
      readout.style.color = '#fff';
      readout.textContent = String(value);
      caption.append(name, readout);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(stepSize);
      input.value = String(value);
      Object.assign(input.style, { width: '100%', accentColor: '#2957ff', margin: '0' });
      input.addEventListener('input', () => {
        readout.textContent = input.value;
        onInput(parseFloat(input.value));
      });
      input.syncDisplay = () => {
        readout.textContent = input.value;
      };

      row.append(caption, input);
      body.appendChild(row);
      return input;
    }

    countInput = slider(options.labels.count, 10, 400, 5, count, (v) => {
      countTouched = true;
      setCount(v);
    });
    let maxInput;
    let minInput;
    maxInput = slider(options.labels.maxSize, 20, 140, 1, maxSize, (v) => {
      maxSize = v;
      if (minSize > v) {
        minSize = v;
        minInput.value = String(v);
        minInput.syncDisplay();
      }
      applySizes();
    });
    minInput = slider(options.labels.minSize, 8, 140, 1, minSize, (v) => {
      minSize = v;
      if (v > maxSize) {
        maxSize = v;
        maxInput.value = String(v);
        maxInput.syncDisplay();
      }
      applySizes();
    });
    slider(options.labels.strength, 0, 0.06, 0.001, options.pointer.strength, (v) => {
      options.pointer.strength = v;
    });
    slider(options.labels.radius, 0.2, 2, 0.05, options.pointer.radius, (v) => {
      options.pointer.radius = v;
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = options.labels.repour;
    Object.assign(button.style, {
      all: 'unset',
      textAlign: 'center',
      padding: '6px 0',
      borderRadius: '6px',
      cursor: 'pointer',
      background: 'rgba(41,87,255,.22)',
      border: '1px solid rgba(41,87,255,.45)',
      color: '#dbe6ff',
      fontSize: '10px',
    });
    button.addEventListener('click', repour);
    body.appendChild(button);

    root.append(head, body);
    return { root };
  }

  // --- auto quality --------------------------------------------------------
  const costSamples = [];
  let downgrades = 0;

  function considerDowngrade(costMs) {
    if (!options.autoQuality || downgrades >= 2 || balls.length <= 45) return;
    // Once someone drives the count slider themselves, stop second-guessing it.
    if (countTouched) return;
    costSamples.push(costMs);
    if (costSamples.length < 90) return;
    costSamples.sort((a, b) => a - b);
    const median = costSamples[Math.floor(costSamples.length / 2)];
    costSamples.length = 0;
    if (median <= options.budgetMs) {
      downgrades = 2; // comfortable — stop sampling
      return;
    }
    const keep = Math.max(45, Math.floor(balls.length * 0.6));
    setCount(keep);
    if (countInput) {
      countInput.value = String(keep);
      countInput.syncDisplay();
    }
    downgrades++;
    console.info(`[ballpit] ${median.toFixed(1)}ms/frame, reduced to ${keep} balls.`);
  }

  // --- loop ----------------------------------------------------------------
  let frameHandle = 0;
  let destroyed = false;

  if (reducedMotion) {
    for (let i = 0; i < 600; i++) step(STEP);
    renderer.render(scene, camera);
  } else {
    let accumulator = 0;
    let last = null;
    const frame = (timestamp) => {
      if (destroyed) return;
      if (last === null) last = timestamp;
      let dt = Math.min((timestamp - last) / 1000, 0.05);
      // A non-monotonic timestamp would drive the accumulator negative and
      // silently stop the simulation for good.
      if (!(dt > 0)) dt = 0;
      last = timestamp;
      accumulator += dt;

      const startedAt = performance.now();
      let guard = 0;
      while (accumulator >= STEP && guard < 5) {
        step(STEP);
        accumulator -= STEP;
        guard++;
      }
      if (accumulator > STEP) accumulator = 0;
      renderer.render(scene, camera);
      considerDowngrade(performance.now() - startedAt);

      frameHandle = requestAnimationFrame(frame);
    };
    frameHandle = requestAnimationFrame(frame);
  }

  return {
    canvas: renderer.domElement,
    repour,
    setCount,
    setSizes,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frameHandle);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerOut);
      document.removeEventListener('mouseleave', onPointerOut);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', resize);
      if (panelObserver) panelObserver.disconnect();
      if (panel && panel.root.parentNode) panel.root.parentNode.removeChild(panel.root);
      geometry.dispose();
      grainTexture.dispose();
      for (const material of materials) material.dispose();
      if (scene.environment) scene.environment.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}

export default createBallpit;
