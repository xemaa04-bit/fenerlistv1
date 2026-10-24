// -----------------------------------------------------------------------------
// EL FENERİ — prosedürel 3B model (gerçek ölçülerde, metre)
// -----------------------------------------------------------------------------
// Klasik metal polis/taktik fener: eloksal alüminyum gövde, elmas tırtıllı kavrama,
// gövde üstünde kauçuk basmalı düğme (başparmakla), genişleyen kafa, oluklu kafa
// halkası, yuvarlak çerçeve (bezel), parabolik krom reflektör, LED ve cam lens.
// Torna (lathe) profilleri küçük pahlarla yuvarlatılır → kenarlar ışığı gerçekçi yakalar.
//
// Fener uzayı: ışın −Z, düğme (üst) +Y, orijin = kavrama merkezi.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import {
  createAnodizedMaps, createKnurlMaps, createRubberNormal, createOrangePeelNormal,
} from './flashlightTextures.js';

export const FLASHLIGHT_DIMS = {
  length: 0.2312,
  gripCenterY: 0.081,     // kavrama merkezi (profil y)
  bodyRadius: 0.0166,     // tırtıllı gövde yarıçapı
  knurlFrom: 0.0336,
  knurlTo: 0.1290,
  switchY: 0.1522,        // düğme merkezi
  collarRadius: 0.0176,
  lensY: 0.2288,
  lensRadius: 0.0229,
  headRadius: 0.0272,
};

// Dış silüetin sadeleştirilmiş profili [profil y, yarıçap] — kavrama çözücüsü parmak/başparmak
// temasını bununla hesaplar (oluklar yok sayılır, en dış yarıçap alınır).
const SILHOUETTE = (() => {
  const pts = [
    [0.0000, 0.0124], [0.0010, 0.0168], [0.0036, 0.0179], [0.0232, 0.0179], [0.0262, 0.0171],
    [0.0267, 0.0165], [0.0284, 0.0170], [0.0334, 0.0170], [0.0336, 0.0166], [0.1290, 0.0166],
    [0.1298, 0.0170], [0.1366, 0.0170], [0.1392, 0.0177], [0.1652, 0.0177], [0.1678, 0.0170],
  ];
  for (let i = 1; i <= 9; i++) {
    const t = i / 10, e = t * t * (3 - 2 * t);
    pts.push([0.1690 + (0.1925 - 0.1690) * t, 0.0170 + (0.0262 - 0.0170) * e]);
  }
  pts.push([0.1935, 0.0262], [0.2198, 0.0262], [0.2214, 0.0257], [0.2220, 0.0273], [0.2288, 0.0273], [0.2312, 0.0262]);
  return pts;
})();
/** Profil yüksekliğinde (kuyruk = 0, lens = 0.2312) gövdenin dış yarıçapı (m). */
export function flashlightRadiusAt(y) {
  const P = SILHOUETTE;
  if (y <= P[0][0]) return P[0][1];
  if (y >= P[P.length - 1][0]) return P[P.length - 1][1];
  let i = 1;
  while (i < P.length - 1 && P[i][0] < y) i++;
  const a = P[i - 1], b = P[i];
  const t = (y - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * t;
}

// Köşeleri yuvarlatılmış poligon: [[r, y, fileYarıçapı], ...]; 0 = keskin kenar.
function roundedProfile(pts, steps = 4) {
  const out = [];
  const P = pts.map(p => new THREE.Vector2(p[0], p[1]));
  for (let i = 0; i < P.length; i++) {
    const rad = pts[i][2] || 0;
    if (i === 0 || i === P.length - 1 || rad <= 0) {
      if (i !== 0 && i !== P.length - 1 && rad <= 0) { out.push(P[i].clone(), P[i].clone()); } // sert kenar
      else out.push(P[i].clone());
      continue;
    }
    const a = P[i].clone().sub(P[i - 1]), b = P[i + 1].clone().sub(P[i]);
    const la = a.length(), lb = b.length();
    a.divideScalar(la); b.divideScalar(lb);
    const cosT = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    const turn = Math.acos(cosT);
    if (turn < 1e-3) { out.push(P[i].clone()); continue; }
    let t = rad * Math.tan(turn / 2);
    t = Math.min(t, la * 0.48, lb * 0.48);
    const p0 = P[i].clone().addScaledVector(a, -t);
    const p1 = P[i].clone().addScaledVector(b, t);
    // ikinci dereceden Bezier ile yay yaklaşımı
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const q = p0.clone().multiplyScalar((1 - u) * (1 - u))
        .addScaledVector(P[i], 2 * u * (1 - u))
        .addScaledVector(p1, u * u);
      out.push(q);
    }
  }
  return out;
}

