// -----------------------------------------------------------------------------
// EL FENERİ — huzmede parlayan toz zerreleri
// -----------------------------------------------------------------------------
// Kameranın çevresinde, DÜNYAYA SABİT (kutu içinde mod ile sarılan) ~4000 zerre.
// Vertex shader'da sadece huzmenin içindekiler parlar: koni + mesafe sönümü + cookie + GÖLGE
// testi (gölgede kalan zerre sönük). Her zerre yavaşça süzülür, pul gibi döner → ara sıra
// hafifçe pırıldar; kameraya yakın olanlar odak dışı (yumuşak bokeh) görünür.
// Additive, depthWrite kapalı; FX_LAYER'da çizilir (normal/SSAO geçişine girmez).
//
// Parlaklık ayarı (kalite düzeltmesi): eski hâlde zerreler ışık şiddetini (60) doğrudan alıyordu
// → HDR değerleri 1.4 bloom eşiğinin çok üstüne (5-11) çıkıyor, aydınlık duvardan bile parlak,
// beyaz yanıp sönen noktalar oluşuyordu. Şimdi: düşük yansıma çarpanı + yumuşak HDR tavanı
// (softMax → bloom'a girmez), yumuşak/yavaş pırıltı, en küçük boyut sınırı (1 px altı zerreler
// kırpışmasın), kameraya çok yakın iri lekeler gizli, sahne sisi uygulanır, renk ışık renginden
// biraz arındırılır (toz ışığı nötre yakın saçar).
// -----------------------------------------------------------------------------
import * as THREE from 'three';

export const DUST_SETTINGS = {
  count: 4200,
  box: 6.0,              // m — kamerayı çevreleyen sarma kutusu
  size: 0.0032,          // m — zerre çapı (ekranda ~1-4 px)
  brightness: 0.085,     // HDR yansıma çarpanı (eski 0.30 → bloom patlaması)
  softMax: 0.55,         // HDR tavanı: zerre parlaklığı buna yumuşakça yaklaşır (bloom eşiği 1.4'ün altı)
  saturation: 0.55,      // zerre renginin ışık rengine doygunluğu (1 = ışık rengiyle aynı)
  glint: 0.4,            // pırıltı payı (0 = sabit parlaklık, 1 = sert yanıp sönme)
  drift: [0.035, -0.012, 0.02], // m/s ortak süzülme (hacimsel ışıktaki rüzgârla uyumlu)
  wobble: 0.04,          // m — tek tek zerrelerin salınımı
  focus: 0.35,           // m — bu mesafeden yakın zerreler bulanıklaşır
  blur: 5.0,             // odak dışı büyüme katsayısı
  minSize: 1.4,          // px — daha küçük zerreler enerji korunarak büyütülür (kırpışma yok)
  maxSize: 10,           // px — en iri bokeh
  nearFade: [0.12, 0.45], // m — kameraya bu mesafeden yakın zerreler yumuşakça kaybolur
};

