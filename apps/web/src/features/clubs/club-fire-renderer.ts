// LOCAL experiment. Original procedural geometry; no textures, page capture,
// third-party shaders or one-context-per-card rendering.
export type FirePoint = readonly [number, number];
export type FireRect = readonly [number, number, number, number];

/** The same transformed rounded border seeds ambient fire and entry. */
export function computeCardFront(
  card: HTMLElement,
  rect = card.getBoundingClientRect(),
  style = getComputedStyle(card),
): FirePoint[] {
  const width = card.offsetWidth,
    height = card.offsetHeight;
  if (width <= 0 || height <= 0) return [];
  const matrix =
    typeof DOMMatrixReadOnly === "undefined"
      ? { a: 1, b: 0, c: 0, d: 1 }
      : new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
  const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 16, width / 2, height / 2);
  const points: FirePoint[] = [];
  const cx = rect.left + rect.width / 2,
    cy = rect.top + rect.height / 2;
  // The actual viewport centre includes translation and transform-origin.
  const corners = [
    [width - radius, height - radius, 0],
    [radius, height - radius, Math.PI / 2],
    [radius, radius, Math.PI],
    [width - radius, radius, Math.PI * 1.5],
  ];
  for (const [x, y, start] of corners) {
    for (let i = 0; i <= 12; i++) {
      const angle = start! + ((i / 12) * Math.PI) / 2;
      const px = x! + Math.cos(angle) * radius - width / 2;
      const py = y! + Math.sin(angle) * radius - height / 2;
      points.push([cx + px * matrix.a + py * matrix.c, cy + px * matrix.b + py * matrix.d]);
    }
  }
  return points;
}

export interface BurnGeometry {
  front: readonly FirePoint[];
  holePath: string;
  cardFront: readonly FirePoint[];
  cardPath: string;
  maskPath: string;
}

const contourPath = (front: readonly FirePoint[]) =>
  front.length
    ? `${front.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join("")}Z`
    : "";

/** One sampled contour is consumed by BOTH the DOM clip and the GPU mesh. */
export function computeBurnGeometry(
  width: number,
  height: number,
  origin: { x: number; y: number; front?: readonly FirePoint[] },
  progress: number,
): BurnGeometry {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const outer = `M0 0H${width}V${height}H0Z`;
  // Subdivide the straight card edges too, so the existing ragged burn can
  // develop along the whole outline rather than just its rounded corners.
  const seed =
    origin.front && origin.front.length >= 3
      ? origin.front.flatMap(([x, y], i, points) => {
          const next = points[(i + 1) % points.length]!;
          const count = Math.max(1, Math.ceil(Math.hypot(next[0] - x, next[1] - y) / 4));
          return Array.from({ length: count }, (_, j): FirePoint => [
            x + ((next[0] - x) * j) / count,
            y + ((next[1] - y) * j) / count,
          ]);
        })
      : null;
  if (p === 0 && !seed)
    return { front: [], holePath: "", cardFront: [], cardPath: "", maskPath: outer };
  const coverage = Math.max(
    Math.hypot(origin.x, origin.y),
    Math.hypot(width - origin.x, origin.y),
    Math.hypot(origin.x, height - origin.y),
    Math.hypot(width - origin.x, height - origin.y),
  );
  const radius = (coverage * 1.34 + 90) * Math.pow(p, 1.12);
  const front: FirePoint[] = Array.from({ length: seed?.length ?? 384 }, (_, i) => {
    const point = seed?.[i];
    const angle = point
      ? Math.atan2(point[1] - origin.y, point[0] - origin.x)
      : (i / 384) * Math.PI * 2;
    const shape =
      0.96 +
      0.052 * Math.sin(angle * 3 + 0.7) +
      0.035 * Math.sin(angle * 7 - 1.3) +
      0.023 * Math.sin(angle * 17 + 2.1) +
      0.012 * Math.sin(angle * 41 - 0.8) +
      0.007 * Math.sin(angle * 97 + 1.5);
    const r = radius * shape;
    // Round once here, not separately in mask and mesh. The GPU front then
    // follows exactly the same polygon as the source's even-odd clipping.
    return [
      Math.round(((point?.[0] ?? origin.x) + Math.cos(angle) * r) * 100) / 100,
      Math.round(((point?.[1] ?? origin.y) + Math.sin(angle) * r) * 100) / 100,
    ];
  });
  // Keep the real card as an island inside the growing hole. Its independently
  // ragged edge eats inward without moving/scaling the underlying logo or text.
  const consumed = Math.min(1, p / 0.2);
  const cardFront: FirePoint[] =
    seed && consumed < 1
      ? seed.map(([x, y]) => {
          const angle = Math.atan2(y - origin.y, x - origin.x);
          const roughness =
            0.12 +
            0.07 * Math.sin(angle * 9 + 0.8) +
            0.035 * Math.sin(angle * 23 - 1.2) +
            0.015 * Math.sin(angle * 51);
          const remaining = Math.pow(1 - consumed, 1.2) * (1 - consumed * roughness);
          return [
            Math.round((origin.x + (x - origin.x) * remaining) * 100) / 100,
            Math.round((origin.y + (y - origin.y) * remaining) * 100) / 100,
          ];
        })
      : [];
  const holePath = contourPath(front);
  const cardPath = contourPath(cardFront);
  return { front, holePath, cardFront, cardPath, maskPath: outer + holePath + cardPath };
}