/** LatheGeometry + yay uzunluğu UV'si + profil kenarlarında aşınma özniteliği. */
function latheGeo(points, segments = 64, uRepeat = 1) {
  const geo = new THREE.LatheGeometry(points, segments);
  const n = points.length;
  const s = new Float32Array(n);
  for (let j = 1; j < n; j++) s[j] = s[j - 1] + points[j].distanceTo(points[j - 1]);
  const total = s[n - 1] || 1;
  // aşınma: profil yönünün keskin döndüğü yerler (kenarlar, pahlar) + en dış yarıçaplar
  const wearP = new Float32Array(n);
  let maxR = 0;
  for (const p of points) maxR = Math.max(maxR, p.x);
  for (let j = 0; j < n; j++) {
    let turn = 0;
    const prev = points[Math.max(0, j - 2)], next = points[Math.min(n - 1, j + 2)];
    const a = points[j].clone().sub(prev), b = next.clone().sub(points[j]);
    if (a.lengthSq() > 1e-12 && b.lengthSq() > 1e-12) turn = Math.acos(THREE.MathUtils.clamp(a.normalize().dot(b.normalize()), -1, 1));
    const outer = THREE.MathUtils.smoothstep(points[j].x, maxR * 0.96, maxR);
    // bölgesel aşınma: kuyruk kapağı oluklarında az (çok gümüş görünüyordu), gövdede orta,
    // kafa çerçevesinde (darbe alan kenar) daha fazla
    const y = points[j].y;
    const region = y < 0.034 ? 0.55 : (y > 0.2195 ? 1.0 : 0.75);
    wearP[j] = Math.min(1, (THREE.MathUtils.smoothstep(turn, 0.25, 1.1) * 0.55 + outer * 0.12) * region);
  }
  const uv = geo.attributes.uv;
  const wear = new Float32Array(uv.count);
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      uv.setXY(k, (i / segments) * uRepeat, s[j] / total);
      wear[k] = wearP[j];
    }
  }
  uv.needsUpdate = true;
  geo.setAttribute('wear', new THREE.BufferAttribute(wear, 1));
  return geo;
}

// Viewmodel derinlik hilesi: silah/kollarla aynı (duvarın içine girmesin, her zaman önde)
export const VIEWMODEL_DEPTH_CHUNK = `#include <project_vertex>
  gl_Position.z = gl_Position.z * 0.08 - gl_Position.w * 0.92;`;