const VERT = /* glsl */`
#include <packing>
attribute vec4 seed;            // x: boy, y: pırıltı fazı, z: dönüş hızı, w: parlaklık
uniform vec3 uCamPos;
uniform float uBox;
uniform vec3 uDrift;
uniform float uTime;
uniform float uWobble;
uniform float uSize;
uniform float uProjScale;
uniform float uFocus;
uniform float uBrightness;
uniform float uSoftMax;
uniform float uSat;
uniform float uGlint;
uniform float uBlur;
uniform float uMinSize;
uniform float uMaxSize;
uniform vec2 uNearFade;
uniform float uFogDensity;
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
varying vec3 vColor;
varying float vSoft;
const float PI4 = 12.566370614359172;
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (PI4 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vSoft = 0.0; }
void main() {
  // dünyaya sabit konum: ortak süzülme + kişisel salınım, kamera çevresinde sarılır
  vec3 wob = vec3(sin(uTime * 0.31 * seed.z + seed.y * 6.28), sin(uTime * 0.23 * seed.z + seed.y * 4.1), cos(uTime * 0.27 * seed.z + seed.y * 5.3)) * uWobble;
  vec3 p = position * uBox + uDrift * uTime + wob;
  vec3 rel = mod(p - uCamPos + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 wp = uCamPos + rel;
  // huzme içinde mi?
  vec3 l = wp - uLightPos;
  float r = length(l);
  vec3 ld = l / max(r, 1e-4);
  float spot = smoothstep(uCosOuter, uCosInner, dot(ld, uLightDir));
  if (spot <= 0.0 || r > uRange) { hide(); return; }
  float att = 1.0 / max(pow(r, uDecay), 0.01);
  float fr = clamp(1.0 - pow(r / uRange, 4.0), 0.0, 1.0);
  att *= fr * fr * smoothstep(0.08, 0.45, r);   // merceğin dibindeki zerreler patlamasın
  vec3 li = uLightColor * spot * att;
  vec4 sc4 = uShadowMatrix * vec4(wp, 1.0);
  vec3 sc = sc4.xyz / sc4.w;
  bool inMap = all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xy, vec2(1.0))) && sc4.w > 0.0;
  if (uHasShadow > 0.5 && inMap && sc.z > 0.0 && sc.z < 1.0) {
    float sd = unpackRGBAToDepth(texture2D(uShadowMap, sc.xy));
    if (sc.z + uShadowBias > sd) { hide(); return; }
  }
  if (uHasCookie > 0.5 && inMap) li *= texture2D(uCookie, sc.xy).rgb;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float dist = -mv.z;
  if (dist < 0.08) { hide(); return; }
  // pul gibi dönen zerre: yavaş, yumuşak pırıltılar (sert yanıp sönme yok)
  float spin = sin(uTime * (0.8 + seed.z * 2.2) + seed.y * 40.0);
  float glint = (1.0 - uGlint) + uGlint * pow(abs(spin), 8.0);
  vec3 toCam = normalize(uCamPos - wp);
  float ph = mix(hg(dot(ld, toCam), 0.6), hg(dot(ld, toCam), -0.3), 0.3) * PI4;
  // odak dışı: yakın zerre büyür ve enerjisi yayılır
  float px = uSize * (0.6 + seed.x) * uProjScale / dist;
  float defocus = max(0.0, uFocus - dist) / uFocus;
  float blur = 1.0 + defocus * defocus * uBlur;
  float size = clamp(px * blur, uMinSize, uMaxSize);
  float energy = (px * px + 0.6) / (size * size + 0.6);
  // kameraya çok yakın (göze yapışan) zerreler ve sis
  float nearF = smoothstep(uNearFade.x, uNearFade.y, dist);
  float fogF = exp(-uFogDensity * uFogDensity * dist * dist);
  vec3 c = li * (uBrightness * glint * ph * (0.4 + seed.w) * energy * nearF * fogF);
  // yumuşak HDR tavanı (Reinhard): parlak zerreler softMax'a yaklaşır, bloom'u tetiklemez
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (lum < 1e-4) { hide(); return; }
  c *= 1.0 / (1.0 + lum / uSoftMax);
  // toz ışığı nötre yakın saçar: renk ışık renginden biraz arındırılır
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSat);
  vColor = c;
  vSoft = clamp(defocus * 1.5, 0.0, 1.0);
  gl_PointSize = size;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
varying vec3 vColor;
varying float vSoft;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  // keskin zerre: gauss çekirdek; odak dışı: düz disk (bokeh) + yumuşak kenar
  float sharp = exp(-r2 * 4.0);
  float bokeh = smoothstep(1.0, 0.7, r2) * 0.55;
  float a = mix(sharp, bokeh, vSoft);
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

/**
 * @param {object} o
 * @param {THREE.SpotLight} o.light  huzmeyi veren spot ışık (el feneri)
 * @param {number} [o.layer]         çizim katmanı (oyunda FX_LAYER)
 */
export function createDustMotes({ light, layer = 0, settings = {} } = {}) {
  const S = { ...DUST_SETTINGS, ...settings };
  const geo = new THREE.BufferGeometry();
  let rnd = 98765;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  const pos = new Float32Array(S.count * 3), seed = new Float32Array(S.count * 4);
  for (let i = 0; i < S.count; i++) {
    pos[i * 3] = rand(); pos[i * 3 + 1] = rand(); pos[i * 3 + 2] = rand();
    seed[i * 4] = rand() ** 2;           // çoğu küçük, az sayıda iri
    seed[i * 4 + 1] = rand();
    seed[i * 4 + 2] = rand();
    seed[i * 4 + 3] = rand() ** 3 * 1.6; // birkaç tane belirgin parlak
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    name: 'FlashlightDustMotes',
    uniforms: {
      uCamPos: { value: new THREE.Vector3() }, uBox: { value: S.box }, uDrift: { value: new THREE.Vector3().fromArray(S.drift) },
      uTime: { value: 0 }, uWobble: { value: S.wobble }, uSize: { value: S.size }, uProjScale: { value: 500 },
      uFocus: { value: S.focus }, uBrightness: { value: S.brightness },
      uSoftMax: { value: S.softMax }, uSat: { value: S.saturation }, uGlint: { value: S.glint }, uBlur: { value: S.blur },
      uMinSize: { value: S.minSize }, uMaxSize: { value: S.maxSize }, uNearFade: { value: new THREE.Vector2().fromArray(S.nearFade) },
      uFogDensity: { value: 0 },
      uLightPos: { value: new THREE.Vector3() }, uLightDir: { value: new THREE.Vector3(0, 0, -1) }, uLightColor: { value: new THREE.Color() },
      uCosOuter: { value: 0.9 }, uCosInner: { value: 0.95 }, uRange: { value: 30 }, uDecay: { value: 2 },
      uShadowMap: { value: white }, uShadowMatrix: { value: new THREE.Matrix4() }, uHasShadow: { value: 0 }, uShadowBias: { value: 0 },
      uCookie: { value: white }, uHasCookie: { value: 0 },
    },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'flashlightDustMotes';
  points.frustumCulled = false;
  points.renderOrder = 5;
  points.layers.set(layer);
  const u = mat.uniforms;
  const tgt = new THREE.Vector3();
  const bufferSize = new THREE.Vector2();
  let time = 0;
  let power = 1;

  /** Her kare (render'dan önce). */
  function update(dt, camera, renderer = null) {
    time += dt;
    const p = light.visible ? light.intensity * power : 0;
    // Toz devre dışıyken (güç 0 / ışık kapalı) zerreler görünmezdir; bu durumda
    // her karedeki matris/uniform işini atlayarak boş CPU işi yapmayız.
    if (p <= 0.001) { points.visible = false; return; }
    u.uTime.value = time;
    camera.getWorldPosition(u.uCamPos.value);
    const h = renderer ? renderer.getDrawingBufferSize(bufferSize).y : (typeof innerHeight !== 'undefined' ? innerHeight : 720);
    u.uProjScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) * 0.5));
    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    u.uLightPos.value.setFromMatrixPosition(light.matrixWorld);
    tgt.setFromMatrixPosition(light.target.matrixWorld);
    u.uLightDir.value.subVectors(tgt, u.uLightPos.value).normalize();
    u.uLightColor.value.copy(light.color).multiplyScalar(p);
    // sahne sisi (FogExp2): zerreler de duvarlarla aynı oranda sise gömülsün
    const fog = points.parent && points.parent.fog;
    u.uFogDensity.value = fog && fog.isFogExp2 ? fog.density : 0;
    u.uCosOuter.value = Math.cos(light.angle);
    u.uCosInner.value = Math.cos(light.angle * (1 - light.penumbra));
    u.uRange.value = light.distance > 0 ? light.distance : 30;
    u.uDecay.value = light.decay;
    const shadowTex = light.castShadow && light.shadow.map ? light.shadow.map.texture : null;
    // gölge matrisi three tarafından bu karenin render'ında güncellenir; bir kare gecikme önemsiz,
    // ama ışık gölgesizse matrisi biz tazeleriz (cookie için)
    if (!shadowTex) light.shadow.updateMatrices(light);
    u.uShadowMatrix.value.copy(light.shadow.matrix);
    u.uShadowMap.value = shadowTex || white;
    u.uHasShadow.value = shadowTex && (!renderer || renderer.shadowMap.enabled) ? 1 : 0;
    u.uShadowBias.value = light.shadow.bias;
    u.uCookie.value = light.map || white;
    u.uHasCookie.value = light.map ? 1 : 0;
    points.visible = p > 0.001;
  }

  return {
    points,
    update,
    settings: S,
    setPower(v) { power = v; },
    dispose() { geo.dispose(); mat.dispose(); white.dispose(); },
  };
}
