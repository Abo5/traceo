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

export type Stage = 0 | 1 | 2 | 3 | 4 | 5;

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
/*
 * Light mode. Not the dark palette inverted — a scene lit for a dark ground and
 * then flipped comes out chalky, because everything that read as "glowing" on
 * black reads as "washed out" on paper. So the panels are near-white surfaces
 * that get their form from shading rather than from emission, the accents keep
 * their saturation, and anything that was additive is now blended normally:
 * additive over white is invisible by definition.
 */
const C = {
  // A white application on a tinted page, which is what the product actually
  // looks like — the first pass made every surface the same pale blue-grey and
  // the window read as one flat shape with lines drawn on it.
  // Spread across a real range instead of three shades of the same grey. The
  // chrome is white, the content blocks are clearly darker than the surface
  // they sit on, and the type lines are darker again — which is the hierarchy
  // an actual interface has and the first light pass flattened away.
  frame: 0xffffff,
  bar: 0xeef2fa,
  block: 0xb9c6e4,
  line: 0xa4b4da,
  field: 0xffffff,
  button: 0x3d6bf5,
  edge: 0x7d90bd,
  edgeSoft: 0xaeb9d6,
  blue: 0x2f55e0,
  violet: 0x6d3fd4,
  pink: 0xc02a86,
  ok: 0x1f7a4d,
  err: 0xc0304a,
  scan: 0x4f7bf0,
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
  { id: "urlbar", kind: "field", x: 0.4, y: 1.98, w: 4.4, h: 0.26, color: 0xffffff },
  { id: "lock", kind: "dot", x: -1.68, y: 1.98, w: 0.1, h: 0.1, color: 0x3fa37a },
  { id: "avatar", kind: "dot", x: 3.24, y: 1.98, w: 0.2, h: 0.2, color: 0xa4b4da },

  // --- the app's own navigation, inside the page ---
  { id: "logo", kind: "block", x: -3.28, y: 1.56, w: 0.2, h: 0.2, color: 0x2f55e0 },
  { id: "nav1", kind: "line", x: -2.85, y: 1.56, w: 0.42, h: 0.1, color: 0xa4b4da },
  { id: "nav2", kind: "line", x: -2.3, y: 1.56, w: 0.34, h: 0.1, color: 0xa4b4da },
  { id: "nav3", kind: "line", x: -1.83, y: 1.56, w: 0.38, h: 0.1, color: 0xa4b4da },
  { id: "navrule", kind: "line", x: 0, y: 1.42, w: 6.6, h: 0.02, color: 0xd2dae9 },

  // --- left column: content ---
  {
    id: "h1", kind: "block", x: -1.85, y: 1.16, w: 2.6, h: 0.34, color: C.block,
    label: "<h1> Create your account",
  },
  { id: "p1", kind: "line", x: -2.05, y: 0.72, w: 2.2, h: 0.11, color: C.line },
  { id: "p2", kind: "line", x: -2.25, y: 0.48, w: 1.8, h: 0.11, color: C.line },
  {
    id: "hero", kind: "block", x: -1.85, y: -0.5, w: 2.6, h: 1.2, color: 0x93aae4,
    label: "<img> 2.4 MB · no width/height",
  },
  {
    id: "link", kind: "chip", x: -2.72, y: -1.5, w: 0.86, h: 0.3, color: 0xdbe4f8,
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
  { id: "link2", kind: "chip", x: -1.72, y: -1.5, w: 0.86, h: 0.3, color: 0xdbe4f8, label: '<a href="/docs">' },

  // --- right column: the form ---
  { id: "card", kind: "bar", x: FIELD_X, y: -0.2, w: 3.0, h: 3.5, z: -0.06, color: 0xf3f6fd },
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
    id: "terms", kind: "chip", x: 0.86, y: -1.24, w: 0.28, h: 0.28, color: 0xdbe4f8,
    label: 'input[type="checkbox"] · required',
    cite: "submit is gated on the checkbox",
  },
  { id: "termsLabel", kind: "line", x: 1.75, y: -1.24, w: 1.3, h: 0.12, color: C.line },

  // --- the small print that makes a form look like a form ---
  { id: "cardTitle", kind: "line", x: 0.86, y: 1.44, w: 1.2, h: 0.14, color: 0x8496c2 },
  { id: "labEmail", kind: "line", x: 0.76, y: 1.3, w: 0.5, h: 0.07, color: 0xb6c3e2 },
  { id: "labName", kind: "line", x: 0.79, y: 0.72, w: 0.56, h: 0.07, color: 0xb6c3e2 },
  { id: "labPin", kind: "line", x: 0.72, y: 0.14, w: 0.42, h: 0.07, color: 0xb6c3e2 },
  { id: "labCountry", kind: "line", x: 0.8, y: -0.44, w: 0.58, h: 0.07, color: 0xb6c3e2 },
  { id: "phEmail", kind: "line", x: 0.86, y: 1.02, w: 0.86, h: 0.06, color: 0xc9d3ec },
  { id: "phName", kind: "line", x: 0.82, y: 0.44, w: 0.78, h: 0.06, color: 0xc9d3ec },
  { id: "phPin", kind: "line", x: 0.74, y: -0.14, w: 0.44, h: 0.06, color: 0xc9d3ec },
  { id: "chevron", kind: "dot", x: 2.86, y: -0.72, w: 0.12, h: 0.12, color: 0x8496c2 },

  // --- page furniture ---
  { id: "footrule", kind: "line", x: 0, y: -1.98, w: 6.6, h: 0.02, color: 0xd2dae9 },
  { id: "foot1", kind: "line", x: -2.95, y: -2.14, w: 0.5, h: 0.08, color: 0xbcc8e6 },
  { id: "foot2", kind: "line", x: -2.28, y: -2.14, w: 0.42, h: 0.08, color: 0xbcc8e6 },
  { id: "foot3", kind: "line", x: -1.7, y: -2.14, w: 0.36, h: 0.08, color: 0xbcc8e6 },
  { id: "scrollbar", kind: "line", x: 3.46, y: 0.9, w: 0.07, h: 1.5, color: 0xa9b6d8 },
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
  // Sign-in: close on the form card, held to the RIGHT so the real credentials
  // form has the left of the frame to itself. The window is the frame; the inputs a visitor actually
  // types into are HTML, because a password field has to BE a password field —
  // focusable, autofillable and readable by a screen reader, none of which a
  // painted rectangle can be.
  5: { z: 7.4, focus: [1.75, -0.1], bias: 0.4, scale: 0.86 },
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
  g.addColorStop(0, "rgba(79,123,240,0.34)");
  g.addColorStop(0.35, "rgba(79,123,240,0.16)");
  g.addColorStop(1, "rgba(79,123,240,0)");
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
  private bug!: THREE.Group;
  private bugLegs: THREE.Object3D[] = [];
  private bugState = {
    pos: new THREE.Vector3(-4.5, -2.2, 1.25),
    heading: 0,
    speed: 0.55,
    target: new THREE.Vector3(3, 1.5, 1.25),
    pause: 0,
    gait: 0,
    startled: 0,
    squashed: 0,
  };
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
    // No tone mapping. ACES is built to roll off highlights so bright things on
    // a dark ground keep their detail — on a light scene it does the same to
    // every white surface, and a white application comes out grey. Without it
    // the whites are white and the accents keep their saturation.
    this.renderer.toneMapping = THREE.NoToneMapping;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y";
    this.host.appendChild(canvas);

    this.labelLayer = document.createElement("div");
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.host.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.camera.position.copy(this.camPos);
    this.scene.add(this.world);
    this.scene.fog = new THREE.Fog(0xf4f6fb, 14, 30);

    this.buildLights();
    this.buildShadow();
    this.buildPage();
    this.buildParticles();
    this.buildBug();
    this.buildScan();
    this.buildMarkers();

    this.bind();
    this.applyStage(0, true);
    this.opts.onBugCount?.(this.markers.length, this.markers.length);
    this.start();
  }

  private buildLights() {
    // Bright ambient with a soft key: on paper the shapes are read from their
    // shadows, so the fill has to be high and the key gentle or every panel
    // flattens into the background it sits on.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdedbd6, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(3.5, 5, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.38);
    fill.position.set(-5, -2, 4);
    this.scene.add(fill);
  }

  /**
   * The shadow the window casts on the page.
   *
   * On a dark ground the model was separated from its background by being
   * brighter than it. On paper nothing is brighter than the page, so the
   * separation has to come from underneath — without this the window is a pale
   * rectangle floating in a pale field, which is exactly how the first light
   * pass read.
   */
  private buildShadow() {
    const size = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(30,45,95,0.34)");
    g.addColorStop(0.45, "rgba(30,45,95,0.16)");
    g.addColorStop(1, "rgba(30,45,95,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(tex);

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(9.4, 6.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    shadow.position.set(0.15, -0.5, -0.6);
    this.world.add(shadow);
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
        roughness: isAccent ? 0.42 : 0.72,
        metalness: isAccent ? 0.15 : 0.08,
        // Almost no emission: on paper a glowing panel just loses its edges.
        emissive: new THREE.Color(isAccent ? C.button : C.edgeSoft),
        emissiveIntensity: isAccent ? 0.12 : 0.02,
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
        color: isAccent ? 0x1c3aa8 : C.edge,
        transparent: true,
        // A light interface is read from its borders. On the dark version these
        // were a highlight; here they are the drawing.
        opacity: isAccent ? 0.5 : 0.85,
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
      "color:#1d2434",
      "background:rgba(255,255,255,0.94)",
      "border:1px solid rgba(38,62,140,0.3)",
      "box-shadow:0 6px 22px rgba(26,34,60,0.14)",
      "white-space:nowrap",
      "opacity:0",
      "will-change:transform,opacity",
    ].join(";");
    this.labelLayer.appendChild(el);
    this.labels.push({ el, pos, shown: 0, onlyStage });
  }

  /**
   * A bug, crawling about behind everything.
   *
   * The joke earns its place: this is a product that finds bugs, and one is
   * loose in its own shop window. It keeps to the background plane so it never
   * competes with the copy, it scurries when the cursor comes near, and it can
   * be squashed — which is the same gesture as fixing a defect, and the same
   * burst of particles.
   *
   * Built from primitives rather than a model file: a loaded mesh would be a
   * network request and a loader on a page whose whole point is that it costs
   * one dynamic import.
   */
  private buildBug() {
    const g = new THREE.Group();
    // On paper it needs no glow: a dark carapace is what reads against a light
    // ground, and the deep red keeps it a bug rather than a smudge. The dark
    // version of this page had it lit from within for the opposite reason.
    const shell = new THREE.MeshStandardMaterial({
      color: 0x7d2033,
      roughness: 0.34,
      metalness: 0.22,
      emissive: new THREE.Color(0x3a0d16),
      emissiveIntensity: 0.1,
    });
    const limb = new THREE.MeshStandardMaterial({ color: 0x35141c, roughness: 0.6 });

    // Forward is +Y: the bug lies in the background plane facing where it walks.
    const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), shell);
    abdomen.scale.set(0.85, 1.25, 0.7);
    abdomen.position.y = -0.1;
    const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.095, 14, 12), shell);
    thorax.scale.set(0.95, 1, 0.75);
    thorax.position.y = 0.09;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), shell);
    head.position.y = 0.19;
    g.add(abdomen, thorax, head);

    // A seam down the back, so it reads as a beetle rather than a pebble.
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.22, 0.01),
      new THREE.MeshBasicMaterial({ color: 0x4a1522 }),
    );
    seam.position.set(0, -0.09, 0.09);
    g.add(seam);

    const legGeom = new THREE.CylinderGeometry(0.012, 0.006, 0.16, 5);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        // Each leg is a pivot at the body with the shin hung off it, so the
        // walk cycle is one rotation rather than six positions to keep in sync.
        const pivot = new THREE.Object3D();
        pivot.position.set(side * 0.07, 0.12 - i * 0.11, 0);
        const leg = new THREE.Mesh(legGeom, limb);
        leg.position.set(side * 0.075, -0.01, -0.015);
        leg.rotation.z = side * 0.82;
        pivot.add(leg);
        pivot.userData.side = side;
        pivot.userData.index = i;
        g.add(pivot);
        this.bugLegs.push(pivot);
      }
    }

    for (let side = -1; side <= 1; side += 2) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.003, 0.115, 4), limb);
      ant.position.set(side * 0.032, 0.245, 0);
      ant.rotation.z = side * -0.42;
      g.add(ant);
    }

    // Big enough to be a bug rather than a speck, small enough to stay
    // background — it is a joke in the corner of the eye, not a mascot.
    // Clicking a beetle made of eight small primitives is a game of darts, so
    // it carries one invisible sphere that is the actual target.
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 10, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 0.02;
    g.add(hit);

    g.scale.setScalar(1.15);
    g.position.copy(this.bugState.pos);
    this.bug = g;
    this.scene.add(g);
  }

  private buildParticles() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const c1 = new THREE.Color(0x6f83b4);
    const c2 = new THREE.Color(0x8f7fc4);
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
      size: 0.035,
      vertexColors: true,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      // Normal blending, deliberately: additive light on a light ground adds
      // nothing that can be seen.
      blending: THREE.NormalBlending,
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
      blending: THREE.NormalBlending,
      depthWrite: false,
      opacity: 0.95,
    });
    this.scanGlow = new THREE.Sprite(mat);
    this.scanGlow.scale.setScalar(2.6);
    this.scanGlow.position.set(0, 0, 0.5);
    this.world.add(this.scanGlow);

    this.scanLight = new THREE.PointLight(C.scan, 4, 4.5, 1.8);
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
        depthWrite: false, blending: THREE.NormalBlending,
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
    if (wasDrag) return;
    // The bug is a target in its own right, at every stage — it is loose in the
    // background, not part of the act being explained.
    if (this.bugUnderPointer()) {
      this.squashBug();
      return;
    }
    this.tryFixAtPointer();
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
      const showing = stage === 3 || stage === 4;
      if (showing && !m.fixed) m.group.visible = true;
      if (!showing) {
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
    this.updateBug(dt, t, reduce);
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
      mat.emissiveIntensity = damp(mat.emissiveIntensity, base + near * 0.22, 9, dt);
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
    const overBug = !this.dragging && this.bugUnderPointer();
    const wantPointer = anyHover || overBug;
    if (wantPointer !== this.hovering) {
      this.hovering = wantPointer;
      this.renderer.domElement.style.cursor = wantPointer ? "pointer" : "grab";
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
    const want = this.stage === 3 || this.stage === 4 ? 1 : 0;
    for (const s of this.verdicts) {
      const mat = s.material as THREE.SpriteMaterial;
      mat.opacity = damp(mat.opacity, want, 5, dt);
      const target = want ? 0.3 : 0.001;
      s.scale.setScalar(damp(s.scale.x, target, 7, dt));
    }
  }

  /** Where the bug is allowed to wander — behind everything, and off to the sides. */
  // In FRONT of the window, not behind it. Behind, the model occludes the bug
  // across most of the frame and the joke is invisible; in front it reads as
  // something crawling on the glass. It is still behind every word on the page,
  // because the copy is HTML laid over the canvas.
  private static BUG_BOUNDS = { x: 6.4, yTop: 3.2, yBottom: -3.2, z: 1.25 };

  private updateBug(dt: number, t: number, reduce: boolean) {
    const b = this.bugState;
    const B = TraceoScene.BUG_BOUNDS;

    // Reduced motion: it stays, it does not crawl. A small thing wandering
    // across the field of view is close to the definition of what that setting
    // is asking to be spared, so the bug is left parked — still there, still
    // squashable, just not moving.
    if (reduce) {
      this.bug.position.copy(b.pos);
      this.bug.rotation.z = b.heading;
      for (const pivot of this.bugLegs) {
        pivot.rotation.z = 0;
        pivot.rotation.x = 0;
      }
      return;
    }

    if (b.squashed > 0) {
      // Squashed: gone for a moment, then back in from an edge. A bug that
      // never comes back would make the joke a one-shot, and the page is
      // scrolled through more than once.
      b.squashed -= dt;
      if (b.squashed <= 0) {
        b.pos.set(Math.random() < 0.5 ? -B.x : B.x, B.yBottom + Math.random() * 2, B.z);
        b.target.set((Math.random() * 2 - 1) * B.x * 0.7, B.yBottom + Math.random() * 3, B.z);
        this.bug.visible = true;
        this.bug.scale.setScalar(1);
      }
      return;
    }

    const toTarget = b.target.clone().sub(b.pos);
    const dist = toTarget.length();

    if (b.pause > 0 && !reduce) {
      // Bugs do not cross a room at a constant speed; they stop, think about
      // it, and go again. The pause is what stops it reading as a cursor.
      b.pause -= dt;
    } else if (dist < 0.25) {
      b.pause = 0.4 + Math.random() * 1.6;
      b.target.set(
        (Math.random() * 2 - 1) * B.x * 0.85,
        B.yBottom + Math.random() * (B.yTop - B.yBottom),
        B.z,
      );
    } else {
      const step = Math.min(dist, b.speed * (1 + b.startled * 2.4) * dt);
      b.pos.addScaledVector(toTarget.normalize(), step);
      b.gait += step * 13;
    }

    // The cursor is a threat. The scan point is in the world group's local
    // space and the bug is not, so it is brought across before comparing.
    if (this.pointerActive && !reduce) {
      const cursor = this.scanPoint.clone().applyMatrix4(this.world.matrixWorld);
      const away = new THREE.Vector2(b.pos.x - cursor.x, b.pos.y - cursor.y);
      const near = away.length();
      // Close enough to be noticed, near enough that it can still be caught.
      // At the old radius it bolted before the cursor could ever reach it, so
      // the joke had a punchline nobody could get to.
      if (near < 0.62) {
        b.startled = 1;
        away.normalize().multiplyScalar(2.6);
        b.target.set(
          THREE.MathUtils.clamp(b.pos.x + away.x, -B.x, B.x),
          THREE.MathUtils.clamp(b.pos.y + away.y, B.yBottom, B.yTop),
          B.z,
        );
        b.pause = 0;
      }
    }
    b.startled = damp(b.startled, 0, 1.2, dt);

    // Face the way it walks, and lean into a turn rather than snapping round.
    const wanted = Math.atan2(b.target.y - b.pos.y, b.target.x - b.pos.x) - Math.PI / 2;
    const delta = ((wanted - b.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
    b.heading += delta * (1 - Math.exp(-6 * dt));

    this.bug.position.copy(b.pos);
    this.bug.rotation.z = b.heading;

    // Alternating tripod: legs 0 and 2 on one side swing with leg 1 on the
    // other, which is how six legs stay standing on three of them.
    const walking = b.pause <= 0 && dist >= 0.25;
    for (const pivot of this.bugLegs) {
      const side = pivot.userData.side as number;
      const index = pivot.userData.index as number;
      const tripod = (index + (side > 0 ? 1 : 0)) % 2;
      const swing = reduce || !walking ? 0 : Math.sin(b.gait + tripod * Math.PI) * 0.42;
      pivot.rotation.z = swing;
      pivot.rotation.x = reduce || !walking ? 0 : Math.abs(Math.cos(b.gait + tripod * Math.PI)) * 0.2;
    }
    void t;
  }

  /** True when the pointer is over the bug — it is a click target of its own. */
  private bugUnderPointer(): boolean {
    if (!this.bug?.visible || this.bugState.squashed > 0) return false;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObject(this.bug, true).length > 0;
  }

  private squashBug() {
    this.bugState.squashed = 1.6;
    this.bug.visible = false;
    this.burst(this.bug.position.clone().applyMatrix4(this.world.matrixWorld.clone().invert()), 0xc6425a);
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
    this.scene.remove(this.bug);
    for (const tex of this.textures) tex.dispose();
    this.renderer.dispose();
    c.remove();
    this.labelLayer.remove();
  }
}
