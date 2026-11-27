import * as THREE from 'three';
import { FINISHES, type FinishId } from '@crewmap/shared/avatar';

/**
 * Special finishes as cheap procedural shader patches on the kit's toon materials (no textures). Patterns are
 * evaluated in object space (they stick to the part while it turns); view-space normals give the fresnel/specular
 * fakes for metals and holo. One compiled program per finish (`#define FINISH n` + program cache key), shared by
 * every material with that finish. Time comes from a uniform object the caller owns: the live stage advances it per
 * frame; sprite bakes keep the default still frame.
 */
export interface FinishClock {
  value: number;
}

/** Phase the baked sprites show (a representative, non-degenerate frame). */
export const BAKE_PHASE = 1.7;

export const stillClock = (): FinishClock => ({ value: BAKE_PHASE });

const HEAD = /* glsl */ `
varying vec3 vFinPos;
uniform float uFinTime;
float finH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float finN(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(finH(i), finH(i + vec3(1.0, 0.0, 0.0)), f.x), mix(finH(i + vec3(0.0, 1.0, 0.0)), finH(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(finH(i + vec3(0.0, 0.0, 1.0)), finH(i + vec3(1.0, 0.0, 1.0)), f.x), mix(finH(i + vec3(0.0, 1.0, 1.0)), finH(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float finFbm(vec3 p) { return 0.5 * finN(p) + 0.25 * finN(p * 2.03) + 0.125 * finN(p * 4.01); }
vec3 finHsv(float h, float s, float v) { vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1.0), k, s); }
float finBaseHue(vec3 c) { float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn; if (d < 1e-4) return 0.0; float h = mx == c.r ? mod((c.g - c.b) / d, 6.0) : (mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0); return fract(h / 6.0); }
/** Spectrum sweep w in [0,1) centred on the chosen colour's hue (half the wheel); a grey base gets the full wheel. */
vec3 finTint(vec3 base, float w, float s, float v) {
  float chroma = max(base.r, max(base.g, base.b)) - min(base.r, min(base.g, base.b));
  float range = mix(1.0, 0.5, smoothstep(0.05, 0.2, chroma));
  return finHsv(fract(finBaseHue(base) + (w - 0.5) * range + 1.0), s, v);
}

/** Re-colours a finish's own palette toward the chosen colour (keeps its light/dark pattern); grey bases keep the original. */
vec3 finTone(vec3 c, vec3 base) {
  float chroma = max(base.r, max(base.g, base.b)) - min(base.r, min(base.g, base.b));
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 tinted = mix(vec3(l), finHsv(finBaseHue(base), 0.85, 1.0) * clamp(l * 1.9, 0.0, 1.25), 0.9);
  return mix(c, tinted, smoothstep(0.05, 0.2, chroma));
}
`;

