/**
 * The landing hero's WebGL scene: the trace itself.
 *
 * Traceo's claim, and its name, is that nothing in a test report is orphaned —
 * every result leads back to a case, every case back to a requirement, and
 * every requirement back to something observed in the application. So the scene
 * is that structure, drawn: three columns woven together by threads, with
 * evidence travelling along them.
 *
 * The interaction is the claim, not a decoration of it. Touch any node and its
 * entire chain lights in both directions while everything else recedes — which
 * is precisely what the product does when you open a requirement (what covers
 * it) or open a failure (what it breaches). And in the derivation act, three
 * candidate cases arrive with no thread back to any evidence at all, and are
 * cut. The grounding gate is not explained here; it is watched.
 *
 * Framework-free on purpose. React owns the copy, the scroll position and the
 * remediation brief; this owns pixels. The only traffic between them is
 * `setStage()` going in and `onBugFixed` coming out, which keeps sixty renders
 * a second from ever touching React's reconciler.
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
 * Palette — the page's tokens, as numbers, because WebGL cannot read CSS
 * custom properties. Ink ground, one azure for the product's own marks, a
 * champagne gold for the evidence side, and saturation reserved for results.
 * ------------------------------------------------------------------------- */
const C = {
  gold: 0xc9a961,
  goldDim: 0x6d5c34,
  azure: 0x4c7bff,
  azureDeep: 0x2f55e0,
  steel: 0x5f7fb8,
  thread: 0x36486d,
  ok: 0x3fa37a,
  err: 0xc6425a,
  ivory: 0xf2efe9,
};

/* ---------------------------------------------------------------------------
 * The trace, as data.
 *
 * Everything on screen is derived from these three lists, so a thread, a
 * flowing particle, a verdict and a defect marker can never disagree about what
 * is connected to what. The content is the product's real vocabulary: these are
 * the requirements a scan of a sign-up page actually produces.
 * ------------------------------------------------------------------------- */

type ReqDef = { id: string; label: string; observed: string; y: number };
type CaseDef = { id: string; req: string; label: string; pass: boolean; y: number };

const COL_X = { req: -4.35, case: 0, result: 4.35 };

const REQS: ReqDef[] = [
  { id: "R1", label: "BRD-009 — the form accepts its declared fields", observed: "#signup · 4 fields", y: 2.05 },
  { id: "R2", label: "BRD-014 — email is mandatory at registration", observed: 'input[type="email"] · required', y: 1.0 },
  { id: "R3", label: "TRD-208 — the terms must be accepted", observed: 'input[type="checkbox"] · required', y: -0.05 },
  { id: "R4", label: "BRD-031 — every navigation link resolves", observed: "2 links · same origin", y: -1.1 },
  { id: "R5", label: "NFR-P-02 — the page loads within 3000 ms", observed: "load · 2410 ms baseline", y: -2.15 },
];

const CASES: CaseDef[] = [
  { id: "C1", req: "R1", label: "full_name accepts 32 characters", pass: true, y: 2.55 },
  { id: "C2", req: "R1", label: "pin rejects a 3-digit value", pass: true, y: 1.9 },
  { id: "C3", req: "R1", label: "country selection is accepted", pass: true, y: 1.25 },
  { id: "C4", req: "R2", label: "submission refused with email empty", pass: false, y: 0.6 },
  { id: "C5", req: "R2", label: "whitespace-only email is refused", pass: true, y: -0.05 },
  { id: "C6", req: "R3", label: "submit blocked with terms unticked", pass: false, y: -0.7 },
  { id: "C7", req: "R4", label: "/pricing resolves", pass: false, y: -1.35 },
  { id: "C8", req: "R4", label: "/docs resolves", pass: true, y: -2.0 },
  { id: "C9", req: "R5", label: "load completes inside budget", pass: true, y: -2.65 },
];

/** Candidates the model proposed that cite nothing discovery saw. */
const UNGROUNDED = [
  { id: "U1", label: "password strength ≥ 12", y: 1.5 },
  { id: "U2", label: "2FA code expires in 30 s", y: 0.2 },
  { id: "U3", label: "referral code is unique", y: -1.1 },
];

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
    actions: [
      "block submission while the required checkbox is unticked, in the handler AND on the server",
    ],
  },
  C7: {
    title: "A link points at a page that isn't there",
    where: 'a[href="/pricing"] on /signup',
    requirement: 'BRD-031 — "Every navigation link resolves to a live page"',
    actions: ["fix or remove the links that do not resolve"],
  },
};

