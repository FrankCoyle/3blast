import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const canvas = document.getElementById('c');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

const scoreEl = document.getElementById('score');
const highScoreEl = document.getElementById('highScore');
const weaponEl = document.getElementById('weapon');
const fpsEl = document.getElementById('fps');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// -----------------
// Audio (simple synth)
// -----------------
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep({ type = 'sine', freq = 440, dur = 0.08, gain = 0.05, detune = 0 } = {}) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  o.detune.setValueAtTime(detune, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.01);
}

function noiseBurst({ dur = 0.08, gain = 0.06 } = {}) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const bufferSize = Math.floor(audioCtx.sampleRate * dur);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(180, t0);

  src.connect(hp).connect(g).connect(audioCtx.destination);
  src.start(t0);
  src.stop(t0 + dur);
}

// -----------------
// Scene
// -----------------
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0d18, 0.0015);

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
camera.position.set(0, 0, 0);

// Player rig: move this for flight. Keep camera local offset for shake.
const player = new THREE.Object3D();
scene.add(player);
player.add(camera);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.58;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.85, 0.12);
composer.addPass(bloomPass);

const crtPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uScanline: { value: 0.18 },
    uVignette: { value: 0.38 },
    uChromatic: { value: 0.9 },
    uCurvature: { value: 0.22 },
    uNoise: { value: 0.22 },
    uFlash: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uScanline;
    uniform float uVignette;
    uniform float uChromatic;
    uniform float uCurvature;
    uniform float uNoise;
    uniform float uFlash;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    vec2 barrel(vec2 uv, float k) {
      vec2 p = uv * 2.0 - 1.0;
      float r2 = dot(p, p);
      p *= 1.0 + k * r2;
      return (p * 0.5 + 0.5);
    }

    void main() {
      vec2 uv = barrel(vUv, uCurvature * 0.12);

      // slight chromatic aberration
      vec2 ca = (uv - 0.5) * (0.0022 * uChromatic);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - ca).b;

      // scanlines
      float scan = sin((uv.y * uResolution.y) * 3.14159) * 0.5 + 0.5;
      float scan2 = sin((uv.y * uResolution.y) * 0.5) * 0.5 + 0.5;
      float scanMix = mix(scan, scan2, 0.35);
      col *= 1.0 - uScanline * (0.25 + 0.75 * (1.0 - scanMix));

      // subtle horizontal wobble
      float wob = sin(uTime * 1.1 + uv.y * 12.0) * 0.0008;
      col = mix(col, texture2D(tDiffuse, uv + vec2(wob, 0.0)).rgb, 0.35);

      // noise/grain
      float n = hash(uv * uResolution.xy + uTime * 60.0);
      col += (n - 0.5) * uNoise * 0.10;

      // vignette
      vec2 p = uv * 2.0 - 1.0;
      float vig = smoothstep(1.25, 0.25, dot(p, p));
      col *= mix(1.0 - uVignette, 1.0, vig);

      // phosphor-ish curve
      col = pow(max(col, 0.0), vec3(0.92));

      // flash on big impacts
      col += vec3(0.35, 0.45, 0.65) * uFlash;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
composer.addPass(crtPass);

// Lighting
const hemi = new THREE.HemisphereLight(0xd6e5ff, 0x1d2240, 1.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2dd, 1.90);
sun.position.set(180, 220, 120);
sun.castShadow = false;
scene.add(sun);

// Subtle rim light for neon edges
const rim = new THREE.DirectionalLight(0x6b7cff, 0.55);
rim.position.set(-140, 90, -120);
scene.add(rim);

// Fill light so buildings read in the fog
const fill = new THREE.DirectionalLight(0x9db7ff, 0.80);
fill.position.set(60, 120, -220);
scene.add(fill);

// Low ambient lift (keeps shadows from crushing)
const amb = new THREE.AmbientLight(0x222a48, 0.72);
scene.add(amb);

// Ground
const groundGeo = new THREE.PlaneGeometry(2000, 2000, 1, 1);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0b0f17, roughness: 1.0, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
scene.add(ground);

// Add subtle grid lines (procedural)
const grid = new THREE.GridHelper(2000, 200, 0x24407a, 0x162544);
grid.material.opacity = 0.13;
grid.material.transparent = true;
scene.add(grid);

// Sky: gradient skydome (gives the scene an actual sky)
const skyTop = new THREE.Color(0x4f7dff);
const skyBottom = new THREE.Color(0x0a0d18);

const skyGeo = new THREE.SphereGeometry(1800, 48, 24);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    uTop: { value: skyTop },
    uBottom: { value: skyBottom },
    uOffset: { value: 0.10 },
    uExponent: { value: 0.75 },
  },
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `,
  fragmentShader: `
    uniform vec3 uTop;
    uniform vec3 uBottom;
    uniform float uOffset;
    uniform float uExponent;
    varying vec3 vWorldPos;
    void main() {
      float h = normalize(vWorldPos).y;
      float t = max(h + uOffset, 0.0);
      t = pow(t, uExponent);
      vec3 col = mix(uBottom, uTop, t);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
});

