// web/src/scene/gl.mjs — the WebGL half of the scene (lazy chunk /dist/scene-gl.js).
// three.js 0.170.0 from /dist/vendor/three.module.min.js (external), OrbitControls bundled in.
// Procedural only (look picked from style draft B): noise-displaced icosahedra rendered as frosted glass
// (back faces + crisp edges + front faces with a frost pattern and an inner core), tube strings with a light pulse,
// one Points cloud of rime. Cluster / live crystals hold one cobalt speck per blocked address (data, not decoration).
// No textures, no post-processing, no environment map, no shadows.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCENE, sceneWorld, sceneRadius } from '../../../shared/layout.mjs';

const C = {
  fog: new THREE.Color('#DCE8F1'), cold: new THREE.Color('#7FB3FF'), cobalt: new THREE.Color('#1E45C9'), amber: new THREE.Color('#C47A1C'),
  graphite: new THREE.Color('#6B7A86'), amberCore: new THREE.Color('#D88A22'), steel: new THREE.Color('#5D7891'), pulse: new THREE.Color('#2F6FE4'),
  string: new THREE.Color('#9AB0C2'), strBase: new THREE.Color('#7891A7'), edge: new THREE.Color('#5E7E9C'),
};

// per-state look: core colour + amount, body opacity, squash (pools/exits flatten), vertex jitter, specks (cluster/live)
const LOOK = {
  freezable: { core: C.cold, coreAmt: 0.9, op: 0.9, squash: 1, amp: 0.22 },
  blocked: { core: C.cobalt, coreAmt: 1.15, op: 0.9, squash: 1, amp: 0.2 },
  frozen: { core: C.cobalt, coreAmt: 1.0, op: 0.9, squash: 1, amp: 0.2 },
  live: { core: C.cobalt, coreAmt: 0.75, op: 0.85, squash: 1, amp: 0.14, specks: true },
  cluster: { core: C.cobalt, coreAmt: 0.5, op: 0.85, squash: 1, amp: 0.16, specks: true },
  unblocked: { core: C.amberCore, coreAmt: 0.8, op: 0.9, squash: 1, amp: 0.22 },
  victim: { core: C.steel, coreAmt: 0.35, op: 0.8, squash: 1, amp: 0.18 },
  plain: { core: C.steel, coreAmt: 0.35, op: 0.85, squash: 1, amp: 0.22 },
  contract: { core: C.graphite, coreAmt: 0.6, op: 0.85, squash: 0.55, amp: 0.14 },
  pool: { core: C.graphite, coreAmt: 0.6, op: 0.8, squash: 0.45, amp: 0.1 },
  router: { core: C.graphite, coreAmt: 0.6, op: 0.8, squash: 0.45, amp: 0.1 },
  'exit-eth': { core: C.amber, coreAmt: 0.8, op: 0.25, squash: 0.35, amp: 0.3 },
  'exit-other': { core: C.graphite, coreAmt: 0.5, op: 0.3, squash: 0.5, amp: 0.25 },
  'exit-stop': { core: C.graphite, coreAmt: 0.4, op: 0.35, squash: 0.7, amp: 0.25 },
};

const NOISE = /* glsl */`
float h31(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i), h31(i+vec3(1,0,0)), f.x), mix(h31(i+vec3(0,1,0)), h31(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i+vec3(0,0,1)), h31(i+vec3(1,0,1)), f.x), mix(h31(i+vec3(0,1,1)), h31(i+vec3(1,1,1)), f.x), f.y), f.z); }`;
const FOG = /* glsl */`
  float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vW));
  col = mix(col, uFog, fogF * 0.75);
  col = mix(uFog, col, uDim);`;

