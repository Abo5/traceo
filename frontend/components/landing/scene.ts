/**
 * The landing hero's WebGL scene: a browser window that Traceo takes apart.
 *
 * The animation is the explanation. Rather than illustrate the product with
 * stock abstractions — floating cubes, orbiting spheres — this renders the one
 * thing Traceo actually operates on (a page with fields, rules and links) and
 * then performs the four things Traceo actually does to it: look at it, write
 * cases grounded in what was found, run them, and hand back a fix for each red.
 * A visitor who only watches the canvas and never reads a word should still
 * come away with the right idea of the product.
 *
 * Framework-free on purpose. React owns the copy, the scroll position and the
 * fix-prompt card; this owns pixels. The only traffic between them is
 * `setStage()` going in and `onBugFixed` coming out, which keeps sixty
 * renders a second from ever touching React's reconciler.
 *
 * Everything is built from core three — rounded panels come from Shape +
 * ExtrudeGeometry rather than the examples/jsm RoundedBoxGeometry — so the
 * bundle carries no example-module baggage.
 */
import * as THREE from "three";

export type Stage = 0 | 1 | 2 | 3 | 4;

export type BugInfo = {
  id: string;
  title: string;
  where: string;
  requirement: string;
  actions: string[];
  remaining: number;
};

export type SceneOptions = {
  onBugFixed?: (bug: BugInfo) => void;
  onBugCount?: (remaining: number, total: number) => void;
  reducedMotion?: boolean;
};

/* ---------------------------------------------------------------------------
 * Palette — the app's own tokens, hard-coded as numbers because WebGL cannot
 * read CSS custom properties. Kept in sync with globals.css by hand; these are
 * the design's blue/violet/pink spectrum over a deep slate ground.
 * ------------------------------------------------------------------------- */
const C = {
  frame: 0x121a2e,
  bar: 0x1a2340,
  block: 0x223056,
  line: 0x2c3c68,
  field: 0x18213c,
  button: 0x3d6bf5,
  edge: 0x4c6ef5,
  edgeSoft: 0x2e3f6b,
  blue: 0x3d6bf5,
  violet: 0x7a5ae6,
  pink: 0xd9479e,
  ok: 0x22c55e,
  err: 0xf43f5e,
  scan: 0x7f9cff,
};

/* ---------------------------------------------------------------------------
 * The page under test, as data.
 *
 * Every visual element is declared once here and the scene is built from it,
 * so a chip, a label, a verdict tick and a bug marker can all refer to the same
 * element by id and stay in agreement. `label` is what the scan light reveals —
 * these read like real discovery output because that is what they stand in for.
 * ------------------------------------------------------------------------- */
type ElKind = "frame" | "bar" | "block" | "line" | "field" | "button" | "dot" | "chip";

type ElDef = {
  id: string;
  kind: ElKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
  color?: number;
  label?: string;
  /** The rule discovery found — an element with one earns a generated case. */
  cite?: string;
  bug?: { title: string; where: string; requirement: string; actions: string[] };
};

const FIELD_X = 1.75;