const skyMesh = new THREE.Mesh(skyGeo, skyMat);
skyMesh.renderOrder = -10;
scene.add(skyMesh);

// Starfield backdrop (retro arcade vibe)
const starGroup = new THREE.Group();
scene.add(starGroup);

function spawnStarfield(count = 1600) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const c1 = new THREE.Color(0x8fb6ff);
  const c2 = new THREE.Color(0xff9a5a);

  for (let i = 0; i < count; i++) {
    const r = 520 + Math.random() * 900;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi) * 0.55 + 260;
    const z = r * Math.sin(phi) * Math.sin(theta);

    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    const mix = Math.random();
    const col = c1.clone().lerp(c2, mix * 0.25).multiplyScalar(0.6 + Math.random() * 0.7);
    colors[i * 3 + 0] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const m = new THREE.PointsMaterial({
    size: 1.2,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
  });

  const pts = new THREE.Points(g, m);
  starGroup.add(pts);
}

spawnStarfield();

// -----------------
// City / Buildings
// -----------------
const cityGroup = new THREE.Group();
scene.add(cityGroup);

// Extra city dressing (roads/trees/cars)
const roadsGroup = new THREE.Group();
roadsGroup.renderOrder = 1;
scene.add(roadsGroup);

const propsGroup = new THREE.Group();
scene.add(propsGroup);

const trafficGroup = new THREE.Group();
scene.add(trafficGroup);

const buildings = [];

let cityState = {
  rows: 18,
  cols: 18,
  spacing: 18,
  halfW: (18 - 1) * 18 * 0.5,
  halfD: (18 - 1) * 18 * 0.5,
};

function createRoadTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');

  // asphalt base
  ctx.fillStyle = '#0b0f18';
  ctx.fillRect(0, 0, c.width, c.height);

  // subtle noise
  const img = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() * 18) | 0;
    img.data[i + 0] = Math.min(255, img.data[i + 0] + n);
    img.data[i + 1] = Math.min(255, img.data[i + 1] + n);
    img.data[i + 2] = Math.min(255, img.data[i + 2] + n);
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // lane markings (center dashed + faint edges)
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 6;
  ctx.setLineDash([28, 22]);
  ctx.beginPath();
  ctx.moveTo(c.width * 0.5, 0);
  ctx.lineTo(c.width * 0.5, c.height);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255, 214, 120, 0.30)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(c.width * 0.18, 0);
  ctx.lineTo(c.width * 0.18, c.height);
  ctx.moveTo(c.width * 0.82, 0);
  ctx.lineTo(c.width * 0.82, c.height);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 16;
  return tex;
}

const roadTexture = createRoadTexture();
const roadMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: roadTexture,
  roughness: 0.95,
  metalness: 0.0,
  emissive: new THREE.Color(0x0b1225),
  emissiveIntensity: 0.35,
});

function clearGroup(g) {
  while (g.children.length) {
    const child = g.children[g.children.length - 1];
    g.remove(child);
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
    else child.material?.dispose?.();
  }
}

function spawnRoads() {
  clearGroup(roadsGroup);
  const { rows, cols, spacing, halfW, halfD } = cityState;

  const roadW = 8.5;
  const y = 0.02;

  const lenZ = (rows - 1) * spacing + spacing;
  const lenX = (cols - 1) * spacing + spacing;

  // Vertical roads (along Z), between columns
  for (let c = 0; c < cols - 1; c++) {
    const x = (c * spacing - halfW) + spacing * 0.5;
    const geo = new THREE.PlaneGeometry(roadW, lenZ);
    const mesh = new THREE.Mesh(geo, roadMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, 0);
    mesh.material.map.repeat.set(1, lenZ / 28);
    mesh.material.map.rotation = 0;
    roadsGroup.add(mesh);
  }

  // Horizontal roads (along X), between rows
  for (let r = 0; r < rows - 1; r++) {
    const z = (r * spacing - halfD) + spacing * 0.5;
    const geo = new THREE.PlaneGeometry(lenX, roadW);
    const mesh = new THREE.Mesh(geo, roadMaterial);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, y, z);
    mesh.material.map.repeat.set(1, lenX / 28);
    mesh.material.map.rotation = Math.PI / 2;
    roadsGroup.add(mesh);
  }

  // Main boulevard (wider, centered)
  {
    const boulevardW = spacing * 1.35;
    const geo = new THREE.PlaneGeometry(boulevardW, lenZ);
    const m = roadMaterial.clone();
    m.emissiveIntensity = 0.45;
    const mesh = new THREE.Mesh(geo, m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, y + 0.002, 0);
    mesh.material.map.repeat.set(1, lenZ / 18);
    mesh.material.map.rotation = 0;
    roadsGroup.add(mesh);
  }
}

let treeTrunks = null;
let treeCanopies = null;