const crystalVert = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec3 vO;
void main(){
  vO = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normalize(position)); // smooth "through the ice" normal for the core
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const crystalFrag = /* glsl */`
uniform vec3 uCore, uRim, uFog, uKey;
uniform float uCoreAmt, uOpacity, uDim, uHi, uFogNear, uFogFar, uSeed;
varying vec3 vW; varying vec3 vN; varying vec3 vO;
${NOISE}
void main(){
  vec3 fn = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 V = normalize(cameraPosition - vW);
  if (dot(fn, V) < 0.0) fn = -fn;
  float fdv = max(dot(fn, V), 0.0);
  float ndv = max(dot(normalize(vN), V), 0.0);
  // facets: each face lit differently by the key light → crisp cut-ice planes
  float facet = dot(fn, uKey) * 0.5 + 0.5;
  // milky frosted ice: soft facet shading on a near-white body
  vec3 col = mix(vec3(0.80, 0.86, 0.92), vec3(1.0), smoothstep(0.05, 0.95, facet));
  // inner frost: rime ferns + fine grain, visible through the whole body
  float n1 = vnoise(vO * 4.2 + uSeed * 9.0), n2 = vnoise(vO * 12.0 + uSeed * 3.0), n3 = vnoise(vO * 26.0 + uSeed);
  float fern = pow(1.0 - abs(n1 * 2.0 - 1.0), 4.0);
  float frost = fern * 0.6 + n2 * 0.25 + n3 * 0.15;
  col = mix(col, vec3(0.97, 0.985, 1.0), frost * 0.6);
  float core = smoothstep(0.25, 1.0, ndv); core = core * core * uCoreAmt * (0.8 + 0.2 * n2);
#ifdef BACK
  col = mix(col * 0.9, uCore, core * 0.85);
  float a = uOpacity * 0.5 + core * 0.45;
#else
  col = mix(col, uCore, core * 0.88);
  float fres = pow(1.0 - fdv, 2.2);
  col = mix(col, uRim, fres * 0.5);
  vec3 H = normalize(uKey + V);
  float spec = pow(max(dot(fn, H), 0.0), 60.0);
  col += vec3(spec * 0.55);
  col = mix(col, vec3(1.0), uHi * 0.08);
  float a = uOpacity * (0.58 + 0.3 * fres + 0.25 * frost) + core * 0.5 + spec * 0.3;
#endif
  ${FOG}
  a = clamp(a, 0.0, 1.0) * mix(0.45, 1.0, uDim);
  gl_FragColor = vec4(col, a);
}`;
const edgeVert = /* glsl */`
varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const edgeFrag = /* glsl */`
uniform vec3 uCol, uFog; uniform float uAlpha, uDim, uFogNear, uFogFar; varying vec3 vW;
void main(){ vec3 col = uCol; ${FOG} gl_FragColor = vec4(col, uAlpha * mix(0.4, 1.0, uDim)); }`;
const speckVert = /* glsl */`
uniform float uPx; attribute float aSeed; varying float vA; varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; gl_Position = projectionMatrix * mv;
  gl_PointSize = max(2.0, uPx * (1.6 + aSeed * 1.6) * (26.0 / -mv.z)); vA = 0.55 + 0.45 * aSeed; }`;
const speckFrag = /* glsl */`
uniform vec3 uCol, uFog; uniform float uDim, uFogNear, uFogFar; varying float vA; varying vec3 vW;
void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c); if (r > 0.5) discard; vec3 col = uCol; ${FOG}
  gl_FragColor = vec4(col, smoothstep(0.5, 0.2, r) * vA * mix(0.4, 1.0, uDim)); }`;

const stringVert = /* glsl */`
varying float vU; varying vec3 vW;
void main(){ vU = uv.x; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const stringFrag = /* glsl */`
uniform float uDraw, uTime, uLen, uDim, uDash, uAlpha, uFlow, uHi, uFogNear, uFogFar, uPulseAmt, uSpeed;
uniform vec3 uBase, uPulse, uFog;
varying float vU; varying vec3 vW;
void main(){
  if (vU > uDraw) discard;
  if (uDash > 0.5 && fract(vU * uLen * 4.0) > 0.55) discard;
  float a = uAlpha;
  vec3 col = uBase;
  // light flowing from 'from' to 'to' at 0.6 units/s; two pulses per string, staggered
  float band = 0.0;
  if (uFlow > 0.5) {
    for (int k = 0; k < 2; k++) {
      float head = fract((uTime * uSpeed) / max(uLen, 0.001) + float(k) * 0.5);
      float d = (vU - head) * uLen;              // world units behind (+) / ahead (-) of the head
      float tail = d < 0.0 ? exp(d * 3.2) : exp(-d * d * 60.0);
      band = max(band, tail * step(vU, uDraw));
    }
  }
  // the drawing tip glows while the string grows
  float tip = uDraw < 1.0 ? exp(-pow((uDraw - vU) * uLen, 2.0) * 30.0) : 0.0;
  band = max(band, tip);
  band *= uPulseAmt;
  col = mix(col, uPulse, band);
  a = max(a, band * 0.95);
  col = mix(col, uPulse, uHi * 0.5); a = max(a, uHi * 0.85);
  float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vW));
  col = mix(col, uFog, fogF * 0.7);
  col = mix(uFog, col, uDim); a *= mix(0.35, 1.0, uDim);
  gl_FragColor = vec4(col, a);
}`;

const rimeVert = /* glsl */`
uniform float uTime, uSize, uPx;
attribute float aSeed; attribute vec3 aHome;
varying float vA;
void main(){
  vec3 p = aHome + vec3(sin(uTime * 0.11 + aSeed * 6.28), sin(uTime * 0.07 + aSeed * 12.1) * 0.6, cos(uTime * 0.09 + aSeed * 3.7)) * 0.22;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.5, uSize * uPx * (0.6 + aSeed) * (24.0 / -mv.z));
  vA = 0.35 + 0.5 * fract(aSeed * 7.13);
}`;
const rimeFrag = /* glsl */`
uniform vec3 uCol; uniform float uDim; varying float vA;
void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c); if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.15, r) * vA * mix(0.4, 1.0, uDim); gl_FragColor = vec4(uCol, a); }`;

const shadowVert = /* glsl */`varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const shadowFrag = /* glsl */`uniform vec3 uFog; uniform float uA, uDim, uFogNear, uFogFar; varying vec2 vUv; varying vec3 vW;
void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a = a * a * uA * mix(0.4, 1.0, uDim);
  float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vW)); gl_FragColor = vec4(vec3(0.42, 0.53, 0.63), a * (1.0 - fogF * 0.8)); }`;

const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const h01 = (s) => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; };

/** a deterministic crystal: icosahedron, vertices jittered by a hash of their position, taller than wide */
function crystalGeometry(seed, look) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (h01(seed + ':' + Math.round(x * 50) + ',' + Math.round(y * 50) + ',' + Math.round(z * 50)) - 0.5) * 2 * look.amp;
    p.setXYZ(i, x * k * 0.86, y * k * 1.36 * look.squash, z * k * 0.86);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * createGL(canvasHost, layout, opts) → controller
 * layout: from shared/layout.mjs (nodes with id/x/y/z/t/state/size; edges; ticks)
 * opts: { mode:'timeline'|'graph', pan, mobile, region:{l,r,t,b}, captureWheel, onFrame(), onLost() }
 */
export function createGL(host, layout, opts = {}) {
  const mobile = !!opts.mobile;
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile, alpha: true, powerPreference: 'high-performance' });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = 'fw-scene__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(SCENE.fov, 1, 0.1, 300);
  const world = new THREE.Group();
  scene.add(world);

  const keyDir = new THREE.Vector3(-0.5, 0.75, 0.6).normalize();
  const shared = { uFog: { value: C.fog }, uKey: { value: keyDir }, uFogNear: { value: 14 }, uFogFar: { value: 34 }, uTime: { value: 0 } };

  // ---------- geometry scale ----------
  const isTl = opts.mode === 'timeline';
  const n = layout.nodes.length;
  // portrait screens: a case graph runs top → bottom instead of left → right (the timeline keeps its diagonal)
  const portrait = opts.mode !== 'timeline' && host.clientHeight > host.clientWidth * 1.1;
  const toWorld = (nd) => { const [x, y, z] = sceneWorld(nd, opts.mode, n); return portrait ? new THREE.Vector3(y * 0.8, -x * 0.85, z) : new THREE.Vector3(x, y, z); };
  world.rotation.y = SCENE.rotY;
  const camera0 = { fov: SCENE.fov, home: SCENE.home };

  const items = new Map();
  const crystals = [];
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  for (const nd of layout.nodes) {
    const look = LOOK[nd.state] || LOOK.plain;
    const pos = toWorld(nd);
    const r = sceneRadius(nd, opts.mode) / 1.15;
    const seed = h01(nd.id);
    const geo = crystalGeometry(nd.id, look);
    const uDim = { value: 1 }, uHi = { value: 0 };
    const mk = (back) => new THREE.ShaderMaterial({
      vertexShader: crystalVert, fragmentShader: crystalFrag, transparent: true, depthWrite: !back, side: back ? THREE.BackSide : THREE.FrontSide,
      defines: back ? { BACK: 1 } : {},
      uniforms: { ...shared, uCore: { value: look.core }, uRim: { value: C.cold }, uCoreAmt: { value: look.coreAmt }, uOpacity: { value: look.op }, uDim, uHi, uSeed: { value: seed } },
    });
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.set((seed - 0.5) * 0.5, seed * 6.28, (h01(nd.id + 'z') - 0.5) * 0.35);
    const back = new THREE.Mesh(geo, mk(true)); back.renderOrder = 1;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), new THREE.ShaderMaterial({
      vertexShader: edgeVert, fragmentShader: edgeFrag, transparent: true, depthWrite: false,
      uniforms: { uFog: shared.uFog, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar, uCol: { value: C.edge }, uAlpha: { value: look.op > 0.5 ? 0.32 : 0.15 }, uDim },
    }));
    edges.renderOrder = 2;
    const front = new THREE.Mesh(geo, mk(false)); front.renderOrder = 3;
    group.add(back, edges, front);
    if (look.specks && nd.count > 0) {
      // one speck per blocked address / event, packed inside the crystal
      const cnt = Math.min(2000, nd.count | 0), arr = new Float32Array(cnt * 3), sd = new Float32Array(cnt);
      for (let i = 0; i < cnt; i++) {
        const k = i + 0.5, phi = Math.acos(1 - 2 * k / cnt), th = Math.PI * (1 + Math.sqrt(5)) * k;
        const rr = 0.62 * Math.cbrt(0.08 + 0.92 * h01(nd.id + 'k' + i));
        arr.set([Math.cos(th) * Math.sin(phi) * rr * 0.86, Math.cos(phi) * rr * 1.3, Math.sin(th) * Math.sin(phi) * rr * 0.86], i * 3);
        sd[i] = h01(nd.id + 'sd' + i);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(arr, 3)); sg.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
      const specks = new THREE.Points(sg, new THREE.ShaderMaterial({ vertexShader: speckVert, fragmentShader: speckFrag, transparent: true, depthWrite: false,
        uniforms: { uPx: { value: dpr }, uCol: { value: C.cobalt }, uFog: shared.uFog, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar, uDim } }));
      specks.renderOrder = 2;
      group.add(specks);
    }
    group.scale.setScalar(r);
    world.add(group);
    // soft contact shadow on an implied floor below the crystal (lighting, not data)
    const sh = new THREE.Mesh(shadowGeo, new THREE.ShaderMaterial({ vertexShader: shadowVert, fragmentShader: shadowFrag, transparent: true, depthWrite: false,
      uniforms: { uFog: shared.uFog, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar, uA: { value: look.op > 0.5 ? 0.22 : 0.08 }, uDim } }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(pos.x, pos.y - r * 1.9, pos.z); sh.scale.set(r * 2.6, r * 1.6, 1); sh.renderOrder = 0;
    world.add(sh);
    const it = { node: nd, group, shadow: sh, uDim, uHi, pos, r: r * 1.15, grow: 1, target: 1, t0: 0, spin: (seed - 0.5) * 0.06 };
    items.set(nd.id, it); crystals.push(it);
  }

  // ---------- strings ----------
  const strings = [];
  const strGroup = new THREE.Group(); world.add(strGroup);
  for (const e of layout.edges) {
    const a = items.get(e.from), b = items.get(e.to);
    if (!a || !b || a === b) continue;
    const kind = e.kind || 'transfer';
    const p0 = a.pos.clone(), p2 = b.pos.clone();
    const dir = p2.clone().sub(p0); const len = dir.length();
    // leave the crystal surfaces, then a gentle arc (strings are taut; the arc only separates parallel hops)
    const n0 = dir.clone().normalize();
    const s0 = p0.clone().addScaledVector(n0, a.r * 0.75), s2 = p2.clone().addScaledVector(n0, -b.r * 0.75);
    const lift = kind === 'spine' ? 0 : kind === 'pair' ? 0.22 : (0.12 + h01(e.tx + e.from) * 0.25) * Math.min(1, len / 4);
    const mid = s0.clone().lerp(s2, 0.5).add(new THREE.Vector3(0, lift, 0));
    const curve = new THREE.QuadraticBezierCurve3(s0, mid, s2);
    const rad = (kind === 'spine' ? 0.016 : kind === 'pair' ? 0.034 : kind === 'exit' ? 0.014 : 0.026) * (isTl ? 1 : 0.62);
    const tg = new THREE.TubeGeometry(curve, Math.max(24, Math.round(curve.getLength() * 14)), rad, mobile ? 4 : 6, false);
    const pulseCol = kind === 'pair' ? C.cobalt : kind === 'spine' ? new THREE.Color('#5B95F0') : kind === 'exit' && b.node.state === 'exit-eth' ? C.amber : C.pulse;
    const m = new THREE.ShaderMaterial({
      vertexShader: stringVert, fragmentShader: stringFrag, transparent: true, depthWrite: false,
      uniforms: {
        uTime: shared.uTime, uFog: shared.uFog, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar,
        uDraw: { value: 0 }, uLen: { value: curve.getLength() }, uDim: { value: 1 }, uHi: { value: 0 },
        uDash: { value: kind === 'swap' || kind === 'exit' ? 1 : 0 }, uFlow: { value: 1 },
        uPulseAmt: { value: kind === 'spine' ? 0.75 : 1 }, uSpeed: { value: kind === 'spine' ? 0.9 : kind === 'pair' ? 0.45 : 0.6 },
        uAlpha: { value: kind === 'spine' ? 0.5 : isTl ? 0.75 : 0.5 }, uBase: { value: kind === 'spine' || !isTl ? C.string : C.strBase }, uPulse: { value: pulseCol },
      },
    });
    const mesh = new THREE.Mesh(tg, m);
    strGroup.add(mesh);
    strings.push({ edge: e, mesh, mat: m, from: e.from, to: e.to, draw: 0, target: 0, len: curve.getLength() });
  }

  // ---------- rime: one small Points cloud per cold crystal, shown only once that crystal exists at time T ----------
  const glowers = crystals.filter((c) => ['freezable', 'blocked', 'frozen', 'live', 'cluster'].includes(c.node.state));
  const maxP = mobile ? 300 : 700;
  const perC = glowers.length ? Math.max(20, Math.floor(maxP / glowers.length)) : 0;
  const rimeMats = [];
  for (const c of glowers) {
    const homes = new Float32Array(perC * 3), seeds = new Float32Array(perC);
    for (let i = 0; i < perC; i++) {
      const u = h01(c.node.id + 'p' + i), v = h01(c.node.id + 'q' + i), w = h01(c.node.id + 'r' + i);
      const th = u * 6.283, ph = Math.acos(2 * v - 1), rr = c.r * (1.3 + 2.6 * Math.pow(w, 1.6));
      homes.set([c.pos.x + Math.sin(ph) * Math.cos(th) * rr, c.pos.y + Math.cos(ph) * rr * 0.8, c.pos.z + Math.sin(ph) * Math.sin(th) * rr], i * 3);
      seeds[i] = h01(c.node.id + 's' + i);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(perC * 3), 3));
    pg.setAttribute('aHome', new THREE.BufferAttribute(homes, 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const pm = new THREE.ShaderMaterial({ vertexShader: rimeVert, fragmentShader: rimeFrag, transparent: true, depthWrite: false,
      uniforms: { uTime: shared.uTime, uSize: { value: mobile ? 2.2 : 2.4 }, uPx: { value: dpr }, uCol: { value: new THREE.Color('#86A3BD') }, uDim: { value: 1 } } });
    const pts = new THREE.Points(pg, pm); pts.frustumCulled = false;
    world.add(pts); c.rime = pts; rimeMats.push(pm);
  }

  // ---------- camera + controls ----------
  const box = new THREE.Box3();
  for (const c of crystals) box.expandByPoint(c.pos.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(world.rotation.y)));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  let baseDist = 20;
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  const homeDir = new THREE.Vector3(...camera0.home).normalize();
  camera.position.copy(center).addScaledVector(homeDir, baseDist);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.enablePan = !!opts.pan; controls.screenSpacePanning = true;
  controls.minPolarAngle = 0.95; controls.maxPolarAngle = 1.85;
  controls.minAzimuthAngle = -0.9; controls.maxAzimuthAngle = 0.9;
  controls.rotateSpeed = 0.55;
  controls.enableZoom = !!opts.captureWheel;

  // fit: the camera distance at which every crystal (with its radius) lies inside the region of the viewport
  const spheres = () => crystals.map((c) => ({ p: world.localToWorld(c.pos.clone()), r: c.r }));
  function fitDistance(region, dir) {
    const sp = spheres(), v = new THREE.Vector3(), tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const ok = (d) => {
      camera.position.copy(controls.target).addScaledVector(dir, d); camera.lookAt(controls.target); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      for (const q of sp) {
        v.copy(q.p).project(camera);
        const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
        const rp = q.r / (camera.position.distanceTo(q.p) * tanH) * H * 0.5;
        if (x - rp < region.l * W || x + rp > region.r * W || y - rp < region.t * H || y + rp > region.b * H) return false;
      }
      return true;
    };
    let lo = 2, hi = 400;
    for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
    return hi;
  }
  let idleSince = performance.now(), driftBase = null;
  let W = 1, H = 1;
  const touched = () => { idleSince = performance.now(); driftBase = null; userMoved = true; };
  controls.addEventListener('start', touched);
  const onWheel = (ev) => {
    if (opts.captureWheel) return;
    // landing: wheel scrolls the page; ctrl/pinch zooms
    controls.enableZoom = !!ev.ctrlKey;
    if (ev.ctrlKey) touched();
  };
  canvas.addEventListener('wheel', onWheel, { passive: true, capture: true });

  // ---------- sizing (region keeps the scene to the right of the HUD) ----------
  let userMoved = false;
  function resize() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    const reg = { l: 0.06, r: 0.94, t: 0.12, b: 0.88, ...(opts.region || {}) };
    // shift the projection so the camera target lands at the centre of the region
    camera.setViewOffset(W, H, -((reg.l + reg.r) / 2 - 0.5) * W, -((reg.t + reg.b) / 2 - 0.5) * H, W, H);
    camera.updateProjectionMatrix();
    if (!userMoved) {
      baseDist = fitDistance(reg, homeDir);
      controls.minDistance = baseDist * 0.6; controls.maxDistance = baseDist * 2.5;
      camera.position.copy(controls.target).addScaledVector(homeDir, baseDist);
      controls.update();
      shared.uFogNear.value = baseDist * 0.95; shared.uFogFar.value = baseDist * 2.4;
    }
    for (const m of rimeMats) m.uniforms.uPx.value = dpr * Math.min(1.4, Math.max(0.7, H / 800));
  }
  resize();

  // ---------- time ----------
  let T = Infinity;
  function setTime(block, instant = false) {
    T = block;
    const now = performance.now();
    for (const c of crystals) {
      const on = c.node.firstBlock == null || c.node.firstBlock <= T;
      const tgt = on ? 1 : 0;
      if (tgt !== c.target) { c.target = tgt; c.t0 = now; c.from = c.grow; }
      if (instant) { c.grow = tgt; c.from = tgt; }
    }
    for (const s of strings) {
      const on = s.edge.block == null || s.edge.block <= T;
      s.target = on ? 1 : 0;
      if (instant) s.draw = s.target;
    }
  }

  // ---------- lens ----------
  let lensId = null;
  function setLens(id) {
    lensId = id;
    const inc = new Set();
    if (id) { inc.add(id); for (const s of strings) if (s.from === id || s.to === id) { inc.add(s.from); inc.add(s.to); } }
    for (const c of crystals) {
      const d = !id || inc.has(c.node.id) ? 1 : 0.4;
      c.dimT = d; c.hiT = id === c.node.id ? 1 : 0;
    }
    for (const s of strings) { s.dimT = !id || s.from === id || s.to === id ? 1 : 0.4; s.hiT = id && (s.from === id || s.to === id) && s.edge.kind !== 'spine' ? 1 : 0; }
    for (const m of rimeMats) m.uniforms.uDim.value = id ? 0.4 : 1;
  }
  setLens(null);

  // ---------- projection + picking ----------
  const tmp = new THREE.Vector3();
  function project(id) {
    const c = items.get(id); if (!c) return null;
    tmp.copy(c.pos); world.localToWorld(tmp);
    const dist = camera.position.distanceTo(tmp);
    tmp.project(camera);
    const x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H;
    const pr = (c.r * c.grow) / (dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * H * 0.5;
    return { x, y, r: pr, visible: tmp.z < 1 && c.grow > 0.05 };
  }
  function pick(px, py) {
    let best = null, bd = Infinity;
    for (const c of crystals) {
      const p = project(c.node.id); if (!p || !p.visible) continue;
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < Math.max(18, p.r * 1.1) && d < bd) { bd = d; best = c.node.id; }
    }
    return best;
  }

  // ---------- loop ----------
  let raf = 0, running = false, last = performance.now(), t = 0;
  const GROW = 420;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    shared.uTime.value = t;
    for (const c of crystals) {
      const k = ease((now - c.t0) / GROW);
      c.grow = c.t0 === 0 ? c.target : c.target ? (c.from ?? 0) + (1 - (c.from ?? 0)) * k : (c.from ?? 1) * (1 - k);
      c.group.scale.setScalar(Math.max(0.0001, c.r / 1.15 * 1.1 * c.grow));
      c.group.visible = c.grow > 0.002; c.shadow.visible = c.group.visible; c.shadow.material.uniforms.uA.value = (c.node.state.startsWith('exit') ? 0.08 : 0.22) * c.grow;
      c.uDim.value += ((c.dimT ?? 1) - c.uDim.value) * 0.18;
      c.uHi.value += ((c.hiT ?? 0) - c.uHi.value) * 0.18;
      c.group.rotation.y += dt * c.spin;
      if (c.rime) c.rime.visible = c.grow > 0.5;
    }
    for (const s of strings) {
      const sp = 3.2 / Math.max(0.5, s.len); // draw speed: a string draws in ≈ len/3.2 s
      s.draw = s.target ? Math.min(1, s.draw + dt * sp) : Math.max(0, s.draw - dt * sp * 2);
      s.mat.uniforms.uDraw.value = s.draw > 0.999 ? 1.01 : s.draw;
      s.mesh.visible = s.draw > 0.001;
      s.mat.uniforms.uDim.value += ((s.dimT ?? 1) - s.mat.uniforms.uDim.value) * 0.18;
      s.mat.uniforms.uHi.value += ((s.hiT ?? 0) - s.mat.uniforms.uHi.value) * 0.18;
    }
    // idle drift: after 8 s, sway the azimuth slowly (≤ 0.02 rad/s), stop on input
    if (!opts.reduced && now - idleSince > 8000) {
      const az = controls.getAzimuthalAngle();
      if (driftBase == null) driftBase = { az, t };
      const target = driftBase.az + 0.32 * Math.sin((t - driftBase.t) * 0.0625);
      const delta = Math.max(-0.02 * dt, Math.min(0.02 * dt, target - az));
      rotateAzimuth(delta);
    }
    controls.update();
    renderer.render(scene, camera);
    opts.onFrame?.();
  }
  const sph = new THREE.Spherical();
  function rotateAzimuth(d) {
    const off = camera.position.clone().sub(controls.target);
    sph.setFromVector3(off); sph.theta = Math.max(controls.minAzimuthAngle, Math.min(controls.maxAzimuthAngle, sph.theta + d));
    off.setFromSpherical(sph); camera.position.copy(controls.target).add(off);
  }
  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); opts.onLost?.(); }, false);

  function fit() { userMoved = false; controls.target.copy(center); resize(); }

  function dispose() {
    stop(); controls.dispose();
    canvas.removeEventListener('wheel', onWheel, { capture: true });
    scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    renderer.dispose(); canvas.remove();
  }

  // first render with everything grown (time = head)
  setTime(Infinity, true);

  const stats = () => ({ strings: strings.length, stringsOn: strings.filter((x) => x.target === 1).length, crystals: crystals.length, crystalsOn: crystals.filter((c) => c.target === 1).length });
  function setRegion(r) { opts.region = r; userMoved = false; resize(); }
  return { canvas, setTime, setLens, project, pick, resize, start, stop, fit, dispose, touched, stats, setRegion, get lens() { return lensId; } };
}
