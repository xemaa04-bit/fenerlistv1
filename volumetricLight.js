// -----------------------------------------------------------------------------
// EL FENERİ — "tozlu" hacimsel ışık huzmesi (postprocessing Pass)
// -----------------------------------------------------------------------------
// Ekran uzayında ışın yürütme (yarım çözünürlük):
//   • Görüş ışını spot konisiyle ANALİTİK kesiştirilir → sadece koni içindeki aralık yürünür
//     (koni dışındaki pikseller tek dallanmayla çıkar, maliyet ≈ sıfır).
//   • Örnekler eşaçılı (equiangular) dağıtılır: nokta ışığın 1/r^decay tekilliğini gürültüsüz
//     örnekler (merceğe yakın parlak bölge az adımla temiz kalır).
//   • Her örnekte: koni açısı (three.js ile aynı smoothstep), mesafe sönümü (aynı formül), GÖLGE
//     (ışığın RGBA paketli gölge haritası + shadow.matrix), COOKIE (aynı matrisle light.map),
//     rüzgârla kayan 3B toz gürültüsü ve Henyey-Greenstein faz fonksiyonu (ileri + geri lob).
//   • Interleaved-gradient-noise titreşimi → 2 geçiş derinlik duyarlı bulanıklaştırma →
//     derinlik duyarlı büyütme ile HDR sahneye EKLENİR (ton eşlemeden önce).
// Viewmodel (el/fener) pikselleri derinlik hilesi yüzünden kameraya çok yakın görünür → o
// piksellerde sis oluşmaz; huzme elin arkasında doğru şekilde kapanır.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { createDustNoise3D } from './flashlightTextures.js';

export const VOLUMETRIC_QUALITY = {
  low: { scale: 0.375, steps: 18, blur: 1 },
  medium: { scale: 0.5, steps: 26, blur: 2 },
  high: { scale: 0.5, steps: 34, blur: 2 },
  cinematic: { scale: 0.5, steps: 44, blur: 2 },
};

export const VOLUMETRIC_SETTINGS = {
  density: 0.012,        // saçılma katsayısı (1/m) — havadaki toz miktarı (0.01 temiz, 0.03 çok tozlu; eski 0.017 sahneyi süt gibi örtüyordu)
  intensity: 1.0,        // sanatsal çarpan
  anisotropy: 0.55,      // ileri saçılma lobu (g)
  backLobe: -0.35,       // geri saçılma lobu (g) — kamera huzmenin arkasındayken de görünür
  backMix: 0.18,         // geri lob payı
  noiseScale: 0.9,       // toz öbeği frekansı (1/m) → ~1 m'lik öbekler, ince tutamlar ×2.7
  noiseAmount: 0.75,     // öbeklenme (0 = homojen sis) — daha az lekeli/benekli huzme
  fineAmount: 0.55,      // ince tutamlar
  wind: [0.05, 0.014, -0.035], // toz akışı (m/s)
  nearFade: 0.25,        // merceğe çok yakın parlamayı yumuşat (m) — elin önünde parlak leke olmasın
  maxDistance: 26,       // huzme yürütme üst sınırı (m)
  depthSharpness: 18,    // bulanıklaştırma/büyütmede derinlik duyarlılığı
};

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

// Ortak: derinlikten dünya konumu / kamera mesafesi
const DEPTH_FUNCS = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uCamPos;
uniform float uFar;
vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uProjInv * ndc;
  vp /= vp.w;
  return (uViewInv * vp).xyz;
}
float sceneDistance(vec2 uv, out vec3 rayDir) {
  float d = texture2D(tDepth, uv).r;
  vec3 wp = worldFromDepth(uv, min(d, 0.9999999));
  vec3 dv = wp - uCamPos;
  float dist = length(dv);
  rayDir = dv / max(dist, 1e-6);
  return d >= 0.9999999 ? uFar : dist;
}`;

const MARCH_FRAG = /* glsl */`
#include <packing>
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
${DEPTH_FUNCS}
uniform vec3 uLightPos;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uCosOuter;
uniform float uCosInner;
uniform float uRange;
uniform float uDecay;
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uHasShadow;
uniform float uShadowBias;
uniform sampler2D uCookie;
uniform float uHasCookie;
uniform sampler3D uNoise;
uniform float uNoiseScale;
uniform vec3 uWind;
uniform float uNoiseAmount;
uniform float uFineAmount;
uniform float uDensity;
uniform float uG1;
uniform float uG2;
uniform float uGMix;
uniform float uNearFade;
uniform float uMaxDist;
uniform vec2 uResolution;
uniform float uJitterSeed;