export interface FireSurface {
  front: readonly FirePoint[];
  clip: FireRect;
  energy: number;
  kind: "card" | "burn";
  seed: number;
  inward?: boolean;
  thickness?: number;
}
export interface ClubFireRenderer {
  draw: (width: number, height: number, time: number, surfaces: readonly FireSurface[]) => void;
  clear: () => void;
  dispose: (releaseContext?: boolean) => void;
}

const vertex = `
attribute vec2 a_position;
attribute float a_distance;
attribute float a_heat;
uniform vec2 u_view;
uniform float u_dpr;
varying vec2 v_position;
varying float v_distance;
varying float v_heat;
void main(){
  v_position=a_position;
  v_distance=a_distance;
  v_heat=a_heat;
  gl_Position=vec4(a_position/u_view*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
  gl_PointSize=max(1.,a_distance*u_dpr);
}`;

const fragment = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_time;
uniform float u_energy;
uniform float u_kind;
uniform float u_seed;
varying vec2 v_position;
varying float v_distance;
varying float v_heat;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){return noise(p)*.57+noise(p*2.03+8.7)*.29+noise(p*4.11-2.8)*.14;}
void main(){
  if(u_kind>1.5){
    float a=(1.-smoothstep(.08,.5,length(gl_PointCoord-.5)))*v_heat;
    gl_FragColor=vec4(vec3(1.,.43,.09)*a,a); return;
  }
  float burn=step(.5,u_kind);
  float d=v_distance;
  vec2 p=v_position+vec2(u_seed*17.3,0.);
  float flow=fbm(vec2(p.x*.052,p.y*.043+u_time*1.7));
  float grain=fbm(vec2(p.x*.13+u_time*.35,p.y*.10+u_time*3.1));
  float ember=fbm(p*.035+vec2(u_time*.11,-u_time*.19));
  float hot=smoothstep(.30,.78,ember)*(.63+.37*grain);
  if(burn>.5){
    // A broad, consuming sheet, not a neon outline: hot outside rim, mottled
    // ochre paper, then a broken black fringe on the revealed inner side.
    float inward=-d;
    float width=22.+fbm(p*.019+vec2(.7,-.3))*32.;
    float grit=noise(p*.37+vec2(u_time*.17,0.));
    float crumble=fbm(p*.12+vec2(1.9,u_time*.12));
    float inner=width+(crumble-.5)*11.;
    float sheet=smoothstep(-1.5,1.2,inward)*(1.-smoothstep(inner-6.,inner+1.,inward));
    float ash=smoothstep(inner-7.,inner+2.,inward)*(1.-smoothstep(inner+4.,inner+15.,inward));
    ash*=smoothstep(.21,.63,grit+crumble*.24);
    float rim=exp(-abs(d)/1.65);
    float glow=exp(-abs(d)/8.)*.27;
    float edgeHeat=1.-smoothstep(0.,inner,inward);
    float heat=clamp(.2+grain*.64+hot*.19+edgeHeat*.19,0.,1.);
    vec3 gold=mix(vec3(.36,.105,.018),vec3(1.,.68,.23),heat);
    gold*=.75+.3*grit;
    gold=mix(gold,vec3(1.,.86,.48),hot*.3*edgeHeat);
    float scorch=smoothstep(inner-13.,inner+2.,inward);
    gold=mix(gold,vec3(.055,.024,.011),scorch*.95);
    float paperAlpha=sheet*(.88+.12*grit);
    float ashAlpha=ash*(.72+.24*crumble);
    float rimAlpha=rim*.94;
    float glowAlpha=glow*(.55+.45*hot);
    float alpha=clamp(paperAlpha+ashAlpha*(1.-paperAlpha)+rimAlpha+glowAlpha,0.,.995);
    vec3 color=gold*paperAlpha;
    color+=vec3(.027,.016,.009)*ashAlpha*(1.-paperAlpha);
    color=mix(color,vec3(1.,.52,.10)*alpha,rimAlpha);
    color+=vec3(.57,.135,.016)*glowAlpha*(1.-paperAlpha);
    gl_FragColor=vec4(min(color,vec3(alpha)),alpha); return;
  }
  float outside=mix(d,-d,burn);
  float height=mix(2.8,19.,u_energy)*pow(flow,1.7)+burn*13.*grain;
  float tongue=smoothstep(-.5,2.8,outside)*(1.-smoothstep(height*.25,height+1.,outside));
  tongue*=smoothstep(.33,.76,flow)*u_energy;
  float core=exp(-abs(d)/mix(1.25,2.0,burn))*(.14+.86*hot);
  core*=mix(.28,1.,u_energy);
  float glow=exp(-abs(d)/mix(5.2,11.,burn))*hot*mix(.09,.38,u_energy);
  float coal=exp(-abs(d-1.1)/2.2)*smoothstep(.42,.72,grain)*.35;
  float charred=burn*smoothstep(-.5,1.8,d)*(1.-smoothstep(6.,15.,d))*(.55+.3*grain);
  float flame=clamp(core+tongue*.7+coal,0.,1.);
  vec3 hue=mix(vec3(.83,.115,.016),vec3(1.,.59,.16),smoothstep(.15,.75,flame));
  hue=mix(hue,vec3(1.,.88,.57),pow(core,2.5)*.86);
  float light=clamp(flame+glow,0.,1.);
  float alpha=clamp(charred+light*(1.-charred*.6),0.,.98);
  vec3 color=mix(vec3(.024,.012,.008),hue,light/max(.001,alpha));
  gl_FragColor=vec4(color*alpha,alpha);
}`;

/** A single low-power WebGL1 context, drawing only narrow edge meshes. */
export function createClubFireRenderer(canvas: HTMLCanvasElement): ClubFireRenderer {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) throw new Error("Club fire: WebGL unavailable");
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let disposed = false;
  const clear = () => {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  const dispose = (releaseContext = false) => {
    if (disposed) return;
    disposed = true;
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (releaseContext && !gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Club fire: shader allocation failed");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(`Club fire: ${gl.getShaderInfoLog(shader) ?? "shader failed"}`);
      return shader;
    };
    program = gl.createProgram();
    buffer = gl.createBuffer();
    if (!program || !buffer) throw new Error("Club fire: graphics allocation failed");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Club fire: shader linking failed");
    gl.useProgram(program);
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    const uniform = (name: string) => {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program!, name));
      return uniforms.get(name) ?? null;
    };
    const attributes = ["a_position", "a_distance", "a_heat"].map((name) =>
      gl.getAttribLocation(program!, name),
    );
    const upload = (vertices: number[], primitive: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      attributes.forEach((attribute, index) => {
        if (attribute < 0) return;
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(
          attribute,
          index === 0 ? 2 : 1,
          gl.FLOAT,
          false,
          16,
          index === 0 ? 0 : (index + 1) * 4,
        );
      });
      gl.drawArrays(primitive, 0, vertices.length / 4);
    };
    const maximumSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    return {
      clear,
      dispose,
      draw: (width, height, time, surfaces) => {
        if (disposed || gl.isContextLost()) throw new Error("Club fire: context lost");
        if (width <= 0 || height <= 0) return;
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          1.5,
          Math.sqrt(2_000_000 / (width * height)),
          maximumSize / width,
          maximumSize / height,
        );
        const w = Math.max(1, Math.round(width * dpr));
        const h = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.useProgram(program);
        clear();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.SCISSOR_TEST);
        gl.uniform2f(uniform("u_view"), width, height);
        gl.uniform1f(uniform("u_dpr"), dpr);
        gl.uniform1f(uniform("u_time"), time);
        for (const surface of surfaces) {
          const { front, energy, seed, kind, clip } = surface;
          const direction = surface.inward ? -1 : 1;
          const thickness = surface.thickness ?? 1;
          if (front.length < 3 || clip[2] <= 0 || clip[3] <= 0) continue;
          if (thickness <= 0) continue;
          const left = Math.max(0, Math.floor(clip[0] * dpr));
          const right = Math.min(w, Math.ceil((clip[0] + clip[2]) * dpr));
          const top = Math.max(0, Math.floor(clip[1] * dpr));
          const bottom = Math.min(h, Math.ceil((clip[1] + clip[3]) * dpr));
          if (right <= left || bottom <= top) continue;
          gl.scissor(left, h - bottom, right - left, bottom - top);
          gl.uniform1f(uniform("u_energy"), energy);
          gl.uniform1f(uniform("u_seed"), seed);
          gl.uniform1f(uniform("u_kind"), kind === "burn" ? 1 : 0);
          const levels =
            kind === "burn" ? [-86, -68, -52, -38, -22, -10, -3, 0, 3, 12] : [-7, -2, 0, 2, 8, 27];
          const centre = front.reduce(
            ([x, y], point) => [x + point[0] / front.length, y + point[1] / front.length],
            [0, 0],
          );
          const normals = front.map((_, i) => {
            if (kind === "burn") {
              // Radial offsets cannot fold over each other at jagged angular
              // valleys, unlike a wide normal extrusion of a ragged polygon.
              const point = front[i]!;
              const dx = point[0] - centre[0]!,
                dy = point[1] - centre[1]!;
              const length = Math.hypot(dx, dy) || 1;
              return [dx / length, dy / length] as const;
            }
            const a = front[(i + front.length - 1) % front.length]!;
            const b = front[(i + 1) % front.length]!;
            const dx = b[0] - a[0],
              dy = b[1] - a[1];
            const length = Math.hypot(dx, dy) || 1;
            return [dy / length, -dx / length] as const;
          });
          const mesh: number[] = [];
          const vertexAt = (i: number, distance: number) => {
            const point = front[i]!,
              normal = normals[i]!;
            const scaledDistance = distance * thickness;
            const radius = Math.hypot(point[0] - centre[0]!, point[1] - centre[1]!);
            const safeDistance =
              kind === "burn"
                ? surface.inward
                  ? Math.min(scaledDistance, Math.max(0, radius - 1))
                  : Math.max(scaledDistance, 1 - radius)
                : scaledDistance;
            mesh.push(
              point[0] + normal[0] * safeDistance * direction,
              point[1] + normal[1] * safeDistance * direction,
              safeDistance / thickness,
              1,
            );
          };
          for (let i = 0; i < front.length; i++) {
            const next = (i + 1) % front.length;
            for (let j = 0; j < levels.length - 1; j++) {
              const a = levels[j]!,
                b = levels[j + 1]!;
              vertexAt(i, a);
              vertexAt(next, a);
              vertexAt(i, b);
              vertexAt(i, b);
              vertexAt(next, a);
              vertexAt(next, b);
            }
          }
          upload(mesh, gl.TRIANGLES);
          // Sparse, deterministic points drift away from the true current front.
          const sparks: number[] = [];
          const count = kind === "burn" ? 46 : Math.round(3 + energy * 10);
          for (let i = 0; i < count; i++) {
            const random = Math.sin((i + 1) * 127.1 + seed * 311.7) * 43758.5453;
            const fraction = random - Math.floor(random);
            const life = (time * (kind === "burn" ? 0.65 : 0.34) + fraction) % 1;
            const point = front[Math.floor(((fraction + i * 0.618) % 1) * front.length)]!;
            const alpha =
              Math.sin(life * Math.PI) *
              (kind === "burn" ? 0.82 : 0.15 + energy * 0.55) *
              Math.min(1, thickness * 3);
            sparks.push(
              point[0] + Math.sin(i * 3.3 + life * 4) * life * 18,
              point[1] - life * (kind === "burn" ? 100 : 36 + energy * 35),
              0.8 + fraction * (kind === "burn" ? 2 : 1.2),
              alpha,
            );
          }
          gl.uniform1f(uniform("u_kind"), 2);
          upload(sparks, gl.POINTS);
        }
        gl.disable(gl.SCISSOR_TEST);
        if (gl.getError() !== gl.NO_ERROR) throw new Error("Club fire: drawing failed");
      },
    };
  } catch (error) {
    dispose(false);
    throw error;
  }
}