const ELEMENTS: ElDef[] = [
  // --- window chrome ---
  { id: "frame", kind: "frame", x: 0, y: 0, w: 7.2, h: 4.7, z: -0.18, color: C.frame },
  { id: "titlebar", kind: "bar", x: 0, y: 1.98, w: 6.9, h: 0.46, color: C.bar },
  { id: "dot1", kind: "dot", x: -3.14, y: 1.98, w: 0.12, h: 0.12, color: 0xf43f5e },
  { id: "dot2", kind: "dot", x: -2.92, y: 1.98, w: 0.12, h: 0.12, color: 0xf59e0b },
  { id: "dot3", kind: "dot", x: -2.7, y: 1.98, w: 0.12, h: 0.12, color: 0x22c55e },
  { id: "urlbar", kind: "field", x: 0.3, y: 1.98, w: 4.6, h: 0.26, color: 0x141c33 },

  // --- left column: content ---
  {
    id: "h1", kind: "block", x: -1.85, y: 1.16, w: 2.6, h: 0.34, color: C.block,
    label: "<h1> Create your account",
  },
  { id: "p1", kind: "line", x: -2.05, y: 0.72, w: 2.2, h: 0.11, color: C.line },
  { id: "p2", kind: "line", x: -2.25, y: 0.48, w: 1.8, h: 0.11, color: C.line },
  {
    id: "hero", kind: "block", x: -1.85, y: -0.5, w: 2.6, h: 1.2, color: 0x1d2a4c,
    label: "<img> 2.4 MB · no width/height",
  },
  {
    id: "link", kind: "chip", x: -2.72, y: -1.5, w: 0.86, h: 0.3, color: 0x1c274a,
    label: '<a href="/pricing">',
    cite: "link target resolves",
    bug: {
      title: "A link points at a page that isn't there",
      where: 'a[href="/pricing"] on /signup',
      requirement: 'BRD-031 — "Every navigation link resolves to a live page"',
      actions: [
        "fix or remove the links that do not resolve",
      ],
    },
  },
  { id: "link2", kind: "chip", x: -1.72, y: -1.5, w: 0.86, h: 0.3, color: 0x1c274a, label: '<a href="/docs">' },

  // --- right column: the form ---
  { id: "card", kind: "bar", x: FIELD_X, y: -0.2, w: 3.0, h: 3.5, z: -0.06, color: 0x16203a },
  {
    id: "email", kind: "field", x: FIELD_X, y: 1.02, w: 2.5, h: 0.38, color: C.field,
    label: 'input[type="email"] · required',
    cite: "required field is enforced",
    bug: {
      title: "The form submits with the email left empty",
      where: "#email on /signup",
      requirement: 'BRD-014 — "Email is mandatory at registration"',
      actions: [
        "reject the submission while this field is empty, in the handler AND on the server",
        "show the user an error next to the field (aria-invalid + a message element)",
      ],
    },
  },
  {
    id: "name", kind: "field", x: FIELD_X, y: 0.44, w: 2.5, h: 0.38, color: C.field,
    label: 'input[name="full_name"] · maxlength=32',
    cite: "maxlength is enforced",
  },
  {
    id: "pin", kind: "field", x: FIELD_X, y: -0.14, w: 2.5, h: 0.38, color: C.field,
    label: 'input[name="pin"] · pattern=^\\d{4}$',
    cite: "pattern is enforced",
  },
  {
    id: "country", kind: "field", x: FIELD_X, y: -0.72, w: 2.5, h: 0.38, color: C.field,
    label: "<select> · 194 options",
    cite: "selection is accepted",
  },
  {
    id: "terms", kind: "chip", x: 0.86, y: -1.24, w: 0.28, h: 0.28, color: 0x1c274a,
    label: 'input[type="checkbox"] · required',
    cite: "submit is gated on the checkbox",
  },
  { id: "termsLabel", kind: "line", x: 1.75, y: -1.24, w: 1.3, h: 0.12, color: C.line },
  {
    id: "submit", kind: "button", x: 1.3, y: -1.82, w: 1.5, h: 0.44, color: C.button,
    label: '<button type="submit">',
    cite: "the happy path submits",
    bug: {
      title: "Submit goes through with the terms box unticked",
      where: "button[type=submit] on /signup",
      requirement: 'TRD-208 — "Registration requires accepting the terms"',
      actions: [
        "block submission while the required checkbox is unticked, in the handler AND on the server",
      ],
    },
  },
];

/** Cases the model proposes but discovery cannot vouch for — these get thrown away. */
const UNGROUNDED = [
  "password strength ≥ 12",
  "2FA code expires in 30s",
  "referral code is unique",
];

/* ---------------------------------------------------------------------------
 * Camera framing per act.
 *
 * `bias` is the half of the screen the model should sit on, as a FRACTION of
 * the visible width rather than a distance in world units: positive pushes the
 * model right (for the acts whose copy is on the left), negative pushes it
 * left. Expressed this way the composition survives any aspect ratio, which a
 * fixed world offset does not — the same offset that clears a 16:9 headline
 * throws the model off the side of a phone.
 * ------------------------------------------------------------------------- */
type Frame = { z: number; focus: [number, number]; bias: number; scale: number };

const FRAMES: Record<Stage, Frame> = {
  0: { z: 10.4, focus: [0, 0], bias: 0.375, scale: 0.8 },
  1: { z: 6.6, focus: [1.75, 0.25], bias: 0.42, scale: 0.85 },
  2: { z: 11.5, focus: [-0.9, 0.1], bias: -0.355, scale: 0.68 },
  3: { z: 9.4, focus: [0.3, 0], bias: 0.371, scale: 0.8 },
  4: { z: 8.2, focus: [1.7, -0.25], bias: -0.22, scale: 0.78 },
};

/* --- small geometry helpers ------------------------------------------------ */

function roundedShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, Math.min(w, h) / 2);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

