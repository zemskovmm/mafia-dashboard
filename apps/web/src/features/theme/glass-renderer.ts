// One WebGL1 scene for all optical surfaces. No DOM/video capture or textures.
// Background and displaced lens samples call the exact same scene function.
export type SceneRect = readonly [number, number, number, number];
export interface GlassSurfaceGeometry {
  readonly rect: SceneRect;
  readonly clip: SceneRect;
  readonly radius: number;
  readonly tint: readonly [number, number, number];
  readonly opacity: number;
}
export interface GlassSceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly table: SceneRect;
  readonly panel: SceneRect;
  readonly nomination: SceneRect;
  readonly background: readonly number[];
  readonly top: readonly number[];
  readonly theme: readonly number[];
  readonly felt: readonly number[];
  readonly feltDark: readonly number[];
  readonly night: boolean;
  readonly gold: number;
  readonly strength: number;
  readonly surfaces: readonly GlassSurfaceGeometry[];
}

const vertex = `attribute vec2 a_position;
void main(){gl_Position=vec4(a_position,0.0,1.0);}`;
const fragment = `precision highp float;
uniform vec2 u_resolution;
uniform vec2 u_view;
uniform vec4 u_table;
uniform vec4 u_panel;
uniform vec4 u_nomination;
uniform vec4 u_rect;
uniform vec3 u_bg;
uniform vec3 u_top;
uniform vec3 u_theme;
uniform vec3 u_felt;
uniform vec3 u_feltDark;
uniform vec3 u_tint;
uniform float u_radius;
uniform float u_opacity;
uniform float u_night;
uniform float u_gold;
uniform float u_strength;
uniform float u_lens;
float sdRound(vec2 p,vec4 r,float radius){
 vec2 q=abs(p-r.xy-r.zw*.5)-(r.zw*.5-vec2(radius));
 return length(max(q,0.0))+min(max(q.x,q.y),0.0)-radius;
}
float spot(vec2 uv,vec2 center,float size){return exp(-dot(uv-center,uv-center)/(size*size));}
vec3 scene(vec2 p){
 vec2 uv=p/u_view;
 vec3 col=mix(u_top,u_bg,smoothstep(0.0,.45,uv.y));
 // Broad wash is independently scaled. Table/status colors and edges are not.
 col+=u_theme*u_gold*(.28*spot(uv,vec2(.86,.42),.27)+.18*spot(uv,vec2(.5,-.2),.4)
 +.34*spot(uv,vec2(.74,.16),.20)+.18*spot(uv,vec2(.28,.72),.28));
 col+=vec3(.04,.12,.08)*spot(uv,vec2(.76,.82),.32);
 float stripe=1.0-smoothstep(.6,1.7,abs(mod(p.x*.78+p.y*.63,52.0)-26.0));
 col+=vec3(.02)*stripe;
 if(u_table.z>0.0){
  vec2 center=u_table.xy+u_table.zw*.5;
  float distance=length((p-center)/(u_table.zw*.5));
  if(distance<1.0){
   vec3 felt=mix(u_felt,u_feltDark,clamp((p.y-u_table.y)/u_table.w,0.0,1.0));
   felt=mix(felt,felt*vec3(.60,.65,.89),u_night*.52);
   felt+=mix(vec3(.055,.038,.015),vec3(.013,.016,.045),u_night)*spot((p-u_table.xy)/u_table.zw,vec2(.24,.2),.25);
   float grain=sin(length(p-center)*.90)*.003;
   col=distance>.965?mix(vec3(.16,.11,.07),vec3(.12,.12,.20),u_night):felt+grain;
  }
 }
 if(u_panel.z>0.0 && sdRound(p,u_panel,20.0)<0.0){
  vec2 panelUV=(p-u_panel.xy)/u_panel.zw;
  col=mix(col,vec3(.05,.04,.03)+u_theme*.08,.65);
  col+=vec3(.08)*max(0.0,1.0-panelUV.x-panelUV.y);
  col+=u_theme*u_gold*.24*spot(panelUV,vec2(.12,.05),.30);
 }
 if(u_nomination.z>0.0 && sdRound(p,u_nomination,14.0)<0.0)
  col=mix(col,vec3(.04,.04,.03)+u_theme*.08,.34);
 return col;
}
void main(){
 vec2 p=vec2(gl_FragCoord.x/u_resolution.x*u_view.x,(1.0-gl_FragCoord.y/u_resolution.y)*u_view.y);
 if(u_lens<.5){gl_FragColor=vec4(scene(p),1.0);return;}
 float d=sdRound(p,u_rect,u_radius);
 if(d>0.0)discard;
 float edge=1.0-smoothstep(0.0,18.0,-d);
 vec2 q=p-u_rect.xy-u_rect.zw*.5;
 vec2 normal=normalize(q/(u_rect.zw*.5)+vec2(.00001));
 vec2 displaced=p-normal*u_strength*(.20+edge*.80);
 vec3 col=scene(displaced);
 col=mix(col,u_tint,.13);
 float rim=(1.0-smoothstep(.35,2.0,-d));
 float light=pow(max(0.0,dot(normal,normalize(vec2(-.65,-.75)))),5.0);
 col+=vec3(.30,.27,.20)*rim+vec3(.12,.115,.10)*light*edge;
 gl_FragColor=vec4(col,u_opacity);
}`;

