/**
 * Swapnil Kumar Goel - Scroll-driven 3D story (Three.js r128)
 *
 * One continuous scene, driven by a "stage" value s (see main.js):
 * section i of the page covers s in [i, i+1), and s = i + 0.5 when the section is centred.
 *
 *   s ~ 0.5  Hero          A spinning gyroscope ring forms the "O" in GOEL; its axis follows the mouse.
 *   s ~ 1.5  Physics       The ring thins into a current loop; its magnetic field (traced numerically
 *                          via Biot-Savart) grows outward. The loop still faces the mouse.
 *   s ~ 2.5  Geophysics    Zoom out: the ring swells into the outer core and the loop field becomes
 *                          the geodynamo's dipole. Cutaway Earth with mantle convection.
 *   s ~ 3.5  SAR           Cutaway closes into the night-side surface; field lines collapse into a
 *                          polar orbit flown by RADARSAT-1. Hovering the globe shows the radar view.
 *   s ~ 4.5  Hyperspectral The Sun comes up; EO-1 (Hyperion) images the lit side. Hovering the globe
 *                          shows a false-colour infrared composite.
 *
 * Units: Earth radius = 10 (1 unit ~ 637 km); the current loop has radius 1 at the start.
 */

(function () {
  'use strict';

  if (typeof THREE === 'undefined') {
    console.warn('Three.js not loaded; 3D scene disabled.');
    return;
  }

  const PI = Math.PI;
  const TAU = PI * 2;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const seg = (s, a, b) => clamp01((s - a) / (b - a));
  const ease = (t) => t * t * (3 - 2 * t);
  const ramp = (s, a, b) => ease(seg(s, a, b));
  const lerp = (a, b, t) => a + (b - a) * t;

  const R_EARTH = 10;
  const R_CRUST = 9.72; // visual crust base (exaggerated so it reads on screen)
  const R_OUTER = 5.46; // core-mantle boundary, 3480 km
  const R_INNER = 1.92; // inner core boundary, 1220 km
  const R_ORBIT = 13.2;
  const CUT_PHI = 0.75 * PI; // centre of the cutaway wedge (three.js sphere phi)
  const CUT_HALF = PI / 4;
  const MAG_TILT = 11 * (PI / 180);

  const N_PTS = 220; // samples per field line
  const PLANES = 16; // meridional planes of field lines (every other one is shown around the loop)
  // Loop-field seeds (radius where the line crosses the loop plane, inside the wire),
  // paired with the dipole L-shell each one morphs into.
  const SEEDS = [0.3, 0.42, 0.53, 0.63, 0.72, 0.8, 0.87, 0.93];
  const L_SHELLS = [40, 31, 25, 20.5, 17, 14.6, 12.7, 11.3];

  const RING_THICK = 0.17; // tube radius of the bold "O" (the wire itself is 0.028)
  const ORBIT_SPEED = 0.2; // rad/s; the satellite rises over the south limb, sets past the north
  const TRAIL = 1.1; // length of the imaged strip each satellite leaves behind it (radians of orbit)

  const params = new URLSearchParams(window.location.search);
  const debugStage = params.has('s') ? parseFloat(params.get('s')) : null;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  const state = {
    target: debugStage !== null ? debugStage : 0.5,
    stage: debugStage !== null ? debugStage : 0.5,
    hasPointer: false,
    px: 0, // pointer in CSS pixels
    py: 0,
    ndc: new THREE.Vector2(), // pointer in normalised device coords
    smoothMouseX: 0,
    smoothMouseY: 0,
  };

  let renderer, scene, camera, clock, container, envMap;
  let pointScale = 1;
  const raycaster = new THREE.Raycaster();

  // ---------------------------------------------------------------------------
  // Shared GLSL
  // ---------------------------------------------------------------------------

  const GLSL_NOISE = `
    float hash3(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise3(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
            mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
            mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
    }
    float fbm(vec3 p) {
      float a = 0.5;
      float s = 0.0;
      for (int i = 0; i < 5; i++) {
        s += a * noise3(p);
        p *= 2.03;
        a *= 0.5;
      }
      return s;
    }
  `;

  // Imaged strips on the globe, in world space. Orbit basis (u, v=pole, n=normal) is shared with
  // JS. Each of the three satellites (orbit angles uSatThs) leaves a trail of captured image
  // behind it that fades out over TRAIL radians. Returns x = inside a strip, y = footprint glow.
  const GLSL_SWATH = `
    uniform vec3 uOrbU;
    uniform vec3 uOrbV;
    uniform vec3 uOrbN;
    uniform vec3 uSatThs;
    float trail(float a, float th) {
      float behind = mod(th - a, 6.2831853);
      return smoothstep(0.0, 0.006, behind) * (1.0 - smoothstep(${(TRAIL * 0.55).toFixed(3)}, ${TRAIL.toFixed(3)}, behind));
    }
    float footprint(float a, float th) {
      float ds = mod(th - a + 3.14159265, 6.2831853) - 3.14159265;
      return exp(-pow(ds / 0.012, 2.0));
    }
    vec2 swath(vec3 d, vec2 cross) {
      float c = asin(clamp(dot(d, uOrbN), -1.0, 1.0));
      float a = atan(dot(d, uOrbV), dot(d, uOrbU));
      float inC = smoothstep(cross.x - 0.004, cross.x + 0.004, c) *
                  (1.0 - smoothstep(cross.y - 0.004, cross.y + 0.004, c));
      float inA = max(trail(a, uSatThs.x), max(trail(a, uSatThs.y), trail(a, uSatThs.z)));
      float lead = max(footprint(a, uSatThs.x), max(footprint(a, uSatThs.y), footprint(a, uSatThs.z)));
      return vec2(inC * inA, inC * lead);
    }
  `;

  // The pointer's magnifying glass, in screen space: everything under the glass is revealed, so
  // the reveal always matches the glass ring exactly (uLensPx / uLensR in device pixels).
  const GLSL_LENS = `
    uniform vec2 uLensPx;
    uniform float uLensR;
    uniform float uHoverAmt;
    uniform float uHoverSar;
    uniform float uHoverHsi;
    float lens() {
      float dd = length(gl_FragCoord.xy - uLensPx);
      return (1.0 - smoothstep(uLensR - 1.5, uLensR, dd)) * uHoverAmt;
    }
  `;

  // Discard the cutaway wedge (world space, so it stays put while the texture spins).
  const GLSL_GAP = `
    uniform float uGap;
    uniform float uCutPhi;
    bool inGap(vec3 w) {
      float phi = atan(w.z, -w.x);
      float d = abs(mod(phi - uCutPhi + 3.14159265, 6.2831853) - 3.14159265);
      return d < uGap;
    }
  `;

  const WORLD_VERT = `
    varying vec2 vUv;
    varying vec3 vWorld;
    varying vec3 vN;
    void main() {
      vUv = uv;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `;

  // ---------------------------------------------------------------------------
  // Generic materials
  // ---------------------------------------------------------------------------

  function glowPointsMaterial(color, size) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uSize: { value: size },
        uScale: { value: pointScale },
        uOpacity: { value: 1 },
      },
      vertexShader: `
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uSize;
        uniform float uScale;
        varying float vA;
        varying vec3 vC;
        void main() {
          vA = aAlpha;
          vC = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, uSize * uScale / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vA;
        varying vec3 vC;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          a *= a;
          gl_FragColor = vec4(uColor * vC, a * vA * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  const glowMaterials = [];

  function makeGlowPoints(count, color, size) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const alpha = new Float32Array(count).fill(1);
    const col = new Float32Array(count * 3).fill(1);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const mat = glowPointsMaterial(color, size);
    glowMaterials.push(mat);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 3;
    return { points, pos, alpha, col, geo, mat };
  }

  // Field lines with pulses travelling along B. aVis = 1 for lines drawn around the loop; the
  // rest fade in (uDense) as the field becomes Earth's, so the dipole reads as a dense pattern.
  function flowLineMaterial(color, pulses, speed) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uGrow: { value: 1e3 },
        uPulses: { value: pulses },
        uSpeed: { value: speed },
        uDense: { value: 0 },
      },
      vertexShader: `
        attribute float aU;
        attribute float aW;
        attribute float aVis;
        varying float vU;
        varying float vW;
        varying float vVis;
        varying float vR;
        void main() {
          vU = aU;
          vW = aW;
          vVis = aVis;
          vR = length(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uOpacity;
        uniform float uGrow;
        uniform float uPulses;
        uniform float uSpeed;
        uniform float uDense;
        varying float vU;
        varying float vW;
        varying float vVis;
        varying float vR;
        void main() {
          float grow = 1.0 - smoothstep(uGrow - 0.4, uGrow, vW);
          float pulse = pow(fract(vU * uPulses - uTime * uSpeed), 8.0);
          float vis = mix(vVis, 1.0, uDense);
          vis *= 1.0 - 0.88 * uDense * (1.0 - smoothstep(${(R_EARTH * 0.97).toFixed(2)}, ${(R_EARTH * 1.03).toFixed(2)}, vR)); // inside the Earth
          float a = (mix(0.3, 0.42, uDense) + 0.9 * pulse) * grow * uOpacity * vis;
          gl_FragColor = vec4(uColor * (0.75 + 0.8 * pulse), a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  function makeCanvasGlow(inner, outer) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.25, outer);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }

  // ---------------------------------------------------------------------------
  // Field-line geometry: current loop (Biot-Savart) -> dipole -> orbit
  // ---------------------------------------------------------------------------

  // B of a unit-radius loop in the xz-plane, current along +phi (B at centre points -y,
  // matching Earth, whose dipole moment points to geographic south).
  const LOOP_SEGS = 160;
  const loopCos = new Float32Array(LOOP_SEGS);
  const loopSin = new Float32Array(LOOP_SEGS);
  for (let k = 0; k < LOOP_SEGS; k++) {
    loopCos[k] = Math.cos(((k + 0.5) / LOOP_SEGS) * TAU);
    loopSin[k] = Math.sin(((k + 0.5) / LOOP_SEGS) * TAU);
  }

  // Field direction in the meridional half-plane z = 0 (by symmetry Bz = 0 there).
  function loopFieldDir(x, y, out) {
    let bx = 0;
    let by = 0;
    for (let k = 0; k < LOOP_SEGS; k++) {
      const c = loopCos[k];
      const s = loopSin[k];
      const rx = x - c;
      const rz = -s;
      const r2 = rx * rx + y * y + rz * rz + 1e-6;
      const inv = 1 / (r2 * Math.sqrt(r2));
      // dl = (-s, 0, c);  dl x r
      bx += -c * y * inv;
      by += (c * rx + s * rz) * inv;
    }
    const m = Math.hypot(bx, by) || 1;
    out[0] = bx / m;
    out[1] = by / m;
  }

  function traceLoopLine(rho0) {
    const pts = [[rho0, 0]];
    const k1 = [0, 0];
    const k2 = [0, 0];
    const k3 = [0, 0];
    const k4 = [0, 0];
    let x = rho0;
    let y = 0;
    let travelled = 0;
    for (let i = 0; i < 9000; i++) {
      const h = Math.min(0.12, Math.max(0.004, 0.12 * Math.hypot(x - 1, y)));
      loopFieldDir(x, y, k1);
      loopFieldDir(x + (k1[0] * h) / 2, y + (k1[1] * h) / 2, k2);
      loopFieldDir(x + (k2[0] * h) / 2, y + (k2[1] * h) / 2, k3);
      loopFieldDir(x + k3[0] * h, y + k3[1] * h, k4);
      const nx = x + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      const ny = y + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      travelled += h;
      if (travelled > 0.3 && y > 0 && ny <= 0 && nx < 1) {
        pts.push([rho0, 0]);
        break;
      }
      x = nx;
      y = ny;
      pts.push([x, y]);
      if (Math.hypot(x, y) > 11) break;
    }
    return pts;
  }

  // Closed dipole line r = L sin^2(theta), ordered along B like the loop lines:
  // start inside the core at the equator, go down (south), exit, arc up to the north, re-enter.
  function dipoleLine(L) {
    const thetaC = Math.asin(Math.sqrt(R_OUTER / L));
    const rhoN = R_OUTER * Math.sin(thetaC);
    const yN = R_OUTER * Math.cos(thetaC);
    const inner = (y) => rhoN * (0.55 + 0.45 * (y / yN) * (y / yN));
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      const y = (-i / 30) * yN;
      pts.push([inner(y), y]);
    }
    for (let i = 1; i <= 160; i++) {
      const th = lerp(PI - thetaC, thetaC, i / 160);
      const r = L * Math.sin(th) * Math.sin(th);
      pts.push([r * Math.sin(th), r * Math.cos(th)]);
    }
    for (let i = 1; i <= 30; i++) {
      const y = yN * (1 - i / 30);
      pts.push([inner(y), y]);
    }
    return pts;
  }

  function resample(pts, n) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[cum.length - 1];
    const out = new Float32Array(n * 2);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = (i / (n - 1)) * total;
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const t = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
      out[i * 2] = lerp(pts[j][0], pts[j + 1][0], t);
      out[i * 2 + 1] = lerp(pts[j][1], pts[j + 1][1], t);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Scene objects
  // ---------------------------------------------------------------------------

  const obj = {};
  const tex = {};
  const U = {}; // uniforms shared by the earth surface + clouds

  function initThree() {
    container = document.getElementById('webgl-canvas-container');
    if (!container) return false;

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x020617, 1);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 3000);
    clock = new THREE.Clock();
    updatePointScale();

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    obj.key = new THREE.DirectionalLight(0xffffff, 1.0);
    obj.key.position.set(4, 6, 8);
    scene.add(obj.key);
    envMap = buildEnvironment();

    const loader = new THREE.TextureLoader();
    const base = 'src/assets/textures/';
    // r128 uploads JPEGs as RGB, which renders black on some GPU backends; force RGBA.
    const asRGBA = (t) => {
      t.format = THREE.RGBAFormat;
      t.needsUpdate = true;
    };
    tex.cubeFace = new THREE.Texture();
    tex.day = loader.load(base + 'earth_atmos_2048.jpg', (t) => {
      asRGBA(t);
      tex.cubeFace.image = t.image;
      tex.cubeFace.format = THREE.RGBAFormat;
      tex.cubeFace.needsUpdate = true;
    });
    tex.night = loader.load(base + 'earth_lights_2048.png');
    tex.spec = loader.load(base + 'earth_specular_2048.jpg', asRGBA);
    tex.clouds = loader.load(base + 'earth_clouds_1024.png');
    const aniso = renderer.capabilities.getMaxAnisotropy();
    Object.values(tex).forEach((t) => (t.anisotropy = Math.min(8, aniso)));

    buildStars();
    buildLoop();
    buildFieldLines();
    buildEarth();
    buildCore();
    buildOrbitAndSatellites();
    buildSun();
    buildLabels();
    buildMagnet();
    obj.lensEl = document.createElement('div');
    obj.lensEl.id = 'lens-cursor';
    obj.lensEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(obj.lensEl);

    window.addEventListener('resize', onResize);
    const onPointer = (x, y) => {
      state.hasPointer = true;
      state.px = x;
      state.py = y;
      state.ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    };
    window.addEventListener('mousemove', (e) => onPointer(e.clientX, e.clientY));
    window.addEventListener('touchstart', (e) => onPointer(e.touches[0].clientX, e.touches[0].clientY), {
      passive: true,
    });
    window.addEventListener('touchmove', (e) => onPointer(e.touches[0].clientX, e.touches[0].clientY), {
      passive: true,
    });
    document.body.classList.add('webgl-ready');
    return true;
  }

  // Soft studio reflections for the metal ring and the satellites.
  function buildEnvironment() {
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x05070d);
    const panel = (color, w, h, pos) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.copy(pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(0xffffff, 6, 2, new THREE.Vector3(0, 6, 3));
    panel(0xffd7a8, 3, 5, new THREE.Vector3(-6, 1, 2));
    panel(0x7fb8ff, 3, 5, new THREE.Vector3(6, 0, -2));
    panel(0x334155, 10, 10, new THREE.Vector3(0, -6, 0));
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(env, 0.02);
    pmrem.dispose();
    return rt.texture;
  }

  function buildStars() {
    const n = isMobile ? 1500 : 3500;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * TAU;
      const r = 600 + Math.random() * 900;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(th);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(th);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    obj.stars = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xcfe3ff, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.75 })
    );
    scene.add(obj.stars);
  }

  // --- Scene 1: gyroscope ring -> current loop -> outer core ---------------------

  // Machined grooves around the ring, so its spin is visible.
  function makeRingTexture() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 48; i++) {
      g.fillStyle = i % 4 === 0 ? 'rgba(70,35,12,0.32)' : 'rgba(90,50,20,0.12)';
      g.fillRect((i / 48) * c.width, 0, i % 4 === 0 ? 4 : 2, c.height);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }

  // One torus that morphs: thin wire (base) <-> bold "O" (target 0) -> unit sphere (target 1).
  function buildRingGeometry() {
    const radial = 48;
    const tubular = 256;
    const thin = new THREE.TorusGeometry(1, 0.028, radial, tubular);
    const thick = new THREE.TorusGeometry(1, RING_THICK, radial, tubular);
    thin.rotateX(PI / 2);
    thick.rotateX(PI / 2);

    // Sphere target: each tube cross-section becomes a meridian. The tube angle maps to
    // latitude; the inner half of the tube folds onto a slightly smaller shell.
    const p = thin.attributes.position;
    const sphere = new Float32Array(p.count * 3);
    const sphereN = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const u = Math.atan2(z, x);
      const radialOff = Math.hypot(x, z) - 1;
      const v = Math.atan2(-y, radialOff); // rotateX(PI/2) maps the tube's +z to -y
      const outerHalf = Math.cos(v) >= 0;
      const lat = outerHalf ? v : Math.sign(v) * (PI - Math.abs(v));
      const r = outerHalf ? 1 : 0.985;
      const nx = Math.cos(lat) * Math.cos(u);
      const ny = -Math.sin(lat);
      const nz = Math.cos(lat) * Math.sin(u);
      sphere.set([nx * r, ny * r, nz * r], i * 3);
      sphereN.set([nx, ny, nz], i * 3);
    }
    thin.morphAttributes.position = [
      thick.attributes.position,
      new THREE.BufferAttribute(sphere, 3),
    ];
    thin.morphAttributes.normal = [thick.attributes.normal, new THREE.BufferAttribute(sphereN, 3)];
    return thin;
  }

  function buildLoop() {
    const g = new THREE.Group(); // position: the hero "O", then the origin. Rotation: axis -> mouse.
    obj.ringMat = new THREE.MeshStandardMaterial({
      color: 0xf2a273,
      map: makeRingTexture(),
      metalness: 0.85,
      roughness: 0.26,
      envMap,
      envMapIntensity: 1.15,
      emissive: 0xff5a1a,
      emissiveIntensity: 0,
      morphTargets: true,
      morphNormals: true,
    });
    obj.ring = new THREE.Mesh(buildRingGeometry(), obj.ringMat);
    g.add(obj.ring);

    // Gyroscope axle and bearings along the spin axis (hero only).
    obj.axleMat = new THREE.MeshStandardMaterial({
      color: 0xd7dde6,
      metalness: 0.9,
      roughness: 0.2,
      envMap,
      transparent: true,
    });
    const axle = new THREE.Group();
    axle.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.9, 16), obj.axleMat));
    [-1, 1].forEach((sgn) => {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.08, 20, 12), obj.axleMat);
      knob.position.y = sgn * 1.45;
      axle.add(knob);
    });
    obj.axle = axle;
    g.add(axle);

    // Hub and spokes spin with the rim.
    const rotor = new THREE.Group();
    rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 32), obj.axleMat));
    for (let k = 0; k < 3; k++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.9, 8), obj.axleMat);
      spoke.rotation.z = PI / 2;
      spoke.position.x = 0.5;
      const arm = new THREE.Group();
      arm.add(spoke);
      arm.rotation.y = (k / 3) * TAU;
      rotor.add(arm);
    }
    obj.rotor = rotor;
    obj.ring.add(rotor);

    // Charge carriers flowing around the wire.
    const n = 28;
    obj.charges = makeGlowPoints(n, 0xfff0c0, 0.2);
    obj.charges.mat.depthTest = false; // they ride inside the wire; draw the glow over it
    obj.chargePhase = new Float32Array(n).map((_, i) => (i / n) * TAU);
    g.add(obj.charges.points);

    obj.loop = g;
    scene.add(g);
    obj.heroO = document.getElementById('hero-o');
  }

  function buildFieldLines() {
    const nLines = PLANES * SEEDS.length;
    const loop2d = SEEDS.map((s) => resample(traceLoopLine(s), N_PTS));
    const dip2d = L_SHELLS.map((L) => resample(dipoleLine(L), N_PTS));

    const total = nLines * N_PTS;
    const A = new Float32Array(total * 3); // loop state, loop units
    const B = new Float32Array(total * 3); // tilted dipole, earth units
    const W = new Float32Array(total); // distance from the wire, for the grow-in
    const Uattr = new Float32Array(total);
    const Vis = new Float32Array(total);
    const lineVis = new Float32Array(nLines);
    const tilt = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, -1).normalize(), MAG_TILT);
    const v = new THREE.Vector3();
    const index = [];

    let line = 0;
    for (let p = 0; p < PLANES; p++) {
      const alpha = (p / PLANES) * TAU + PI / PLANES;
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);
      for (let k = 0; k < SEEDS.length; k++, line++) {
        const baseIdx = line * N_PTS;
        lineVis[line] = p % 2 === 0 ? 1 : 0;
        Vis.fill(lineVis[line], baseIdx, baseIdx + N_PTS);
        for (let i = 0; i < N_PTS; i++) {
          const o = (baseIdx + i) * 3;
          const rhoA = loop2d[k][i * 2];
          const yA = loop2d[k][i * 2 + 1];
          A[o] = rhoA * ca;
          A[o + 1] = yA;
          A[o + 2] = -rhoA * sa;
          W[baseIdx + i] = Math.hypot(rhoA - 1, yA);

          const rhoB = dip2d[k][i * 2];
          v.set(rhoB * ca, dip2d[k][i * 2 + 1], -rhoB * sa).applyMatrix4(tilt);
          B[o] = v.x;
          B[o + 1] = v.y;
          B[o + 2] = v.z;

          Uattr[baseIdx + i] = i / (N_PTS - 1);
          if (i < N_PTS - 1) index.push(baseIdx + i, baseIdx + i + 1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(total * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.BufferAttribute(Uattr, 1));
    geo.setAttribute('aW', new THREE.BufferAttribute(W, 1));
    geo.setAttribute('aVis', new THREE.BufferAttribute(Vis, 1));
    geo.setIndex(index);
    const mat = flowLineMaterial(0x5fd4ff, 5, 0.22);
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 2;

    // Tracer particles riding the lines in the direction of B.
    const perLine = 3;
    const tracers = makeGlowPoints(nLines * perLine, 0x9be7ff, 0.045);
    const tracerLine = new Uint16Array(nLines * perLine);
    const tracerU = new Float32Array(nLines * perLine);
    for (let l = 0; l < nLines; l++) {
      for (let j = 0; j < perLine; j++) {
        tracerLine[l * perLine + j] = l;
        tracerU[l * perLine + j] = (j + Math.random() * 0.5) / perLine;
      }
    }

    // Lines are built around the origin; the group carries the loop's position and tilt.
    const group = new THREE.Group();
    group.add(lines, tracers.points);
    scene.add(group);

    obj.field = { A, B, W, pos, geo, mat, lines, nLines, lineVis, tracers, tracerLine, tracerU, group };
  }

  // --- Scene 2/3/4: Earth --------------------------------------------------------

  function buildEarth() {
    Object.assign(U, {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uKeyDir: { value: new THREE.Vector3(0.5, 0.5, 0.7).normalize() },
      uSun: { value: 0 },
      uDark: { value: 0 },
      uGap: { value: CUT_HALF },
      uCutPhi: { value: CUT_PHI },
      uOpacity: { value: 0 },
      uSarAmt: { value: 0 },
      uHsiAmt: { value: 0 },
      uCrossSar: { value: new THREE.Vector2(0.05, 0.17) },
      uCrossHsi: { value: new THREE.Vector2(-0.07, 0.07) },
      uOrbU: { value: new THREE.Vector3(1, 0, 0) },
      uOrbV: { value: new THREE.Vector3(0, 1, 0) },
      uOrbN: { value: new THREE.Vector3(0, 0, 1) },
      uSatThs: { value: new THREE.Vector3() },
      uLensPx: { value: new THREE.Vector2() },
      uLensR: { value: 60 },
      uHoverAmt: { value: 0 },
      uHoverSar: { value: 0 },
      uHoverHsi: { value: 0 },
    });

    obj.earth = new THREE.Group();
    scene.add(obj.earth);

    // Surface
    obj.surfaceMat = new THREE.ShaderMaterial({
      uniforms: Object.assign(
        { uDay: { value: tex.day }, uNight: { value: tex.night }, uSpec: { value: tex.spec } },
        U
      ),
      vertexShader: WORLD_VERT,
      fragmentShader: `
        uniform sampler2D uDay;
        uniform sampler2D uNight;
        uniform sampler2D uSpec;
        uniform vec3 uSunDir;
        uniform vec3 uKeyDir;
        uniform float uSun;
        uniform float uDark;
        uniform float uOpacity;
        uniform float uSarAmt;
        uniform float uHsiAmt;
        uniform vec2 uCrossSar;
        uniform vec2 uCrossHsi;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying vec3 vN;
        ${GLSL_GAP}
        ${GLSL_SWATH}
        ${GLSL_LENS}
        float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float lumAt(vec2 uv) { return dot(texture2D(uDay, uv).rgb, vec3(0.3, 0.59, 0.11)); }
        void main() {
          if (inGap(vWorld)) discard;
          vec3 n = normalize(vN);
          vec3 d = normalize(vWorld);
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 day = texture2D(uDay, vUv).rgb;
          vec3 night = texture2D(uNight, vUv).rgb;
          float water = texture2D(uSpec, vUv).r;

          // Neutral studio light for the cutaway.
          vec3 col = day * (0.45 + 0.65 * max(dot(n, uKeyDir), 0.0));

          // Night pass: almost black, city lights only.
          vec3 dark = day * vec3(0.04, 0.06, 0.1) + night * vec3(1.0, 0.78, 0.45) * 0.5;
          col = mix(col, dark, uDark);

          // Sunlight with a soft terminator, ocean glint, and city lights on the night side.
          float ndl = dot(n, uSunDir);
          float dayAmt = smoothstep(-0.08, 0.2, ndl);
          vec3 h = normalize(uSunDir + viewDir);
          float glint = pow(max(dot(n, h), 0.0), 45.0) * water * 0.7 * dayAmt;
          vec3 sunlit = day * (0.025 + 1.15 * max(ndl, 0.0)) + vec3(1.0, 0.88, 0.65) * glint +
                        night * vec3(1.0, 0.78, 0.45) * 0.6 * (1.0 - dayAmt);
          col = mix(col, sunlit, uSun);

          float ln = lens();

          // SAR: radar brightness. Water is a dark specular reflector; terrain slopes facing the
          // radar return strongly; multiplicative speckle.
          float sarW = 0.0;
          vec2 sw = vec2(0.0);
          if (uSarAmt > 0.001) {
            sw = swath(d, uCrossSar);
            sarW = sw.x * uSarAmt;
          }
          sarW = max(sarW, ln * uHoverSar);
          if (sarW > 0.001) {
            float lum = dot(day, vec3(0.3, 0.59, 0.11));
            vec2 px = vec2(1.0 / 2048.0, 1.0 / 1024.0);
            float relief = (lumAt(vUv + vec2(px.x, 0.0)) - lumAt(vUv - vec2(px.x, 0.0))) +
                           (lumAt(vUv + vec2(0.0, px.y)) - lumAt(vUv - vec2(0.0, px.y)));
            float speck = 0.5 + hash2(floor(vUv * vec2(4096.0, 2048.0)));
            float land = 0.16 + 1.3 * lum + 3.0 * relief;
            float sar = mix(0.04 + 0.05 * hash2(floor(vUv * 900.0)), land, 1.0 - water) * speck;
            col = mix(col, vec3(clamp(sar, 0.0, 1.2)) * vec3(0.94, 0.97, 1.0), sarW);
          }
          col += vec3(0.25, 0.85, 1.0) * sw.y * uSarAmt * 1.3;

          // Hyperspectral: false-colour composite (NIR, R, G) - healthy vegetation glows red.
          float hsiW = 0.0;
          vec2 hw = vec2(0.0);
          if (uHsiAmt > 0.001) {
            hw = swath(d, uCrossHsi);
            hsiW = hw.x * uHsiAmt * 0.9;
          }
          float hsiLens = ln * uHoverHsi;
          if (max(hsiW, hsiLens) > 0.001) {
            float veg = clamp((day.g - 0.5 * (day.r + day.b)) * 5.0, 0.0, 1.0);
            float nir = (1.0 - water) * clamp(0.22 + 0.55 * dot(day, vec3(0.333)) + 1.0 * veg, 0.0, 1.0);
            vec3 fc = vec3(nir, day.r * 1.1, day.g * 1.05) * 1.3;
            col = mix(col, fc * (0.3 + 0.7 * max(ndl, 0.0)), hsiW);
            col = mix(col, fc, hsiLens); // the lens shows the product, not the lighting
            float c = asin(clamp(dot(d, uOrbN), -1.0, 1.0));
            float t = clamp((c - uCrossHsi.x) / (uCrossHsi.y - uCrossHsi.x), 0.0, 1.0);
            vec3 rainbow = 0.5 + 0.5 * cos(6.2831 * (t * 0.8 + vec3(0.0, 0.33, 0.67)));
            col += rainbow * hw.y * uHsiAmt * 1.5;
          }

          gl_FragColor = vec4(col, uOpacity);
        }
      `,
    });
    obj.surface = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH, 160, 80), obj.surfaceMat);
    obj.earth.add(obj.surface);

    // Clouds (thinned inside the SAR swath: radar sees through them)
    obj.cloudMat = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uClouds: { value: tex.clouds } }, U),
      vertexShader: WORLD_VERT,
      fragmentShader: `
        uniform sampler2D uClouds;
        uniform vec3 uSunDir;
        uniform vec3 uKeyDir;
        uniform float uSun;
        uniform float uDark;
        uniform float uOpacity;
        uniform float uSarAmt;
        uniform vec2 uCrossSar;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying vec3 vN;
        ${GLSL_GAP}
        ${GLSL_SWATH}
        ${GLSL_LENS}
        void main() {
          if (inGap(vWorld)) discard;
          vec3 n = normalize(vN);
          vec3 d = normalize(vWorld);
          float c = texture2D(uClouds, vUv).a;
          float light = mix(0.5 + 0.6 * max(dot(n, uKeyDir), 0.0), 0.1, uDark);
          light = mix(light, 0.03 + 1.1 * max(dot(n, uSunDir), 0.0), uSun);
          float a = c * uOpacity * 0.85;
          float clear = max(swath(d, uCrossSar).x * uSarAmt, lens() * uHoverSar);
          a *= 1.0 - 0.95 * clear;
          a *= 1.0 - 0.6 * lens() * uHoverHsi;
          gl_FragColor = vec4(vec3(light), a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    obj.clouds = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 1.006, 128, 64), obj.cloudMat);
    obj.clouds.renderOrder = 1;
    obj.earth.add(obj.clouds);

    // Atmosphere rim
    obj.atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: U.uSunDir,
        uSun: U.uSun,
        uDark: U.uDark,
        uOpacity: { value: 0 },
      },
      vertexShader: `
        varying vec3 vNView;
        varying vec3 vWorld;
        void main() {
          vNView = normalize(normalMatrix * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir;
        uniform float uSun;
        uniform float uDark;
        uniform float uOpacity;
        varying vec3 vNView;
        varying vec3 vWorld;
        void main() {
          vec3 viewDir = normalize(vWorld - cameraPosition);
          // Behind the globe: normally hidden by the surface, but visible through the cutaway.
          float b = dot(cameraPosition, viewDir);
          if (b < 0.0 && dot(cameraPosition, cameraPosition) - b * b < ${(R_EARTH * R_EARTH).toFixed(1)}) discard;
          float rim = pow(max(0.0, 0.68 - dot(vNView, vec3(0.0, 0.0, 1.0))), 3.0);
          float sunSide = max(dot(normalize(vWorld), uSunDir), 0.0);
          float forward = pow(max(dot(viewDir, uSunDir), 0.0), 6.0);
          float k = mix(1.0, 0.35, uDark);
          k = mix(k, 0.15 + 1.6 * sunSide, uSun);
          vec3 col = vec3(0.3, 0.62, 1.0) * rim * k + vec3(1.0, 0.75, 0.45) * forward * rim * uSun * 2.5;
          gl_FragColor = vec4(col, uOpacity);
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    obj.atmo = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 1.07, 96, 48), obj.atmoMat);
    obj.earth.add(obj.atmo);

    // Cutaway faces (crust band + convecting mantle), one on each side of the wedge.
    obj.faceMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        varying vec3 vPos;
        ${GLSL_NOISE}
        void main() {
          float r = length(vPos);
          float lat = atan(vPos.y, length(vPos.xz));
          if (r > ${R_CRUST.toFixed(3)}) {
            float n = noise3(vPos * 4.0);
            gl_FragColor = vec4(mix(vec3(0.3, 0.25, 0.2), vec3(0.52, 0.43, 0.33), n), uOpacity);
            return;
          }
          float xi = clamp((r - ${R_OUTER.toFixed(3)}) / ${(R_CRUST - R_OUTER).toFixed(3)}, 0.0, 1.0);
          float eta = (lat + 1.5707963) / 3.1415926;
          float K = 6.0;
          float sx = sin(3.1415926 * xi);
          float psi = sx * sin(K * 3.1415926 * eta);
          float up = sx * cos(K * 3.1415926 * eta);   // ~ radial velocity: plumes where > 0
          float T = 0.12 + 0.55 * pow(1.0 - xi, 1.6) + 0.38 * up * sx;
          T += 0.12 * (fbm(vec3(vPos.xy * 0.7, uTime * 0.15)) - 0.5);
          T = clamp(T, 0.0, 1.0);
          vec3 col = mix(vec3(0.16, 0.03, 0.03), vec3(0.72, 0.16, 0.04), smoothstep(0.0, 0.45, T));
          col = mix(col, vec3(1.0, 0.6, 0.18), smoothstep(0.45, 0.8, T));
          col = mix(col, vec3(1.0, 0.9, 0.6), smoothstep(0.8, 1.0, T));
          float contour = 1.0 - smoothstep(0.0, 0.05, abs(fract(psi * 3.0 + 0.5) - 0.5));
          col += contour * 0.06;
          col += vec3(1.0, 0.45, 0.1) * smoothstep(0.07, 0.0, xi) * 0.6;   // hot D'' layer at the CMB
          gl_FragColor = vec4(col, uOpacity);
        }
      `,
      side: THREE.DoubleSide,
    });
    const faceGeo = new THREE.RingGeometry(R_OUTER, R_EARTH * 0.999, 128, 12, -PI / 2, PI);
    obj.faceA = new THREE.Mesh(faceGeo, obj.faceMat);
    obj.faceB = new THREE.Mesh(faceGeo, obj.faceMat);
    obj.earth.add(obj.faceA, obj.faceB);

    // Mantle convection tracers on both faces, advected by the same stream function.
    const n = isMobile ? 160 : 300;
    obj.conv = {
      xi: new Float32Array(n).map(() => 0.04 + Math.random() * 0.92),
      eta: new Float32Array(n).map(() => 0.02 + Math.random() * 0.96),
      a: makeGlowPoints(n, 0xffd28a, 0.16),
      b: makeGlowPoints(n, 0xffd28a, 0.16),
    };
    obj.earth.add(obj.conv.a.points, obj.conv.b.points);
  }

  function buildCore() {
    obj.innerMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: `
        varying vec3 vPos;
        varying vec3 vNView;
        void main() {
          vPos = position;
          vNView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3 vPos;
        varying vec3 vNView;
        ${GLSL_NOISE}
        void main() {
          float n = fbm(vPos * 2.4);
          float grain = smoothstep(0.45, 0.55, noise3(vPos * 7.0));
          vec3 col = mix(vec3(0.95, 0.72, 0.32), vec3(1.0, 0.96, 0.8), n);
          col = mix(col, col * 0.75, grain * 0.5);
          col *= 0.55 + 0.6 * pow(max(vNView.z, 0.0), 0.7);
          gl_FragColor = vec4(col, uOpacity);
        }
      `,
      transparent: true,
    });
    obj.inner = new THREE.Mesh(new THREE.SphereGeometry(R_INNER, 64, 32), obj.innerMat);
    obj.earth.add(obj.inner);

    obj.outerMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: `
        varying vec3 vPos;
        varying vec3 vNView;
        varying vec3 vViewPos;
        void main() {
          vPos = position;
          vNView = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPos = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        varying vec3 vPos;
        varying vec3 vNView;
        varying vec3 vViewPos;
        ${GLSL_NOISE}
        void main() {
          vec3 p = normalize(vPos);
          // Westward drift, faster at the equator (differential rotation of the liquid core).
          float drift = -uTime * 0.12 * (1.0 - 0.6 * p.y * p.y);
          float c = cos(drift), s = sin(drift);
          p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
          vec3 q = p * 3.0;
          float w = fbm(q + vec3(0.0, uTime * 0.07, 0.0));
          float n = fbm(q * 1.7 + 2.5 * w + vec3(uTime * 0.05));
          vec3 col = mix(vec3(0.55, 0.1, 0.02), vec3(1.0, 0.55, 0.12), smoothstep(0.3, 0.7, n));
          col += vec3(1.0, 0.85, 0.4) * pow(smoothstep(0.55, 0.85, n), 2.0);
          float fres = pow(1.0 - abs(dot(normalize(vNView), normalize(-vViewPos))), 2.0);
          float a = uOpacity * (0.45 + 0.45 * fres + 0.15 * n);
          gl_FragColor = vec4(col * (0.8 + 0.6 * fres), a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    obj.outer = new THREE.Mesh(new THREE.SphereGeometry(R_OUTER, 96, 48), obj.outerMat);
    obj.outer.renderOrder = 1;
    obj.earth.add(obj.outer);

    // Outer-core flow: helical Taylor columns parallel to the spin axis, drifting westward.
    const n = isMobile ? 450 : 1000;
    const cols = 8;
    const t = {
      n,
      col: new Uint8Array(n),
      ang: new Float32Array(n),
      rr: new Float32Array(n),
      y: new Float32Array(n),
      vy: new Float32Array(n),
      pts: makeGlowPoints(n, 0xffb347, 0.13),
    };
    for (let i = 0; i < n; i++) {
      t.col[i] = i % cols;
      t.ang[i] = Math.random() * TAU;
      t.rr[i] = 0.15 + Math.random() * 0.75;
      t.y[i] = (Math.random() * 2 - 1) * 3.2;
      t.vy[i] = (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.4);
    }
    obj.taylor = t;
    obj.earth.add(t.pts.points);
  }

  // --- Satellites, orbit, radar beam ----------------------------------------------

  // Three satellites per sensor, equally spaced along one polar orbit. The first is the lead: it
  // paints the imaged strip on the globe.
  const CONSTELLATION = [0, 1, 2].map((k) => ({ phase: (k * TAU) / 3 }));

  // Real spacecraft (NASA 3D Resources, Draco-compressed glTF), normalised so the longest side is
  // `size`, and placed in every holder. `basis` maps model axes into the holder frame: holder +z
  // looks at the target on the ground, holder +y points along the velocity.
  function loadSatellite(holders, file, size, basis, prepare, retries = 2) {
    if (typeof THREE.GLTFLoader !== 'function') return;
    const loader = new THREE.GLTFLoader();
    if (typeof THREE.DRACOLoader === 'function') {
      const draco = new THREE.DRACOLoader();
      draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
    }
    loader.load(
      'src/assets/models/' + file,
      (gltf) => {
        const model = gltf.scene;
        if (prepare) prepare(model);
        const box = new THREE.Box3().setFromObject(model);
        const dims = box.getSize(new THREE.Vector3());
        model.position.sub(box.getCenter(new THREE.Vector3()));
        const fit = new THREE.Group();
        fit.add(model);
        fit.scale.setScalar(size / Math.max(dims.x, dims.y, dims.z));
        const orient = new THREE.Group();
        orient.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(...basis));
        orient.add(fit);
        const mats = [];
        model.traverse((o) => {
          if (!o.isMesh) return;
          const list = Array.isArray(o.material) ? o.material : [o.material];
          list.forEach((m) => {
            if (mats.includes(m)) return;
            m.envMap = envMap;
            m.envMapIntensity = 0.7;
            m.metalness = Math.max(m.metalness, 0.25);
            m.roughness = Math.min(m.roughness, 0.6);
            m.transparent = true;
            mats.push(m);
          });
        });
        // Clones share geometry and materials, so one opacity fade drives the whole constellation.
        holders.forEach((holder, i) => {
          holder.userData.mats = mats;
          holder.add(i === 0 ? orient : orient.clone());
        });
      },
      undefined,
      (err) => {
        if (retries > 0) setTimeout(() => loadSatellite(holders, file, size, basis, prepare, retries - 1), 1500);
        else console.warn('Satellite model failed to load:', file, err);
      }
    );
  }

  // The EO-1 model has a single solar wing; give it a second one, mirrored through the bus.
  function addSecondWing(model) {
    // GLTFLoader sanitises node names ("EO-1_vFINAL [Layer1]" -> "EO-1_vFINAL_Layer1").
    let wing = null;
    let bus = null;
    model.traverse((o) => {
      if (/Layer1$/.test(o.name) && !wing) wing = o;
      if (/Layer2$/.test(o.name) && !bus) bus = o;
    });
    if (!wing || !bus || !wing.parent) return;
    model.updateMatrixWorld(true);
    const parent = wing.parent;
    const c = parent.worldToLocal(new THREE.Box3().setFromObject(bus).getCenter(new THREE.Vector3()));
    // Span axis of the wing: principal axis of its vertices, in the parent's frame.
    const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const pts = [];
    const v = new THREE.Vector3();
    wing.traverse((o) => {
      if (!o.isMesh) return;
      const m = new THREE.Matrix4().multiplyMatrices(toParent, o.matrixWorld);
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 3) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone());
    });
    const mean = pts.reduce((acc, q) => acc.add(q), new THREE.Vector3()).divideScalar(pts.length);
    const d = new THREE.Vector3(1, 0, 1).normalize();
    for (let it = 0; it < 30; it++) {
      const next = new THREE.Vector3();
      pts.forEach((q) => next.addScaledVector(v.copy(q).sub(mean), v.dot(d)));
      d.copy(next.normalize());
    }
    // Reflect across the plane normal to the span through the point on the wing's axis nearest
    // the bus, so the twin extends from the other side, in line with the original.
    const p0 = mean.clone().addScaledVector(d, v.copy(c).sub(mean).dot(d));
    c.copy(p0);
    const reflect = new THREE.Matrix4().set(
      1 - 2 * d.x * d.x, -2 * d.x * d.y, -2 * d.x * d.z, 0,
      -2 * d.y * d.x, 1 - 2 * d.y * d.y, -2 * d.y * d.z, 0,
      -2 * d.z * d.x, -2 * d.z * d.y, 1 - 2 * d.z * d.z, 0,
      0, 0, 0, 1
    );
    const pivot = new THREE.Group();
    pivot.matrixAutoUpdate = false;
    pivot.matrix
      .makeTranslation(c.x, c.y, c.z)
      .multiply(reflect)
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    pivot.add(wing.clone());
    parent.add(pivot);
  }

  function setOpacity(holder, a) {
    holder.visible = a > 0.001;
    (holder.userData.mats || []).forEach((m) => {
      m.opacity = a;
      m.depthWrite = a > 0.98;
    });
  }

  function buildOrbitAndSatellites() {
    obj.orbitGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 257 }, () => new THREE.Vector3()));
    obj.orbitMat = new THREE.LineBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0, depthWrite: false });
    obj.orbit = new THREE.Line(obj.orbitGeo, obj.orbitMat);
    obj.orbit.frustumCulled = false;
    scene.add(obj.orbit);

    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    const holders = () =>
      CONSTELLATION.map(() => {
        const g = new THREE.Group();
        g.visible = false;
        scene.add(g);
        return g;
      });
    // RADARSAT-1: antenna face is model +z, long axis model x (along track).
    obj.satsSar = holders();
    loadSatellite(obj.satsSar, 'radarsat1.glb', 3.8, [Y, X.clone().negate(), Z]);
    // EO-1: instrument deck is model +y (nadir), solar wings along model z (cross track).
    obj.satsHsi = holders();
    loadSatellite(obj.satsHsi, 'eo1.glb', 4.4, [Y, Z, X], addSecondWing);

    // Per SAR satellite: beam cone (apex at the antenna, base on the footprint, local +z),
    // transmitted pulses (cyan) and received echoes (amber).
    const coneGeo = new THREE.ConeGeometry(1, 1, 40, 1, true);
    coneGeo.rotateX(-PI / 2);
    coneGeo.translate(0, 0, 0.5);
    const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
    const glow = (color) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    obj.sarFx = CONSTELLATION.map(() => {
      const beam = new THREE.Mesh(coneGeo, glow(0x38bdf8));
      beam.renderOrder = 2;
      scene.add(beam);
      const pulses = [];
      const echoes = [];
      for (let i = 0; i < 5; i++) {
        const p = new THREE.Mesh(ringGeo, glow(0x67e8f9));
        const e = new THREE.Mesh(ringGeo, glow(0xfbbf24));
        scene.add(p, e);
        pulses.push(p);
        echoes.push(e);
      }
      return { beam, pulses, echoes };
    });
  }

  // A warm disc with a soft corona - present, but not blinding.
  function buildSun() {
    const g = new THREE.Group();
    obj.sunMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true });
    g.add(new THREE.Mesh(new THREE.SphereGeometry(4.2, 48, 24), obj.sunMat));
    obj.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeCanvasGlow('rgba(255,236,200,0.9)', 'rgba(255,170,80,0.22)'),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      })
    );
    obj.sunGlow.scale.setScalar(34);
    obj.sunHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeCanvasGlow('rgba(255,200,130,0.25)', 'rgba(255,140,60,0.05)'),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      })
    );
    obj.sunHalo.scale.setScalar(90);
    g.add(obj.sunGlow, obj.sunHalo);
    g.visible = false;
    obj.sun = g;
    scene.add(g);
  }

  // --- HTML labels pinned to 3D points --------------------------------------------

  const labels = [];

  function buildLabels() {
    const layer = document.createElement('div');
    layer.id = 'scene-labels';
    document.body.appendChild(layer);
    const add = (text, win, getPos) => {
      const el = document.createElement('div');
      el.className = 'scene-label';
      el.innerHTML = text;
      layer.appendChild(el);
      labels.push({ el, win, getPos, v: new THREE.Vector3() });
    };
    const faceDir = (phi, r, lat, out) =>
      out.set(-Math.cos(phi) * r * Math.cos(lat), r * Math.sin(lat), Math.sin(phi) * r * Math.cos(lat));

    add('Inner core', [2.2, 2.38, 2.62, 2.75], (v) => v.set(0, -0.6, 0));
    add('Outer core', [2.2, 2.38, 2.62, 2.75], (v) => faceDir(CUT_PHI, 3.9, -0.55, v));
    add('Mantle', [2.2, 2.38, 2.62, 2.75], (v) => faceDir(CUT_PHI + frame.gap, 7.6, 0.55, v));
    add('Crust', [2.2, 2.38, 2.62, 2.75], (v) => faceDir(CUT_PHI - frame.gap, 9.9, 0.95, v));
  }

  function updateLabels(s) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const l of labels) {
      const [a, b, c, d] = l.win;
      const o = Math.min(seg(s, a, b), 1 - seg(s, c, d));
      if (o <= 0.001) {
        l.el.style.opacity = '0';
        continue;
      }
      l.getPos(l.v);
      l.v.project(camera);
      if (l.v.z > 1) {
        l.el.style.opacity = '0';
        continue;
      }
      const x = (l.v.x * 0.5 + 0.5) * w;
      const y = (-l.v.y * 0.5 + 0.5) * h;
      l.el.style.opacity = o.toFixed(3);
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  // ---------------------------------------------------------------------------
  // Camera path
  // ---------------------------------------------------------------------------

  // On desktop the scene sits right of the text column by a constant amount, so nothing swings
  // side to side between sections. Portrait screens lift it above the text instead.
  const SHIFT = 0.17;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const geoCam = V(-Math.cos(CUT_PHI + 0.12), 0, Math.sin(CUT_PHI + 0.12)).multiplyScalar(36).setY(13);
  const KEYS = [
    { s: 0.5, pos: V(0, 0.3, 6.2), target: V(0, 0, 0), shift: SHIFT },
    { s: 1.5, pos: V(0, 2.1, 5.2), target: V(0, -0.15, 0), shift: SHIFT },
    { s: 2.5, pos: geoCam, target: V(0, 0, 0), shift: SHIFT },
    { s: 3.5, pos: V(-7, 6, 37), target: V(0, 0.5, 0), shift: SHIFT },
    { s: 4.5, pos: V(6, 5, 38), target: V(0, 0.5, 0), shift: SHIFT },
  ];

  const camState = { pos: new THREE.Vector3(), target: new THREE.Vector3(), shift: 0 };

  function cameraAt(s, out) {
    if (s <= KEYS[0].s) {
      out.pos.copy(KEYS[0].pos);
      out.target.copy(KEYS[0].target);
      out.shift = KEYS[0].shift;
      return out;
    }
    for (let i = 0; i < KEYS.length - 1; i++) {
      const a = KEYS[i];
      const b = KEYS[i + 1];
      if (s <= b.s) {
        const t = ease(seg(s, a.s, b.s));
        // Interpolate in spherical terms around the origin so zooms feel like zooms, not slides.
        const ra = a.pos.length();
        const rb = b.pos.length();
        const r = Math.exp(lerp(Math.log(ra), Math.log(rb), t));
        out.pos.copy(a.pos).normalize().lerp(b.pos.clone().normalize(), t).normalize().multiplyScalar(r);
        out.target.copy(a.target).lerp(b.target, t);
        out.shift = lerp(a.shift, b.shift, t);
        return out;
      }
    }
    const last = KEYS[KEYS.length - 1];
    out.pos.copy(last.pos);
    out.target.copy(last.target);
    out.shift = last.shift;
    return out;
  }

  // Orbit planes, tilted toward screen-right (away from the text) as seen from each key.
  function orbitU(key, sideAngle) {
    const d = key.pos.clone().setY(0).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(d).normalize();
    return d.multiplyScalar(Math.cos(sideAngle)).addScaledVector(right, Math.sin(sideAngle)).normalize();
  }
  const ORB_U_SAR = orbitU(KEYS[3], 0.42);
  const ORB_U_HSI = orbitU(KEYS[4], 0.3);
  const ORB_V = new THREE.Vector3(0, 1, 0);

  // Lighting for the hyperspectral pass: from behind the Earth (night side toward us) round to the
  // front-right, so the imaged side ends up in daylight.
  const hsiCam = (() => {
    const fwd = KEYS[4].target.clone().sub(KEYS[4].pos).normalize();
    const right = fwd.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const up = right.clone().cross(fwd);
    return { pos: KEYS[4].pos, fwd, right, up };
  })();
  const LIGHT_START = hsiCam.fwd.clone().addScaledVector(hsiCam.right, 0.35).addScaledVector(hsiCam.up, 0.2).normalize();
  const LIGHT_END = hsiCam.fwd.clone().negate().multiplyScalar(0.85).addScaledVector(hsiCam.right, 0.6).addScaledVector(hsiCam.up, 0.35).normalize();

  const INDIA = (() => {
    const phi = ((78.9 + 180) / 360) * TAU;
    return Math.atan2(-Math.cos(phi), Math.sin(phi));
  })();

  // ---------------------------------------------------------------------------
  // Per-frame state
  // ---------------------------------------------------------------------------

  const UP = new THREE.Vector3(0, 1, 0);
  const ORIGIN = new THREE.Vector3();
  const NO_ROTATION = new THREE.Quaternion();

  const frame = {
    loopScale: 1,
    loopPos: new THREE.Vector3(),
    loopQuat: new THREE.Quaternion(),
    gap: CUT_HALF,
    th: 0,
    satPos: new THREE.Vector3(),
    footSar: new THREE.Vector3(),
    nadir: new THREE.Vector3(),
    crossSar: new THREE.Vector2(0.05, 0.17),
  };
  const ring = { axis: new THREE.Vector3(0, 0, 1), heroPos: new THREE.Vector3(), heroScale: 0.3 };
  const orb = { u: new THREE.Vector3(1, 0, 0), v: ORB_V, n: new THREE.Vector3(0, 0, 1) };
  const tmp = {
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    d: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    ndc: new THREE.Vector2(),
  };

  function satPosAt(th, out, b = orb) {
    return out.copy(b.u).multiplyScalar(Math.cos(th)).addScaledVector(b.v, Math.sin(th)).multiplyScalar(R_ORBIT);
  }

  function groundDir(th, cross, out, b = orb) {
    return out
      .copy(b.u)
      .multiplyScalar(Math.cos(th))
      .addScaledVector(b.v, Math.sin(th))
      .multiplyScalar(Math.cos(cross))
      .addScaledVector(b.n, Math.sin(cross))
      .normalize();
  }

  // Point under a screen position, at the camera depth of `at`.
  function screenToDepth(ndc, at, out) {
    raycaster.setFromCamera(ndc, camera);
    camera.getWorldDirection(tmp.fwd);
    const depth = tmp.b.copy(at).sub(camera.position).dot(tmp.fwd);
    const t = depth / raycaster.ray.direction.dot(tmp.fwd);
    out.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, t);
    return depth;
  }

  // Track the "O" placeholder in the hero heading: its centre and size, mapped into the world.
  function trackHeroO() {
    const el = obj.heroO;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.height < 1) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    tmp.ndc.set(((r.left + r.width / 2) / w) * 2 - 1, -((r.top + r.height / 2) / h) * 2 + 1);
    const depth = screenToDepth(tmp.ndc, camState.target, ring.heroPos);
    const worldPerPx = (2 * depth * Math.tan((camera.fov * PI) / 360)) / h;
    ring.heroScale = (0.5 * r.height * 1.04 * worldPerPx) / (1 + RING_THICK);
  }

  function updateLoop(s, time, dt) {
    const toCentre = ramp(s, 0.55, 1.15);
    const thin = ramp(s, 0.6, 1.1);
    const sphere = ramp(s, 1.75, 2.2);
    const fade = 1 - ramp(s, 2.1, 2.35);

    if (s < 1.2) trackHeroO();
    frame.loopPos.copy(ring.heroPos).lerp(ORIGIN, toCentre);
    const base = Math.exp(lerp(Math.log(ring.heroScale), 0, toCentre));
    frame.loopScale = base * lerp(1, 3.7, ramp(s, 1.65, 2.4));

    // Axis toward the pointer. The pointer is pulled out of the screen by k (in ring radii), so
    // with the pointer on the ring the ring faces you, and further away it tilts toward it.
    if (state.hasPointer) {
      screenToDepth(state.ndc, frame.loopPos, tmp.c);
      const k = lerp(2.4, 0.9, toCentre) * frame.loopScale;
      tmp.c.addScaledVector(tmp.fwd, -k).sub(frame.loopPos).normalize();
    } else {
      camera.getWorldDirection(tmp.fwd);
      tmp.c.copy(tmp.fwd).negate().lerp(UP, toCentre * 0.8).normalize();
    }
    // A gyroscope's slow precession around where it is pointed.
    const wob = 0.06 * (1 - toCentre);
    tmp.c.x += wob * Math.cos(time * 1.3);
    tmp.c.y += wob * Math.sin(time * 1.3);
    tmp.c.normalize();
    tmp.d.copy(ring.axis).lerp(tmp.c, 1 - Math.exp(-dt * 5));
    if (tmp.d.lengthSq() > 1e-6) ring.axis.copy(tmp.d.normalize());
    // Stand upright before the field becomes Earth's dipole.
    frame.loopQuat.setFromUnitVectors(UP, ring.axis).slerp(NO_ROTATION, ramp(s, 1.55, 1.95));

    obj.loop.visible = fade > 0.001;
    if (!obj.loop.visible) return;
    obj.loop.position.copy(frame.loopPos);
    obj.loop.quaternion.copy(frame.loopQuat);
    obj.loop.scale.setScalar(lerp(frame.loopScale, R_OUTER, sphere));

    obj.ring.morphTargetInfluences[0] = 1 - thin;
    obj.ring.morphTargetInfluences[1] = sphere;
    obj.ring.rotation.y += dt * lerp(4.5, 0, thin);
    obj.ringMat.opacity = fade;
    obj.ringMat.transparent = fade < 0.999;
    obj.ringMat.emissiveIntensity = 0.9 * sphere;

    const axleA = 1 - ramp(s, 0.5, 0.85);
    obj.axle.visible = obj.rotor.visible = axleA > 0.001;
    obj.axleMat.opacity = axleA;

    const c = obj.charges;
    const chargeA = ramp(s, 0.85, 1.2) * (1 - ramp(s, 1.7, 1.95));
    c.points.visible = chargeA > 0.001;
    c.mat.uniforms.uOpacity.value = chargeA;
    if (!c.points.visible) return;
    const n = obj.chargePhase.length;
    for (let i = 0; i < n; i++) {
      obj.chargePhase[i] = (obj.chargePhase[i] + dt * 0.9) % TAU;
      const ph = obj.chargePhase[i];
      c.pos[i * 3] = Math.cos(ph);
      c.pos[i * 3 + 1] = 0;
      c.pos[i * 3 + 2] = Math.sin(ph);
    }
    c.geo.attributes.position.needsUpdate = true;
  }

  function updateFieldLines(s, time, dt) {
    const f = obj.field;
    if (s > 3.4 || s < 0.95) {
      f.group.visible = false;
      return;
    }
    f.group.visible = true;
    f.group.position.copy(frame.loopPos);
    f.group.quaternion.copy(frame.loopQuat);
    const mAB = ramp(s, 1.65, 2.4);
    const mBC = ramp(s, 2.75, 3.3);
    const ls = frame.loopScale;
    const { A, B, pos } = f;

    // Orbit circle state (computed inline): every line collapses onto the polar orbit.
    const n = f.nLines;
    for (let l = 0; l < n; l++) {
      const swirl = l * 0.21;
      for (let i = 0; i < N_PTS; i++) {
        const k = l * N_PTS + i;
        const o = k * 3;
        let x = lerp(A[o] * ls, B[o], mAB);
        let y = lerp(A[o + 1] * ls, B[o + 1], mAB);
        let z = lerp(A[o + 2] * ls, B[o + 2], mAB);
        if (mBC > 0) {
          const a = (i / (N_PTS - 1)) * TAU + swirl;
          const ca = Math.cos(a) * R_ORBIT;
          const sa = Math.sin(a) * R_ORBIT;
          x = lerp(x, orb.u.x * ca + orb.v.x * sa, mBC);
          y = lerp(y, orb.u.y * ca + orb.v.y * sa, mBC);
          z = lerp(z, orb.u.z * ca + orb.v.z * sa, mBC);
        }
        pos[o] = x;
        pos[o + 1] = y;
        pos[o + 2] = z;
      }
    }
    f.geo.attributes.position.needsUpdate = true;

    const grow = Math.pow(ramp(s, 0.95, 1.5), 1.6) * 12;
    const dense = ramp(s, 1.7, 2.3);
    const opacity = 1 - ramp(s, 3.05, 3.35);
    f.mat.uniforms.uGrow.value = grow;
    f.mat.uniforms.uTime.value = time;
    f.mat.uniforms.uDense.value = dense;
    f.mat.uniforms.uOpacity.value = opacity;
    f.lines.visible = opacity > 0.001 && grow > 0.01;

    // Tracers
    const t = f.tracers;
    t.points.visible = f.lines.visible;
    if (!t.points.visible) return;
    t.mat.uniforms.uOpacity.value = opacity;
    t.mat.uniforms.uSize.value = lerp(0.045, 0.32, mAB);
    const speed = lerp(0.05, 0.04, mAB);
    for (let j = 0; j < f.tracerU.length; j++) {
      f.tracerU[j] = (f.tracerU[j] + dt * speed) % 1;
      const line = f.tracerLine[j];
      const fi = f.tracerU[j] * (N_PTS - 1);
      const i0 = Math.floor(fi);
      const fr = fi - i0;
      const k0 = line * N_PTS + i0;
      const k1 = Math.min(k0 + 1, line * N_PTS + N_PTS - 1);
      for (let c = 0; c < 3; c++) t.pos[j * 3 + c] = lerp(pos[k0 * 3 + c], pos[k1 * 3 + c], fr);
      const w = lerp(f.W[k0], f.W[k1], fr);
      t.alpha[j] = (1 - clamp01((w - (grow - 0.4)) / 0.4)) * lerp(f.lineVis[line], 1, dense);
    }
    t.geo.attributes.position.needsUpdate = true;
    t.geo.attributes.aAlpha.needsUpdate = true;
  }

  function updateEarth(s, time, dt, camAz) {
    const surf = ramp(s, 1.9, 2.3);
    const coreIn = ramp(s, 1.95, 2.3);
    const close = ramp(s, 2.65, 3.05);
    frame.gap = CUT_HALF * (1 - close);

    obj.earth.visible = surf > 0.001 || coreIn > 0.001;
    if (!obj.earth.visible) return;

    // Keep India facing the viewer once we are looking at the surface.
    obj.surface.rotation.y = camAz - INDIA + time * 0.004;
    obj.clouds.rotation.y = obj.surface.rotation.y + time * 0.006;

    U.uOpacity.value = surf;
    U.uGap.value = frame.gap;
    const fading = surf < 0.999;
    obj.surfaceMat.transparent = fading;
    obj.surfaceMat.depthWrite = !fading || surf > 0.5;
    obj.atmoMat.uniforms.uOpacity.value = surf;

    const facesOn = frame.gap > 0.002;
    obj.faceA.visible = obj.faceB.visible = facesOn && surf > 0.001;
    obj.faceMat.uniforms.uOpacity.value = surf;
    obj.faceMat.transparent = fading;
    obj.faceMat.uniforms.uTime.value = time;
    const phiA = CUT_PHI + frame.gap;
    const phiB = CUT_PHI - frame.gap;
    obj.faceA.rotation.y = PI + phiA;
    obj.faceB.rotation.y = PI + phiB;

    // Cores are only visible through the wedge. The ring has just swollen into the outer core.
    const coreVis = coreIn * clamp01(frame.gap / (CUT_HALF * 0.35));
    obj.inner.visible = obj.outer.visible = coreVis > 0.001;
    obj.innerMat.uniforms.uOpacity.value = coreVis;
    obj.innerMat.transparent = coreVis < 0.999;
    obj.inner.scale.setScalar(lerp(0.6, 1, coreIn));
    obj.inner.rotation.y += dt * 0.35;
    obj.outer.scale.setScalar(lerp(0.97, 1, coreIn));
    obj.outerMat.uniforms.uOpacity.value = coreVis;
    obj.outerMat.uniforms.uTime.value = time;

    updateConvection(dt, facesOn ? surf : 0, phiA, phiB);
    updateTaylorColumns(time, dt, coreVis);
  }

  function updateConvection(dt, alpha, phiA, phiB) {
    const c = obj.conv;
    c.a.points.visible = c.b.points.visible = alpha > 0.001;
    if (!c.a.points.visible) return;
    const Lr = R_CRUST - R_OUTER;
    const Lt = PI * (R_OUTER + R_CRUST) * 0.5;
    const K = 6;
    const speed = 2.2;
    const dA = [-Math.cos(phiA), Math.sin(phiA)];
    const dB = [-Math.cos(phiB), Math.sin(phiB)];
    // Push tracers slightly off each face, into the open wedge.
    const offA = [-Math.sin(phiA) * 0.06, -Math.cos(phiA) * 0.06];
    const offB = [Math.sin(phiB) * 0.06, Math.cos(phiB) * 0.06];
    for (let i = 0; i < c.xi.length; i++) {
      const xi = c.xi[i];
      const eta = c.eta[i];
      const sx = Math.sin(PI * xi);
      const cx = Math.cos(PI * xi);
      const se = Math.sin(K * PI * eta);
      const ce = Math.cos(K * PI * eta);
      const vX = ((K * PI) / Lt) * sx * ce * speed;
      const vY = -(PI / Lr) * cx * se * speed;
      c.xi[i] = Math.min(0.99, Math.max(0.01, xi + (vX / Lr) * dt));
      c.eta[i] = Math.min(0.995, Math.max(0.005, eta + (vY / Lt) * dt));
      const r = R_OUTER + c.xi[i] * Lr;
      const lat = c.eta[i] * PI - PI / 2;
      const rc = r * Math.cos(lat);
      const y = r * Math.sin(lat);
      c.a.pos.set([dA[0] * rc + offA[0], y, dA[1] * rc + offA[1]], i * 3);
      c.b.pos.set([dB[0] * rc + offB[0], y, dB[1] * rc + offB[1]], i * 3);
      const a = 0.35 + 0.65 * clamp01(vX * 1.2 + 0.4); // rising (hot) tracers glow brighter
      c.a.alpha[i] = c.b.alpha[i] = a;
    }
    [c.a, c.b].forEach((p) => {
      p.mat.uniforms.uOpacity.value = alpha;
      p.geo.attributes.position.needsUpdate = true;
      p.geo.attributes.aAlpha.needsUpdate = true;
    });
  }

  function updateTaylorColumns(time, dt, alpha) {
    const t = obj.taylor;
    t.pts.points.visible = alpha > 0.001;
    if (!t.pts.points.visible) return;
    t.pts.mat.uniforms.uOpacity.value = alpha * 0.55;
    const rhoC = 3.65;
    const ymax = Math.sqrt(R_OUTER * R_OUTER - (rhoC + 0.9) * (rhoC + 0.9));
    for (let i = 0; i < t.n; i++) {
      const k = t.col[i];
      const sign = k % 2 === 0 ? 1 : -1;
      t.ang[i] += dt * sign * (1.4 / (t.rr[i] + 0.3));
      t.y[i] += dt * t.vy[i];
      if (t.y[i] > ymax) t.y[i] = -ymax;
      if (t.y[i] < -ymax) t.y[i] = ymax;
      const colAng = (k / 8) * TAU - time * 0.08;
      const cx = rhoC * Math.cos(colAng);
      const cz = rhoC * Math.sin(colAng);
      t.pts.pos[i * 3] = cx + t.rr[i] * Math.cos(t.ang[i]);
      t.pts.pos[i * 3 + 1] = t.y[i];
      t.pts.pos[i * 3 + 2] = cz + t.rr[i] * Math.sin(t.ang[i]);
      const edge = 1 - Math.abs(t.y[i]) / ymax;
      t.pts.alpha[i] = Math.min(1, edge * 4);
    }
    t.pts.geo.attributes.position.needsUpdate = true;
    t.pts.geo.attributes.aAlpha.needsUpdate = true;
  }

  function updateOrbitAndSensors(s, time) {
    const satStage = ramp(s, 3.0, 3.3);
    const night = ramp(s, 2.8, 3.2) * (1 - ramp(s, 3.6, 4.1));
    const sarAmt = ramp(s, 3.1, 3.35) * (1 - ramp(s, 3.7, 3.95));
    const hsiAmt = ramp(s, 3.95, 4.25);
    const sunAmt = ramp(s, 3.6, 4.15);

    // Orbit basis swings from the SAR pass to the hyperspectral pass.
    orb.u.copy(ORB_U_SAR).lerp(ORB_U_HSI, ramp(s, 3.6, 4.2)).normalize();
    orb.n.crossVectors(orb.u, orb.v).normalize();
    const camSar = KEYS[3].pos.clone().normalize();
    const look = Math.sign(orb.n.dot(camSar)) || 1; // right-looking toward the viewer
    frame.crossSar.set(Math.min(look * 0.05, look * 0.17), Math.max(look * 0.05, look * 0.17));

    // Continuous orbit: rises over the south limb, passes in front, sets behind the north pole.
    frame.th = ((time * ORBIT_SPEED + 1.6) % TAU) - PI;

    U.uOrbU.value.copy(orb.u);
    U.uOrbN.value.copy(orb.n);
    U.uCrossSar.value.copy(frame.crossSar);
    U.uSarAmt.value = sarAmt;
    U.uHsiAmt.value = hsiAmt;
    U.uDark.value = night;
    U.uSun.value = sunAmt;

    // Orbit ring
    obj.orbit.visible = satStage > 0.001;
    if (obj.orbit.visible) {
      const arr = obj.orbitGeo.attributes.position.array;
      for (let i = 0; i <= 256; i++) {
        satPosAt((i / 256) * TAU, tmp.a);
        arr[i * 3] = tmp.a.x;
        arr[i * 3 + 1] = tmp.a.y;
        arr[i * 3 + 2] = tmp.a.z;
      }
      obj.orbitGeo.attributes.position.needsUpdate = true;
      obj.orbitMat.opacity = 0.3 * satStage;
    }

    // Satellites: the RADARSAT-1 constellation hands over to EO-1 on the same tracks.
    const swap = ramp(s, 3.75, 4.05);
    const halfW = ((frame.crossSar.y - frame.crossSar.x) / 2) * R_EARTH;
    const crossMid = (frame.crossSar.x + frame.crossSar.y) / 2;
    CONSTELLATION.forEach((c, k) => {
      const b = orb;
      const th = ((frame.th + c.phase + PI) % TAU + TAU) % TAU - PI;
      const pos = satPosAt(th, tmp.a, b);
      const foot = groundDir(th, crossMid, tmp.c, b).multiplyScalar(R_EARTH);
      const nadir = groundDir(th, 0, tmp.d, b).multiplyScalar(R_EARTH);
      const vel = tmp.b.copy(b.u).multiplyScalar(-Math.sin(th)).addScaledVector(b.v, Math.cos(th));
      if (k === 0) {
        frame.satPos.copy(pos);
        frame.footSar.copy(foot);
        frame.nadir.copy(nadir);
      }
      [
        [obj.satsSar[k], satStage * (1 - swap), foot],
        [obj.satsHsi[k], satStage * swap, nadir],
      ].forEach(([sat, a, aim]) => {
        setOpacity(sat, a);
        if (!sat.visible) return;
        sat.position.copy(pos);
        sat.up.copy(vel);
        sat.lookAt(aim);
      });
      // Each radar fires while it is over the visible hemisphere.
      U.uSatThs.value.setComponent(k, th);
      updateSarBeam(obj.sarFx[k], pos, foot, halfW, time + k * 0.37, sarAmt * satStage);
    });

    updateSun(s, sunAmt);
  }

  function updateSarBeam(fx, from, to, halfW, time, amt) {
    const on = amt > 0.001;
    fx.beam.visible = on;
    fx.pulses.forEach((m) => (m.visible = on));
    fx.echoes.forEach((m) => (m.visible = on));
    if (!on) return;
    const len = from.distanceTo(to);
    fx.beam.position.copy(from);
    fx.beam.lookAt(to);
    fx.beam.scale.set(halfW, halfW, len);
    fx.beam.material.opacity = 0.1 * amt;

    const n = fx.pulses.length;
    for (let i = 0; i < n; i++) {
      const f = ((time * 0.9 + i / n) % 1 + 1) % 1;
      const pm = fx.pulses[i];
      pm.position.copy(from).lerp(to, f);
      pm.lookAt(from);
      pm.scale.setScalar(0.05 + halfW * f);
      pm.material.opacity = amt * 0.85 * Math.sin(PI * f);

      const g = ((time * 0.9 + i / n + 0.5) % 1 + 1) % 1; // echoes return, collapsing onto the antenna
      const em = fx.echoes[i];
      em.position.copy(to).lerp(from, g);
      em.lookAt(from);
      em.scale.setScalar(0.05 + halfW * 0.6 * (1 - g));
      em.material.opacity = amt * 0.7 * Math.sin(PI * g);
    }
  }

  function updateSun(s, amt) {
    const rise = ramp(s, 3.7, 4.45);
    U.uSunDir.value.copy(LIGHT_START).lerp(LIGHT_END, rise).normalize();
    obj.sun.visible = amt > 0.001;
    if (!obj.sun.visible) return;
    // The Sun is at infinity, so it is placed relative to the camera: it rises from behind the
    // Earth and settles upper right (desktop) or above the globe (portrait).
    const portrait = window.innerWidth < window.innerHeight;
    camera.getWorldDirection(tmp.fwd);
    const right = tmp.a.crossVectors(tmp.fwd, UP).normalize();
    const up = tmp.c.crossVectors(right, tmp.fwd);
    const x = lerp(0.02, portrait ? 0.1 : 0.3, rise);
    const y = lerp(-0.02, portrait ? 0.16 : 0.27, rise);
    obj.sun.position
      .copy(tmp.fwd)
      .addScaledVector(right, x)
      .addScaledVector(up, y)
      .normalize()
      .multiplyScalar(210)
      .add(camera.position);
    obj.sunMat.opacity = amt;
    obj.sunGlow.material.opacity = amt * 0.8;
    obj.sunHalo.material.opacity = amt * 0.6;
    obj.key.position.copy(U.uSunDir.value).multiplyScalar(10);
  }

  // Point on the globe under the pointer, if there is one.
  function pointerOnEarth(out) {
    raycaster.setFromCamera(state.ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const b = o.dot(d);
    const disc = b * b - (o.lengthSq() - R_EARTH * R_EARTH);
    if (disc <= 0 || -b - Math.sqrt(disc) <= 0) return false;
    out.copy(o).addScaledVector(d, -b - Math.sqrt(disc));
    return true;
  }

  // Geophysics: the pointer becomes a bar magnet that lines up with Earth's field where it is -
  // on the surface when over the globe (like a compass), otherwise in the plane through the
  // Earth's centre. Dipole moment points to geographic south, tilted like the field lines.
  const DIPOLE_M = new THREE.Vector3(0, -1, 0).applyMatrix4(
    new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, -1).normalize(), MAG_TILT)
  );
  const magnetQuat = new THREE.Quaternion();

  function buildMagnet() {
    const g = new THREE.Group();
    const mat = (color) =>
      new THREE.MeshStandardMaterial({
        color,
        metalness: 0.35,
        roughness: 0.35,
        envMap,
        envMapIntensity: 0.9,
        transparent: true,
        depthTest: false, // drawn over the scene, like a cursor
      });
    obj.magnetMats = [mat(0xe23b3b), mat(0xdde3ea)];
    const half = new THREE.BoxGeometry(0.2, 0.5, 0.2);
    [0.25, -0.25].forEach((y, i) => {
      const m = new THREE.Mesh(half, obj.magnetMats[i]); // north (red) along +y
      m.position.y = y;
      m.renderOrder = 20;
      g.add(m);
    });
    g.visible = false;
    obj.magnet = g;
    scene.add(g);
  }

  function updateMagnet(s, dt) {
    const headerPx = 72;
    const inHeader = state.ndc.y > 1 - (2 * headerPx) / window.innerHeight;
    const amt = state.hasPointer && !inHeader ? ramp(s, 1.95, 2.2) * (1 - ramp(s, 2.8, 3.0)) : 0;
    document.body.classList.toggle('magnet-cursor', amt > 0.5);
    obj.magnet.visible = amt > 0.001;
    if (!obj.magnet.visible) return;

    const p = tmp.a;
    if (!pointerOnEarth(p)) screenToDepth(state.ndc, ORIGIN, p);
    const r = p.length();
    const B = tmp.b;
    if (r < R_OUTER) {
      B.copy(DIPOLE_M); // inside the source region the field runs along the moment
    } else {
      const rh = tmp.c.copy(p).divideScalar(r);
      B.copy(rh).multiplyScalar(3 * DIPOLE_M.dot(rh)).sub(DIPOLE_M).normalize();
    }
    magnetQuat.setFromUnitVectors(UP, B);
    if (obj.magnet.userData.placed) obj.magnet.quaternion.slerp(magnetQuat, 1 - Math.exp(-dt * 12));
    else obj.magnet.quaternion.copy(magnetQuat);
    obj.magnet.userData.placed = true;
    obj.magnet.position.copy(p);
    obj.magnet.scale.setScalar(camera.position.distanceTo(p) * 0.075);
    obj.magnetMats.forEach((m) => (m.opacity = amt));
  }

  // SAR / hyperspectral: the pointer is a magnifying glass. Whatever it covers on the globe is
  // shown as a radar image (SAR) or a false-colour infrared composite (hyperspectral).
  const LENS_R = 64; // CSS px
  function updateHover(s) {
    const sarMode = ramp(s, 3.2, 3.4) * (1 - ramp(s, 3.75, 3.95));
    const hsiMode = ramp(s, 4.0, 4.25);
    const inHeader = state.py < 72;
    const footer = obj.footerEl || (obj.footerEl = document.querySelector('.hud-footer'));
    const inFooter = footer && state.py >= footer.getBoundingClientRect().top;
    const amt = state.hasPointer && !inHeader && !inFooter ? Math.max(sarMode, hsiMode) : 0;
    const pr = renderer.getPixelRatio();
    U.uHoverSar.value = sarMode;
    U.uHoverHsi.value = hsiMode;
    U.uHoverAmt.value = amt > 0.001 ? 1 : 0;
    U.uLensPx.value.set(state.px * pr, (window.innerHeight - state.py) * pr);
    U.uLensR.value = LENS_R * pr;

    const el = obj.lensEl;
    document.body.classList.toggle('lens-cursor', amt > 0.5);
    el.style.opacity = amt.toFixed(3);
    if (amt <= 0.001) return;
    el.style.setProperty('--lens-r', `${LENS_R}px`);
    el.classList.toggle('hsi', hsiMode > sarMode);
    el.style.transform = `translate(${state.px.toFixed(1)}px, ${state.py.toFixed(1)}px)`;
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  function placeCamera(s) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const portrait = w < h;
    const pull = portrait ? Math.min(2.1, 0.85 / (w / h)) : 1;
    const dist = camState.pos.length();
    camera.position.copy(camState.pos).multiplyScalar(pull);
    // Gentle parallax once the pointer is no longer steering the ring.
    const par = ramp(s, 1.8, 2.4);
    const right = tmp.a.set(camState.pos.z, 0, -camState.pos.x).normalize();
    camera.position.addScaledVector(right, state.smoothMouseX * dist * 0.05 * par);
    camera.position.y -= state.smoothMouseY * dist * 0.03 * par;
    camera.lookAt(camState.target);
    // Desktop: scene to the right of the text. Portrait: scene above the text.
    const shiftX = portrait ? 0 : camState.shift;
    const shiftY = portrait ? 0.2 : 0;
    camera.setViewOffset(w, h, -shiftX * w, shiftY * h, w, h);
    camera.updateMatrixWorld();
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    state.stage += (state.target - state.stage) * (1 - Math.exp(-dt * 4));
    const s = state.stage;
    state.smoothMouseX += (state.ndc.x * 0.5 - state.smoothMouseX) * 0.05;
    state.smoothMouseY += (-state.ndc.y * 0.5 - state.smoothMouseY) * 0.05;

    cameraAt(s, camState);
    placeCamera(s);
    const camAz = Math.atan2(camState.pos.x, camState.pos.z);

    updateLoop(s, time, dt);
    updateFieldLines(s, time, dt);
    updateEarth(s, time, dt, camAz);
    updateOrbitAndSensors(s, time);
    updateHover(s);
    updateMagnet(s, dt);

    updateLabels(s);
    renderer.render(scene, camera);
  }

  function updatePointScale() {
    const pr = renderer.getPixelRatio();
    pointScale = (window.innerHeight * pr) / (2 * Math.tan((camera.fov * PI) / 360));
    glowMaterials.forEach((m) => (m.uniforms.uScale.value = pointScale));
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updatePointScale();
  }

  // ---------------------------------------------------------------------------
  // Public API (used by main.js)
  // ---------------------------------------------------------------------------

  window.Portfolio3D = {
    setStage(s) {
      if (debugStage === null) state.target = s;
    },
  };

  window.addEventListener('DOMContentLoaded', () => {
    if (initThree()) animate();
  });
})();
