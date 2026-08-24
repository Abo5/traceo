/**
 * The landing hero's WebGL scene: the specimen under glass.
 *
 * A luminous core — the application under test — sits inside a frosted vessel,
 * with heavy glass panes turning slowly around it. The glass is real: physical
 * transmission with roughness, so whatever sits behind a pane is genuinely
 * refracted and blurred by it rather than faked with an overlay. Bring a pane
 * forward and it clears; the thing behind it sharpens because the material
 * changed, not because a filter was swapped.
 *
 * That is the product's argument, made in a material. Traceo's whole claim is
 * that you can see what your application is actually doing rather than what it
 * probably does, and the page opens on something you cannot quite make out
 * until you clear the glass in front of it.
 *
 * Framework-free on purpose. React owns the copy, the scroll position and the
 * remediation brief; this owns pixels. The only traffic between them is
 * `setStage()` going in and `onBugFixed` coming out, which keeps sixty renders
 * a second from ever touching React's reconciler.
 *
 * Cost note: every transmissive object makes the renderer draw the scene again
 * into a transmission target. Four of them would be four extra passes a frame,
 * so the target is rendered at half resolution and the beads are ordinary
 * translucent material rather than glass. Frosted glass hides the difference —
 * that is the one place where the cheap thing and the right thing agree.
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

const C = {
  gold: 0xc9a961,
  azure: 0x4c7bff,
  azureDeep: 0x2f55e0,
  glass: 0xdbe6ff,
  ok: 0x3fa37a,
  err: 0xc6425a,
  ivory: 0xf2efe9,
};

/* --- what the panes and the core stand for -------------------------------- */

const PANES = [
  { id: "P1", label: "Discovery", angle: -0.5, radius: 3.5, w: 2.3, h: 3.1, tilt: 0.2, lift: 0.55 },
  { id: "P2", label: "Derivation", angle: 1.7, radius: 3.9, w: 1.95, h: 2.6, tilt: -0.26, lift: -0.7 },
  { id: "P3", label: "Execution", angle: 3.6, radius: 3.3, w: 2.15, h: 2.9, tilt: 0.13, lift: 0.15 },
];

/** What discovery read off the page — revealed when the first pane clears. */
const OBSERVED = [
  'input[type="email"] · required',
  'input[name="pin"] · pattern=^\\d{4}$',
  "maxlength=32",
  '<button type="submit">',
  '<a href="/pricing">',
];

const BEADS = [
  { id: "B1", label: "full_name accepts 32 characters", pass: true },
  { id: "B2", label: "pin rejects a 3-digit value", pass: true },
  { id: "B3", label: "country selection is accepted", pass: true },
  { id: "C4", label: "submission refused with email empty", pass: false },
  { id: "B5", label: "whitespace-only email is refused", pass: true },
  { id: "C6", label: "submit blocked with terms unticked", pass: false },
  { id: "C7", label: "/pricing resolves", pass: false },
  { id: "B8", label: "/docs resolves", pass: true },
  { id: "B9", label: "load completes inside budget", pass: true },
];

const UNGROUNDED = ["password strength ≥ 12", "2FA code expires in 30 s", "referral code is unique"];

const DEFECTS: Record<string, { title: string; where: string; requirement: string; actions: string[] }> = {
  C4: {
    title: "The form submits with the email left empty",
    where: "#email on /signup",
    requirement: 'BRD-014 — "Email is mandatory at registration"',
    actions: [
      "reject the submission while this field is empty, in the handler AND on the server",
      "show the user an error next to the field (aria-invalid + a message element)",
    ],
  },
  C6: {
    title: "Submit goes through with the terms box unticked",
    where: "button[type=submit] on /signup",
    requirement: 'TRD-208 — "Registration requires accepting the terms"',
    actions: ["block submission while the required checkbox is unticked, in the handler AND on the server"],
  },
  C7: {
    title: "A link points at a page that isn't there",
    where: 'a[href="/pricing"] on /signup',
    requirement: 'BRD-031 — "Every navigation link resolves to a live page"',
    actions: ["fix or remove the links that do not resolve"],
  },
};

/* --- helpers --------------------------------------------------------------- */

const damp = (cur: number, to: number, lambda: number, dt: number) =>
  cur + (to - cur) * (1 - Math.exp(-lambda * dt));