const float PI4 = 12.566370614359172;
float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (PI4 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Işının ileri koni içindeki [giriş, çıkış] aralığı (yoksa giriş > çıkış)
vec2 coneInterval(vec3 o, vec3 v, vec3 p, vec3 a, float c) {
  vec3 co = o - p;
  float va = dot(v, a), ca = dot(co, a), c2 = c * c;
  float A = va * va - c2;
  float B = 2.0 * (va * ca - c2 * dot(v, co));
  float C = ca * ca - c2 * dot(co, co);
  float tMin = -1e9, tMax = 1e9;
  if (abs(va) > 1e-6) { float th = -ca / va; if (va > 0.0) tMin = th; else tMax = th; }
  else if (ca < 0.0) return vec2(1.0, -1.0);
  if (abs(A) < 1e-7) {
    if (abs(B) < 1e-9) { return C < 0.0 ? vec2(1.0, -1.0) : vec2(tMin, tMax); }
    float t = -C / B;
    if (B > 0.0) tMin = max(tMin, t); else tMax = min(tMax, t);
    return vec2(tMin, tMax);
  }
  float disc = B * B - 4.0 * A * C;
  if (disc < 0.0) return A < 0.0 ? vec2(1.0, -1.0) : vec2(tMin, tMax);
  float sq = sqrt(disc);
  float r0 = (-B - sq) / (2.0 * A), r1 = (-B + sq) / (2.0 * A);
  if (r0 > r1) { float tmp = r0; r0 = r1; r1 = tmp; }
  if (A < 0.0) return vec2(max(tMin, r0), min(tMax, r1));
  vec2 s1 = vec2(tMin, min(tMax, r0));
  vec2 s2 = vec2(max(tMin, r1), tMax);
  return (s2.y - s2.x) >= (s1.y - s1.x) ? s2 : s1;
}

void main() {
  vec3 v;
  float sceneDist = sceneDistance(vUv, v);
  vec3 o = uCamPos;
  vec3 p = uLightPos;
  vec2 ci = coneInterval(o, v, p, uLightDir, uCosOuter);
  // ışık menzili küresi
  vec3 co = o - p;
  float b = dot(co, v);
  float cc = dot(co, co) - uRange * uRange;
  float h = b * b - cc;
  float t0 = max(ci.x, 0.0), t1 = min(min(ci.y, sceneDist), uMaxDist);
  if (h > 0.0) { float sh = sqrt(h); t0 = max(t0, -b - sh); t1 = min(t1, -b + sh); } else { t1 = -1.0; }
  if (t1 <= t0 + 1e-4) { gl_FragColor = vec4(0.0, 0.0, 0.0, sceneDist); return; }

  // eşaçılı örnekleme
  float delta = dot(p - o, v);
  float D = max(length(p - (o + delta * v)), 0.015);
  float thA = atan(t0 - delta, D), thB = atan(t1 - delta, D);
  float jitter = fract(ign(gl_FragCoord.xy) + uJitterSeed);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float u = (float(i) + jitter) / float(STEPS);
    float th = mix(thA, thB, u);
    float t = delta + D * tan(th);
    float x2 = (t - delta);
    float w = (thB - thA) * (D * D + x2 * x2) / D;          // 1/pdf
    vec3 x = o + v * t;
    vec3 l = x - p;
    float r = length(l);
    vec3 ld = l / max(r, 1e-5);
    float spot = smoothstep(uCosOuter, uCosInner, dot(ld, uLightDir));
    if (spot <= 0.0) continue;
    float att = 1.0 / max(pow(r, uDecay), 0.01);
    float fr = clamp(1.0 - pow(r / uRange, 4.0), 0.0, 1.0);
    att *= fr * fr * smoothstep(0.0, uNearFade, r);
    vec3 li = uLightColor * spot * att;
    vec4 sc4 = uShadowMatrix * vec4(x, 1.0);
    vec3 sc = sc4.xyz / sc4.w;
    bool inMap = all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xy, vec2(1.0))) && sc4.w > 0.0;
    if (uHasShadow > 0.5 && inMap && sc.z < 1.0 && sc.z > 0.0) {
      float sd = unpackRGBAToDepth(texture2D(uShadowMap, sc.xy));
      if (sc.z + uShadowBias > sd) continue;
    }
    if (uHasCookie > 0.5 && inMap) li *= texture2D(uCookie, sc.xy).rgb;
    vec3 np = x * uNoiseScale + uWind;
    vec2 n = texture(uNoise, np).rg;
    vec2 n2 = texture(uNoise, np * 2.71 + vec3(0.37, 0.11, 0.73)).rg;
    float clump = mix(1.0, smoothstep(0.18, 0.82, n.r) * 1.85 + 0.08, uNoiseAmount);
    float fine = mix(1.0, n2.g * 2.1, uFineAmount);
    float dens = uDensity * clump * fine;
    float cth = dot(ld, -v);
    float ph = mix(hg(cth, uG1), hg(cth, uG2), uGMix);
    acc += li * (dens * ph * w);
  }
  acc /= float(STEPS);
  gl_FragColor = vec4(max(acc, vec3(0.0)), sceneDist);
}`;

const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uDir;          // texel adımı
uniform float uSharp;
void main() {
  vec4 c0 = texture2D(tInput, vUv);
  float d0 = c0.a;
  vec3 sum = c0.rgb * 0.2270270270;
  float wsum = 0.2270270270;
  float W[4];
  W[0] = 0.1945945946; W[1] = 0.1216216216; W[2] = 0.0540540541; W[3] = 0.0162162162;
  for (int i = 1; i <= 4; i++) {
    for (int s = -1; s <= 1; s += 2) {
      vec4 c = texture2D(tInput, vUv + uDir * float(i * s) * 1.5);
      float dd = abs(c.a - d0) / max(d0, 0.05);
      float w = W[i - 1] * exp(-dd * uSharp);
      sum += c.rgb * w; wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, d0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${DEPTH_FUNCS}
uniform sampler2D tScene;
uniform sampler2D tVol;
uniform vec2 uVolSize;
uniform float uSharp;
uniform float uIntensity;
void main() {
  vec4 scene = texture2D(tScene, vUv);
  vec3 v;
  float d = sceneDistance(vUv, v);
  // derinlik duyarlı büyütme: 4 komşu yarım çözünürlük tekseli
  vec2 tc = vUv * uVolSize - 0.5;
  vec2 f = fract(tc);
  vec2 base = (floor(tc) + 0.5) / uVolSize;
  vec2 px = 1.0 / uVolSize;
  vec4 s00 = texture2D(tVol, base);
  vec4 s10 = texture2D(tVol, base + vec2(px.x, 0.0));
  vec4 s01 = texture2D(tVol, base + vec2(0.0, px.y));
  vec4 s11 = texture2D(tVol, base + px);
  float inv = 1.0 / max(d, 0.05);
  float w00 = (1.0 - f.x) * (1.0 - f.y) * exp(-abs(s00.a - d) * inv * uSharp) + 1e-5;
  float w10 = f.x * (1.0 - f.y) * exp(-abs(s10.a - d) * inv * uSharp) + 1e-5;
  float w01 = (1.0 - f.x) * f.y * exp(-abs(s01.a - d) * inv * uSharp) + 1e-5;
  float w11 = f.x * f.y * exp(-abs(s11.a - d) * inv * uSharp) + 1e-5;
  vec3 vol = (s00.rgb * w00 + s10.rgb * w10 + s01.rgb * w01 + s11.rgb * w11) / (w00 + w10 + w01 + w11);
  gl_FragColor = vec4(scene.rgb + vol * uIntensity, scene.a);
}`;