function spawnTrees() {
  // Keep trees simple + fast via instancing.
  if (treeTrunks) propsGroup.remove(treeTrunks);
  if (treeCanopies) propsGroup.remove(treeCanopies);

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.28, 2.0, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1d, roughness: 1.0, metalness: 0.0 });
  const canopyGeo = new THREE.IcosahedronGeometry(1.35, 0);
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x1e6b3e,
    roughness: 1.0,
    metalness: 0.0,
    emissive: new THREE.Color(0x0f2a18),
    emissiveIntensity: 0.25,
  });

  const count = 260;
  treeTrunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  treeCanopies = new THREE.InstancedMesh(canopyGeo, canopyMat, count);
  treeTrunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  treeCanopies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const dummy = new THREE.Object3D();
  const { spacing, halfW, halfD } = cityState;

  let placed = 0;
  let tries = 0;
  while (placed < count && tries < count * 20) {
    tries++;
    const x = (Math.random() * 2 - 1) * (halfW + spacing * 0.25);
    const z = (Math.random() * 2 - 1) * (halfD + spacing * 0.25);

    // Prefer parks and boulevard edges
    const inPark = Math.abs(z) < spacing * 0.55 && Math.abs(x) > spacing * 3;
    const nearBoulevard = Math.abs(x) < spacing * 1.2 && Math.abs(z) > spacing * 1.2;
    if (!inPark && !nearBoulevard && Math.random() < 0.70) continue;

    // Avoid the center of roads a bit
    const roadBand = Math.abs((Math.abs(x) % spacing) - spacing * 0.5) < 4.5 || Math.abs((Math.abs(z) % spacing) - spacing * 0.5) < 4.5;
    if (roadBand && !inPark && Math.random() < 0.85) continue;

    const s = 0.85 + Math.random() * 0.7;
    dummy.position.set(x, 0.0, z);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.scale.set(s, 1.0 + Math.random() * 0.6, s);
    dummy.updateMatrix();
    treeTrunks.setMatrixAt(placed, dummy.matrix);

    dummy.position.set(x, 2.0 + Math.random() * 0.8, z);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.scale.set(1.05 + Math.random() * 0.6, 1.05 + Math.random() * 0.6, 1.05 + Math.random() * 0.6);
    dummy.updateMatrix();
    treeCanopies.setMatrixAt(placed, dummy.matrix);

    placed++;
  }

  treeTrunks.count = placed;
  treeCanopies.count = placed;
  treeTrunks.instanceMatrix.needsUpdate = true;
  treeCanopies.instanceMatrix.needsUpdate = true;

  propsGroup.add(treeTrunks);
  propsGroup.add(treeCanopies);
}

let cars = null;
let carLights = null;
let carData = [];

function spawnCars() {
  clearGroup(trafficGroup);

  const bodyGeo = new THREE.BoxGeometry(2.4, 0.9, 4.2);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x6b7cff,
    roughness: 0.55,
    metalness: 0.15,
    emissive: new THREE.Color(0x0a1020),
    emissiveIntensity: 0.35,
  });

  const lightGeo = new THREE.BoxGeometry(0.35, 0.2, 0.18);
  const lightMat = new THREE.MeshBasicMaterial({
    color: 0xfff2cc,
    transparent: true,
    opacity: 0.95,
  });

  const count = 42;
  cars = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
  carLights = new THREE.InstancedMesh(lightGeo, lightMat, count * 2);
  cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  carLights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  carData = [];
  const { spacing, halfW, halfD } = cityState;
  const lanesZ = [-(spacing * 2.5), 0, spacing * 2.5];
  const lanesX = [-(spacing * 2.5), spacing * 2.5];
  const dummy = new THREE.Object3D();

  for (let i = 0; i < count; i++) {
    const alongZ = i % 2 === 0;
    const laneOffset = alongZ ? lanesZ[i % lanesZ.length] : lanesX[i % lanesX.length];
    const speed = (alongZ ? 14 : 12) + Math.random() * 10;
    const dir = Math.random() > 0.5 ? 1 : -1;
    const t0 = Math.random();
    const color = new THREE.Color().setHSL(0.55 + (Math.random() * 0.1 - 0.05), 0.55, 0.55);
    cars.setColorAt(i, color);

    carData.push({ alongZ, laneOffset, speed, dir, t0 });

    // init matrices (updated in tick)
    dummy.position.set(0, 0.5, 0);
    dummy.rotation.y = 0;
    dummy.updateMatrix();
    cars.setMatrixAt(i, dummy.matrix);
  }

  cars.instanceColor.needsUpdate = true;
  trafficGroup.add(cars);
  trafficGroup.add(carLights);
}

const carDummy = new THREE.Object3D();
const lightDummy = new THREE.Object3D();