/** A rounded slab, from core three only. */
function slabGeometry(w: number, h: number, depth: number, r = 0.22): THREE.ExtrudeGeometry {
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
  const g = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3, curveSegments: 10,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

type Pane = {
  id: string;
  mesh: THREE.Mesh;
  mat: THREE.MeshPhysicalMaterial;
  angle: number;
  radius: number;
  tilt: number;
  lift: number;
  clear: number;
  hover: number;
  front: boolean;
};

type Bead = {
  id: string;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  halo: THREE.Mesh;
  angle: number;
  radius: number;
  height: number;
  speed: number;
  pass: boolean;
  fixed: boolean;
  revealed: number;
  hover: number;
};

type Ghost = { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; base: THREE.Vector3; t: number };

type Frame = { z: number; focus: [number, number]; bias: number; scale: number };

const FRAMES: Record<Stage, Frame> = {
  0: { z: 12.6, focus: [0, 0], bias: 0.42, scale: 0.82 },
  1: { z: 9.4, focus: [0, 0], bias: 0.36, scale: 1.0 },
  2: { z: 10.6, focus: [0, 0], bias: -0.32, scale: 0.95 },
  3: { z: 10.0, focus: [0, 0], bias: 0.34, scale: 0.95 },
  4: { z: 9.2, focus: [0, -0.1], bias: -0.3, scale: 1.0 },
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
  private frameSpec = FRAMES[0];
  private worldScale = 1;

  private core = new THREE.Group();
  private shards: THREE.Mesh[] = [];
  private vessel!: THREE.Mesh;
  private vesselMat!: THREE.MeshPhysicalMaterial;
  private panes: Pane[] = [];
  private beads: Bead[] = [];
  private ghosts: Ghost[] = [];
  private bursts: { pts: THREE.Points; life: number }[] = [];
  private labels: { el: HTMLDivElement; anchor: THREE.Object3D | null; offset: THREE.Vector3; shown: number; onlyStage?: Stage; caption?: boolean }[] = [];
  private envTexture: THREE.Texture | null = null;
  private motes!: THREE.Points;
  private textures: THREE.Texture[] = [];

  private pointer = new THREE.Vector2(0, 0);
  private pointerActive = false;
  private dragging = false;
  private dragMoved = 0;
  private lastDrag = { x: 0, y: 0 };
  private spin = { x: 0, y: 0 };
  private spinTarget = { x: 0, y: 0 };
  private cursorPointer = false;
  private hoverPane: string | null = null;
  private hoverBead: string | null = null;

  private camPos = new THREE.Vector3(0, 0, 12);
  private camAim = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();

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
    // Transmission is the expensive part; a lower pixel ratio costs far less
    // than a lower transmission resolution and is far harder to see.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    const anyRenderer = this.renderer as unknown as { transmissionResolutionScale?: number };
    if ("transmissionResolutionScale" in anyRenderer) anyRenderer.transmissionResolutionScale = 0.5;

    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y";
    this.host.appendChild(canvas);

    this.labelLayer = document.createElement("div");
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.host.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.scene.add(this.world);

    this.buildEnvironment();
    this.buildBackdrop();
    this.buildLights();
    this.buildCore();
    this.buildVessel();
    this.buildPanes();
    this.buildBeads();
    this.buildGhosts();

    this.bind();
    this.opts.onBugCount?.(3, 3);
    this.start();
  }

  /**
   * Glass has nothing to show without something to reflect, so the scene gets
   * an environment built here rather than fetched: a gradient with three soft
   * highlights, projected equirectangularly and pre-filtered. No network, no
   * HDR asset, and the highlights are placed where the panes will catch them.
   */
  private buildEnvironment() {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 256;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#22335a");
    g.addColorStop(0.45, "#0d1526");
    g.addColorStop(1, "#05080f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);

    const spot = (x: number, y: number, r: number, colour: string) => {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, colour);
      rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    spot(130, 62, 120, "rgba(168,196,255,0.95)");
    spot(372, 96, 96, "rgba(201,169,97,0.6)");
    spot(286, 208, 130, "rgba(70,105,180,0.4)");

    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    this.scene.environment = env;
    this.envTexture = env;
    pmrem.dispose();
    tex.dispose();
  }

  /**
   * Something for the glass to bend.
   *
   * Frosted glass in front of empty space is a grey sheet — refraction needs a
   * source, and roughness needs structure to smear. So there is a lit backdrop
   * behind everything and a field of motes between it and the panes. Both sit
   * in the scene rather than the rotating world, so turning the assembly moves
   * the glass across the light instead of carrying the light with it.
   */
  private buildBackdrop() {
    const cv = document.createElement("canvas");
    cv.width = 1024;
    cv.height = 640;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#070b14";
    ctx.fillRect(0, 0, 1024, 640);
    const glow = (x: number, y: number, r: number, colour: string) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, colour);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    // Weighted to the right of frame, where the glass sits. The copy occupies
    // the left third and needs the ground to stay dark under it.
    glow(690, 300, 360, "rgba(74,112,225,0.6)");
    glow(880, 176, 230, "rgba(201,169,97,0.34)");
    glow(560, 470, 260, "rgba(56,86,168,0.34)");
    glow(300, 300, 260, "rgba(40,62,120,0.22)");

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(tex);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 24),
      new THREE.MeshBasicMaterial({ map: tex, depthWrite: false }),
    );
    mesh.position.z = -9.5;
    this.scene.add(mesh);

    const N = 420;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const a = new THREE.Color(0x8fb0ff);
    const b = new THREE.Color(C.gold);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 22;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 13;
      pos[i * 3 + 2] = -8 + Math.random() * 6.5;
      const c = a.clone().lerp(b, Math.random() * 0.5);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.motes = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.07, vertexColors: true, transparent: true, opacity: 0.5,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      }),
    );
    this.scene.add(this.motes);
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x9fb4dc, 0x080c16, 0.5));
    const key = new THREE.DirectionalLight(0xf3efe6, 1.1);
    key.position.set(3, 4.5, 7);
    this.scene.add(key);
    const warm = new THREE.PointLight(C.gold, 26, 24);
    warm.position.set(-6, 2, 3.5);
    this.scene.add(warm);
    const cool = new THREE.PointLight(0x5f7fb8, 30, 24);
    cool.position.set(6, -2, 4);
    this.scene.add(cool);
  }

  /** The application under test: a small lattice of emissive shards. */
  private buildCore() {
    const geom = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const positions: [number, number, number][] = [
      [0, 0, 0], [0.42, 0.2, -0.1], [-0.4, 0.28, 0.12], [0.16, -0.42, 0.2],
      [-0.3, -0.3, -0.22], [0.5, -0.14, 0.3], [-0.52, -0.05, -0.3], [0.06, 0.5, 0.26],
      [0.3, 0.34, -0.4], [-0.18, -0.5, -0.05], [0.44, 0.02, -0.44], [-0.44, 0.4, -0.12],
    ];
    for (const [x, y, z] of positions) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x9fc0ff,
        emissive: new THREE.Color(C.azure),
        emissiveIntensity: 1.5,
        roughness: 0.3,
        metalness: 0.2,
      });
      const m = new THREE.Mesh(geom, mat);
      m.position.set(x, y, z);
      m.userData.home = m.position.clone();
      m.userData.seed = Math.random() * Math.PI * 2;
      this.core.add(m);
      this.shards.push(m);
    }
    this.world.add(this.core);
  }

  /** The frosted vessel around it — the glass you are looking through. */
  private buildVessel() {
    this.vesselMat = new THREE.MeshPhysicalMaterial({
      color: C.glass,
      metalness: 0,
      roughness: 0.16,
      transmission: 1,
      thickness: 0.45,
      ior: 1.48,
      attenuationColor: new THREE.Color(0x9fc0ff),
      attenuationDistance: 14,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      iridescence: 0.3,
      iridescenceIOR: 1.25,
      envMapIntensity: 1.5,
      transparent: true,
    });
    this.vessel = new THREE.Mesh(new THREE.IcosahedronGeometry(1.42, 4), this.vesselMat);
    this.world.add(this.vessel);
  }

  private buildPanes() {
    for (const def of PANES) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0xf2f7ff,
        metalness: 0,
        roughness: 0.22,
        transmission: 1,
        thickness: 0.2,
        ior: 1.5,
        attenuationColor: new THREE.Color(0xbcd2ff),
        attenuationDistance: 22,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        iridescence: 0.42,
        iridescenceIOR: 1.3,
        specularIntensity: 1,
        envMapIntensity: 1.6,
        transparent: true,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(slabGeometry(def.w, def.h, 0.22), mat);
      this.world.add(mesh);
      this.panes.push({
        id: def.id, mesh, mat, angle: def.angle, radius: def.radius,
        tilt: def.tilt, lift: def.lift, clear: 0, hover: 0, front: false,
      });
      this.makeLabel(def.label, mesh, new THREE.Vector3(0, def.h / 2 + 0.3, 0), { caption: true });
    }
  }

  /**
   * The derived cases, orbiting the vessel. Ordinary translucent material, not
   * glass: nine more transmissive objects would triple the frame cost to say
   * something the frost in front of them would swallow anyway.
   */
  private buildBeads() {
    const geom = new THREE.IcosahedronGeometry(0.13, 1);
    BEADS.forEach((b, i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc8d8ff,
        emissive: new THREE.Color(C.azure),
        emissiveIntensity: 0.7,
        roughness: 0.25,
        metalness: 0.1,
        transparent: true,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(geom, mat);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.36, 10, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      mesh.add(halo);
      this.world.add(mesh);
      this.beads.push({
        id: b.id, mesh, mat, halo,
        angle: (i / BEADS.length) * Math.PI * 2,
        radius: 2.35 + (i % 3) * 0.22,
        height: Math.sin(i * 1.7) * 0.85,
        speed: 0.1 + (i % 4) * 0.015,
        pass: b.pass, fixed: false, revealed: 0, hover: 0,
      });
      this.makeLabel(b.label, mesh, new THREE.Vector3(0, 0.32, 0), {});
    });
  }

  /** Candidates with nothing behind them: they never take on substance. */
  private buildGhosts() {
    const geom = new THREE.IcosahedronGeometry(0.13, 1);
    UNGROUNDED.forEach((label, i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffb3c0,
        emissive: new THREE.Color(C.err),
        emissiveIntensity: 0.8,
        roughness: 0.3,
        transparent: true,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(geom, mat);
      const base = new THREE.Vector3(-1.1 + i * 1.1, 2.4 + i * 0.25, 1.4);
      mesh.position.copy(base);
      mesh.visible = false;
      this.world.add(mesh);
      this.ghosts.push({ mesh, mat, base, t: -0.55 * i });
      this.makeLabel(label, mesh, new THREE.Vector3(0, 0.32, 0), { onlyStage: 2 });
    });
  }

  private makeLabel(
    text: string,
    anchor: THREE.Object3D | null,
    offset: THREE.Vector3,
    opts: { onlyStage?: Stage; caption?: boolean },
  ) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = [
      "position:absolute", "left:0", "top:0", "transform:translate(-50%,-50%)",
      opts.caption ? "padding:0" : "padding:4px 9px",
      opts.caption ? "" : "border-radius:3px",
      opts.caption
        ? "font:400 10px/1 'JetBrains Mono',ui-monospace,monospace"
        : "font:400 10.5px/1.4 'JetBrains Mono',ui-monospace,monospace",
      opts.caption ? "letter-spacing:0.24em" : "letter-spacing:0.02em",
      opts.caption ? "text-transform:uppercase" : "",
      opts.caption ? "color:#c9a961" : "color:#e4ebf7",
      opts.caption ? "background:none" : "background:rgba(9,14,26,0.82)",
      opts.caption ? "" : "border:1px solid rgba(201,169,97,0.3)",
      opts.caption ? "" : "backdrop-filter:blur(6px)",
      "white-space:nowrap", "opacity:0", "will-change:transform,opacity",
    ].filter(Boolean).join(";");
    this.labelLayer.appendChild(el);
    this.labels.push({ el, anchor, offset, shown: 0, onlyStage: opts.onlyStage, caption: opts.caption });
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
      this.spinTarget.y += dx * 0.005;
      this.spinTarget.x = THREE.MathUtils.clamp(this.spinTarget.x - dy * 0.003, -0.4, 0.4);
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
    try {
      this.renderer.domElement.releasePointerCapture?.(e.pointerId);
    } catch {
      /* capture was never taken */
    }
    if (!wasDrag) this.tryFix();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
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

  private pickBead(): Bead | null {
    if (!this.pointerActive) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const live = this.beads.filter((b) => b.revealed > 0.5);
    const hits = this.raycaster.intersectObjects(live.map((b) => b.halo), false);
    if (!hits.length) return null;
    return live.find((b) => b.halo === hits[0].object) ?? null;
  }

  private pickPane(): Pane | null {
    if (!this.pointerActive) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.panes.map((p) => p.mesh), false);
    if (!hits.length) return null;
    return this.panes.find((p) => p.mesh === hits[0].object) ?? null;
  }

  private tryFix() {
    if (this.stage < 4) return;
    const bead = this.pickBead();
    if (!bead || bead.pass || bead.fixed) return;
    this.fix(bead);
  }

  private fix(bead: Bead) {
    bead.fixed = true;
    bead.pass = true;
    bead.mat.color.setHex(0xbdf0d8);
    bead.mat.emissive.setHex(C.ok);
    this.burst(bead.mesh.position, C.ok);

    const remaining = this.beads.filter((b) => !b.pass).length;
    const def = DEFECTS[bead.id];
    if (def) this.opts.onBugFixed?.({ id: bead.id, ...def, remaining });
    this.opts.onBugCount?.(remaining, 3);
  }

  private burst(at: THREE.Vector3, hex: number) {
    const N = 40;
    const pos = new Float32Array(N * 3);
    const vel: number[] = [];
    for (let i = 0; i < N; i++) {
      pos[i * 3] = at.x; pos[i * 3 + 1] = at.y; pos[i * 3 + 2] = at.z;
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.5) * Math.PI;
      const sp = 1 + Math.random() * 1.9;
      vel.push(Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp, Math.sin(a) * Math.cos(b) * sp);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.userData.vel = vel;
    const pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: hex, size: 0.07, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.world.add(pts);
    this.bursts.push({ pts, life: 0 });
  }

  /* --- public API ---------------------------------------------------------- */

  setStage(next: Stage) {
    if (next === this.stage) return;
    this.stage = next;
    this.frameSpec = FRAMES[next];
    if (next < 4) this.spinTarget = { x: 0, y: 0 };

    // One pane is brought to the front per act; it clears as it arrives.
    this.panes.forEach((p, i) => {
      p.front = (next === 1 && i === 0) || (next === 2 && i === 1) || (next >= 3 && i === 2);
    });
    for (const g of this.ghosts) {
      g.mesh.visible = next === 2;
      if (next === 2) {
        g.t = -0.55 * this.ghosts.indexOf(g);
        g.mesh.position.copy(g.base);
        g.mat.opacity = 0;
      }
    }
  }

  /** The keyboard-reachable equivalent of clicking each failed case. */
  fixAll() {
    for (const b of this.beads) if (!b.pass && !b.fixed) this.fix(b);
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

  private resolveFrame() {
    const f = this.frameSpec;
    const aspect = this.camera.aspect;
    const portrait = aspect < 1;
    const scale = f.scale * (portrait ? 0.62 : 1);
    const bias = f.bias * (portrait ? 0.18 : 1);
    const halfH = f.z * Math.tan((this.camera.fov * Math.PI) / 360);
    const halfW = halfH * aspect;

    this.worldScale = scale;
    this.camAim.set(
      f.focus[0] * scale - bias * halfW,
      f.focus[1] * scale - (portrait ? halfH * 0.34 : 0),
      0,
    );
    this.camPos.set(this.camAim.x, this.camAim.y + 0.2, f.z);
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const reduce = !!this.opts.reducedMotion;

    this.resolveFrame();
    this.camera.position.lerp(this.camPos, reduce ? 1 : 1 - Math.exp(-3 * dt));
    this.camera.lookAt(this.camAim);

    if (!reduce) {
      this.spin.y = damp(this.spin.y, this.spinTarget.y + t * 0.055, 2.2, dt);
      this.spin.x = damp(this.spin.x, this.spinTarget.x + Math.cos(t * 0.13) * 0.03, 2.2, dt);
    } else {
      this.spin.y = this.spinTarget.y;
      this.spin.x = this.spinTarget.x;
    }
    this.world.rotation.y = this.spin.y;
    this.world.rotation.x = this.spin.x;
    this.world.scale.setScalar(damp(this.world.scale.x || 1, this.worldScale, reduce ? 40 : 3, dt));

    this.updateHover(dt);
    this.updateCore(dt, t, reduce);
    this.updatePanes(dt, t, reduce);
    this.updateBeads(dt, t, reduce);
    this.updateGhosts(dt);
    this.updateLabels(dt);
    this.updateBursts(dt);
    if (!reduce) this.motes.rotation.z = t * 0.012;

    this.renderer.render(this.scene, this.camera);
  }

  private updateHover(_dt: number) {
    const bead = this.dragging ? null : this.pickBead();
    this.hoverBead = bead?.id ?? null;
    const pane = bead || this.dragging ? null : this.pickPane();
    this.hoverPane = pane?.id ?? null;

    const wantPointer = !!bead && this.stage >= 4 && !bead.pass;
    if (wantPointer !== this.cursorPointer) {
      this.cursorPointer = wantPointer;
      this.renderer.domElement.style.cursor = wantPointer ? "pointer" : "grab";
    }
  }

  private updateCore(dt: number, t: number, reduce: boolean) {
    // The lattice loosens as the acts progress: the application stops being one
    // opaque thing and becomes the parts discovery found in it.
    const spread = this.stage === 0 ? 1 : 1.35;
    for (const m of this.shards) {
      const home = m.userData.home as THREE.Vector3;
      const seed = m.userData.seed as number;
      const drift = reduce ? 0 : Math.sin(t * 0.6 + seed) * 0.05;
      m.position.lerp(home.clone().multiplyScalar(spread).addScalar(drift), 1 - Math.exp(-2 * dt));
      if (!reduce) {
        m.rotation.x += dt * 0.25;
        m.rotation.y += dt * 0.32;
      }
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.2 + (reduce ? 0 : Math.sin(t * 1.6 + seed) * 0.4);
    }
    if (!reduce) this.core.rotation.y = t * 0.12;
  }

  private updatePanes(dt: number, t: number, reduce: boolean) {
    for (const p of this.panes) {
      const hovered = this.hoverPane === p.id;
      // Hover or an act brings a pane forward, and forward means clear: the
      // roughness is what makes the glass frosted, so this really is wiping it.
      const wantClear = hovered || p.front ? 1 : 0;
      p.clear = damp(p.clear, wantClear, 4, dt);
      p.hover = damp(p.hover, hovered ? 1 : 0, 6, dt);

      p.mat.roughness = 0.24 - p.clear * 0.21;
      p.mat.thickness = 0.2 - p.clear * 0.12;
      p.mat.clearcoatRoughness = 0.1 - p.clear * 0.08;

      // A pane the act has called forward stops orbiting and comes to a known
      // place. Letting it clear wherever its orbit happened to be meant the act
      // was framed by chance — sometimes centre stage, sometimes half off screen.
      if (p.front) {
        // Between the camera and the core, so you look THROUGH it at the thing
        // it is about. Past centre rather than at it: the pane is nearer the
        // camera than the core is, so perspective carries it back toward frame
        // centre on its own.
        const target = 1.94;
        const delta = ((target - p.angle + Math.PI) % (Math.PI * 2)) - Math.PI;
        p.angle += delta * (1 - Math.exp(-2.4 * dt));
      } else if (!reduce) {
        p.angle += dt * 0.11;
      }
      const radius = p.radius - p.clear * 1.3 - p.hover * 0.15;
      // A presented pane also settles toward the core's height, so its caption
      // has room above it instead of running off the top of the frame.
      const lift = p.lift * (1 - p.clear * 0.85) + p.clear * 0.1;
      p.mesh.position.set(
        Math.cos(p.angle) * radius,
        lift + Math.sin(p.angle * 0.7) * 0.3 * (1 - p.clear),
        Math.sin(p.angle) * radius,
      );
      p.mesh.rotation.set(p.tilt, -p.angle + Math.PI / 2, 0);
      void t;
    }
  }

  private updateBeads(dt: number, t: number, reduce: boolean) {
    const want = this.stage >= 2 ? 1 : 0;
    for (const b of this.beads) {
      b.revealed = damp(b.revealed, want, 2.4, dt);
      b.mat.opacity = b.revealed;
      const hovered = this.hoverBead === b.id;
      b.hover = damp(b.hover, hovered ? 1 : 0, 8, dt);

      if (!reduce) b.angle += dt * b.speed;
      const r = b.radius * (0.55 + b.revealed * 0.45);
      b.mesh.position.set(
        Math.cos(b.angle) * r,
        b.height + (reduce ? 0 : Math.sin(t * 0.5 + b.angle) * 0.12),
        Math.sin(b.angle) * r,
      );
      b.mesh.scale.setScalar(0.85 + b.hover * 0.5);
      if (!reduce) b.mesh.rotation.y += dt * 0.6;

      // A verdict only exists after execution; before that every bead is neutral.
      if (this.stage >= 3) {
        const target = b.pass ? C.ok : C.err;
        b.mat.emissive.lerp(new THREE.Color(target), 1 - Math.exp(-3 * dt));
        b.mat.emissiveIntensity = b.pass
          ? 0.8
          : 1.1 + (reduce ? 0 : Math.sin(t * 2.6) * 0.45);
      } else {
        b.mat.emissive.lerp(new THREE.Color(C.azure), 1 - Math.exp(-3 * dt));
        b.mat.emissiveIntensity = 0.7;
      }
    }
  }

  private updateGhosts(dt: number) {
    for (const g of this.ghosts) {
      if (!g.mesh.visible) continue;
      g.t += dt;
      if (g.t < 0) continue;
      if (g.t < 2.6) {
        // proposed: it drifts toward the vessel with the others
        g.mat.opacity = damp(g.mat.opacity, 0.9, 2.4, dt);
        g.mesh.position.lerp(new THREE.Vector3(g.base.x * 0.45, 0.5, 1.9), 1 - Math.exp(-1.1 * dt));
      } else {
        // cut: nothing behind it, so it never becomes a case
        g.mat.opacity = damp(g.mat.opacity, 0, 1.6, dt);
        g.mesh.position.y -= dt * 1.1;
        g.mesh.rotation.z += dt * 1.4;
        if (g.t > 5.6) {
          g.t = 0;
          g.mesh.position.copy(g.base);
          g.mesh.rotation.set(0, 0, 0);
          g.mat.opacity = 0;
        }
      }
    }
  }

  private updateLabels(dt: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    for (const l of this.labels) {
      let want: number;
      if (l.onlyStage !== undefined) {
        want = this.stage === l.onlyStage ? 1 : 0;
      } else if (l.caption) {
        // A pane names itself only while it is the one being looked through.
        const pane = this.panes.find((p) => p.mesh === l.anchor);
        want = pane ? Math.max(0, pane.clear - 0.25) : 0;
      } else {
        // A case names itself on hover — otherwise nine labels shout at once.
        const bead = this.beads.find((b) => b.mesh === l.anchor);
        want = bead ? bead.hover * bead.revealed : 0;
      }
      if (l.anchor && "material" in l.anchor) {
        const mat = (l.anchor as THREE.Mesh).material as THREE.Material & { opacity?: number };
        if (typeof mat.opacity === "number" && (l.anchor as THREE.Mesh).visible === false) want = 0;
        else if (l.onlyStage !== undefined && typeof mat.opacity === "number") want *= mat.opacity;
      }
      l.shown = damp(l.shown, want, 8, dt);
      if (l.shown < 0.02) {
        l.el.style.opacity = "0";
        continue;
      }
      const anchor = l.anchor
        ? l.anchor.getWorldPosition(new THREE.Vector3()).add(l.offset)
        : l.offset.clone().applyMatrix4(this.world.matrixWorld);
      const p = anchor.project(this.camera);
      const x = (p.x * 0.5 + 0.5) * r.width;
      const y = (-p.y * 0.5 + 0.5) * r.height;
      l.el.style.opacity = p.z > 1 ? "0" : l.shown.toFixed(3);
      l.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    }
  }

  private updateBursts(dt: number) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life += dt;
      const attr = b.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      const vel = b.pts.geometry.userData.vel as number[];
      for (let j = 0; j < attr.count; j++) {
        attr.setXYZ(
          j,
          attr.getX(j) + vel[j * 3] * dt,
          attr.getY(j) + vel[j * 3 + 1] * dt - 0.8 * dt * b.life,
          attr.getZ(j) + vel[j * 3 + 2] * dt,
        );
      }
      attr.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - b.life / 1.1);
      if (b.life > 1.1) {
        this.world.remove(b.pts);
        b.pts.geometry.dispose();
        (b.pts.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
      }
    }
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
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    this.envTexture?.dispose();
    for (const tex of this.textures) tex.dispose();
    this.renderer.dispose();
    c.remove();
    this.labelLayer.remove();
  }
}