function glyphTexture(glyph: string, hex: number): THREE.CanvasTexture {
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const css = "#" + hex.toString(16).padStart(6, "0");
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = css;
  ctx.globalAlpha = 0.18;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 5;
  ctx.strokeStyle = css;
  ctx.stroke();
  ctx.fillStyle = css;
  ctx.font = "bold 68px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, size / 2, size / 2 + 3);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture(): THREE.CanvasTexture {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(150,180,255,0.95)");
  g.addColorStop(0.35, "rgba(90,130,255,0.35)");
  g.addColorStop(1, "rgba(60,100,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const damp = (cur: number, to: number, lambda: number, dt: number) =>
  cur + (to - cur) * (1 - Math.exp(-lambda * dt));

/* --------------------------------------------------------------------------- */

type Chip = {
  mesh: THREE.Mesh;
  target: THREE.Vector3;
  home: THREE.Vector3;
  stackAt: THREE.Vector3;
  grounded: boolean;
  delay: number;
  state: "hidden" | "toStack" | "stacked" | "dissolving" | "gone" | "toHome";
  t: number;
};

type Marker = {
  id: string;
  group: THREE.Group;
  ring: THREE.Mesh;
  core: THREE.Mesh;
  pos: THREE.Vector3;
  def: NonNullable<ElDef["bug"]>;
  fixed: boolean;
  hover: number;
  pop: number;
};

export class TraceoScene {
  private host: HTMLElement;
  private opts: SceneOptions;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private world = new THREE.Group();
  private labelLayer!: HTMLDivElement;

  private raf = 0;
  private clock = new THREE.Clock();
  private running = false;
  private disposed = false;

  private stage: Stage = 0;
  private stageT = 0;

  private meshes = new Map<string, THREE.Mesh>();
  private defs = new Map<string, ElDef>();
  private labels: { el: HTMLDivElement; pos: THREE.Vector3; shown: number; onlyStage?: Stage }[] = [];
  private chips: Chip[] = [];
  private markers: Marker[] = [];
  private verdicts: THREE.Sprite[] = [];
  private particles!: THREE.Points;
  private scanGlow!: THREE.Sprite;
  private scanLight!: THREE.PointLight;
  private burstPool: { pts: THREE.Points; life: number }[] = [];

  // pointer / drag
  private pointer = new THREE.Vector2(0, 0);
  private pointerActive = false;
  private scanPoint = new THREE.Vector3(0, 0, 0.3);
  private dragging = false;
  private dragMoved = 0;
  private lastDrag = { x: 0, y: 0 };
  private spin = { x: 0, y: 0 };
  private spinTarget = { x: 0, y: 0 };
  private hovering = false;

  private camPos = new THREE.Vector3(0, 0.25, 10.4);
  private worldScale = 1;
  private chipCycle = 0;
  private frameSpec = FRAMES[0];
  private camAim = new THREE.Vector3(0, 0, 0);
  private raycaster = new THREE.Raycaster();
  private planeZ = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.3);
  private textures: THREE.Texture[] = [];

  constructor(host: HTMLElement, opts: SceneOptions = {}) {
    this.host = host;
    this.opts = opts;
    this.init();
  }

  /* --- construction -------------------------------------------------------- */

  private init() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y";
    this.host.appendChild(canvas);

    this.labelLayer = document.createElement("div");
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.host.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.camera.position.copy(this.camPos);
    this.scene.add(this.world);
    this.scene.fog = new THREE.Fog(0x080c18, 12, 26);

    this.buildLights();
    this.buildPage();
    this.buildParticles();
    this.buildScan();
    this.buildMarkers();

    this.bind();
    this.applyStage(0, true);
    this.opts.onBugCount?.(this.markers.length, this.markers.length);
    this.start();
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x8fa8ff, 0x0a0f1e, 1.05));
    const key = new THREE.DirectionalLight(0xdce6ff, 1.5);
    key.position.set(3.5, 5, 7);
    this.scene.add(key);
    const rimV = new THREE.PointLight(C.violet, 55, 26);
    rimV.position.set(-6.5, 2.5, 3.5);
    this.scene.add(rimV);
    const rimP = new THREE.PointLight(C.pink, 26, 22);
    rimP.position.set(6.5, -3, 2.5);
    this.scene.add(rimP);
  }

  private buildPage() {
    for (const def of ELEMENTS) {
      this.defs.set(def.id, def);
      const depth = def.kind === "frame" ? 0.22 : def.kind === "bar" ? 0.12 : 0.09;
      const radius = def.kind === "dot" ? def.w / 2 : Math.min(0.09, def.h / 2.2);
      const shape = roundedShape(def.w, def.h, radius);
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: 0.012,
        bevelSize: 0.012,
        bevelSegments: 2,
        curveSegments: 6,
      });
      geom.translate(0, 0, -depth / 2);

      const isAccent = def.kind === "button";
      const mat = new THREE.MeshStandardMaterial({
        color: def.color ?? C.block,
        roughness: isAccent ? 0.3 : 0.62,
        metalness: isAccent ? 0.15 : 0.08,
        emissive: new THREE.Color(isAccent ? C.button : C.edgeSoft),
        emissiveIntensity: isAccent ? 0.5 : 0.12,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(def.x, def.y, def.z ?? 0);
      mesh.userData.baseEmissive = mat.emissiveIntensity;
      mesh.userData.def = def;
      this.world.add(mesh);
      this.meshes.set(def.id, mesh);

      // A hairline outline is what makes a slab read as a piece of interface.
      const pts = shape.getPoints(28).map((p) => new THREE.Vector3(p.x, p.y, depth / 2 + 0.004));
      const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
      const lineMat = new THREE.LineBasicMaterial({
        color: isAccent ? 0xa9c0ff : C.edge,
        transparent: true,
        opacity: isAccent ? 0.7 : 0.34,
      });
      mesh.add(new THREE.LineLoop(lineGeom, lineMat));

      if (def.label) this.addLabel(def);
    }
  }

  private addLabel(def: ElDef) {
    this.makeLabel(def.label!, new THREE.Vector3(def.x, def.y + def.h / 2 + 0.22, 0.2));
  }

  /** A caption in the scene. Without `onlyStage` it belongs to the scanner. */
  private makeLabel(text: string, pos: THREE.Vector3, onlyStage?: Stage) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "transform:translate(-50%,-50%)",
      "padding:4px 9px",
      "border-radius:7px",
      "font:500 11px/1.35 'JetBrains Mono',ui-monospace,monospace",
      "letter-spacing:0.01em",
      "color:#dbe6ff",
      "background:rgba(12,18,36,0.86)",
      "border:1px solid rgba(108,142,255,0.45)",
      "box-shadow:0 6px 22px rgba(0,0,0,0.45)",
      "white-space:nowrap",
      "opacity:0",
      "will-change:transform,opacity",
    ].join(";");
    this.labelLayer.appendChild(el);
    this.labels.push({ el, pos, shown: 0, onlyStage });
  }

  private buildParticles() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const c1 = new THREE.Color(C.blue);
    const c2 = new THREE.Color(C.violet);
    for (let i = 0; i < N; i++) {
      const r = 5.5 + Math.random() * 7;
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r * (0.8 + Math.random() * 0.5);
      pos[i * 3 + 1] = (Math.random() - 0.5) * 9;
      pos[i * 3 + 2] = -3 - Math.random() * 9;
      const c = c1.clone().lerp(c2, Math.random());
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      seed[i] = Math.random() * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.userData.seed = seed;
    g.userData.base = pos.slice();
    const m = new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.particles = new THREE.Points(g, m);
    this.scene.add(this.particles);
  }

  private buildScan() {
    const tex = glowTexture();
    this.textures.push(tex);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.9,
    });
    this.scanGlow = new THREE.Sprite(mat);
    this.scanGlow.scale.setScalar(2.6);
    this.scanGlow.position.set(0, 0, 0.5);
    this.world.add(this.scanGlow);

    this.scanLight = new THREE.PointLight(C.scan, 12, 4.5, 1.8);
    this.scanLight.position.set(0, 0, 1.1);
    this.world.add(this.scanLight);
  }

  private buildMarkers() {
    const ringGeom = new THREE.TorusGeometry(0.17, 0.022, 10, 32);
    const coreGeom = new THREE.OctahedronGeometry(0.085, 0);
    // A marker is ~34px across and drifts with the scene's idle sway, so the
    // pixel a visitor aims at is not quite the pixel they release on. The hit
    // volume is deliberately much larger than the mark it stands for.
    const hitGeom = new THREE.SphereGeometry(0.36, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const def of ELEMENTS) {
      if (!def.bug) continue;
      const group = new THREE.Group();
      const pos = new THREE.Vector3(def.x + def.w / 2 - 0.06, def.y + def.h / 2 + 0.04, 0.32);
      group.position.copy(pos);

      const ring = new THREE.Mesh(
        ringGeom,
        new THREE.MeshBasicMaterial({ color: C.err, transparent: true, opacity: 0.9 })
      );
      const core = new THREE.Mesh(
        coreGeom,
        new THREE.MeshStandardMaterial({
          color: C.err,
          emissive: new THREE.Color(C.err),
          emissiveIntensity: 1.4,
          roughness: 0.3,
        })
      );
      group.add(ring, core, new THREE.Mesh(hitGeom, hitMat));
      group.visible = false;
      group.scale.setScalar(0.001);
      this.world.add(group);
      this.markers.push({ id: def.id, group, ring, core, pos, def: def.bug, fixed: false, hover: 0, pop: 0 });
    }
  }

  /* --- chips (the generated cases) ----------------------------------------- */

  private ensureChips() {
    if (this.chips.length) return;
    const geom = new THREE.PlaneGeometry(0.92, 0.26);
    const grounded = ELEMENTS.filter((e) => e.cite);
    const stackX = -4.75;
    let row = 0;

    const make = (color: number, from: THREE.Vector3, home: THREE.Vector3, isGrounded: boolean, delay: number) => {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(from);
      mesh.visible = false;
      this.world.add(mesh);
      const stackAt = isGrounded
        ? new THREE.Vector3(stackX, 1.85 - row * 0.34, 0.35)
        // The rejected ones travel to the gate and get no further.
        : new THREE.Vector3(stackX + 1.35, 0.5 - row * 0.34, 0.35);
      row++;
      this.chips.push({
        mesh, target: stackAt.clone(), home, stackAt, grounded: isGrounded,
        delay, state: "hidden", t: 0,
      });
    };

    grounded.forEach((def, i) => {
      const from = new THREE.Vector3(def.x, def.y, 0.3);
      make(C.blue, from.clone(), from.clone(), true, i * 0.13);
    });
    // Held back deliberately: the discard only means something once the
    // visitor has watched the grounded ones land.
    row = 0;
    UNGROUNDED.forEach((_, i) => {
      const from = new THREE.Vector3(-0.4 + i * 0.5, -2.4, 0.3);
      make(C.err, from, from.clone(), false, 1.5 + i * 0.42);
    });

    this.makeLabel("7 grounded — each cites what it saw", new THREE.Vector3(stackX + 0.15, 2.3, 0.4), 2);
    this.makeLabel("3 discarded — nothing to cite", new THREE.Vector3(stackX + 1.5, -1.15, 0.4), 2);
  }

  /* --- verdicts ------------------------------------------------------------ */

  private ensureVerdicts() {
    if (this.verdicts.length) return;
    const okTex = glyphTexture("✓", C.ok);
    this.textures.push(okTex);
    for (const def of ELEMENTS) {
      if (!def.cite || def.bug) continue;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: okTex, transparent: true, opacity: 0, depthWrite: false }));
      s.scale.setScalar(0.001);
      s.position.set(def.x + def.w / 2 - 0.04, def.y + def.h / 2 + 0.04, 0.32);
      this.world.add(s);
      this.verdicts.push(s);
    }
  }

  private burst(at: THREE.Vector3, hex: number) {
    const N = 46;
    const pos = new Float32Array(N * 3);
    const vel: number[] = [];
    for (let i = 0; i < N; i++) {
      pos[i * 3] = at.x;
      pos[i * 3 + 1] = at.y;
      pos[i * 3 + 2] = at.z;
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.5) * Math.PI;
      const sp = 1.6 + Math.random() * 2.6;
      vel.push(Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp, Math.sin(a) * Math.cos(b) * sp * 0.5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.userData.vel = vel;
    const pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: hex, size: 0.07, transparent: true, opacity: 1,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    this.world.add(pts);
    this.burstPool.push({ pts, life: 0 });
  }

  /* --- input --------------------------------------------------------------- */

  private onPointerMove = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.pointerActive = true;
    if (this.dragging) {
      const dx = e.clientX - this.lastDrag.x;
      const dy = e.clientY - this.lastDrag.y;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.spinTarget.y = THREE.MathUtils.clamp(this.spinTarget.y + dx * 0.005, -0.85, 0.85);
      this.spinTarget.x = THREE.MathUtils.clamp(this.spinTarget.x - dy * 0.004, -0.45, 0.45);
      this.lastDrag = { x: e.clientX, y: e.clientY };
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.dragMoved = 0;
    this.lastDrag = { x: e.clientX, y: e.clientY };
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasDrag = this.dragMoved > 6;
    this.dragging = false;
    this.renderer.domElement.releasePointerCapture?.(e.pointerId);
    if (!wasDrag) this.tryFixAtPointer();
  };

  private onPointerLeave = () => {
    this.pointerActive = false;
    this.dragging = false;
  };

  private onResize = () => {
    if (this.disposed) return;
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
  };

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private bind() {
    const c = this.renderer.domElement;
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private tryFixAtPointer() {
    // Act 3 shows the reds as results; act 4 is where they become repairable.
    // Letting a click land a stage early would fire a fix prompt at a visitor
    // who has not been told what one is yet.
    if (this.stage < 4) return;
    const live = this.markers.filter((m) => !m.fixed && m.group.visible);
    if (!live.length) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(live.map((m) => m.group), true);
    if (!hits.length) return;
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && !live.some((m) => m.group === obj)) obj = obj.parent;
    const marker = live.find((m) => m.group === obj);
    if (marker) this.fix(marker);
  }

  private fix(marker: Marker) {
    marker.fixed = true;
    marker.pop = 0.0001;
    this.burst(marker.group.position.clone(), C.ok);

    const okTex = glyphTexture("✓", C.ok);
    this.textures.push(okTex);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: okTex, transparent: true, opacity: 0, depthWrite: false }));
    s.position.copy(marker.group.position);
    s.scale.setScalar(0.001);
    this.world.add(s);
    this.verdicts.push(s);

    const remaining = this.markers.filter((m) => !m.fixed).length;
    this.opts.onBugFixed?.({
      id: marker.id,
      title: marker.def.title,
      where: marker.def.where,
      requirement: marker.def.requirement,
      actions: marker.def.actions,
      remaining,
    });
    this.opts.onBugCount?.(remaining, this.markers.length);
  }

  /* --- public API ---------------------------------------------------------- */

  setStage(next: Stage) {
    if (next === this.stage) return;
    this.stage = next;
    this.stageT = 0;
    this.applyStage(next, false);
  }

  /** The keyboard-reachable equivalent of clicking every red marker. */
  fixAll() {
    for (const m of this.markers) if (!m.fixed && m.group.visible) this.fix(m);
  }

  private applyStage(stage: Stage, _immediate: boolean) {
    if (stage >= 2) this.ensureChips();
    if (stage >= 3) this.ensureVerdicts();

    // Camera framing per act. Act 1 leans into the form, act 2 pulls back so the
    // stack of generated cases has somewhere to land, act 4 sits close enough
    // that the red markers are comfortable click targets.
    this.frameSpec = FRAMES[stage];

    if (stage < 4) this.spinTarget = { x: 0, y: 0 };

    for (const c of this.chips) {
      if (stage === 2 && c.state === "hidden") c.state = "toStack";
      if (stage >= 3 && (c.state === "stacked" || c.state === "toStack") && c.grounded) {
        c.state = "toHome";
        c.t = 0;
      }
    }
    for (const m of this.markers) {
      if (stage >= 3 && !m.fixed) m.group.visible = true;
      if (stage < 3) {
        m.group.visible = false;
        m.group.scale.setScalar(0.001);
      }
    }
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /* --- the loop ------------------------------------------------------------ */

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this.stageT += dt;
    const reduce = !!this.opts.reducedMotion;

    this.resolveFrame();

    // Camera easing.
    this.camera.position.lerp(this.camPos, reduce ? 1 : 1 - Math.exp(-3.2 * dt));
    this.camera.lookAt(this.camAim);

    // World rotation: the drag the visitor applied, plus an idle sway.
    if (!reduce) {
      const idleY = Math.sin(t * 0.24) * 0.075;
      const idleX = Math.cos(t * 0.19) * 0.035;
      this.spin.y = damp(this.spin.y, this.spinTarget.y + idleY, 3, dt);
      this.spin.x = damp(this.spin.x, this.spinTarget.x + idleX, 3, dt);
    } else {
      this.spin.y = this.spinTarget.y;
      this.spin.x = this.spinTarget.x;
    }
    this.world.rotation.y = this.spin.y;
    this.world.rotation.x = this.spin.x;
    const sc = damp(this.world.scale.x, this.worldScale, reduce ? 40 : 3.2, dt);
    this.world.scale.setScalar(sc);

    this.updateScan(dt, t, reduce);
    this.updateLabels(dt);
    this.updateChips(dt);
    this.updateMarkers(dt, t);
    this.updateVerdicts(dt);
    this.updateBursts(dt);
    if (!reduce) this.updateParticles(t);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Turn the act's framing into a camera, for the viewport we actually have.
   *
   * Portrait has no room to stand copy beside the model, so the model shrinks,
   * moves back toward centre and rides higher up the screen — the copy then
   * reads as a card over it rather than beside it.
   */
  private resolveFrame() {
    const f = this.frameSpec;
    const aspect = this.camera.aspect;
    const portrait = aspect < 1;
    const scale = f.scale * (portrait ? 0.62 : 1);
    const bias = f.bias * (portrait ? 0.25 : 1);

    const halfH = f.z * Math.tan((this.camera.fov * Math.PI) / 360);
    const halfW = halfH * aspect;

    this.worldScale = scale;
    // Aiming BELOW the model lifts it up the screen, which on portrait is what
    // leaves the lower half free for the copy card.
    this.camAim.set(
      f.focus[0] * scale - bias * halfW,
      f.focus[1] * scale - (portrait ? halfH * 0.45 : 0),
      0
    );
    this.camPos.set(this.camAim.x, this.camAim.y + 0.2, f.z);
  }

  private updateScan(dt: number, t: number, reduce: boolean) {
    // Where the cursor meets the page plane — the point the "scanner" is on.
    if (this.pointerActive) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = new THREE.Vector3();
      const local = this.raycaster.ray.intersectPlane(this.planeZ, hit);
      if (local) this.world.worldToLocal(hit);
      if (local) this.scanPoint.lerp(hit, reduce ? 1 : 1 - Math.exp(-14 * dt));
    } else if (!reduce) {
      // Idle: the scanner keeps working on its own, so the page is never still.
      const r = 2.2;
      this.scanPoint.lerp(
        new THREE.Vector3(Math.sin(t * 0.5) * r + 0.6, Math.cos(t * 0.37) * 1.2, 0.3),
        1 - Math.exp(-2.5 * dt)
      );
    }
    this.scanGlow.position.set(this.scanPoint.x, this.scanPoint.y, 0.55);
    this.scanLight.position.set(this.scanPoint.x, this.scanPoint.y, 1.15);
    const pulse = reduce ? 1 : 1 + Math.sin(t * 3.4) * 0.06;
    this.scanGlow.scale.setScalar(2.5 * pulse);

    // Panels brighten as the scanner passes: discovery made visible.
    for (const [, mesh] of this.meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const d = mesh.position.distanceTo(this.scanPoint);
      const near = THREE.MathUtils.clamp(1 - d / 1.9, 0, 1);
      const base = mesh.userData.baseEmissive as number;
      mat.emissiveIntensity = damp(mat.emissiveIntensity, base + near * 0.85, 9, dt);
    }
  }

  private updateLabels(dt: number) {
    const showAll = this.stage === 1;
    const r = this.renderer.domElement.getBoundingClientRect();
    for (const l of this.labels) {
      const world = l.pos.clone().applyMatrix4(this.world.matrixWorld);
      const d = l.pos.distanceTo(this.scanPoint);
      const want = l.onlyStage !== undefined
        ? (this.stage === l.onlyStage ? 1 : 0)
        : this.stage > 1 ? 0          // past discovery, the scanner stops narrating
        : showAll ? 1 : d < 1.35 ? 1 : 0;
      l.shown = damp(l.shown, want, 8, dt);

      if (l.shown < 0.02) {
        l.el.style.opacity = "0";
        continue;
      }
      const p = world.project(this.camera);
      const x = (p.x * 0.5 + 0.5) * r.width;
      const y = (-p.y * 0.5 + 0.5) * r.height;
      const behind = p.z > 1;
      l.el.style.opacity = behind ? "0" : String(l.shown.toFixed(3));
      l.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${(0.9 + l.shown * 0.1).toFixed(3)})`;
    }
  }

  private updateChips(dt: number) {
    // Generation replays while the act is on screen: a visitor who arrives
    // mid-cycle should still get to watch the rejected cases fall out.
    if (this.stage === 2 && this.chips.length) {
      const settled = this.chips.every((c) => c.state === "stacked" || c.state === "gone");
      this.chipCycle = settled ? this.chipCycle + dt : 0;
      if (this.chipCycle > 2.6) {
        this.chipCycle = 0;
        for (const c of this.chips) {
          c.mesh.position.copy(c.home);
          c.mesh.rotation.z = 0;
          c.mesh.visible = false;
          (c.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
          c.state = "toStack";
          c.t = 0;
        }
      }
    }

    for (const c of this.chips) {
      const mat = c.mesh.material as THREE.MeshBasicMaterial;
      switch (c.state) {
        case "hidden":
          break;
        case "toStack": {
          c.t += dt;
          if (c.t < c.delay) break;
          c.mesh.visible = true;
          mat.opacity = damp(mat.opacity, 1, 6, dt);
          c.mesh.position.lerp(c.stackAt, 1 - Math.exp(-4.5 * dt));
          if (c.mesh.position.distanceTo(c.stackAt) < 0.05) {
            c.state = c.grounded ? "stacked" : "dissolving";
            c.t = 0;
          }
          break;
        }
        case "stacked":
          mat.opacity = damp(mat.opacity, 1, 6, dt);
          break;
        case "dissolving": {
          // The ungrounded ones never make it into the suite. They fall out and
          // fade — the grounding gate, as a gesture.
          c.t += dt;
          if (c.t > 0.55) {
            mat.opacity = damp(mat.opacity, 0, 1.5, dt);
            c.mesh.position.y -= dt * 0.85;
            c.mesh.rotation.z += dt * 1.1;
          }
          if (mat.opacity < 0.02) {
            c.mesh.visible = false;
            c.state = "gone";
          }
          break;
        }
        case "toHome": {
          c.t += dt;
          c.mesh.visible = true;
          c.mesh.position.lerp(c.home, 1 - Math.exp(-5 * dt));
          if (c.mesh.position.distanceTo(c.home) < 0.12) {
            mat.opacity = damp(mat.opacity, 0, 7, dt);
            if (mat.opacity < 0.03) {
              c.mesh.visible = false;
              c.state = "gone";
            }
          }
          break;
        }
        case "gone":
          break;
      }
    }
  }

  private updateMarkers(dt: number, t: number) {
    // Face the camera through the parent's rotation, not around it.
    const faceCam = this.world
      .getWorldQuaternion(new THREE.Quaternion())
      .invert()
      .multiply(this.camera.quaternion);
    const live = this.markers.filter((m) => !m.fixed && m.group.visible);
    let anyHover = false;
    if (live.length && this.stage >= 4 && this.pointerActive && !this.dragging) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(live.map((m) => m.group), true);
      if (hits.length) {
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && !live.some((m) => m.group === obj)) obj = obj.parent;
        const hovered = live.find((m) => m.group === obj);
        if (hovered) {
          hovered.hover = 1;
          anyHover = true;
        }
      }
    }
    if (anyHover !== this.hovering) {
      this.hovering = anyHover;
      this.renderer.domElement.style.cursor = anyHover ? "pointer" : "grab";
    }

    for (const m of this.markers) {
      if (m.fixed) {
        if (m.pop > 0) {
          m.pop += dt * 4;
          const s = Math.max(0.001, 1 - m.pop);
          m.group.scale.setScalar(s);
          if (m.pop >= 1) {
            m.group.visible = false;
            m.pop = 0;
          }
        }
        continue;
      }
      if (!m.group.visible) continue;
      const target = 1 + m.hover * 0.35;
      const cur = m.group.scale.x;
      m.group.scale.setScalar(damp(cur, target, 9, dt));
      m.hover = damp(m.hover, 0, 6, dt);
      const pulse = 1 + Math.sin(t * 4.2) * 0.12;
      m.ring.scale.setScalar(pulse);
      m.ring.rotation.z += dt * 1.1;
      (m.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1 + Math.sin(t * 4.2) * 0.5;
      m.group.quaternion.copy(faceCam);
    }
  }

  private updateVerdicts(dt: number) {
    const want = this.stage >= 3 ? 1 : 0;
    for (const s of this.verdicts) {
      const mat = s.material as THREE.SpriteMaterial;
      mat.opacity = damp(mat.opacity, want, 5, dt);
      const target = want ? 0.3 : 0.001;
      s.scale.setScalar(damp(s.scale.x, target, 7, dt));
    }
  }

  private updateBursts(dt: number) {
    for (let i = this.burstPool.length - 1; i >= 0; i--) {
      const b = this.burstPool[i];
      b.life += dt;
      const attr = b.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      const vel = b.pts.geometry.userData.vel as number[];
      for (let j = 0; j < attr.count; j++) {
        attr.setXYZ(
          j,
          attr.getX(j) + vel[j * 3] * dt,
          attr.getY(j) + vel[j * 3 + 1] * dt - 1.1 * dt * b.life,
          attr.getZ(j) + vel[j * 3 + 2] * dt
        );
      }
      attr.needsUpdate = true;
      const mat = b.pts.material as THREE.PointsMaterial;
      mat.opacity = Math.max(0, 1 - b.life / 1.1);
      if (b.life > 1.1) {
        this.world.remove(b.pts);
        b.pts.geometry.dispose();
        mat.dispose();
        this.burstPool.splice(i, 1);
      }
    }
  }

  private updateParticles(t: number) {
    const g = this.particles.geometry;
    const attr = g.getAttribute("position") as THREE.BufferAttribute;
    const base = g.userData.base as Float32Array;
    const seed = g.userData.seed as Float32Array;
    for (let i = 0; i < attr.count; i++) {
      const s = seed[i];
      attr.setY(i, base[i * 3 + 1] + Math.sin(t * 0.35 + s) * 0.22);
      attr.setX(i, base[i * 3] + Math.cos(t * 0.28 + s) * 0.18);
    }
    attr.needsUpdate = true;
    this.particles.rotation.y = t * 0.012;
  }

  /* --- teardown ------------------------------------------------------------ */

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    const c = this.renderer.domElement;
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);

    this.scene.traverse((o) => {
      const any = o as THREE.Mesh;
      if (any.geometry) any.geometry.dispose();
      const mat = (any as any).material;
      if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    for (const tex of this.textures) tex.dispose();
    this.renderer.dispose();
    c.remove();
    this.labelLayer.remove();
  }
}