/**
 * El feneri hacimsel huzme geçişi.
 * composer'a normalPass ile ton eşleme (masterPass) ARASINA eklenir.
 * @param {THREE.Camera} camera
 * @param {THREE.SpotLight} light
 */
export class VolumetricSpotPass extends Pass {
  constructor(camera, light, { quality = 'high', settings = {} } = {}) {
    super('VolumetricSpotPass');
    this.viewCamera = camera;
    this.light = light;
    this.settings = { ...VOLUMETRIC_SETTINGS, ...settings };
    this.needsDepthTexture = true;
    this.needsSwap = true;
    this.depthTexture = null;
    this.time = 0;
    this.quality = VOLUMETRIC_QUALITY[quality] ? quality : 'high';
    this.resolution = new THREE.Vector2(1, 1);
    this.lightPower = 1;       // dışarıdan (ör. rig.getLightPower) çarpan

    const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.rtA.texture.name = 'Volumetric.A';
    this.rtB.texture.name = 'Volumetric.B';
    this.rtA.texture.generateMipmaps = this.rtB.texture.generateMipmaps = false;

    this.noise = createDustNoise3D(64, 11);
    this.dummy2D = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.dummy2D.needsUpdate = true;

    const depthUniforms = () => ({
      tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uFar: { value: 100 },
    });
    this.marchMaterial = new THREE.ShaderMaterial({
      name: 'VolumetricSpot.March',
      defines: { STEPS: VOLUMETRIC_QUALITY[this.quality].steps },
      uniforms: {
        ...depthUniforms(),
        uLightPos: { value: new THREE.Vector3() }, uLightDir: { value: new THREE.Vector3(0, 0, -1) },
        uLightColor: { value: new THREE.Color() }, uCosOuter: { value: 0.9 }, uCosInner: { value: 0.95 },
        uRange: { value: 30 }, uDecay: { value: 2 },
        uShadowMap: { value: this.dummy2D }, uShadowMatrix: { value: new THREE.Matrix4() }, uHasShadow: { value: 0 }, uShadowBias: { value: 0 },
        uCookie: { value: this.dummy2D }, uHasCookie: { value: 0 },
        uNoise: { value: this.noise }, uNoiseScale: { value: 0.4 }, uWind: { value: new THREE.Vector3() },
        uNoiseAmount: { value: 0.8 }, uFineAmount: { value: 0.4 }, uDensity: { value: 0.04 },
        uG1: { value: 0.5 }, uG2: { value: -0.3 }, uGMix: { value: 0.3 }, uNearFade: { value: 0.06 }, uMaxDist: { value: 26 },
        uResolution: { value: new THREE.Vector2(1, 1) }, uJitterSeed: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT, fragmentShader: MARCH_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      name: 'VolumetricSpot.Blur',
      uniforms: { tInput: { value: null }, uDir: { value: new THREE.Vector2() }, uSharp: { value: 18 } },
      vertexShader: FULLSCREEN_VERT, fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'VolumetricSpot.Composite',
      uniforms: { ...depthUniforms(), tScene: { value: null }, tVol: { value: null }, uVolSize: { value: new THREE.Vector2(1, 1) },
        uSharp: { value: 18 }, uIntensity: { value: 1 } },
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.fullscreenMaterial = this.marchMaterial;
    this._v = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  /** composer tarafından çağrılır (kararlı sahne derinliği). */
  setDepthTexture(depthTexture) {
    this.depthTexture = depthTexture;
  }
  getDepthTexture() { return this.depthTexture; }

  setQuality(q) {
    if (!VOLUMETRIC_QUALITY[q] || q === this.quality) return;
    this.quality = q;
    this.marchMaterial.defines.STEPS = VOLUMETRIC_QUALITY[q].steps;
    this.marchMaterial.needsUpdate = true;
    this.setSize(this.resolution.x, this.resolution.y);
  }

  setSize(width, height) {
    this.resolution.set(width, height);
    const s = VOLUMETRIC_QUALITY[this.quality].scale;
    const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.marchMaterial.uniforms.uResolution.value.set(w, h);
    this.compositeMaterial.uniforms.uVolSize.value.set(w, h);
  }

  _updateDepthUniforms(u) {
    const cam = this.viewCamera;
    u.tDepth.value = this.depthTexture;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uViewInv.value.copy(cam.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.uFar.value = cam.far;
  }

  render(renderer, inputBuffer, outputBuffer, deltaTime = 1 / 60) {
    const light = this.light, S = this.settings;
    this.time += deltaTime || 0;
    const mu = this.marchMaterial.uniforms;
    this._updateDepthUniforms(mu);
    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    mu.uLightPos.value.setFromMatrixPosition(light.matrixWorld);
    this._t.setFromMatrixPosition(light.target.matrixWorld);
    mu.uLightDir.value.subVectors(this._t, mu.uLightPos.value).normalize();
    const power = light.visible ? light.intensity * this.lightPower : 0;
    mu.uLightColor.value.copy(light.color).multiplyScalar(power);
    mu.uCosOuter.value = Math.cos(light.angle);
    mu.uCosInner.value = Math.cos(light.angle * (1 - light.penumbra));
    mu.uRange.value = light.distance > 0 ? light.distance : S.maxDistance;
    mu.uDecay.value = light.decay;
    // gölge / cookie matrisi (three her karede günceller; ışık gölgesizse biz güncelleriz)
    const shadowTex = light.castShadow && light.shadow.map ? light.shadow.map.texture : null;
    if (!shadowTex) light.shadow.updateMatrices(light);
    mu.uShadowMatrix.value.copy(light.shadow.matrix);
    mu.uShadowMap.value = shadowTex || this.dummy2D;
    mu.uHasShadow.value = shadowTex && renderer.shadowMap.enabled ? 1 : 0;
    mu.uShadowBias.value = light.shadow.bias;
    mu.uCookie.value = light.map || this.dummy2D;
    mu.uHasCookie.value = light.map ? 1 : 0;
    mu.uNoiseScale.value = S.noiseScale;
    mu.uWind.value.set(S.wind[0], S.wind[1], S.wind[2]).multiplyScalar(this.time * S.noiseScale);
    mu.uNoiseAmount.value = S.noiseAmount;
    mu.uFineAmount.value = S.fineAmount;
    mu.uDensity.value = S.density;
    mu.uG1.value = S.anisotropy;
    mu.uG2.value = S.backLobe;
    mu.uGMix.value = S.backMix;
    mu.uNearFade.value = S.nearFade;
    mu.uMaxDist.value = S.maxDistance;

    // 1) ışın yürütme (yarım çözünürlük)
    this.fullscreenMaterial = this.marchMaterial;
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.scene, this.camera);
    // 2) derinlik duyarlı ayrılabilir bulanıklaştırma
    const bu = this.blurMaterial.uniforms;
    bu.uSharp.value = S.depthSharpness;
    this.fullscreenMaterial = this.blurMaterial;
    const iters = VOLUMETRIC_QUALITY[this.quality].blur;
    for (let i = 0; i < iters; i++) {
      bu.tInput.value = this.rtA.texture;
      bu.uDir.value.set(1 / this.rtA.width, 0);
      renderer.setRenderTarget(this.rtB);
      renderer.render(this.scene, this.camera);
      bu.tInput.value = this.rtB.texture;
      bu.uDir.value.set(0, 1 / this.rtA.height);
      renderer.setRenderTarget(this.rtA);
      renderer.render(this.scene, this.camera);
    }
    // 3) sahneye ekle (HDR, ton eşlemeden önce)
    const cu = this.compositeMaterial.uniforms;
    this._updateDepthUniforms(cu);
    cu.tScene.value = inputBuffer.texture;
    cu.tVol.value = this.rtA.texture;
    cu.uSharp.value = S.depthSharpness;
    cu.uIntensity.value = S.intensity;
    this.fullscreenMaterial = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.noise.dispose();
    this.dummy2D.dispose();
    this.marchMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    // Pass.dispose() çağrılmaz: composer'ın paylaşılan derinlik dokusunu da (depthTexture) silerdi
  }
}