/* --- small helpers --------------------------------------------------------- */

const damp = (cur: number, to: number, lambda: number, dt: number) =>
  cur + (to - cur) * (1 - Math.exp(-lambda * dt));

function glyphTexture(glyph: string, hex: number): THREE.CanvasTexture {
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const css = "#" + hex.toString(16).padStart(6, "0");
  ctx.fillStyle = css;
  ctx.font = "600 84px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, size / 2, size / 2 + 4);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A thread between two columns: bowed forward so the weave has depth. */
function thread(from: THREE.Vector3, to: THREE.Vector3): THREE.QuadraticBezierCurve3 {
  const mid = from.clone().lerp(to, 0.5);
  mid.z += 0.85;
  mid.y += (to.y - from.y) * 0.12;
  return new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
}

/* --------------------------------------------------------------------------- */

type Node = {
  id: string;
  kind: "req" | "case" | "result" | "ungrounded";
  mesh: THREE.Mesh;
  halo?: THREE.Mesh;
  pos: THREE.Vector3;
  baseEmissive: number;
  focus: number;
  /** ids this node is chained to, in both directions */
  chain: string[];
  pass?: boolean;
  cut?: boolean;
  cutT?: number;
  fixed?: boolean;
};

type Link = {
  from: string;
  to: string;
  curve: THREE.QuadraticBezierCurve3;
  mesh: THREE.Mesh;
  focus: number;
  drawn: number;
};

type Frame = { z: number; focus: [number, number]; bias: number; scale: number };

const FRAMES: Record<Stage, Frame> = {
  0: { z: 12.4, focus: [0, 0], bias: 0.43, scale: 0.7 },
  1: { z: 9.6, focus: [-4.35, 0], bias: 0.4, scale: 0.9 },
  2: { z: 10.6, focus: [-1.4, 0], bias: -0.32, scale: 0.86 },
  3: { z: 10.4, focus: [2.4, 0], bias: 0.34, scale: 0.86 },
  4: { z: 10.6, focus: [3.6, -0.2], bias: -0.26, scale: 0.92 },
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

  private nodes = new Map<string, Node>();
  private links: Link[] = [];
  private labels: { el: HTMLDivElement; pos: THREE.Vector3; shown: number; node?: string; onlyStage?: Stage }[] = [];
  private flow!: THREE.Points;
  private flowState: { link: number; t: number; speed: number }[] = [];
  private verdictSprites = new Map<string, THREE.Sprite>();
  private bursts: { pts: THREE.Points; life: number }[] = [];
  private textures: THREE.Texture[] = [];

  private hovered: string | null = null;
  private hoverChain = new Set<string>();
  private pointer = new THREE.Vector2(0, 0);
  private pointerActive = false;
  private dragging = false;
  private dragMoved = 0;
  private lastDrag = { x: 0, y: 0 };
  private spin = { x: 0, y: 0 };
  private spinTarget = { x: 0, y: 0 };
  private cursorPointer = false;

  private camPos = new THREE.Vector3(0, 0, 13.2);
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y";
    this.host.appendChild(canvas);

    this.labelLayer = document.createElement("div");
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.host.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.scene.add(this.world);
    this.scene.fog = new THREE.Fog(0x070b14, 16, 34);

    this.buildLights();
    this.buildNodes();
    this.buildLinks();
    this.buildFlow();
    this.buildCaptions();

    this.bind();
    this.opts.onBugCount?.(3, 3);
    this.start();
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x93a9d4, 0x080c16, 0.85));
    const key = new THREE.DirectionalLight(0xf0ece3, 1.05);
    key.position.set(2.5, 4, 8);
    this.scene.add(key);
    const warm = new THREE.PointLight(C.gold, 22, 26);
    warm.position.set(-7, 1.5, 4);
    this.scene.add(warm);
    const cool = new THREE.PointLight(C.steel, 26, 26);
    cool.position.set(7, -1.5, 4);
    this.scene.add(cool);
  }

  private addNode(
    id: string, kind: Node["kind"], pos: THREE.Vector3,
    geom: THREE.BufferGeometry, color: number, emissive: number,
  ) {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: emissive,
      roughness: 0.38,
      metalness: 0.12,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(pos);
    this.world.add(mesh);

    // A wider, unlit halo: it is what a node fades UP to when its chain is
    // traced, and it doubles as a hit volume far larger than the mark itself.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 12, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }),
    );
    mesh.add(halo);

    this.nodes.set(id, {
      id, kind, mesh, halo, pos: pos.clone(),
      baseEmissive: emissive, focus: 0, chain: [],
    });
  }

  private buildNodes() {
    const reqGeom = new THREE.IcosahedronGeometry(0.17, 1);
    const caseGeom = new THREE.OctahedronGeometry(0.125, 0);
    const resGeom = new THREE.SphereGeometry(0.14, 16, 12);

    for (const r of REQS) {
      this.addNode(r.id, "req", new THREE.Vector3(COL_X.req, r.y, 0), reqGeom, C.gold, 0.5);
    }
    for (const c of CASES) {
      this.addNode(c.id, "case", new THREE.Vector3(COL_X.case, c.y, 0), caseGeom, C.azure, 0.45);
      const rid = "V" + c.id;
      this.addNode(rid, "result", new THREE.Vector3(COL_X.result, c.y, 0), resGeom, c.pass ? C.ok : C.err, c.pass ? 0.45 : 0.85);
      const node = this.nodes.get(rid)!;
      node.pass = c.pass;

      const tex = glyphTexture(c.pass ? "✓" : "✕", c.pass ? C.ok : C.err);
      this.textures.push(tex);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
      sprite.position.set(COL_X.result + 0.42, c.y, 0.2);
      sprite.scale.setScalar(0.3);
      this.world.add(sprite);
      this.verdictSprites.set(rid, sprite);
    }
    for (const u of UNGROUNDED) {
      // Placed just short of the case column: they got as far as being proposed.
      this.addNode(u.id, "ungrounded", new THREE.Vector3(-1.5, u.y, 0.55), caseGeom, C.err, 0.5);
      const n = this.nodes.get(u.id)!;
      n.mesh.visible = false;
      (n.mesh.material as THREE.MeshStandardMaterial).opacity = 0;
    }

    // Chains, both directions — this is what a hover walks.
    for (const c of CASES) {
      const v = "V" + c.id;
      this.nodes.get(c.id)!.chain.push(c.req, v);
      this.nodes.get(c.req)!.chain.push(c.id);
      this.nodes.get(v)!.chain.push(c.id);
    }
  }

  private buildLinks() {
    const mkLink = (fromId: string, toId: string) => {
      const a = this.nodes.get(fromId)!.pos;
      const b = this.nodes.get(toId)!.pos;
      const curve = thread(a, b);
      const geom = new THREE.TubeGeometry(curve, 34, 0.014, 5, false);
      const mat = new THREE.MeshBasicMaterial({ color: C.thread, transparent: true, opacity: 0.62 });
      const mesh = new THREE.Mesh(geom, mat);
      this.world.add(mesh);
      this.links.push({ from: fromId, to: toId, curve, mesh, focus: 0, drawn: 1 });
    };
    for (const c of CASES) {
      mkLink(c.req, c.id);
      mkLink(c.id, "V" + c.id);
    }
  }

  private buildFlow() {
    const PER_LINK = 7;
    const total = this.links.length * PER_LINK;
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const gold = new THREE.Color(C.gold);
    const azure = new THREE.Color(C.azure);
    let i = 0;
    for (let l = 0; l < this.links.length; l++) {
      // Evidence arrives gold and leaves as a result: the first hop of every
      // chain carries the requirement's colour, the second the case's.
      const c = this.links[l].from.startsWith("R") ? gold : azure;
      for (let k = 0; k < PER_LINK; k++) {
        this.flowState.push({ link: l, t: Math.random(), speed: 0.11 + Math.random() * 0.07 });
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        i++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.flow = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: 0.062, vertexColors: true, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      }),
    );
    this.world.add(this.flow);
  }

  private makeLabel(text: string, pos: THREE.Vector3, opts: { node?: string; onlyStage?: Stage; caption?: boolean } = {}) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = [
      "position:absolute", "left:0", "top:0",
      "transform:translate(-50%,-50%)",
      opts.caption ? "padding:0" : "padding:4px 9px",
      opts.caption ? "" : "border-radius:3px",
      opts.caption
        ? "font:400 10px/1 'JetBrains Mono',ui-monospace,monospace"
        : "font:400 10.5px/1.4 'JetBrains Mono',ui-monospace,monospace",
      opts.caption ? "letter-spacing:0.24em" : "letter-spacing:0.02em",
      opts.caption ? "text-transform:uppercase" : "",
      opts.caption ? "color:#c9a961" : "color:#dfe6f2",
      opts.caption ? "background:none" : "background:rgba(10,15,28,0.9)",
      opts.caption ? "" : "border:1px solid rgba(201,169,97,0.34)",
      opts.caption ? "" : "box-shadow:0 8px 26px rgba(0,0,0,0.5)",
      "white-space:nowrap", "opacity:0", "will-change:transform,opacity",
    ].filter(Boolean).join(";");
    this.labelLayer.appendChild(el);
    this.labels.push({ el, pos, shown: 0, node: opts.node, onlyStage: opts.onlyStage });
  }

  private buildCaptions() {
    this.makeLabel("Requirements", new THREE.Vector3(COL_X.req, 3.15, 0), { caption: true });
    this.makeLabel("Test cases", new THREE.Vector3(COL_X.case, 3.15, 0), { caption: true });
    this.makeLabel("Results", new THREE.Vector3(COL_X.result, 3.15, 0), { caption: true });
    // What each requirement was observed from — the discovery act reveals these.
    for (const r of REQS) {
      this.makeLabel(r.observed, new THREE.Vector3(COL_X.req, r.y + 0.36, 0.2), { onlyStage: 1 });
    }
    for (const u of UNGROUNDED) {
      this.makeLabel(u.label, new THREE.Vector3(0, 0.36, 0.25), { node: u.id, onlyStage: 2 });
    }
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
      this.spinTarget.y = THREE.MathUtils.clamp(this.spinTarget.y + dx * 0.004, -0.6, 0.6);
      this.spinTarget.x = THREE.MathUtils.clamp(this.spinTarget.x - dy * 0.003, -0.32, 0.32);
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
      /* the capture was never taken; nothing to release */
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

  /** The node under the cursor, by its halo — a far larger target than the mark. */
  private pick(): Node | null {
    if (!this.pointerActive) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const halos: THREE.Object3D[] = [];
    for (const n of this.nodes.values()) {
      if (n.kind === "ungrounded" || n.cut || !n.mesh.visible) continue;
      if (n.halo) halos.push(n.halo);
    }
    const hits = this.raycaster.intersectObjects(halos, false);
    if (!hits.length) return null;
    for (const n of this.nodes.values()) if (n.halo === hits[0].object) return n;
    return null;
  }

  private walkChain(id: string): Set<string> {
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
      const cur = this.nodes.get(queue.shift()!);
      if (!cur) continue;
      for (const next of cur.chain) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  private tryFix() {
    if (this.stage < 4) return;
    const n = this.pick();
    if (!n || n.kind !== "result" || n.pass || n.fixed) return;
    this.fix(n);
  }

  private fix(node: Node) {
    node.fixed = true;
    node.pass = true;
    const mat = node.mesh.material as THREE.MeshStandardMaterial;
    mat.color.setHex(C.ok);
    mat.emissive.setHex(C.ok);
    node.baseEmissive = 0.45;
    (node.halo!.material as THREE.MeshBasicMaterial).color.setHex(C.ok);

    const tex = glyphTexture("✓", C.ok);
    this.textures.push(tex);
    const sprite = this.verdictSprites.get(node.id);
    if (sprite) {
      (sprite.material as THREE.SpriteMaterial).map = tex;
      (sprite.material as THREE.SpriteMaterial).needsUpdate = true;
    }
    this.burst(node.pos, C.ok);

    const caseId = node.id.slice(1);
    const def = DEFECTS[caseId];
    const remaining = [...this.nodes.values()].filter((x) => x.kind === "result" && !x.pass).length;
    if (def) {
      this.opts.onBugFixed?.({ id: caseId, ...def, remaining });
    }
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
      const sp = 1.2 + Math.random() * 2;
      vel.push(Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp, Math.sin(a) * Math.cos(b) * sp * 0.6);
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

    // The ungrounded candidates exist only for the derivation act: they arrive,
    // they are found to cite nothing, they are cut.
    for (const u of UNGROUNDED) {
      const n = this.nodes.get(u.id)!;
      if (next === 2) {
        n.mesh.visible = true;
        n.cut = false;
        n.cutT = -0.7 * UNGROUNDED.indexOf(u);
        n.mesh.position.set(-1.5, u.y, 0.55);
        (n.mesh.material as THREE.MeshStandardMaterial).opacity = 0;
      } else {
        n.mesh.visible = false;
        n.cut = true;
      }
    }
  }

  /** The keyboard-reachable equivalent of clicking each failed result. */
  fixAll() {
    for (const n of this.nodes.values()) {
      if (n.kind === "result" && !n.pass && !n.fixed) this.fix(n);
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

  private resolveFrame() {
    const f = this.frameSpec;
    const aspect = this.camera.aspect;
    const portrait = aspect < 1;
    const scale = f.scale * (portrait ? 0.58 : 1);
    const bias = f.bias * (portrait ? 0.2 : 1);
    const halfH = f.z * Math.tan((this.camera.fov * Math.PI) / 360);
    const halfW = halfH * aspect;

    this.worldScale = scale;
    this.camAim.set(
      f.focus[0] * scale - bias * halfW,
      f.focus[1] * scale - (portrait ? halfH * 0.34 : 0),
      0,
    );
    this.camPos.set(this.camAim.x, this.camAim.y + 0.15, f.z);
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const reduce = !!this.opts.reducedMotion;

    this.resolveFrame();
    this.camera.position.lerp(this.camPos, reduce ? 1 : 1 - Math.exp(-3 * dt));
    this.camera.lookAt(this.camAim);

    if (!reduce) {
      this.spin.y = damp(this.spin.y, this.spinTarget.y + Math.sin(t * 0.15) * 0.05, 3, dt);
      this.spin.x = damp(this.spin.x, this.spinTarget.x + Math.cos(t * 0.11) * 0.02, 3, dt);
    } else {
      this.spin.y = this.spinTarget.y;
      this.spin.x = this.spinTarget.x;
    }
    this.world.rotation.y = this.spin.y;
    this.world.rotation.x = this.spin.x;
    this.world.scale.setScalar(damp(this.world.scale.x || 1, this.worldScale, reduce ? 40 : 3, dt));

    this.updateHover(dt);
    this.updateNodes(dt, t, reduce);
    this.updateLinks(dt);
    this.updateFlow(dt, reduce);
    this.updateUngrounded(dt);
    this.updateVerdicts(dt);
    this.updateLabels(dt);
    this.updateBursts(dt);

    this.renderer.render(this.scene, this.camera);
  }

  private updateHover(_dt: number) {
    const hit = this.dragging ? null : this.pick();
    const id = hit?.id ?? null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.hoverChain = id ? this.walkChain(id) : new Set();
    }
    const wantPointer = !!hit && this.stage >= 4 && hit.kind === "result" && !hit.pass;
    if (wantPointer !== this.cursorPointer) {
      this.cursorPointer = wantPointer;
      this.renderer.domElement.style.cursor = wantPointer ? "pointer" : "grab";
    }
  }

  private updateNodes(dt: number, t: number, reduce: boolean) {
    const tracing = this.hoverChain.size > 0;
    for (const n of this.nodes.values()) {
      if (n.kind === "ungrounded") continue;
      const inChain = !tracing || this.hoverChain.has(n.id);
      n.focus = damp(n.focus, inChain ? 1 : 0.18, 8, dt);

      const mat = n.mesh.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.25 + n.focus * 0.75;
      let emissive = n.baseEmissive * (0.35 + n.focus * 0.9);
      // An unresolved failure keeps a slow pulse of its own, so the thing the
      // visitor is invited to click is never the same brightness as its neighbours.
      if (n.kind === "result" && !n.pass && !reduce) emissive += 0.35 + Math.sin(t * 2.4) * 0.28;
      mat.emissiveIntensity = emissive;

      if (n.halo) {
        const hm = n.halo.material as THREE.MeshBasicMaterial;
        hm.opacity = tracing && this.hoverChain.has(n.id) ? 0.1 : 0;
      }
      if (!reduce) n.mesh.rotation.y += dt * (n.kind === "case" ? 0.5 : 0.22);
    }
  }

  private updateLinks(dt: number) {
    const tracing = this.hoverChain.size > 0;
    for (const l of this.links) {
      const inChain = !tracing || (this.hoverChain.has(l.from) && this.hoverChain.has(l.to));
      l.focus = damp(l.focus, inChain ? 1 : 0.1, 8, dt);
      const mat = l.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.1 + l.focus * 0.62;
      mat.color.setHex(tracing && inChain ? C.gold : C.thread);
    }
  }

  private updateFlow(dt: number, reduce: boolean) {
    const attr = this.flow.geometry.getAttribute("position") as THREE.BufferAttribute;
    const tracing = this.hoverChain.size > 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < this.flowState.length; i++) {
      const f = this.flowState[i];
      if (!reduce) {
        f.t += dt * f.speed;
        if (f.t > 1) f.t -= 1;
      }
      const link = this.links[f.link];
      link.curve.getPointAt(f.t, p);
      attr.setXYZ(i, p.x, p.y, p.z);
    }
    attr.needsUpdate = true;
    const mat = this.flow.material as THREE.PointsMaterial;
    mat.opacity = damp(mat.opacity, tracing ? 0.35 : 0.85, 6, dt);
  }

  private updateUngrounded(dt: number) {
    for (const u of UNGROUNDED) {
      const n = this.nodes.get(u.id)!;
      if (!n.mesh.visible) continue;
      const mat = n.mesh.material as THREE.MeshStandardMaterial;
      n.cutT = (n.cutT ?? 0) + dt;
      if (n.cutT < 3.1) {
        // proposed, and held up to be checked
        mat.opacity = damp(mat.opacity, 0.96, 2.6, dt);
        n.mesh.position.x = damp(n.mesh.position.x, -0.8, 1.4, dt);
        mat.emissiveIntensity = 0.5 + Math.sin(Math.max(0, n.cutT) * 3) * 0.2;
      } else {
        // cut: it cites nothing, so nothing holds it up
        mat.opacity = damp(mat.opacity, 0, 1.6, dt);
        n.mesh.position.y -= dt * 1.05;
        n.mesh.rotation.z += dt * 1.3;
        if (n.cutT > 6.2) {
          n.mesh.position.set(-1.5, u.y, 0.55);
          n.mesh.rotation.set(0, 0, 0);
          mat.opacity = 0;
          n.cutT = 0;
        }
      }
    }
  }

  private updateVerdicts(dt: number) {
    const want = this.stage >= 3 ? 1 : 0;
    const tracing = this.hoverChain.size > 0;
    for (const [id, sprite] of this.verdictSprites) {
      const node = this.nodes.get(id)!;
      const inChain = !tracing || this.hoverChain.has(id);
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.opacity = damp(mat.opacity, want * (0.25 + (inChain ? 0.75 : 0)), 5, dt);
      sprite.scale.setScalar(damp(sprite.scale.x, want ? 0.3 : 0.001, 7, dt));
      void node;
    }
  }

  private updateLabels(dt: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    for (const l of this.labels) {
      let want: number;
      if (l.onlyStage !== undefined) want = this.stage === l.onlyStage ? 1 : 0;
      else want = 1; // column captions stand for the whole page
      if (l.node) {
        const owner = this.nodes.get(l.node)!;
        want *= owner.mesh.visible
          ? (owner.mesh.material as THREE.MeshStandardMaterial).opacity
          : 0;
      }
      l.shown = damp(l.shown, want, 7, dt);
      if (l.shown < 0.02) {
        l.el.style.opacity = "0";
        continue;
      }
      // A label bound to a node follows it: `pos` is an offset in that case,
      // an absolute point otherwise.
      const anchor = l.node
        ? this.nodes.get(l.node)!.mesh.position.clone().add(l.pos)
        : l.pos.clone();
      const world = anchor.applyMatrix4(this.world.matrixWorld);
      const p = world.project(this.camera);
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
          attr.getY(j) + vel[j * 3 + 1] * dt - 0.9 * dt * b.life,
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
    for (const tex of this.textures) tex.dispose();
    this.renderer.dispose();
    c.remove();
    this.labelLayer.remove();
  }
}
