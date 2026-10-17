// One WebGL1 scene for all optical surfaces. No DOM/video capture or textures.
// Background and displaced lens samples call the exact same scene function.
export type SceneRect = readonly [number, number, number, number];
export interface GlassSurfaceGeometry {
  readonly rect: SceneRect;
  readonly clip: SceneRect;
  readonly radius: number;
  readonly tint: readonly [number, number, number];
  readonly tintAmount?: number;
  readonly opacity: number;
  readonly roundedClips?: readonly { readonly rect: SceneRect; readonly radius: number }[];
}
export interface GlassSceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly table: SceneRect;
  readonly panel: SceneRect;
  readonly nomination: SceneRect;
  readonly workspace: SceneRect;
  readonly workspaceRadius: number;

  readonly background: readonly number[];
  readonly top: readonly number[];
  readonly theme: readonly number[];
  readonly felt: readonly number[];
  readonly feltDark: readonly number[];
  readonly night: boolean;
  readonly gold: number;
  readonly strength: number;
  readonly matte: boolean;
  readonly profile: "edge" | "simple";
  readonly frosting: number;
  readonly tintAmount: number;
  readonly edgeHighlights: number;
  readonly caustics: number;
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
uniform vec4 u_workspace;
uniform float u_workspaceRadius;

uniform vec4 u_clips[4];
uniform vec4 u_clipRadii;
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
uniform float u_matte;
uniform float u_profile;
uniform float u_frosting;
uniform float u_tintAmount;
uniform float u_edgeHighlights;
uniform float u_caustics;
uniform float u_lens;
float sdRound(vec2 p,vec4 r,float radius){
 vec2 q=abs(p-r.xy-r.zw*.5)-(r.zw*.5-vec2(radius));
 return length(max(q,0.0))+min(max(q.x,q.y),0.0)-radius;
}
float spot(vec2 uv,vec2 center,float size){return exp(-dot(uv-center,uv-center)/(size*size));}
vec3 scene(vec2 p){
 vec2 uv=p/u_view;
 // The decorative scene is anchored to the viewport, never a panel's bounds.
 vec3 col=mix(u_top,u_bg,clamp(uv.x*.4+uv.y*.6,0.0,1.0));
 col+=u_theme*u_gold*.25*exp(-dot(uv,uv)*2.3);
 float t=mod(p.x*.829+p.y*.559+390.0,195.0);
 float band=smoothstep(78.0,95.0,t)*(1.0-smoothstep(119.0,144.0,t));
 float mask=mix(.08,.8,smoothstep(0.0,.38,uv.y))*(1.0-.60*smoothstep(.82,1.0,uv.y));
 col+=vec3(.125,.120,.091)*band*mask;
 col+=sin(p.x*1.73+p.y*2.31)*sin(p.y*1.17-p.x*.83)*.002;
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
  col=mix(col,vec3(15.0,16.0,17.0)/255.0,.48);
  col+=vec3(.04)*max(0.0,1.0-panelUV.x-panelUV.y);
 }
 if(u_nomination.z>0.0 && sdRound(p,u_nomination,14.0)<0.0)
  col=mix(col,vec3(.04,.04,.03)+u_theme*.08,.34);
 if(u_workspace.z>0.0 && sdRound(p,u_workspace,u_workspaceRadius)<0.0){
  col=mix(col,vec3(15.0,16.0,17.0)/255.0,.48);
 }
 return col;
}
void main(){
 vec2 p=vec2(gl_FragCoord.x/u_resolution.x*u_view.x,(1.0-gl_FragCoord.y/u_resolution.y)*u_view.y);
 if(u_lens<.5){gl_FragColor=vec4(scene(p),1.0);return;}
 float d=sdRound(p,u_rect,u_radius);
 if(d>0.0)discard;
 for(int i=0;i<4;i++){
  if(u_clips[i].z>0.0 && sdRound(p,u_clips[i],u_clipRadii[i])>0.0)discard;
 }
 float edge=1.0-smoothstep(0.0,18.0,-d);
 vec2 q=p-u_rect.xy-u_rect.zw*.5;
 vec2 normal=normalize(q/(u_rect.zw*.5)+vec2(.00001));
 float amount=u_strength*(.20+edge*.80);
 if(u_profile>.5){
  normal=normalize(vec2(sdRound(p+vec2(.5,0.0),u_rect,u_radius)-sdRound(p-vec2(.5,0.0),u_rect,u_radius),
   sdRound(p+vec2(0.0,.5),u_rect,u_radius)-sdRound(p-vec2(0.0,.5),u_rect,u_radius))+vec2(.00001));
  float band=min(18.0,min(u_rect.z,u_rect.w)*.25);
  float t=clamp(1.0+d/band,0.0,1.0);
  amount=u_strength*t*t*(3.0-2.0*t);
 }
 // Capped-DPR canvas reconstruction must not spill displacement past the rim.
 amount*=smoothstep(1.25,2.25,-d);
 vec2 displaced=p-normal*amount;
 vec3 col=scene(displaced);
 // Fixed five-tap frosting of the same displaced decoration, in CSS pixels.
 // Clear mode keeps one sample; rims, tint and HTML content are not blurred.
 if(u_matte>.5 && u_frosting>0.0){
  col=col*.4+.15*(scene(displaced+vec2(u_frosting,0.0))+scene(displaced-vec2(u_frosting,0.0))
   +scene(displaced+vec2(0.0,u_frosting))+scene(displaced-vec2(0.0,u_frosting)));
 }
 col=mix(col,u_tint,u_tintAmount);
 float rim=(1.0-smoothstep(.35,2.0,-d));
 float light=pow(max(0.0,dot(normal,normalize(vec2(-.65,-.75)))),5.0);
 col+=vec3(.30,.27,.20)*rim*u_edgeHighlights+vec3(.12,.115,.10)*light*edge*u_caustics;
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
    const maximumSize = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
    );
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
        rect("u_workspace", scene.workspace);
        scalar("u_workspaceRadius", scene.workspaceRadius);

        rgb("u_bg", scene.background);
        rgb("u_top", scene.top);
        rgb("u_theme", scene.theme);
        rgb("u_felt", scene.felt);
        rgb("u_feltDark", scene.feltDark);
        scalar("u_night", scene.night ? 1 : 0);
        scalar("u_gold", scene.gold);
        scalar("u_strength", scene.strength);
        scalar("u_matte", scene.matte ? 1 : 0);
        scalar("u_profile", scene.profile === "edge" ? 1 : 0);
        scalar("u_frosting", scene.frosting);
        scalar("u_tintAmount", scene.tintAmount);
        scalar("u_edgeHighlights", scene.edgeHighlights);
        scalar("u_caustics", scene.caustics);
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
          scalar("u_tintAmount", surface.tintAmount ?? scene.tintAmount);
          const clips = surface.roundedClips ?? [];
          for (let i = 0; i < 4; i++) rect(`u_clips[${i}]`, clips[i]?.rect ?? [0, 0, 0, 0]);
          gl.uniform4fv(
            uniform("u_clipRadii"),
            Float32Array.from({ length: 4 }, (_, i) => clips[i]?.radius ?? 0),
          );
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