function updateCars(nowSec) {
  if (!cars || !carLights) return;
  const { halfW, halfD, spacing } = cityState;
  const roadY = 0.03;
  const roadSpanX = (halfW + spacing * 0.65);
  const roadSpanZ = (halfD + spacing * 0.65);

  let lightIndex = 0;

  for (let i = 0; i < carData.length; i++) {
    const c = carData[i];
    const t = (c.t0 + nowSec * (c.speed / 120)) % 1;

    if (c.alongZ) {
      const z = lerp(-roadSpanZ, roadSpanZ, t) * c.dir;
      const x = c.laneOffset;
      carDummy.position.set(x, roadY + 0.45, z);
      carDummy.rotation.y = c.dir > 0 ? 0 : Math.PI;
    } else {
      const x = lerp(-roadSpanX, roadSpanX, t) * c.dir;
      const z = c.laneOffset;
      carDummy.position.set(x, roadY + 0.45, z);
      carDummy.rotation.y = c.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }

    carDummy.updateMatrix();
    cars.setMatrixAt(i, carDummy.matrix);

    // headlight positions (front corners)
    const forward = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(0, carDummy.rotation.y, 0));
    const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, carDummy.rotation.y, 0));
    const front = carDummy.position.clone().addScaledVector(forward, 2.15);

    const leftPos = front.clone().addScaledVector(right, -0.65);
    const rightPos = front.clone().addScaledVector(right, 0.65);

    lightDummy.position.copy(leftPos).setY(roadY + 0.35);
    lightDummy.rotation.y = carDummy.rotation.y;
    lightDummy.updateMatrix();
    carLights.setMatrixAt(lightIndex++, lightDummy.matrix);

    lightDummy.position.copy(rightPos).setY(roadY + 0.35);
    lightDummy.rotation.y = carDummy.rotation.y;
    lightDummy.updateMatrix();
    carLights.setMatrixAt(lightIndex++, lightDummy.matrix);
  }

  cars.instanceMatrix.needsUpdate = true;
  carLights.count = lightIndex;
  carLights.instanceMatrix.needsUpdate = true;
}