function anodizedMaterial(maps, envMap, key) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: maps.map,
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1,
    metalness: 1,
    envMap,
    envMapIntensity: 0.32,
  });
  mat.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute float wear;\nvarying float vWear;\n' + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWear = wear;')
      .replace('#include <project_vertex>', VIEWMODEL_DEPTH_CHUNK);
    shader.fragmentShader = 'varying float vWear;\nfloat flWear = 0.0;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float wn = texture2D( roughnessMap, vRoughnessMapUv ).r;
    flWear = clamp( vWear * 1.55 - ( 1.0 - wn ) * 1.05, 0.0, 1.0 );
    flWear = smoothstep( 0.05, 0.6, flWear );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.56, 0.57, 0.58 ), flWear );
  }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor, 0.30, flWear );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = mix( metalnessFactor, 1.0, flWear );`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

function viewmodelMaterial(mat, key) {
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', VIEWMODEL_DEPTH_CHUNK);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * Feneri oluşturur.
 * @returns {{ group, lensSocket, switchButton, setPower(p), materials, dims }}
 */
export function createFlashlightModel({ envMap = null } = {}) {
  const D = { ...FLASHLIGHT_DIMS };       // örnek başına kopya (kavrama merkezi kayabilir)
  const group = new THREE.Group();
  group.name = 'handFlashlight';
  // lathe Y ekseni → fener −Z ışın yönü; lathe +Z (φ=0) → fener +Y (üst / düğme)
  const shell = new THREE.Group();
  shell.rotation.x = -Math.PI / 2;
  shell.position.set(0, 0, 0);
  group.add(shell);
  const lift = new THREE.Group();          // kavrama merkezini orijine taşı
  lift.position.y = -D.gripCenterY;
  shell.add(lift);

  const anoMaps = createAnodizedMaps();
  const knurlMaps = createKnurlMaps({ pyramidsU: 22, pyramidsV: 10 });
  const anodized = anodizedMaterial(anoMaps, envMap, 'fl-anodized');
  const knurl = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: knurlMaps.map, roughnessMap: knurlMaps.orm, metalnessMap: knurlMaps.orm,
    normalMap: knurlMaps.normal, normalScale: new THREE.Vector2(1.15, 1.15), roughness: 1, metalness: 1,
    envMap, envMapIntensity: 0.32,
  });
  knurl.map.repeat.set(4, 4.3); knurl.roughnessMap.repeat.set(4, 4.3); knurl.normalMap.repeat.set(4, 4.3);
  viewmodelMaterial(knurl, 'fl-knurl');
  const rubber = viewmodelMaterial(new THREE.MeshStandardMaterial({
    color: 0x0c0c0d, roughness: 0.82, metalness: 0, normalMap: createRubberNormal(), normalScale: new THREE.Vector2(0.5, 0.5),
    envMap, envMapIntensity: 0.15,
  }), 'fl-rubber');
  const chrome = viewmodelMaterial(new THREE.MeshStandardMaterial({
    color: 0xe9eaec, metalness: 1, roughness: 0.11, normalMap: createOrangePeelNormal(), normalScale: new THREE.Vector2(0.25, 0.25),
    emissive: new THREE.Color(0xf3f5fb), emissiveIntensity: 0, envMap, envMapIntensity: 0.9,
  }), 'fl-chrome');
  const ledBase = viewmodelMaterial(new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.35, metalness: 0.2 }), 'fl-ledbase');
  const ledEmit = viewmodelMaterial(new THREE.MeshStandardMaterial({
    color: 0xf2d77a, roughness: 0.4, metalness: 0, emissive: new THREE.Color(0xf7f8ff), emissiveIntensity: 0,
  }), 'fl-led');
  const glass = viewmodelMaterial(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.16, depthWrite: false,
    emissive: new THREE.Color(0xf5f7ff), emissiveIntensity: 0, envMap, envMapIntensity: 1.4,
    clearcoat: 1, clearcoatRoughness: 0.02,
  }), 'fl-glass');
  const darkGap = viewmodelMaterial(new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.6, metalness: 0.4 }), 'fl-gap');

  // --- Dış kabuk (kuyruk kapağı → gövde → anahtar bileziği → kafa → çerçeve) ---
  const flare = [];
  for (let i = 1; i <= 9; i++) {
    const t = i / 10, e = t * t * (3 - 2 * t);
    flare.push([0.0170 + (0.0262 - 0.0170) * e, 0.1690 + (0.1925 - 0.1690) * t, 0.0004]);
  }
  const profile = roundedProfile([
    [0.0000, 0.0000, 0],
    [0.0124, 0.0000, 0.0005],
    [0.0130, 0.0010, 0.0003],
    [0.0168, 0.0010, 0.0010],
    [0.0179, 0.0036, 0.0008],
    [0.0179, 0.0058, 0.0003],
    [0.0172, 0.0066, 0.0003],
    [0.0172, 0.0078, 0.0003],
    [0.0179, 0.0086, 0.0003],
    [0.0179, 0.0110, 0.0003],
    [0.0172, 0.0118, 0.0003],
    [0.0172, 0.0130, 0.0003],
    [0.0179, 0.0138, 0.0003],
    [0.0179, 0.0232, 0.0008],
    [0.0171, 0.0262, 0.0004],
    [0.0163, 0.0267, 0],
    [0.0163, 0.0279, 0],
    [0.0170, 0.0284, 0.0004],
    [0.0170, 0.0328, 0.0004],
    [0.0160, 0.0334, 0],
    [0.0160, 0.1292, 0],
    [0.0170, 0.1298, 0.0004],
    [0.0170, 0.1366, 0.0006],
    [0.0177, 0.1392, 0.0010],
    [0.0177, 0.1652, 0.0010],
    [0.0170, 0.1678, 0.0006],
    ...flare,
    [0.0262, 0.1935, 0.0008],
    [0.0262, 0.2010, 0.0002],
    [0.0254, 0.2018, 0.0002],
    [0.0254, 0.2032, 0.0002],
    [0.0262, 0.2040, 0.0002],
    [0.0262, 0.2068, 0.0002],
    [0.0254, 0.2076, 0.0002],
    [0.0254, 0.2090, 0.0002],
    [0.0262, 0.2098, 0.0002],
    [0.0262, 0.2198, 0.0004],
    [0.0257, 0.2204, 0],
    [0.0257, 0.2214, 0],
    [0.0273, 0.2220, 0.0006],
    [0.0273, 0.2288, 0.0013],
    [0.0262, 0.2312, 0.0006],
    [0.0237, 0.2312, 0.0004],
    [0.0231, 0.2297, 0],
    [0.0229, 0.2290, 0],
  ]);
  const shellMesh = new THREE.Mesh(latheGeo(profile, 72, 1), anodized);
  shellMesh.name = 'flashlightShell';
  lift.add(shellMesh);

  // --- Elmas tırtıllı kavrama bandı ---
  const knurlLen = D.knurlTo - D.knurlFrom;
  const knurlGeo = new THREE.CylinderGeometry(D.bodyRadius, D.bodyRadius, knurlLen, 96, 1, true);
  const knurlMesh = new THREE.Mesh(knurlGeo, knurl);
  knurlMesh.position.y = D.knurlFrom + knurlLen / 2;
  knurlMesh.name = 'flashlightKnurl';
  lift.add(knurlMesh);

  // Kuyruk kapağı dişli birleşim boşluğu (koyu ince halka)
  const gap = new THREE.Mesh(new THREE.CylinderGeometry(0.01632, 0.01632, 0.0011, 64, 1, true), darkGap);
  gap.position.y = 0.0273;
  lift.add(gap);

  // --- Reflektör (parabolik krom) ---
  const refl = [];
  const rIn = 0.0044, rOut = 0.0228, yIn = 0.2068, yOut = 0.2287;
  const k = (yOut - yIn) / (rOut * rOut - rIn * rIn);
  refl.push(new THREE.Vector2(0.0001, yIn - 0.0004));
  refl.push(new THREE.Vector2(rIn, yIn - 0.0004));
  for (let i = 0; i <= 18; i++) {
    const r = rIn + (rOut - rIn) * (i / 18);
    refl.push(new THREE.Vector2(r, yIn + k * (r * r - rIn * rIn)));
  }
  const reflGeo = latheGeo(refl, 72, 1);
  // iç yüzey kameraya/ışığa baksın: normal yönünü çevir (lathe dışa bakar)
  const reflMesh = new THREE.Mesh(reflGeo, chrome);
  chrome.side = THREE.BackSide;
  reflMesh.name = 'flashlightReflector';
  lift.add(reflMesh);

  // --- LED (seramik taban + fosfor kaplı çip) ---
  const led = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0036, 0.0016, 24), ledBase);
  led.position.y = yIn + 0.0004;
  lift.add(led);
  const chip = new THREE.Mesh(new THREE.BoxGeometry(0.0021, 0.0008, 0.0021), ledEmit);
  chip.position.y = yIn + 0.0014;
  lift.add(chip);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.0021, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  dome.position.y = yIn + 0.0012;
  lift.add(dome);

  // --- Lens camı ---
  const lens = new THREE.Mesh(new THREE.CircleGeometry(D.lensRadius, 64), glass);
  lens.rotation.x = -Math.PI / 2;
  lens.position.y = D.lensY;
  lens.name = 'flashlightLens';
  lift.add(lens);

  // --- Kauçuk basmalı düğme (başparmak) + metal çerçeve ---
  const switchRoot = new THREE.Group();
  switchRoot.position.set(0, D.switchY, D.collarRadius - 0.0004);
  lift.add(switchRoot);
  const bezelRing = new THREE.Mesh(new THREE.TorusGeometry(0.0058, 0.0010, 12, 40), anodized);
  bezelRing.scale.set(1, 1.32, 1);
  bezelRing.geometry.setAttribute('wear', new THREE.BufferAttribute(new Float32Array(bezelRing.geometry.attributes.position.count).fill(0.75), 1));
  switchRoot.add(bezelRing);
  const switchButton = new THREE.Group();
  switchRoot.add(switchButton);
  const boot = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), rubber);
  boot.rotation.x = Math.PI / 2;           // kubbe +Z (yüzey normali) yönünde
  boot.scale.set(0.0050, 0.0030, 0.0068);  // x: çevre, y: yükseklik (→ yüzey normali), z: boy
  switchButton.add(boot);
  // düğme üzerindeki ince kabartma çizgiler
  const ribs = [];
  for (let i = -1; i <= 1; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.0062, 0.00055, 0.0007), rubber);
    rib.position.set(0, i * 0.0019, 0.0026 - Math.abs(i) * 0.0005);
    rib.userData.z0 = rib.position.z;
    switchButton.add(rib);
    ribs.push(rib);
  }

  // Bütün parçalar: gölge yok, kırpma yok, en önde çiz
  group.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = false;
    o.renderOrder = o.material.transparent ? 1002 : 1000;
  });

  // Mercek soketi: ışık buradan çıkar (fener uzayı, −Z bakar)
  const lensSocket = new THREE.Object3D();
  lensSocket.name = 'flashlightLensSocket';
  lensSocket.position.set(0, 0, -(D.lensY - D.gripCenterY) + 0.0015);
  group.add(lensSocket);

  // Düğmenin fener uzayındaki konumu (başparmak hedefi)
  const switchPoint = new THREE.Vector3(0, D.collarRadius + 0.0028, -(D.switchY - D.gripCenterY));

  /** Kavrama merkezini (fener orijini) gövde boyunca taşır: profil y (m). */
  function setGripCenter(y) {
    D.gripCenterY = y;
    lift.position.y = -y;
    lensSocket.position.z = -(D.lensY - y) + 0.0015;
    switchPoint.z = -(D.switchY - y);
    group.updateMatrixWorld(true);
  }

  let power = 0;
  function setPower(p) {
    power = Math.max(0, p);
    ledEmit.emissiveIntensity = 60 * power;
    chrome.emissiveIntensity = 0.55 * power;
    glass.emissiveIntensity = 0.9 * power;
    glass.opacity = 0.16 + Math.min(0.25, power * 0.25);
  }
  setPower(0);

  /** Düğme basılma miktarı 0..1 (kauçuk çöker). */
  function setSwitchPress(t) {
    const s = THREE.MathUtils.clamp(t, 0, 1);
    // tepe toplam ~1.85 mm çöker (rig'deki başparmak basma derinliğiyle aynı)
    switchButton.position.z = -0.0008 * s;
    boot.scale.y = 0.0030 * (1 - 0.35 * s);
    for (const r of ribs) r.position.z = r.userData.z0 * (1 - 0.35 * s);
  }

  return {
    group,
    lensSocket,
    switchButton,
    switchPoint,
    setPower,
    getPower: () => power,
    setSwitchPress,
    materials: { anodized, knurl, rubber, chrome, ledBase, ledEmit, glass, darkGap },
    dims: D,
    radiusAt: flashlightRadiusAt,
    setGripCenter,
  };
}