export interface GlassRenderer {
  draw: (scene: GlassSceneGeometry) => void;
  dispose: (releaseContext?: boolean) => void;
}

export const createGlassRenderer = (canvas: HTMLCanvasElement): GlassRenderer => {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "low-power",
  });
  if (gl === null) throw new Error("WebGL unavailable");
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = (releaseContext = true) => {
    if (buffer !== null) gl.deleteBuffer(buffer);
    if (program !== null) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (releaseContext && !gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind);
      if (shader === null) throw new Error("Shader allocation failed");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Shader compilation failed");
      return shader;
    };
    program = gl.createProgram();
    buffer = gl.createBuffer();
    if (program === null || buffer === null) throw new Error("Graphics allocation failed");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Shader linking failed");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const locations = new Map<string, WebGLUniformLocation | null>();
    const uniform = (name: string) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program!, name));
      return locations.get(name) ?? null;
    };
    const scalar = (name: string, value: number) => gl.uniform1f(uniform(name), value);
    const rgb = (name: string, value: readonly number[]) =>
      gl.uniform3f(uniform(name), value[0]!, value[1]!, value[2]!);
    const rect = (name: string, value: SceneRect) => gl.uniform4f(uniform(name), ...value);
    const maximumSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    return {
      dispose,
      draw: (scene) => {
        if (gl.isContextLost()) throw new Error("Graphics context lost");
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          1.5,
          maximumSize / scene.width,
          maximumSize / scene.height,
        );
        const width = Math.max(1, Math.round(scene.width * dpr));
        const height = Math.max(1, Math.round(scene.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        gl.uniform2f(uniform("u_resolution"), width, height);
        gl.uniform2f(uniform("u_view"), scene.width, scene.height);
        rect("u_table", scene.table);
        rect("u_panel", scene.panel);
        rect("u_nomination", scene.nomination);
        rgb("u_bg", scene.background);
        rgb("u_top", scene.top);
        rgb("u_theme", scene.theme);
        rgb("u_felt", scene.felt);
        rgb("u_feltDark", scene.feltDark);
        scalar("u_night", scene.night ? 1 : 0);
        scalar("u_gold", scene.gold);
        scalar("u_strength", scene.strength);
        scalar("u_lens", 0);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.BLEND);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        scalar("u_lens", 1);
        gl.enable(gl.SCISSOR_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        for (const surface of scene.surfaces) {
          const [x, y, w, h] = surface.clip;
          const left = Math.max(0, Math.floor(x * dpr));
          const right = Math.min(width, Math.ceil((x + w) * dpr));
          const top = Math.max(0, Math.floor(y * dpr));
          const bottom = Math.min(height, Math.ceil((y + h) * dpr));
          if (right <= left || bottom <= top) continue;
          gl.scissor(left, height - bottom, right - left, bottom - top);
          rect("u_rect", surface.rect);
          scalar("u_radius", surface.radius);
          scalar("u_opacity", surface.opacity);
          rgb("u_tint", surface.tint);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.BLEND);
        if (gl.getError() !== gl.NO_ERROR) throw new Error("Glass drawing failed");
      },
    };
  } catch (error) {
    dispose(false);
    throw error;
  }
};