function spawnCityDressing() {
  spawnRoads();
  spawnTrees();
  spawnCars();
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function createWindowsTexture(seed = 1) {
  const rand = makeRng(seed);
  const w = 128;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  // base
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, w, h);

  // subtle vertical gradient
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(20, 30, 60, 0.35)');
  bg.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // window grid
  const cellW = 10;
  const cellH = 12;
  const padX = 2;
  const padY = 2;

  const warmBase = [255, 210, 120];
  const coolBase = [120, 195, 255];

  for (let y = 0; y < h; y += cellH) {
    for (let x = 0; x < w; x += cellW) {
      // fewer single pixels, more clusters
      const on = rand() > 0.52;
      if (!on) continue;

      const warm = rand() > 0.55;
      const base = warm ? warmBase : coolBase;
      const bright = 0.55 + rand() * 0.55;

      const r = Math.floor(base[0] * (0.85 + rand() * 0.2));
      const g = Math.floor(base[1] * (0.85 + rand() * 0.2));
      const b = Math.floor(base[2] * (0.85 + rand() * 0.2));

      // glow underpaint
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${bright * 0.22})`;
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

      // core window
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${bright * 0.85})`;
      ctx.fillRect(x + padX, y + padY, cellW - padX * 2, cellH - padY * 2);

      // occasional larger lit strips (more realistic reads at distance)
      if (rand() > 0.92) {
        const stripW = (cellW - padX * 2) * (1.0 + Math.floor(rand() * 2));
        const stripH = Math.max(2, Math.floor((cellH - padY * 2) * 0.35));
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${bright * 0.5})`;
        ctx.fillRect(x + padX, y + padY + Math.floor((cellH - stripH) * 0.5), stripW, stripH);
      }
    }
  }

  // faint vertical neon bands
  for (let i = 0; i < 3; i++) {
    const x = Math.floor(rand() * w);
    const grad = ctx.createLinearGradient(x, 0, x, h);
    grad.addColorStop(0, 'rgba(90, 130, 255, 0.0)');
    grad.addColorStop(0.5, 'rgba(90, 130, 255, 0.18)');
    grad.addColorStop(1, 'rgba(90, 130, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 2, h);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 16;
  return tex;
}

const windowTextures = Array.from({ length: 10 }, (_, i) => createWindowsTexture(1000 + i * 97));

function createBuildingMaterial() {
  const tex = windowTextures[Math.floor(Math.random() * windowTextures.length)];
  tex.offset.set(Math.random(), Math.random());
  tex.repeat.set(1.25 + Math.random() * 2.0, 3.5 + Math.random() * 6.0);

  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.58 + (Math.random() * 0.08 - 0.04), 0.28, 0.34 + Math.random() * 0.22),
    roughness: 0.72,
    metalness: 0.05,
    map: tex,
    emissive: new THREE.Color(0x243b7a),
    emissiveMap: tex,
    emissiveIntensity: 2.05,
  });
}

function spawnCity({ rows = 18, cols = 18, spacing = 18 } = {}) {
  // clear
  for (const b of buildings) {
    if (b.mesh) cityGroup.remove(b.mesh);
  }
  buildings.length = 0;

  // A boulevard down the middle
  const halfW = (cols - 1) * spacing * 0.5;
  const halfD = (rows - 1) * spacing * 0.5;

  cityState = { rows, cols, spacing, halfW, halfD };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * spacing - halfW;
      const z = r * spacing - halfD;

      const boulevard = Math.abs(x) < spacing * 0.75;
      const park = Math.abs(z) < spacing * 0.55 && Math.abs(x) > spacing * 3;
      if (boulevard || park) continue;

      const w = 7 + Math.random() * 6;
      const d = 7 + Math.random() * 6;
      const h = 18 + Math.random() * 78;

      const geo = new THREE.BoxGeometry(w, h, d);
      const mat = createBuildingMaterial();
      const mesh = new THREE.Mesh(geo, mat);

      mesh.position.set(x + (Math.random() * 2 - 1), h / 2, z + (Math.random() * 2 - 1));
      mesh.receiveShadow = false;
      mesh.castShadow = false;

      const box = new THREE.Box3().setFromObject(mesh);
      const maxHealth = 60 + h * 1.15;

      const b = {
        mesh,
        box,
        maxHealth,
        health: maxHealth,
        alive: true,
        baseColor: mesh.material.color.clone(),
        height: h,
      };

      // Edge glow overlay (retro vector-ish)
      const edges = new THREE.EdgesGeometry(geo, 24);
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x6b7cff,
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const edgeLines = new THREE.LineSegments(edges, edgeMat);
      edgeLines.renderOrder = 2;
      mesh.add(edgeLines);

      mesh.userData.buildingIndex = buildings.length;
      buildings.push(b);
      cityGroup.add(mesh);
    }
  }
}

spawnCity();
spawnCityDressing();

function updateBuildingBox(b) {
  // Boxes are static unless we do destruction effects; recompute only on demand.
  b.box.setFromObject(b.mesh);
}

// -----------------
// FX: Debris + Particles
// -----------------
const debris = [];
const particles = [];
const shockwaves = [];
const laserBeams = [];

function spawnDebris(origin, count = 18) {
  for (let i = 0; i < count; i++) {
    const s = 0.6 + Math.random() * 1.4;
    const geo = new THREE.BoxGeometry(s, s, s);
    const mat = new THREE.MeshStandardMaterial({ color: 0x33405a, roughness: 1.0, metalness: 0.02 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(origin).add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() * 3) + 1.5, (Math.random() - 0.5) * 6));

    const vel = new THREE.Vector3((Math.random() - 0.5) * 26, 12 + Math.random() * 22, (Math.random() - 0.5) * 26);
    debris.push({ mesh: m, vel, life: 2.2 + Math.random() * 1.6 });
    scene.add(m);
  }
}

function spawnExplosionParticles(origin, color = 0x7aa9ff, count = 70) {
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.15, Math.random() - 0.5).normalize();
    const speed = 8 + Math.random() * 26;
    positions[i * 3 + 0] = origin.x;
    positions[i * 3 + 1] = origin.y;
    positions[i * 3 + 2] = origin.z;

    velocities[i * 3 + 0] = dir.x * speed;
    velocities[i * 3 + 1] = dir.y * speed;
    velocities[i * 3 + 2] = dir.z * speed;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const m = new THREE.PointsMaterial({
    color,
    size: 0.22,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const p = new THREE.Points(g, m);
  particles.push({ points: p, velocities, life: 0.75 + Math.random() * 0.35 });
  scene.add(p);
}

function spawnShockwave(origin, color = 0x7aa9ff) {
  const g = new THREE.RingGeometry(0.5, 1.2, 48);
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(origin);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 3;
  shockwaves.push({ mesh, life: 0.55, age: 0 });
  scene.add(mesh);
}

// -----------------
// Controls: Flying
// -----------------
const controls = new PointerLockControls(camera, document.body);

// Keep the camera at a stable local offset. Player altitude comes from the player rig.
camera.position.set(0, 0, 0);

const keys = new Map();
let isFiring = false;

window.addEventListener('keydown', (e) => {
  keys.set(e.code, true);
  if (e.code === 'Digit1') setWeapon('cannon');
  if (e.code === 'Digit2') setWeapon('rocket');
  if (e.code === 'Digit3') setWeapon('laser');
  if (e.code === 'KeyR') resetGame();
});

window.addEventListener('keyup', (e) => keys.set(e.code, false));
window.addEventListener('mousedown', () => (isFiring = true));
window.addEventListener('mouseup', () => (isFiring = false));

startBtn.addEventListener('click', () => {
  ensureAudio();
  controls.lock();
});

document.addEventListener('click', () => {
  // if overlay is up, clicking anywhere should start
  if (!overlay.classList.contains('hidden')) {
    ensureAudio();
    controls.lock();
  }
});

controls.addEventListener('lock', () => {
  overlay.classList.add('hidden');
});

controls.addEventListener('unlock', () => {
  overlay.classList.remove('hidden');
});

const velocity = new THREE.Vector3();
const accel = new THREE.Vector3();

function getMoveInput() {
  const forward = (keys.get('KeyW') ? 1 : 0) - (keys.get('KeyS') ? 1 : 0);
  const strafe = (keys.get('KeyD') ? 1 : 0) - (keys.get('KeyA') ? 1 : 0);
  const up = (keys.get('Space') ? 1 : 0) - (keys.get('ShiftLeft') ? 1 : 0) - (keys.get('ShiftRight') ? 1 : 0);
  return { forward, strafe, up };
}

// -----------------
// Weapons
// -----------------
let score = 0;
let highScore = Number(localStorage.getItem('3blast_highScore') || 0);

highScoreEl.textContent = String(highScore);
scoreEl.textContent = String(score);

const raycaster = new THREE.Raycaster();
const tmpV = new THREE.Vector3();

const projectiles = [];

const weaponDefs = {
  cannon: { name: 'Cannon', cooldown: 0.12, speed: 240, damage: 26, radius: 0, color: 0x9db7ff },
  rocket: { name: 'Rocket', cooldown: 0.65, speed: 140, damage: 120, radius: 18, color: 0xff8a3d },
  laser: { name: 'Laser', cooldown: 0.05, speed: 0, damage: 10, radius: 0, color: 0x7aa9ff },
};

let weaponKey = 'cannon';
let nextShotAt = 0;

function setWeapon(key) {
  if (!weaponDefs[key]) return;
  weaponKey = key;
  weaponEl.textContent = weaponDefs[key].name;
  beep({ type: 'triangle', freq: key === 'rocket' ? 220 : key === 'laser' ? 680 : 440, dur: 0.06, gain: 0.04 });
}

setWeapon('cannon');

function fire(now) {
  const w = weaponDefs[weaponKey];
  if (now < nextShotAt) return;
  nextShotAt = now + w.cooldown;

  if (weaponKey === 'laser') {
    // hitscan
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObjects(cityGroup.children, false);
    const from = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
    const to = hits.length ? hits[0].point.clone() : from.clone().add(dir.multiplyScalar(520));

    // Beam visual
    {
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array([from.x, from.y, from.z, to.x, to.y, to.z]);
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const m = new THREE.LineBasicMaterial({
        color: w.color,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(g, m);
      line.renderOrder = 4;
      laserBeams.push({ line, life: 0.06 });
      scene.add(line);
    }

    if (hits.length) {
      const hit = hits[0];
      const b = buildings[hit.object.userData.buildingIndex];
      if (b?.alive) {
        damageBuilding(b, w.damage, hit.point, w.color);
        spawnExplosionParticles(hit.point, w.color, 28);
        beep({ type: 'sine', freq: 920, dur: 0.03, gain: 0.035 });
      }
    } else {
      beep({ type: 'sine', freq: 720, dur: 0.02, gain: 0.02 });
    }
    return;
  }

  // projectile
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();

  const radius = weaponKey === 'rocket' ? 0.9 : 0.35;
  const geo = weaponKey === 'rocket' ? new THREE.ConeGeometry(radius, radius * 2.2, 10) : new THREE.SphereGeometry(radius, 10, 10);
  const mat = new THREE.MeshStandardMaterial({
    color: w.color,
    emissive: new THREE.Color(w.color),
    emissiveIntensity: 0.8,
    roughness: 0.2,
    metalness: 0.1,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin).add(dir.clone().multiplyScalar(2));
  if (weaponKey === 'rocket') {
    mesh.rotation.x = Math.PI * 0.5;
  }
  scene.add(mesh);

  const vel = dir.multiplyScalar(w.speed);

  // simple tracer line
  const tracerGeo = new THREE.BufferGeometry();
  const tracerArr = new Float32Array(6);
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerArr, 3));
  const tracerMat = new THREE.LineBasicMaterial({
    color: w.color,
    transparent: true,
    opacity: weaponKey === 'rocket' ? 0.35 : 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const tracer = new THREE.Line(tracerGeo, tracerMat);
  tracer.renderOrder = 4;
  scene.add(tracer);

  projectiles.push({ mesh, vel, life: weaponKey === 'rocket' ? 2.8 : 2.0, weapon: weaponKey, tracer, prevPos: mesh.position.clone() });

  if (weaponKey === 'rocket') {
    noiseBurst({ dur: 0.07, gain: 0.05 });
    beep({ type: 'sawtooth', freq: 140, dur: 0.07, gain: 0.03 });
  } else {
    beep({ type: 'square', freq: 520, dur: 0.04, gain: 0.03 });
  }
}

// -----------------
// Scoring + damage
// -----------------
function addScore(delta) {
  score += delta;
  scoreEl.textContent = String(score);
  if (score > highScore) {
    highScore = score;
    localStorage.setItem('3blast_highScore', String(highScore));
    highScoreEl.textContent = String(highScore);
  }
}

let shakeT = 0;
let shakeMag = 0;
const baseCamLocalPos = new THREE.Vector3(0, 0, 0);

function cameraShake(mag, t = 0.18) {
  shakeMag = Math.max(shakeMag, mag);
  shakeT = Math.max(shakeT, t);
}

function damageBuilding(b, amount, hitPoint, fxColor) {
  if (!b.alive) return;

  b.health -= amount;
  const health01 = clamp(b.health / b.maxHealth, 0, 1);
  // darken and add slight emissive flicker
  b.mesh.material.color.copy(b.baseColor).multiplyScalar(0.45 + 0.55 * health01);
  b.mesh.material.emissiveIntensity = 0.25 + (1 - health01) * 1.2;

  if (b.health <= 0) {
    b.alive = false;
    const pos = b.mesh.position.clone();
    const h = b.height;

    cityGroup.remove(b.mesh);

    spawnDebris(pos.clone().add(new THREE.Vector3(0, h * 0.2, 0)), 26);
    spawnExplosionParticles(pos.clone().add(new THREE.Vector3(0, h * 0.25, 0)), fxColor, 110);
    spawnShockwave(pos.clone().add(new THREE.Vector3(0, 0.25, 0)), fxColor);

    noiseBurst({ dur: 0.10, gain: 0.07 });
    beep({ type: 'sawtooth', freq: 90, dur: 0.12, gain: 0.03 });

    cameraShake(0.55, 0.22);
    crtPass.uniforms.uFlash.value = Math.min(1.0, crtPass.uniforms.uFlash.value + 0.45);

    addScore(Math.floor(20 + h * 0.9));
  } else {
    spawnExplosionParticles(hitPoint, fxColor, 18);
  }
}

function explodeAt(point, radius, damage, color) {
  spawnExplosionParticles(point, color, 150);
  spawnDebris(point, 14);
  spawnShockwave(point.clone().add(new THREE.Vector3(0, 0.25, 0)), color);
  cameraShake(0.85, 0.28);
  crtPass.uniforms.uFlash.value = Math.min(1.0, crtPass.uniforms.uFlash.value + 0.65);

  for (const b of buildings) {
    if (!b.alive) continue;
    const p = b.mesh.position;
    const dist = p.distanceTo(point);
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    damageBuilding(b, damage * falloff, point, color);
  }

  noiseBurst({ dur: 0.12, gain: 0.08 });
  beep({ type: 'sawtooth', freq: 75, dur: 0.16, gain: 0.03 });
}

function resetGame() {
  score = 0;
  scoreEl.textContent = String(score);

  // clear fx
  for (const d of debris) scene.remove(d.mesh);
  debris.length = 0;

  for (const p of particles) scene.remove(p.points);
  particles.length = 0;

  for (const pr of projectiles) scene.remove(pr.mesh);
  for (const pr of projectiles) if (pr.tracer) scene.remove(pr.tracer);
  projectiles.length = 0;

  for (const s of shockwaves) scene.remove(s.mesh);
  shockwaves.length = 0;

  for (const b of laserBeams) scene.remove(b.line);
  laserBeams.length = 0;

  spawnCity();
  spawnCityDressing();
  beep({ type: 'triangle', freq: 320, dur: 0.06, gain: 0.04 });
}

// -----------------
// Update loop
// -----------------
let lastT = performance.now();
let fpsAccT = 0;
let fpsFrames = 0;

function tick(now) {
  const dt = Math.min(0.033, (now - lastT) / 1000);
  lastT = now;

  crtPass.uniforms.uTime.value = now / 1000;
  crtPass.uniforms.uFlash.value = Math.max(0, crtPass.uniforms.uFlash.value - dt * 1.8);

  // slow star drift
  starGroup.position.copy(player.position);
  starGroup.rotation.y += dt * 0.02;
  skyMesh.position.copy(player.position);

  // FPS
  fpsAccT += dt;
  fpsFrames += 1;
  if (fpsAccT >= 0.5) {
    fpsEl.textContent = String(Math.round(fpsFrames / fpsAccT));
    fpsAccT = 0;
    fpsFrames = 0;
  }

  // movement
  if (controls.isLocked) {
    const { forward, strafe, up } = getMoveInput();

    const speed = keys.get('ControlLeft') || keys.get('ControlRight') ? 55 : 78;

    // Convert input to world-space, based on the camera's facing.
    const fwd = tmpV.set(0, 0, 0);
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() > 0) fwd.normalize();

    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

    accel.set(0, 0, 0);
    accel.addScaledVector(fwd, forward);
    accel.addScaledVector(right, strafe);
    accel.multiplyScalar(speed);
    accel.y = up * speed;

    velocity.addScaledVector(accel, dt);

    // damping
    const damp = Math.pow(0.06, dt);
    velocity.multiplyScalar(damp);

    // apply
    player.position.addScaledVector(velocity, dt);

    // stay above ground
    player.position.y = Math.max(4.0, player.position.y);

    // firing
    if (isFiring) fire(now / 1000);
  }

  // camera shake (applied as small local offset)
  camera.position.copy(baseCamLocalPos);
  if (shakeT > 0) {
    shakeT -= dt;
    const s = (shakeT / 0.28);
    const mag = shakeMag * s;
    camera.position.x = baseCamLocalPos.x + (Math.random() - 0.5) * mag;
    camera.position.y = baseCamLocalPos.y + (Math.random() - 0.5) * mag;
    camera.position.z = baseCamLocalPos.z + (Math.random() - 0.5) * mag;
    if (shakeT <= 0) {
      shakeMag = 0;
      camera.position.copy(baseCamLocalPos);
    }
  }

  // traffic
  updateCars(now / 1000);

  // update projectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.life -= dt;

    pr.mesh.position.addScaledVector(pr.vel, dt);

    // orient rocket along velocity
    if (pr.weapon === 'rocket') {
      const d = pr.vel.clone().normalize();
      pr.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    }

    // tracer update
    if (pr.tracer) {
      const arr = pr.tracer.geometry.attributes.position.array;
      const tail = pr.prevPos;
      const head = pr.mesh.position;
      arr[0] = tail.x;
      arr[1] = tail.y;
      arr[2] = tail.z;
      arr[3] = head.x;
      arr[4] = head.y;
      arr[5] = head.z;
      pr.tracer.geometry.attributes.position.needsUpdate = true;
      pr.tracer.material.opacity = (pr.weapon === 'rocket' ? 0.35 : 0.55) * clamp(pr.life / 2.0, 0, 1);
      pr.prevPos.copy(head);
    }

    // trail-ish glow scale
    pr.mesh.material.emissiveIntensity = 0.7 + 0.35 * Math.sin(now * 0.02);

    // collide with ground
    if (pr.mesh.position.y <= 0.6) {
      const w = weaponDefs[pr.weapon];
      if (pr.weapon === 'rocket') explodeAt(pr.mesh.position.clone(), w.radius, w.damage, w.color);
      scene.remove(pr.mesh);
      if (pr.tracer) scene.remove(pr.tracer);
      projectiles.splice(i, 1);
      continue;
    }

    // collide with buildings (cheap AABB point containment)
    let hitBuilding = null;
    for (const b of buildings) {
      if (!b.alive) continue;
      // b.box is valid while mesh exists and static
      if (b.box.containsPoint(pr.mesh.position)) {
        hitBuilding = b;
        break;
      }
    }

    if (hitBuilding) {
      const w = weaponDefs[pr.weapon];
      if (pr.weapon === 'rocket') {
        explodeAt(pr.mesh.position.clone(), w.radius, w.damage, w.color);
      } else {
        damageBuilding(hitBuilding, w.damage, pr.mesh.position.clone(), w.color);
        cameraShake(0.15, 0.12);
      }

      scene.remove(pr.mesh);
      if (pr.tracer) scene.remove(pr.tracer);
      projectiles.splice(i, 1);
      continue;
    }

    if (pr.life <= 0) {
      // expire
      if (pr.weapon === 'rocket') {
        const w = weaponDefs.rocket;
        explodeAt(pr.mesh.position.clone(), w.radius * 0.75, w.damage * 0.65, w.color);
      }
      scene.remove(pr.mesh);
      if (pr.tracer) scene.remove(pr.tracer);
      projectiles.splice(i, 1);
    }
  }

  // laser beam fade
  for (let i = laserBeams.length - 1; i >= 0; i--) {
    const b = laserBeams[i];
    b.life -= dt;
    b.line.material.opacity = clamp(b.life / 0.06, 0, 1);
    if (b.life <= 0) {
      scene.remove(b.line);
      laserBeams.splice(i, 1);
    }
  }

  // update debris
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    d.vel.y -= 26 * dt;
    d.mesh.position.addScaledVector(d.vel, dt);
    d.mesh.rotation.x += dt * 2.8;
    d.mesh.rotation.z += dt * 3.1;

    if (d.mesh.position.y < 0.4) {
      d.mesh.position.y = 0.4;
      d.vel.multiplyScalar(0.45);
      d.vel.y = Math.abs(d.vel.y) * 0.25;
    }

    d.mesh.material.opacity = clamp(d.life / 3.2, 0, 1);
    d.mesh.material.transparent = true;

    if (d.life <= 0) {
      scene.remove(d.mesh);
      debris.splice(i, 1);
    }
  }

  // update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    const g = p.points.geometry;
    const arr = g.attributes.position.array;
    for (let j = 0; j < arr.length / 3; j++) {
      const vx = p.velocities[j * 3 + 0];
      const vy = p.velocities[j * 3 + 1];
      const vz = p.velocities[j * 3 + 2];

      arr[j * 3 + 0] += vx * dt;
      arr[j * 3 + 1] += vy * dt;
      arr[j * 3 + 2] += vz * dt;

      // gravity + drag
      p.velocities[j * 3 + 1] -= 16 * dt;
      p.velocities[j * 3 + 0] *= Math.pow(0.35, dt);
      p.velocities[j * 3 + 1] *= Math.pow(0.35, dt);
      p.velocities[j * 3 + 2] *= Math.pow(0.35, dt);
    }
    g.attributes.position.needsUpdate = true;

    p.points.material.opacity = clamp(p.life / 1.1, 0, 1);

    if (p.life <= 0) {
      scene.remove(p.points);
      particles.splice(i, 1);
    }
  }

  // shockwaves
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const s = shockwaves[i];
    s.life -= dt;
    s.age += dt;
    const t = 1 - clamp(s.life / 0.55, 0, 1);
    const scale = lerp(1.0, 26.0, t);
    s.mesh.scale.set(scale, scale, scale);
    s.mesh.material.opacity = (1 - t) * 0.55;
    if (s.life <= 0) {
      scene.remove(s.mesh);
      shockwaves.splice(i, 1);
    }
  }

  composer.render();
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// -----------------
// Resize
// -----------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  crtPass.uniforms.uResolution.value.set(w, h);
}

window.addEventListener('resize', onResize);

// Put player somewhere nice
player.position.set(0, 22, 90);

// Update building AABBs once after creation (cheap and stable)
for (const b of buildings) updateBuildingBox(b);

// When city is respawned, rebuild boxes
const _spawnCity = spawnCity;
spawnCity = (...args) => {
  _spawnCity(...args);
  for (const b of buildings) updateBuildingBox(b);
};