/** Index = position in FINISHES (1 = rainbow, ...). */
const BODY = /* glsl */ `
{
  vec3 p = vFinPos; float t = uFinTime; vec3 base = diffuseColor.rgb;
  vec3 fn = normalize(normal); vec3 fv = normalize(vViewPosition);
  float fr = 1.0 - abs(dot(fn, fv));
  float spec = pow(max(dot(reflect(-fv, fn), normalize(vec3(0.3, 0.8, 0.5))), 0.0), 24.0);
  vec3 col = base; vec3 glow = vec3(0.0);
#if FINISH == 1
  col = finTint(base, fract(p.y * 1.5 + p.x * 0.5 - t * 0.3), 0.8, 1.0); glow = col * 0.15;
#elif FINISH == 2
  float a = finFbm(p * 2.0 + vec3(t * 0.3)); float b = finFbm(p * 3.4 + a * 2.0 - t * 0.2);
  col = finTint(base, fract(a * 1.5 + b + t * 0.1), 0.9, 1.0); glow = col * 0.2;
#elif FINISH == 3
  col = mix(base * 0.5 + 0.45, finTint(base, fract(fr * 1.2 + p.y * 0.6 + t * 0.1), 0.55, 1.0), 0.35 + 0.65 * fr); glow = col * fr * 0.35;
#elif FINISH == 4
  col = vec3(1.0, 0.74, 0.22) * (0.6 + 0.6 * fr); glow = vec3(1.0, 0.9, 0.6) * spec;
#elif FINISH == 5
  float e = fn.y * 0.5 + 0.5 + (finN(p * 3.0) - 0.5) * 0.2;
  col = mix(vec3(0.22, 0.24, 0.28), vec3(0.95), smoothstep(0.4, 0.6, e)); glow = vec3(spec);
#elif FINISH == 6
  float ga = t * 0.45; vec3 gp = vec3(p.x * cos(ga) - p.z * sin(ga), p.y, p.x * sin(ga) + p.z * cos(ga)) * 6.0;
  col = mix(vec3(0.04, 0.02, 0.14), vec3(0.42, 0.1, 0.6), finFbm(gp * 1.2 + vec3(0.0, t * 0.5, 0.0))) + vec3(0.1, 0.3, 0.6) * finFbm(gp * 2.4 - vec3(0.0, t * 0.35, 0.0));
  col = finTone(col, base);
  float cell = finH(floor(gp * 7.0));
  glow = vec3(step(0.93, cell) * (0.55 + 0.45 * sin(t * 4.0 + cell * 20.0))) + col * 0.2;
#elif FINISH == 7
  float crack = smoothstep(0.45, 0.6, finFbm(p * 2.5 + vec3(0.0, -t * 0.3, 0.0)));
  col = finTone(mix(vec3(0.12, 0.05, 0.04), vec3(1.0, 0.35, 0.05), crack), base); glow = finTone(vec3(1.0, 0.4, 0.05), base) * crack * 0.9;
#elif FINISH == 8
  col = finTone(mix(vec3(0.6, 0.85, 1.0), vec3(0.95, 1.0, 1.0), finFbm(p * 5.0)), base);
  glow = finTone(vec3(0.5, 0.8, 1.0), base) * fr * fr * 0.6 + vec3(spec * 0.8);
#elif FINISH == 9
  float g = finH(vec3(floor(p.y * 20.0), floor(t * 8.0), 3.0));
  col = g > 0.8 ? base.gbr : base; col = g > 0.94 ? vec3(0.0, 1.0, 1.0) : col;
  col *= 0.85 + 0.15 * step(0.5, fract(p.y * 40.0)); glow = col * 0.2 * step(0.85, g);
#elif FINISH == 10
  col = base * 0.35; glow = base * (0.35 + fr * fr * 1.4) * (0.75 + 0.25 * sin(t * 4.0));
#elif FINISH == 11
  float c1 = finN(p * 3.0); float c2 = finN(p * 3.0 + 7.0);
  col = mix(mix(vec3(0.3, 0.38, 0.2), base, 0.25), vec3(0.45, 0.38, 0.22), step(0.55, c2)); col = mix(col, vec3(0.16, 0.2, 0.1), step(0.6, c1));
#elif FINISH == 12
  col = mix(vec3(0.05), vec3(0.95), step(0.0, sin((p.x * 3.0 + finN(p * 2.0) * 2.0) * 6.0)));
#elif FINISH == 13
  float s = finN(p * 6.0);
  col = mix(vec3(0.86, 0.62, 0.3), vec3(0.08, 0.05, 0.03), smoothstep(0.62, 0.66, s) - smoothstep(0.72, 0.76, s));
  col = mix(col, vec3(0.6, 0.38, 0.15), smoothstep(0.72, 0.76, s));
  col = finTone(col, base);
#elif FINISH == 14
  vec3 q = floor(p * 6.0); col = mix(vec3(0.06), vec3(0.97), mod(q.x + q.y + q.z, 2.0));
#elif FINISH == 15
  float sx = abs(p.x); col = sx < 0.08 ? vec3(0.97) : (sx < 0.12 ? base * 0.3 : base);
#elif FINISH == 16
  col = finTint(base, fract(length(p.xz) * 2.0 + atan(p.z, p.x) * 0.16 + finN(p * 3.0) * 0.4), 0.65, 1.0);
#elif FINISH == 17
  vec2 w = (p.xy + p.zz) * 30.0; float f = mod(floor(w.x) + floor(w.y), 2.0) > 0.5 ? fract(w.x) : fract(w.y);
  col = vec3(0.07, 0.075, 0.08) + vec3(0.12) * sin(f * 3.14159); glow = vec3(spec * 0.4);
#elif FINISH == 18
  col = floor(base * (0.75 + 0.35 * finH(floor(p * 10.0) * 13.0)) * 4.0 + 0.5) / 4.0;
#endif
  diffuseColor.rgb = col; totalEmissiveRadiance += glow;
}
`;

/** Patch a toon material with a finish; `none` (or an unknown id) leaves it untouched. */
export function applyFinish(mat: THREE.MeshToonMaterial, finish: FinishId, clock: FinishClock): void {
  const idx = FINISHES.indexOf(finish);
  if (idx <= 0) return;
  mat.defines = { ...mat.defines, FINISH: idx };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFinTime = clock;
    sh.vertexShader = `varying vec3 vFinPos;\n${sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinPos = position;')}`;
    sh.fragmentShader = HEAD + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${BODY}`);
  };
  mat.customProgramCacheKey = () => `finish${idx}`;
}
