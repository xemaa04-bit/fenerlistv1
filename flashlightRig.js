// -----------------------------------------------------------------------------
// EL FENERİ — birinci şahıs el + fener rig'i
// -----------------------------------------------------------------------------
// Tabanca/AK ile aynı kol rig'i (Cransh FPS arms) klonlanır ve kollar prosedürel sürülür:
//   • Sağ el feneri gövdesinden yumruk şeklinde kavrar: parmaklar silindir yüzeyine değene
//     kadar otomatik kıvrılır (her fener ölçüsünde doğal kavrama).
//   • Başparmak gövde üstündeki kauçuk düğmenin üzerinde durur; aç/kapa sırasında
//     düğmeye gerçekten basar (kauçuk çöker, "klik").
//   • Kol zinciri iki-kemik IK ile çözülür, bilek dönüşü ön kol twist kemiklerine dağıtılır.
//   • Sol kol kadraj dışında, rahat pozda.
// Hareket katmanları (kamera uzayı, x=sağ, y=yukarı, −z=ileri):
//   kuşanma / indirme / aç-kapa / inceleme / bekleme anahtar kareleri,
//   bakış ataleti (fener ve ışık huzmesi kameranın biraz gerisinden yaylı takip eder),
//   yürüme/koşma salınımı, yan adım eğimi, zıplama/iniş, nefes, el titremesi.
// Titreşimsiz hareket ilkeleri (huzme 10+ m öteye vurduğundan 1° dönme = duvarda ~20 cm kayma):
//   • Bakış ataleti fare DELTASIYLA değil, yumuşatılmış AÇISAL HIZLA sürülür; yaylar kritik
//     sönümlüdür → fare örnekleme/kare hizalama gürültüsü ve yay salınımı (aşma) fenere geçmez.
//   • Yürüme/koşma salınımı ağırlıkla KONUM + rulo (huzme ekseni etrafında) ile verilir;
//     huzmeyi süpüren yaw/pitch bileşenleri küçüktür. Titreme gürültüsü yalnızca düşük frekanslıdır.
//   • Tüm yumuşatmalar kare hızından bağımsızdır (1 − e^(−k·dt)).
// Işık huzmesi feneri izler: ışık mercek soketine bağlıdır.
// -----------------------------------------------------------------------------
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { createFlashlightModel } from './flashlightModel.js';

const DEG = Math.PI / 180;
const clamp01 = t => Math.min(1, Math.max(0, t));
const smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

// --- Anahtar kare eğrisi (düzgün olmayan Catmull-Rom + "hold" = sıfır teğet) ---
function sampleKeys(keys, t, out) {
  const n = keys.length;
  const dim = keys[0].v.length;
  if (t <= keys[0].t) { for (let c = 0; c < dim; c++) out[c] = keys[0].v[c]; return out; }
  if (t >= keys[n - 1].t) { for (let c = 0; c < dim; c++) out[c] = keys[n - 1].v[c]; return out; }
  let i = 0;
  while (i < n - 2 && t > keys[i + 1].t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const span = k2.t - k1.t;
  const s = (t - k1.t) / span;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (let c = 0; c < dim; c++) {
    const m1 = k1.hold ? 0 : ((k2.v[c] - k0.v[c]) / Math.max(1e-4, k2.t - k0.t)) * span;
    const m2 = k2.hold ? 0 : ((k3.v[c] - k1.v[c]) / Math.max(1e-4, k3.t - k1.t)) * span;
    out[c] = h00 * k1.v[c] + h10 * m1 + h01 * k2.v[c] + h11 * m2;
  }
  return out;
}
// [t, x, y, z, pitch°, yaw°, roll°] (+pitch huzmeyi kaldırır, +yaw sola, +roll saat yönü tersi)
export const keys6 = list => list.map(k => ({ t: k[0], hold: !!k[7], v: k.slice(1, 7) }));

const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _bm = new THREE.Matrix4();
function handBasisQuat(fingers, palm, side, out) {
  _by.copy(fingers).normalize();
  _bx.copy(palm).multiplyScalar(side === 'R' ? 1 : -1);
  _bx.addScaledVector(_by, -_bx.dot(_by)).normalize();
  _bz.crossVectors(_bx, _by);
  _bm.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_bm);
}
function findByPrefix(root, prefix) {
  let found = null;
  root.traverse(o => { if (!found && o.name && o.name.startsWith(prefix)) found = o; });
  return found;
}
function findByRegex(root, re) {
  let found = null;
  root.traverse(o => { if (!found && o.name && re.test(o.name)) found = o; });
  return found;
}

class Spring {
  constructor(k, c) { this.k = k; this.c = c; this.x = 0; this.v = 0; }
  step(dt, target = 0) {
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (-this.k * (this.x - target) - this.c * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
  reset() { this.x = 0; this.v = 0; }
}
// Doğal frekans (rad/s) + sönüm oranı ile yay: zeta ≥ ~0.9 → aşma/salınım yok
const springFZ = (w, zeta) => new Spring(w * w, 2 * zeta * w);
const expK = (rate, dt) => 1 - Math.exp(-rate * dt);

// -----------------------------------------------------------------------------
// AYARLAR (ince ayar için değerleri burada değiştir)
// -----------------------------------------------------------------------------
export const FLASHLIGHT_TUNE = {
  // Kavrama merkezinin kamera uzayındaki bekleme konumu ve huzme yakınsama mesafesi
  // roll −45: elin sırtı dışa (sağa) döner → kıvrık parmaklar, başparmak + gövde üstü ve kafa görünür
  hold: { p: [0.20, -0.235, -0.40], roll: -45 },
  converge: 14.0,           // m — huzme bu mesafede artı işaretine oturur (yakında hafif sağda, videodaki gibi)
  sizeScale: 1.0,           // fenerin el ölçüsüne göre çarpanı (1 = gerçekçi oran)
  armsOffset: [0, -0.095, 0.065],
  elbowPole: [1.0, -1.15, 0.45],
  // Fenerin el içindeki yerleşimi (el kemiği uzayında, ölçülen el boyutlarına göre normalize)
  // autoRoll: fener kendi ekseni etrafında döner → düğme başparmak pedinin altına gelir
  // (rollOffset ile ince ayar; autoRoll=false ise sabit 'roll' kullanılır)
  // autoSlide: el gövde boyunca, rahat başparmağın düğmeye yetiştiği yere kayar
  // (slideRange: kavrama merkezinin profil y sınırları — yumruk tırtıllı gövdede kalsın)
  // along: silindir ekseni bilekten parmak köklerine oranla (0.72 → avuç içi/parmak dibi; parmaklar gövdeyi sarar)
  // tilt −12: gövde avuçta hafif çapraz (serçe tarafı bileğe yakın) — gerçek 'güç kavrayışı'
  grip: { along: 0.72, out: 1.0, side: -0.02, roll: 18, autoRoll: true, rollOffset: 0, autoSlide: true, slideRange: [0.066, 0.118], twist: 0, tilt: -12 },
  // base: başparmak kökü Euler başlangıcı (çözücü buradan arar), pad: distal falanksta ped konumu,
  // thick: başparmak yarı kalınlığı (m)
  // cross: pedin başparmak köküne göre parmak uçlarına doğru açısal kayması (°)
  thumb: { base: [0, -20, 28], pad: 0.55, thick: 0.0074, cross: 12 },
  cup: [6, 8, 11, 14],
  // Bakış ataleti — hedef = −kazanç × (yumuşatılmış bakış açısal hızı, rad/s)
  //   smooth: açısal hız yumuşatma zaman sabiti (s) — fare örnekleme gürültüsünü süzer
  //   rot/roll: rad başına (rad/s) sapma; pos: m başına (rad/s)
  //   max*: yumuşak (tanh) üst sınırlar; freq/zeta: yay doğal frekansı (rad/s) ve sönüm oranı
  lag: { smooth: 0.05, rot: 0.032, roll: 0.036, pos: 0.0065, maxRot: 0.075, maxRoll: 0.085, maxPos: 0.018,
    maxVel: 12, freq: 10.5, zeta: 0.92, posFreq: 13, posZeta: 0.95 },
  // Yürüme / koşma salınımı: v/l = dikey/yanal konum (m), yaw/pitch/roll = derece
  // (yaw/pitch huzmeyi süpürür → küçük; his konum + ruloyla verilir)
  bob: {
    walk: { v: 0.0030, l: 0.0048, yaw: 0.32, pitch: 0.26, roll: 0.9 },
    run: { v: 0.0080, l: 0.0120, yaw: 1.30, pitch: 0.95, roll: 3.0 },
  },
  // El titremesi (derece): amp = dinlenik genlik, fatigue = koşu yorgunluğu çarpanı, drift = yavaş gezinme
  tremor: { amp: 0.055, fatigue: 1.4, drift: 0.30 },
  pivot: [0, -0.025, 0.085], // dönme pivotu (fener uzayı, bilek tarafı)
};

export const FLASHLIGHT_TIMING = {
  draw: 0.80,
  drawClick: 0.585,     // başparmak düğmeye basar → ışık yanar
  holster: 0.34,
  toggle: 0.24,
  togglePress: 0.075,
  inspect: 2.9,
};

const DRAW_KEYS = keys6([
  [0.00, 0.12, -0.42, 0.12, -72, 22, -46, 1],
  [0.10, 0.11, -0.36, 0.10, -64, 19, -40],
  [0.26, 0.050, -0.145, 0.045, -30, 8, -17],
  [0.42, -0.006, 0.013, -0.012, 7, -2.5, 6],
  [0.54, 0.002, -0.004, 0.003, -2.0, 0.6, -1.5],
  [0.66, 0, 0, 0, 0, 0, 0, 1],
  [0.80, 0, 0, 0, 0, 0, 0, 1],
]);
const HOLSTER_KEYS = keys6([
  [0.00, 0, 0, 0, 0, 0, 0, 1],
  [0.07, 0.004, 0.008, 0.0, 3, -1, 2],
  [0.34, 0.13, -0.40, 0.12, -70, 18, -40, 1],
]);
const INSPECT_KEYS = keys6([
  [0.00, 0, 0, 0, 0, 0, 0, 1],
  [0.55, -0.080, 0.040, 0.070, 8, 34, 30],
  [0.95, -0.084, 0.043, 0.072, 10, 37, 35],
  [1.30, -0.083, 0.042, 0.071, 10, 36, 33],
  [1.85, -0.055, 0.046, 0.066, 30, -30, -18],
  [2.30, -0.054, 0.048, 0.064, 32, -33, -22],
  [2.90, 0, 0, 0, 0, 0, 0, 1],
]);
const FIDGET_KEYS = keys6([
  [0.00, 0, 0, 0, 0, 0, 0, 1],
  [0.45, -0.012, 0.008, 0.01, 4, 6, 26],
  [1.00, -0.013, 0.009, 0.01, 5, 7, 29],
  [1.55, 0, 0, 0, 0, 0, 0, 1],
]);

/**
 * @param {object} o
 * @param {THREE.Object3D} o.parent      kamera (veya kameraya bağlı viewmodel grubu)
 * @param {object} o.armsAsset           kollu GLTF (pistol.glb — aynı kol rig'i)
 * @param {Function} [o.prepareArmsMaterial] (mat) → derinlik hilesi (oyunda tabanca rig'i zaten hazırlar)
 * @param {THREE.Texture} [o.envMap]
 * @param {Function} [o.onEvent]         ('click'|'on'|'off'|'draw'|'holster'|'flicker') olayları
 * @param {Function} [o.createModel]     ({envMap}) → el-içi model (varsayılan: el feneri). Aynı arayüzü
 *   taklit eden başka bir model (ör. tahta sopa, src/weapons/clubHeldModel.js) verilebilir.
 * @param {string}   [o.name]            root düğüm adı
 *
 * tune ek alanları (genelleştirme — varsayılan değerler el fenerinin eski davranışıdır):
 *   idle: [x,y,z,pitch°,yaw°,roll°]  sabit bekleme ofseti (anahtar kare katmanına eklenir)
 *   clickOnDraw: false                kuşanırken başparmak tıkı / ışık yanması yok
 *   noLight: true                     modelde ışık yok (setLight etkisiz, güç hep 0)
 */
export function createFlashlightRig({
  parent,
  armsAsset,
  armsClipName = 'Pistol_Idle',
  prepareArmsMaterial = null,
  envMap = null,
  onEvent = () => {},
  tune = FLASHLIGHT_TUNE,
  createModel = opts => createFlashlightModel(opts),
  name = 'flashlightViewmodel',
} = {}) {
  const root = new THREE.Group();
  root.name = name;
  root.visible = false;
  parent.add(root);
  const armsHolder = new THREE.Group();
  root.add(armsHolder);

  const arms = cloneSkinned(armsAsset.scene);
  arms.scale.setScalar(0.66);
  arms.rotation.y = Math.PI;
  // Oyunda pistolAsset.scene zaten kendi Head_Cam ofsetiyle konumlanmış olur; klon bu konumu
  // kopyalar. Head_Cam hizalaması sıfır konumdan ölçülmeli (aksi halde ofset iki kez eklenir).
  arms.position.set(0, 0, 0);
  armsHolder.add(arms);
  root.updateWorldMatrix(true, true);
  const headCam = findByPrefix(arms, 'Head_Cam_0');
  if (headCam) {
    const hp = headCam.getWorldPosition(new THREE.Vector3());
    armsHolder.worldToLocal(hp);
    arms.position.copy(hp).multiplyScalar(-1);
  }
  armsHolder.position.fromArray(tune.armsOffset);
  root.updateWorldMatrix(true, true);

  const armMeshes = [];
  arms.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const isArms = mats.some(m => m && m.name === 'arms');
    o.visible = isArms;
    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = false;
    o.renderOrder = 999;
    if (isArms) {
      armMeshes.push(o);
      if (prepareArmsMaterial) mats.forEach(m => prepareArmsMaterial(m));
    }
  });

  // --- Kemikler ---
  const rest = new Map();
  arms.traverse(o => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone() }));
  const fingerNames = [['004', '005', '006', '007', '007_end'], ['008', '009', '010', '011', '011_end'],
    ['012', '013', '014', '015', '015_end'], ['016', '017', '018', '019', '019_end'], ['020', '021', '022', '022_end']];
  function armBones(S) {
    return {
      side: S,
      sign: S === 'R' ? -1 : 1,
      up: findByPrefix(arms, `UpArm_${S}_`),
      fore: findByPrefix(arms, `Forearm_${S}_`),
      tw3: findByPrefix(arms, `BoneTwist_03${S}`),
      tw2: findByPrefix(arms, `BoneTwist_02${S}`),
      tw1: findByRegex(arms, new RegExp(`^BoneTwist_01${S}_\\d+$`)),
      twEnd: findByPrefix(arms, `BoneTwist_01${S}_end`),
      ctrl: findByPrefix(arms, `IK_Hand_Cntrl_${S}`),
      hand: findByRegex(arms, new RegExp(`^Hand_${S}_\\d+$`)),
      fingers: fingerNames.map(chain => chain.map(id => id.endsWith('_end')
        ? findByPrefix(arms, `Bone_${S}${id}`)
        : findByRegex(arms, new RegExp(`^Bone_${S}${id}_\\d+$`)))),
    };
  }
  const R = armBones('R');
  const L = armBones('L');

  const clip = armsAsset.animations.find(c => c.name.includes(armsClipName)) || armsAsset.animations[0];
  if (clip) {
    const mixer = new THREE.AnimationMixer(arms);
    mixer.clipAction(clip).play();
    mixer.update(0);
    arms.traverse(o => { const r = rest.get(o); if (r) { r.p.copy(o.position); r.q.copy(o.quaternion); } });
    mixer.stopAllAction();
    mixer.uncacheRoot(arms);
  }
  const bindFinger = new Map();
  {
    const tmp = cloneSkinned(armsAsset.scene);
    const byName = new Map(); tmp.traverse(o => byName.set(o.name, o));
    for (const A of [R, L]) for (const ch of A.fingers) for (const b of ch) {
      const src = b && byName.get(b.name);
      if (b && src) bindFinger.set(b, src.quaternion.clone());
    }
  }
  const flatFinger = new Map();
  for (const A of [R, L]) for (const ch of A.fingers) ch.forEach((b, j) => {
    if (!b || !bindFinger.has(b)) return;
    const q = bindFinger.get(b).clone();
    if (j === 0 || j >= ch.length - 1) { flatFinger.set(b, q); return; }
    const tw = new THREE.Quaternion(0, 0, q.z, q.w).normalize();
    flatFinger.set(b, q.multiply(tw.invert()));
  });
  const controlled = [];
  for (const A of [R, L]) {
    controlled.push(A.up, A.fore, A.tw3, A.tw2, A.tw1, A.ctrl, A.hand);
    for (const ch of A.fingers) for (const b of ch) controlled.push(b);
  }
  function restorePose() {
    for (const o of controlled) {
      if (!o) continue;
      const r = rest.get(o);
      o.position.copy(r.p);
      o.quaternion.copy(r.q);
    }
  }

  // --- Geçici nesneler ---
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion(), q4 = new THREE.Quaternion();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
  const euler = new THREE.Euler();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const handScaleOf = A => { A.hand.matrixWorld.decompose(_p, _q, _s); return _s.x; };
  function worldPos(o, out) { return out.setFromMatrixPosition(o.matrixWorld); }
  function worldQuat(o, out) { o.matrixWorld.decompose(_p, out, _s); return out; }
  function setWorldQuat(o, qW) {
    worldQuat(o.parent, q4);
    o.quaternion.copy(q4.invert().multiply(qW));
    o.updateMatrixWorld(true);
  }
  const _inv = new THREE.Matrix4();
  function toLocal(o, pW, out) { return out.copy(pW).applyMatrix4(_inv.copy(o.matrixWorld).invert()); }
  function setWorldPose(o, pW, qW) {
    toLocal(o.parent, pW, o.position);
    setWorldQuat(o, qW);
  }

  function measureArm(A) {
    restorePose();
    arms.updateMatrixWorld(true);
    const S = worldPos(A.up, new THREE.Vector3());
    const F = worldPos(A.fore, new THREE.Vector3());
    const W = worldPos(A.twEnd, new THREE.Vector3());
    A.lenUp = S.distanceTo(F);
    A.lenFore = F.distanceTo(W);
    A.baseUpW = worldQuat(A.up, new THREE.Quaternion());
    A.baseForeW = worldQuat(A.fore, new THREE.Quaternion());
    A.baseHandW = worldQuat(A.hand, new THREE.Quaternion());
    const rootQInv = worldQuat(root, new THREE.Quaternion()).invert();
    A.baseUpR = rootQInv.clone().multiply(A.baseUpW);
    A.baseForeR = rootQInv.clone().multiply(A.baseForeW);
    A.relHandFore = A.baseForeW.clone().invert().multiply(A.baseHandW);
    const u0 = F.clone().sub(S).normalize();
    const f0 = W.clone().sub(F).normalize();
    const n0 = new THREE.Vector3().crossVectors(u0, f0).normalize();
    A.u0R = u0.applyQuaternion(rootQInv);
    A.f0R = f0.applyQuaternion(rootQInv);
    A.n0R = n0.applyQuaternion(rootQInv);
  }
  measureArm(R);
  measureArm(L);
  // Omuz (üst kol kökü) root uzayında sabittir (IK yalnız döndürür) → sinematik erişim hesabı için önbellek
  root.updateMatrixWorld(true);
  const shoulderRoot = {
    R: toLocal(root, worldPos(R.up, new THREE.Vector3()), new THREE.Vector3()),
    L: toLocal(root, worldPos(L.up, new THREE.Vector3()), new THREE.Vector3()),
  };

  const basis0 = new THREE.Matrix4(), basis1 = new THREE.Matrix4();
  const S = new THREE.Vector3(), T = new THREE.Vector3(), E = new THREE.Vector3(), dir = new THREE.Vector3(), pole = new THREE.Vector3();
  const u0 = new THREE.Vector3(), f0 = new THREE.Vector3(), n0 = new THREE.Vector3(), u1 = new THREE.Vector3(), f1 = new THREE.Vector3(), n1 = new THREE.Vector3(), w0 = new THREE.Vector3();
  const rootQ = new THREE.Quaternion();
  const twistAxis = new THREE.Vector3(0, 1, 0);

  // İki kemik IK + twist dağıtımı + el yerleşimi (wristW/handQW dünya uzayında)
  function solveArm(A, wristW, handQW, poleRoot) {
    worldQuat(root, rootQ);
    worldPos(A.up, S);
    T.copy(wristW);
    dir.subVectors(T, S);
    let d = dir.length();
    dir.divideScalar(Math.max(d, 1e-6));
    const a = A.lenUp, b = A.lenFore;
    const dMax = (a + b) * 0.9985, dMin = Math.abs(a - b) * 1.05 + 1e-4;
    if (d > dMax) { d = dMax; T.copy(S).addScaledVector(dir, d); }
    if (d < dMin) { d = dMin; T.copy(S).addScaledVector(dir, d); }
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    pole.copy(poleRoot).applyQuaternion(rootQ);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-8) pole.set(0, -1, 0).applyQuaternion(rootQ).addScaledVector(dir, -dir.y);
    pole.normalize();
    E.copy(S).addScaledVector(dir, a * cosA).addScaledVector(pole, a * sinA);

    u0.copy(A.u0R).applyQuaternion(rootQ);
    f0.copy(A.f0R).applyQuaternion(rootQ);
    n0.copy(A.n0R).applyQuaternion(rootQ);
    u1.subVectors(E, S).normalize();
    f1.subVectors(T, E).normalize();
    n1.crossVectors(u1, f1);
    if (n1.lengthSq() < 1e-10) n1.copy(n0); else n1.normalize();
    w0.crossVectors(u0, n0);
    basis0.makeBasis(u0, n0, w0);
    v1.crossVectors(u1, n1);
    basis1.makeBasis(u1, n1, v1);
    m1.copy(basis1).multiply(m2.copy(basis0).transpose());
    q1.setFromRotationMatrix(m1);
    q2.copy(rootQ).multiply(A.baseUpR);
    setWorldQuat(A.up, q3.copy(q1).multiply(q2));

    v2.copy(f0).applyQuaternion(q1).normalize();
    q2.setFromUnitVectors(v2, f1);
    q3.copy(rootQ).multiply(A.baseForeR);
    q3.premultiply(q1).premultiply(q2);
    setWorldQuat(A.fore, q3);

    worldQuat(A.fore, q1);
    q2.copy(q1).invert().multiply(handQW);
    q3.copy(A.relHandFore).invert();
    q2.multiply(q3);
    let theta = 2 * Math.atan2(q2.y, q2.w);
    if (theta > Math.PI) theta -= 2 * Math.PI;
    if (theta < -Math.PI) theta += 2 * Math.PI;
    const part = theta / 3;
    for (const tb of [A.tw3, A.tw2, A.tw1]) {
      if (!tb) continue;
      tb.quaternion.multiply(q4.setFromAxisAngle(twistAxis, part));
    }
    A.fore.updateMatrixWorld(true);
    setWorldPose(A.hand, T, handQW);
    return T;
  }

  // ---------------------------------------------------------------------------
  // EL ÖLÇÜMÜ (el kemiği uzayında): bilek, parmak kökleri, avuç normali
  // ---------------------------------------------------------------------------
  restorePose();
  for (const ch of R.fingers) for (const b of ch) if (b && flatFinger.has(b)) b.quaternion.copy(flatFinger.get(b));
  arms.updateMatrixWorld(true);
  // ch[0] metakarp (bilekten başlar) → parmak kökü (MCP) = ch[1]
  const knuck = R.fingers.slice(0, 4).map(ch => toLocal(R.hand, worldPos(ch[1] || ch[0], new THREE.Vector3()), new THREE.Vector3()));
  const tips = R.fingers.slice(0, 4).map(ch => toLocal(R.hand, worldPos(ch[4] || ch[3], new THREE.Vector3()), new THREE.Vector3()));
  const thumbRoot = R.fingers[4][0] ? toLocal(R.hand, worldPos(R.fingers[4][0], new THREE.Vector3()), new THREE.Vector3()) : new THREE.Vector3();
  // işaret ↔ serçe: başparmak köküne en yakın kök işaret parmağıdır
  // parmaklar uzayda sıralı (0..3); başparmak köküne yakın uç işaret parmağıdır
  let idxI = 0, pinkI = 3;
  if (knuck[3].distanceTo(thumbRoot) < knuck[0].distanceTo(thumbRoot)) { idxI = 3; pinkI = 0; }
  const knuckleCenter = knuck.reduce((a, k) => a.add(k), new THREE.Vector3()).multiplyScalar(0.25);
  const acrossDir = knuck[idxI].clone().sub(knuck[pinkI]).normalize();       // serçe → işaret (huzme yönü)
  const fingerDir = knuckleCenter.clone().normalize();                        // bilek → parmak kökleri
  const knuckleSpan = knuck[idxI].distanceTo(knuck[pinkI]);                   // el yerel birimi
  const palmLen = knuckleCenter.length();
  // avuç normali: parmak uçlarının kıvrılacağı taraf (rig ölçümü: sağ elde +X)
  const palmDir = new THREE.Vector3(1, 0, 0);
  palmDir.addScaledVector(fingerDir, -palmDir.dot(fingerDir)).addScaledVector(acrossDir, -palmDir.dot(acrossDir)).normalize();
  const handInfo = { knuck, tips, thumbRoot, idxI, pinkI, knuckleCenter, acrossDir, fingerDir, palmDir, knuckleSpan, palmLen };

  // ---------------------------------------------------------------------------
  // FENER MODELİ + EL İÇİ YERLEŞİM
  // ---------------------------------------------------------------------------
  const model = createModel({ envMap });
  const flashPivot = new THREE.Group();
  flashPivot.name = 'flashlightGrip';
  flashPivot.add(model.group);
  // Işık bağlantı noktası: −Y ekseni huzme yönüne bakar (silah feneri prop'u bu düzende)
  const lightMount = new THREE.Object3D();
  lightMount.name = 'flashlightLightMount';
  lightMount.rotation.x = Math.PI / 2;
  model.lensSocket.add(lightMount);

  const D = model.dims;
  // el ölçüsü (hand local) → fener ölçeği: gerçek el kök aralığı ≈ 64 mm
  let flashScale = 1;          // kamera/root uzayındaki ölçek (dünya)
  const gripLocalM = new THREE.Matrix4();
  const GRIP = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

  function computeGripLocal() {
    const g = tune.grip;
    // fener ekseni (−Z) = serçe→işaret yönü; fener +Y (düğme) başparmak tarafına döner
    const zAxis = acrossDir.clone().negate();                       // fener +Z = arka (serçe tarafı)
    let yAxis = fingerDir.clone().negate().addScaledVector(palmDir, -0.15); // üst: bilek→parmak tersine yakın
    yAxis.addScaledVector(zAxis, -yAxis.dot(zAxis)).normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    m1.makeBasis(xAxis, yAxis, zAxis);
    GRIP.quat.setFromRotationMatrix(m1);
    // eksen etrafında döndür (düğmeyi başparmağa getir) + ince eğimler
    const roll = (g.autoRoll ? (computeGripLocal.rollAuto || 0) + (g.rollOffset || 0) : g.roll);
    GRIP.quat.multiply(q1.setFromEuler(euler.set(g.tilt * DEG, g.twist * DEG, roll * DEG, 'XYZ')));
    // silindir ekseni: avuç içinden (palmDir) yarıçap + avuç kalınlığı kadar dışarıda,
    // bilekten parmak köklerine doğru 'along' oranında
    const rLocal = D.bodyRadius * flashScaleLocal();
    GRIP.pos.copy(knuckleCenter).multiplyScalar(g.along)
      .addScaledVector(palmDir, rLocal * g.out + knuckleSpan * 0.16)
      .addScaledVector(acrossDir, knuckleSpan * g.side);
  }
  // fener ölçeği el yerel biriminde
  function flashScaleLocal() { return (knuckleSpan / 0.064) * tune.sizeScale; }

  function attachFlash() {
    R.hand.add(flashPivot);
    computeGripLocal();
    flashPivot.position.copy(GRIP.pos);
    flashPivot.quaternion.copy(GRIP.quat);
    flashPivot.scale.setScalar(flashScaleLocal());
    flashPivot.updateMatrix();
    gripLocalM.copy(flashPivot.matrix);
    arms.updateMatrixWorld(true);
    flashScale = flashScaleLocal() * handScaleOf(R);
  }

  // --- Parmak kavrama çözücüsü (gerçek gövde profili) ---
  const curlAxis = new THREE.Vector3(0, 0, 1);
  const gripPoseR = new Map();
  const pressPoseR = new Map();
  const _fInv = new THREE.Matrix4();
  const _lp = new THREE.Vector3();
  // Fener yerel uzayında gövde yarıçapı (z: kavrama merkezine göre, −z ileri)
  function bodyRadiusAt(z) { return model.radiusAt(D.gripCenterY - z); }
  function cylDistLocal(pW) {
    v3.copy(pW).applyMatrix4(_fInv);
    return Math.hypot(v3.x, v3.y) - bodyRadiusAt(v3.z);
  }
  function localOf(o, out) { return out.setFromMatrixPosition(o.matrixWorld).applyMatrix4(_fInv); }
  const fingerThick = [0.0105, 0.0098, 0.0090, 0.0082];      // fener yerel (m) — parmak yarı kalınlığı

  // Parmak sarma: eklemler birlikte (doğal tendon oranıyla) kıvrılır; bir falanks gövdeye
  // değince o falanksı taşıyan eklemler donar, uçtaki eklemler kıvrılmaya devam eder.
  const CURL_MAX = [88 * DEG, 104 * DEG, 78 * DEG];   // MCP, PIP, DIP
  const CURL_W = [1.0, 1.15, 0.8];
  function curlFingers() {
    for (let f = 0; f < 4; f++) {
      const ch = R.fingers[f];
      for (const b of ch) if (b && flatFinger.has(b)) b.quaternion.copy(flatFinger.get(b));
      if (ch[0]) ch[0].quaternion.copy(bindFinger.get(ch[0])).multiply(q4.setFromAxisAngle(curlAxis, R.sign * (tune.cup[f] || 0) * DEG));
      R.hand.updateMatrixWorld(true);
      const bones = [ch[1], ch[2], ch[3]], ends = [ch[2], ch[3], ch[4]];
      const nJ = bones.filter(Boolean).length;
      const base = bones.map(b => b && b.quaternion.clone());
      const ang = [0, 0, 0], trial = [0, 0, 0];
      const apply = a => {
        for (let k = 0; k < nJ; k++) if (bones[k]) bones[k].quaternion.copy(base[k]).multiply(q4.setFromAxisAngle(curlAxis, R.sign * a[k]));
        if (bones[0]) bones[0].updateMatrixWorld(true);
      };
      const segClear = k => {
        if (!bones[k] || !ends[k]) return 1;
        const tip = worldPos(ends[k], v1);
        const mid = worldPos(bones[k], v2).lerp(tip, 0.5);
        return Math.min(cylDistLocal(tip), cylDistLocal(mid)) - fingerThick[Math.min(3, k + 1)];
      };
      let active = 0;
      const step = 1.0 * DEG;
      for (let it = 0; it < 400 && active < nJ; it++) {
        let moved = false;
        for (let k = 0; k < 3; k++) {
          trial[k] = k >= active ? Math.min(CURL_MAX[k], ang[k] + step * CURL_W[k]) : ang[k];
          if (trial[k] !== ang[k]) moved = true;
        }
        if (!moved) break;
        apply(trial);
        let hit = -1;
        for (let k = active; k < nJ; k++) if (segClear(k) < 0) { hit = k; break; }
        if (hit < 0) { for (let k = 0; k < 3; k++) ang[k] = trial[k]; continue; }
        apply(ang);
        active = hit + 1;
      }
      apply(ang);
      for (const b of ch) if (b) gripPoseR.set(b, b.quaternion.clone());
    }
  }

  // --- Başparmak çözücüsü: pedi düğmenin üstüne, gövde boyunca yatırır ---
  // Parametreler: CMC (başparmak kökü) Euler'ı + iki eklem kıvrımı. Hedef: distal falanksın
  // pedi düğme kubbesinin üstünde (yarıçap + parmak kalınlığı), düğmenin eksenel konumunda;
  // tırnak dışarı, ped gövdeye dönük; parmak ileri (−Z) uzanır; gövdeye / işaret parmağına girmez.
  // Hedef açısal konumdan bağımsızdır → düğme daha sonra fener ekseni etrafında başparmağa döndürülür.
  let rnd = 12345;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  const TH = { A: new THREE.Vector3(), B: new THREE.Vector3(), C: new THREE.Vector3(), Dt: new THREE.Vector3(), P: new THREE.Vector3(), F: new THREE.Vector3(), tmp: new THREE.Vector3() };
  let thumbSolution = null, thumbPhi0 = 0, thumbCrossSign = 1;
  function thumbApply(x) {
    const th = R.fingers[4];
    th[0].quaternion.copy(bindFinger.get(th[0])).multiply(q4.setFromEuler(euler.set(x[0] * DEG, x[1] * DEG, x[2] * DEG)));
    th[1].quaternion.copy(flatFinger.get(th[1])).multiply(q4.setFromAxisAngle(curlAxis, R.sign * x[3] * DEG));
    th[2].quaternion.copy(flatFinger.get(th[2])).multiply(q4.setFromAxisAngle(curlAxis, R.sign * x[4] * DEG));
    th[0].updateMatrixWorld(true);
  }
  function thumbPoints() {
    const th = R.fingers[4];
    localOf(th[0], TH.A); localOf(th[1], TH.B); localOf(th[2], TH.C); localOf(th[3], TH.Dt);
    TH.P.copy(TH.C).lerp(TH.Dt, tune.thumb.pad);
  }
  const switchTopR = () => model.switchPoint.y;               // kubbe tepesi yarıçapı
  const switchZ = () => model.switchPoint.z;
  function segPenalty(a, b, thick, w) {
    let c = 0;
    for (let k = 1; k <= 6; k++) {
      TH.tmp.copy(a).lerp(b, k / 6);
      const d = Math.hypot(TH.tmp.x, TH.tmp.y) - bodyRadiusAt(TH.tmp.z) - thick;
      if (d < 0) c += (d / 0.0012) ** 2 * w;
    }
    return c;
  }
  const idxPts = [];
  // mode: 'fixed' (ped düğme hizasında), 'free' (rahat başparmak — eksenel konum serbest), 'press'
  let costLog = null;
  const logC = (k, v) => { if (costLog) costLog[k] = (costLog[k] || 0) + v; return v; };
  function thumbCost(x, mode = 'fixed') {
    const pressDepth = mode === 'press' ? 0.0017 : 0;   // düğme tepesi ~1.85 mm çöker (model.setSwitchPress)
    thumbApply(x);
    thumbPoints();
    const T = tune.thumb;
    const rP = Math.hypot(TH.P.x, TH.P.y);
    const rT = switchTopR() - pressDepth + T.thick;
    let c = logC('rad', ((rP - rT) / 0.0012) ** 2) + logC('z', mode === 'free' ? 0 : ((TH.P.z - switchZ()) / 0.0025) ** 2);
    // gövdeye girme cezası (ped kısmı düğme kubbesine oturur → kubbe yüksekliği kadar tolerans)
    c += logC('colProx', segPenalty(TH.B, TH.C, T.thick + 0.0012, 1));
    c += logC('colDist', segPenalty(TH.C, TH.P, T.thick - 0.0026 - pressDepth, 1));
    c += logC('colMeta', segPenalty(TH.A, TH.B, 0.0115, 0.4));
    if (mode === 'press') return c + ((x[3] - thumbSolution[3]) / 30) ** 2;
    // distal falanks ileri bakmalı (gövde boyunca yatar)
    const dir = TH.tmp.subVectors(TH.Dt, TH.C).normalize();
    c += logC('dir', (Math.max(0, 0.72 + dir.z) / 0.08) ** 2);
    // proksimal falanks gövdeye yakın (havada durmasın)
    TH.F.copy(TH.B).lerp(TH.C, 0.6);
    const lift = Math.hypot(TH.F.x, TH.F.y) - bodyRadiusAt(TH.F.z) - T.thick;
    if (lift > 0.004) c += logC('lift', ((lift - 0.004) / 0.003) ** 2);
    // ped gövdeye dönük: kıvrım yönü merkeze doğru olmalı
    const p0 = TH.F.copy(TH.P);
    const xs = x[4];
    x[4] = xs + 6;
    thumbApply(x); thumbPoints();
    const flex = TH.tmp.subVectors(TH.P, p0).normalize();
    x[4] = xs;
    const inward = -(flex.x * p0.x + flex.y * p0.y) / Math.max(1e-6, Math.hypot(p0.x, p0.y));
    c += logC('flex', (Math.max(0, 0.55 - inward) / 0.12) ** 2);
    thumbApply(x); thumbPoints();
    // işaret parmağıyla çakışma
    for (let k = 0; k <= 4; k++) {
      TH.F.copy(TH.B).lerp(TH.Dt, k / 4);
      for (const q of idxPts) { const d = TH.F.distanceTo(q) - 0.0175; if (d < 0) c += logC('idx', (d / 0.002) ** 2 * 0.6); }
    }
    // ped gövdenin üstünde, başparmak kökünün hizasında (biraz parmak uçlarına doğru) dursun;
    // yoksa başparmak işaret parmağının önünden dolanıp gövdenin altına iner
    {
      let dphi = Math.atan2(-TH.P.x, TH.P.y) - thumbPhi0;
      dphi = Math.atan2(Math.sin(dphi), Math.cos(dphi));
      c += logC('ang', ((dphi / DEG - T.cross * thumbCrossSign) / 18) ** 2);
    }
    // doğal poz düzenlileştirme
    const b = T.base;
    c += logC('regBase', ((x[0] - b[0]) / 40) ** 2 + ((x[1] - b[1]) / 40) ** 2 + ((x[2] - b[2]) / 40) ** 2);
    c += logC('regCurl', ((x[3] - 14) / 45) ** 2 + ((x[4] - 18) / 45) ** 2);
    return c;
  }
  function patternSearch(x, f, step, minStep, lo, hi) {
    let fx = f(x);
    const st = step.slice();
    for (let iter = 0; iter < 400; iter++) {
      let improved = false;
      for (let i = 0; i < x.length; i++) {
        for (const sgn of [1, -1]) {
          const y = x.slice();
          y[i] = Math.min(hi[i], Math.max(lo[i], y[i] + sgn * st[i]));
          const fy = f(y);
          if (fy < fx) { x = y; fx = fy; improved = true; break; }
        }
      }
      if (!improved) {
        let done = true;
        for (let i = 0; i < st.length; i++) { st[i] *= 0.5; if (st[i] > minStep) done = false; }
        if (done) break;
      }
    }
    return { x, fx };
  }
  function solveThumb(mode = 'fixed') {
    const th = R.fingers[4];
    for (const b of th) if (b && flatFinger.has(b)) b.quaternion.copy(flatFinger.get(b));
    // başparmak kökünün açısal konumu ve parmak uçlarının hangi tarafta olduğu (işaret)
    localOf(th[0], TH.A);
    thumbPhi0 = Math.atan2(-TH.A.x, TH.A.y);
    {
      const tip = localOf(R.fingers[handInfo.idxI][4] || R.fingers[handInfo.idxI][3], new THREE.Vector3());
      let d = Math.atan2(-tip.x, tip.y) - thumbPhi0;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      thumbCrossSign = d >= 0 ? 1 : -1;
    }
    idxPts.length = 0;
    const ix = R.fingers[handInfo.idxI];
    for (let j = 1; j < ix.length; j++) if (ix[j]) idxPts.push(localOf(ix[j], new THREE.Vector3()));
    for (let j = 1; j < ix.length - 1; j++) if (ix[j] && ix[j + 1]) idxPts.push(idxPts[j - 1].clone().lerp(idxPts[j], 0.5));
    const b = tune.thumb.base;
    const lo = [b[0] - 75, b[1] - 75, b[2] - 75, -12, -10], hi = [b[0] + 75, b[1] + 75, b[2] + 75, 70, 75];
    rnd = 12345;
    let best = null, bestF = Infinity;
    for (let n = 0; n < 900; n++) {
      const x = lo.map((l, i) => l + (hi[i] - l) * rand());
      const fx = thumbCost(x, mode);
      if (fx < bestF) { bestF = fx; best = x; }
    }
    // en iyi birkaç adayı ayrı ayrı inceltmek yerine en iyiden yerel arama (deterministik)
    let r = patternSearch(best, x => thumbCost(x, mode), [12, 12, 12, 10, 10], 0.2, lo, hi);
    const r2 = patternSearch(b.concat([14, 18]), x => thumbCost(x, mode), [12, 12, 12, 10, 10], 0.2, lo, hi);
    if (r2.fx < r.fx) r = r2;
    thumbSolution = r.x;
    costLog = {}; thumbCost(r.x, mode); const terms = costLog; costLog = null;
    for (const k in terms) terms[k] = +terms[k].toFixed(3);
    thumbApply(r.x);
    thumbPoints();
    for (const bb of th) if (bb) gripPoseR.set(bb, bb.quaternion.clone());
    const pad = TH.P.clone();
    // basma pozu: sadece eklem kıvrımları, ped kubbeyi ~1.8 mm çökertir
    const pr = patternSearch(r.x.slice(), x => thumbCost(x, 'press'), [0, 0, 0, 4, 4], 0.1,
      [r.x[0], r.x[1], r.x[2], r.x[3] - 5, r.x[4] - 5], [r.x[0], r.x[1], r.x[2], r.x[3] + 25, r.x[4] + 25]);
    thumbApply(pr.x);
    for (const bb of th) if (bb) pressPoseR.set(bb, bb.quaternion.clone());
    thumbApply(r.x);
    return { cost: r.fx, x: r.x, press: pr.x, pad, terms };
  }

  function solveGrip() {
    restorePose();
    computeGripLocal.rollAuto = 0;
    attachFlash();
    arms.updateMatrixWorld(true);
    model.group.updateMatrixWorld(true);
    _fInv.copy(model.group.matrixWorld).invert();
    R.hand.updateMatrixWorld(true);
    curlFingers();
    let ts = solveThumb(tune.grip.autoSlide ? 'free' : 'fixed');
    // eksenel kayma: el, rahat başparmağın pedi düğmeye gelecek yerden kavrar (insan da öyle yapar)
    if (tune.grip.autoSlide) {
      const [gMin, gMax] = tune.grip.slideRange;
      const gc = THREE.MathUtils.clamp(D.switchY + ts.pad.z, gMin, gMax);
      model.setGripCenter(gc);
      model.group.updateMatrixWorld(true);
      _fInv.copy(model.group.matrixWorld).invert();
      curlFingers();
      ts = solveThumb('fixed');
    }
    // düğmeyi başparmak pedinin altına döndür (fener ekseni etrafında): parmak teması dönmeden
    // bağımsız olduğundan kavrama yeniden çözülmez, sadece fener döner
    if (tune.grip.autoRoll) {
      const phi = Math.atan2(-ts.pad.x, ts.pad.y);
      computeGripLocal.rollAuto = phi / DEG;
      attachFlash();
      arms.updateMatrixWorld(true);
      model.group.updateMatrixWorld(true);
      _fInv.copy(model.group.matrixWorld).invert();
    }
    for (const [b, q] of gripPoseR) b.quaternion.copy(q);
    arms.updateMatrixWorld(true);
    gripInfo.thumb = ts;
    gripInfo.roll = tune.grip.autoRoll ? computeGripLocal.rollAuto + (tune.grip.rollOffset || 0) : tune.grip.roll;
    gripInfo.gripCenterY = D.gripCenterY;
  }
  const gripInfo = {};
  solveGrip();

  // Sol kol: kadraj dışında, rahat; parmaklar hafif kıvrık
  const LEFT_REST = { p: [-0.30, -0.70, -0.16], f: [0.2, 0.8, -0.5], n: [0.85, -0.2, -0.3], e: [-0.6, -1.0, 0.2] };
  const leftPose = new Map();
  for (const ch of L.fingers) ch.forEach((b, j) => {
    if (!b || !flatFinger.has(b)) return;
    const c = [0.08, 0.35, 0.45, 0.3, 0][j] || 0;
    leftPose.set(b, flatFinger.get(b).clone().multiply(q4.setFromAxisAngle(curlAxis, L.sign * c)));
  });
  // Sinematik: sol el kavrama (direksiyon / kapı kolu) — parmaklar belirgin kıvrık
  const leftGripPose = new Map();
  for (const ch of L.fingers) ch.forEach((b, j) => {
    if (!b || !flatFinger.has(b)) return;
    const c = [0.06, 0.95, 1.0, 0.7, 0][j] || 0;
    leftGripPose.set(b, flatFinger.get(b).clone().multiply(q4.setFromAxisAngle(curlAxis, L.sign * c)));
  });
  // Sinematik: sağ el açık (fener elde değilken anahtar/mandal/kapak) — hafif doğal kıvrım
  const openPoseR = new Map();
  for (const ch of R.fingers) ch.forEach((b, j) => {
    if (!b || !flatFinger.has(b)) return;
    const c = [0.03, 0.14, 0.2, 0.12, 0][j] || 0;
    openPoseR.set(b, flatFinger.get(b).clone().multiply(q4.setFromAxisAngle(curlAxis, R.sign * c)));
  });

  // ---------------------------------------------------------------------------
  // DURUM
  // ---------------------------------------------------------------------------
  let state = 'hidden';            // hidden | drawing | idle | holstering
  let stateT = 0;
  let lightOn = false;
  let power = 0;                   // ışık gücü 0..1 (titreme dahil)
  let flickerSeq = null;           // [{t, v}] — yanma titreşimi
  let flickerT = 0;
  let toggleT = -1;
  let toggleApplied = false;
  let actionClip = null, actionT = 0, actionW = 0, actionCancel = false;
  let drawClicked = false;
  // Gevşek temas simülasyonu: fener açıkken seyrek aralıklarla ışık anlık kısılıp
  // açılıyordu — kullanıcı bunu "fener bozuluyor / kapanıp açılıyor" gibi algıladı.
  // Kapalı tutuluyor; istersen `false` yerine `true` yazarak geri açabilirsin.
  const RARE_FLICKER_ENABLED = false;
  let rareFlickerTimer = 25 + Math.random() * 40;
  let idleClock = 0, nextFidget = 14 + Math.random() * 6;
  let bobPhase = 0, moveBlend = 0, runBlend = 0, fatigue = 0;
  let lastYaw = null, lastPitch = 0;
  const LG = tune.lag;
  const lagSp = { yaw: springFZ(LG.freq, LG.zeta), pitch: springFZ(LG.freq, LG.zeta), roll: springFZ(LG.freq * 0.9, LG.zeta),
    x: springFZ(LG.posFreq, LG.posZeta), y: springFZ(LG.posFreq, LG.posZeta) };
  let lookVelY = 0, lookVelP = 0;   // yumuşatılmış bakış açısal hızı (rad/s)
  const landSp = new Spring(140, 13);
  let strafeRoll = 0;
  const camPrev = new THREE.Vector3(), camVel = new THREE.Vector3(), camNow = new THREE.Vector3();
  let haveCam = false, prevVy = 0;
  const anim6 = new Float32Array(6), act6 = new Float32Array(6);

  function makeIgnition() {
    // gevşek temas: kısa titreşim dizisi, sonra sabit
    const j = () => (Math.random() - 0.5) * 0.012;
    return [
      { t: 0.000, v: 0.0 }, { t: 0.010 + j(), v: 0.75 }, { t: 0.035 + j(), v: 0.12 }, { t: 0.055 + j(), v: 0.95 },
      { t: 0.080 + j(), v: 0.35 }, { t: 0.105 + j(), v: 1.0 }, { t: 0.125, v: 0.86 }, { t: 0.15, v: 1.0 },
    ];
  }
  function makeRareFlicker() {
    const seq = [{ t: 0, v: 1 }];
    let t = 0;
    const n = 2 + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++) {
      t += 0.03 + Math.random() * 0.05; seq.push({ t, v: 0.25 + Math.random() * 0.5 });
      t += 0.02 + Math.random() * 0.04; seq.push({ t, v: 0.9 + Math.random() * 0.1 });
    }
    seq.push({ t: t + 0.05, v: 1 });
    return seq;
  }
  function sampleSeq(seq, t) {
    if (t <= seq[0].t) return seq[0].v;
    for (let i = 1; i < seq.length; i++) {
      if (t < seq[i].t) {
        // LED: neredeyse anında geçiş (kısa yumuşatma)
        const a = seq[i - 1], b = seq[i];
        const k = clamp01((t - a.t) / Math.min(0.008, b.t - a.t));
        return a.v + (b.v - a.v) * k;
      }
    }
    return seq[seq.length - 1].v;
  }
  function setLight(on, { silent = false, instant = false } = {}) {
    if (tune.noLight) { lightOn = false; flickerSeq = null; return; }   // ışıksız model (sopa)
    if (instant) { flickerSeq = null; flickerT = 0; }
    if (on === lightOn) return;
    lightOn = on;
    if (on) {
      flickerSeq = instant ? null : makeIgnition();
      flickerT = 0;
      if (!silent) onEvent('on');
    } else {
      flickerSeq = null;
      if (!silent) onEvent('off');
    }
  }

  // ---------------------------------------------------------------------------
  // POZLAMA
  // ---------------------------------------------------------------------------
  const holdPos = new THREE.Vector3(), aimQ = new THREE.Quaternion(), offQ = new THREE.Quaternion();
  const aimBaseQ = new THREE.Quaternion(), rollQ = new THREE.Quaternion();
  const pivot = new THREE.Vector3().fromArray(tune.pivot);
  const fPos = new THREE.Vector3(), fQuat = new THREE.Quaternion(), fScl = new THREE.Vector3();
  const flashW = new THREE.Matrix4(), handW = new THREE.Matrix4(), tmpM = new THREE.Matrix4();
  const pH = new THREE.Vector3(), qH = new THREE.Quaternion(), sH = new THREE.Vector3();
  const poleR = new THREE.Vector3(), poleL = new THREE.Vector3(), pL = new THREE.Vector3(), qL = new THREE.Quaternion();
  const lf = new THREE.Vector3(), ln = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------------------
  // SİNEMATİK (giriş sineması — src/cutscenes/hospitalArrival.js)
  //  - cineGrip: sanal fener (= el) dünya hedefi; w ağırlığıyla normal tutuşa karışır (ölçek korunur)
  //  - cineOpen: sağ el açıklığı (fener yokken), cineLeft: sol el dünya hedefi + kavrama
  //  - detach/regrip: fener torpido tepsisindeki çapaya taşınır, alınınca ele yumuşak geçer
  // ---------------------------------------------------------------------------
  let cinematic = false;
  const cineGrip = { w: 0, pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  const cinePoleR = { w: 0, v: new THREE.Vector3() };
  let cineOpen = 0;
  const cineLeft = { w: 0, curl: 0, pos: new THREE.Vector3(), fingers: new THREE.Vector3(0, 1, 0), palm: new THREE.Vector3(1, 0, 0), poleW: 0, pole: new THREE.Vector3() };
  let flashDetached = false;
  let flashShown = true;
  let regripT = -1, regripDur = 0.25;
  const regripFrom = new THREE.Matrix4(), _rgB = new THREE.Matrix4(), _rgW = new THREE.Matrix4(), _rgL = new THREE.Matrix4();
  const _cp = new THREE.Vector3(), _cq = new THREE.Quaternion(), _cs = new THREE.Vector3();
  const _cp2 = new THREE.Vector3(), _cq2 = new THREE.Quaternion(), _cs2 = new THREE.Vector3();
  const _cqL = new THREE.Quaternion(), _cv = new THREE.Vector3();
  const _gInv = new THREE.Matrix4(), _wM = new THREE.Matrix4();
  const smooth01 = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

  function setFlashVisible(v) {
    v = !!v;
    if (v === flashShown) return;
    flashShown = v;
    model.group.traverse(o => { if (o.isMesh) o.visible = v; });
  }
  function restoreFlashToHand() {
    if (flashPivot.parent !== R.hand) R.hand.add(flashPivot);
    gripLocalM.decompose(flashPivot.position, flashPivot.quaternion, flashPivot.scale);
    flashPivot.updateMatrixWorld(true);
    flashDetached = false;
    regripT = -1;
  }
  function detachTo(obj) {
    if (!obj) return;
    regripT = -1;
    obj.add(flashPivot);
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(_cp, _cq, _cs);
    flashPivot.position.set(0, 0, 0);
    flashPivot.quaternion.identity();
    flashPivot.scale.setScalar(flashScale / Math.max(1e-6, _cs.x));
    flashPivot.updateMatrixWorld(true);
    flashDetached = true;
  }
  // Regrip: fener dünya pozundan (tepsi) el-bağlı poza `regripDur` içinde kayar (sıçrama yok)
  function applyRegrip() {
    if (regripT < 0) return;
    const k = smooth01(regripT / regripDur);
    _rgB.multiplyMatrices(R.hand.matrixWorld, gripLocalM);
    regripFrom.decompose(_cp, _cq, _cs);
    _rgB.decompose(_cp2, _cq2, _cs2);
    _cp.lerp(_cp2, k); _cq.slerp(_cq2, k); _cs.lerp(_cs2, k);
    _rgW.compose(_cp, _cq, _cs);
    _rgL.copy(R.hand.matrixWorld).invert().multiply(_rgW);
    _rgL.decompose(flashPivot.position, flashPivot.quaternion, flashPivot.scale);
    flashPivot.updateMatrixWorld(true);
  }

  function computeAim() {
    holdPos.fromArray(tune.hold.p);
    const target = v1.set(0, 0, -tune.converge);
    const zAxis = v2.subVectors(holdPos, target).normalize();     // fener +Z = huzmenin tersi
    const xAxis = v3.crossVectors(up, zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    m1.makeBasis(xAxis, yAxis, zAxis);
    // aimBaseQ: rulosuz nişan (yaw/pitch ofsetleri ve bakış ataleti bu eksenlerde → huzme yatay
    // fare hareketinde yatay gecikir); bekleme rulosu en son, fener ekseni etrafında uygulanır
    aimBaseQ.setFromRotationMatrix(m1);
    rollQ.setFromAxisAngle(_bz.set(0, 0, 1), tune.hold.roll * DEG);
    aimQ.copy(aimBaseQ).multiply(rollQ);
  }
  computeAim();

  // Yumuşak gürültü: yalnızca iki düşük harmonik (eski 4.07× harmonik ~4 Hz titreşim üretiyordu)
  function noise(t, f, seed) {
    return Math.sin(t * f + seed) * 0.65 + Math.sin(t * f * 2.31 + seed * 1.7) * 0.35;
  }

  let thumbPress = 0;
  function pose(time) {
    restorePose();
    // ÖNEMLİ (titreme düzeltmesi): kemiklerin DÜNYA matrisleri de bu karenin kamerasıyla
    // tazelenmeli. Eskiden yalnızca root/ataları güncelleniyordu (updateWorldMatrix(true, false));
    // IK omuz konumunu ve ebeveyn dönüşlerini bir ÖNCEKİ karenin kamera dönüşümünden okuyordu →
    // el + fener her karede kameranın son kare hareketi kadar (dönüş/yürüyüş deltası) kayıyordu.
    // Fare deltaları ve kare süreleri her karede farklı olduğundan bu, dönerken ve yürürken
    // fenerde/huzmede titreme olarak görünüyordu.
    root.updateWorldMatrix(true, true);
    // --- anahtar kare katmanı (kuşanma / indirme) ---
    anim6.fill(0);
    if (state === 'drawing') sampleKeys(DRAW_KEYS, stateT, anim6);
    else if (state === 'holstering') sampleKeys(HOLSTER_KEYS, stateT, anim6);
    // sabit bekleme ofseti (sopa: yukarı-ileri kalkık tutuş); kuşanma/indirme bu poza göre olur
    if (tune.idle) for (let c = 0; c < 6; c++) anim6[c] += tune.idle[c];
    // --- eylem katmanı (inceleme / bekleme hareketi) ---
    if (actionClip) {
      sampleKeys(actionClip, actionT, act6);
      for (let c = 0; c < 6; c++) anim6[c] += act6[c] * actionW;
    }
    // --- aç/kapa başparmak basışı ---
    thumbPress = 0;
    if (state === 'drawing' && tune.clickOnDraw !== false) {
      const c = FLASHLIGHT_TIMING.drawClick;
      thumbPress = smooth((stateT - (c - 0.075)) / 0.075) * (1 - smooth((stateT - c - 0.03) / 0.09));
    }
    if (toggleT >= 0) {
      const P = FLASHLIGHT_TIMING.togglePress;
      thumbPress = Math.max(thumbPress, smooth(toggleT / P) * (1 - smooth((toggleT - P - 0.035) / 0.1)));
    }
    // --- koşma pozu + yürüme salınımı ---
    const vb = moveBlend * (1 - runBlend), rb = runBlend;
    const BW = tune.bob.walk, BR = tune.bob.run;
    const bobV = Math.sin(bobPhase * 2) * (BW.v * vb + BR.v * rb);
    const bobL = Math.sin(bobPhase) * (BW.l * vb + BR.l * rb);
    const bobYaw = Math.sin(bobPhase + 0.4) * (BW.yaw * vb + BR.yaw * rb);
    const bobPitch = Math.sin(bobPhase * 2 + 0.7) * (BW.pitch * vb + BR.pitch * rb);
    const bobRoll = Math.sin(bobPhase) * (BW.roll * vb + BR.roll * rb);
    // --- nefes / titreme / yavaş gezinme ---
    const TR = tune.tremor;
    const breathA = 1 + fatigue * 1.5;
    const br = 1.85 + fatigue * 1.2;
    const tremA = TR.amp * (1 + fatigue * TR.fatigue + rb * 0.3);
    const LGc = tune.lag;
    const sc = (x, m) => m * Math.tanh(x / m);
    const px = anim6[0] + 0.02 * rb + bobL + sc(lagSp.x.x, LGc.maxPos);
    const py = anim6[1] - 0.032 * rb + bobV + Math.sin(time * br) * 0.0011 * breathA + sc(lagSp.y.x, LGc.maxPos) + sc(landSp.x, 0.04) - thumbPress * 0.0018;
    const pz = anim6[2] + 0.05 * rb;
    const pitch = (anim6[3] - 12 * rb + bobPitch - thumbPress * 0.9
      + Math.sin(time * br + 0.6) * 0.22 * breathA
      + noise(time, 4.1, 1.1) * tremA + noise(time, 0.37, 4.2) * TR.drift) * DEG + sc(lagSp.pitch.x, LGc.maxRot);
    const yaw = (anim6[4] + 10 * rb + bobYaw
      + noise(time, 3.3, 2.7) * tremA + noise(time, 0.29, 7.9) * TR.drift * 1.2) * DEG + sc(lagSp.yaw.x, LGc.maxRot);
    const roll = (anim6[5] - 14 * rb + bobRoll + thumbPress * 0.6) * DEG + sc(lagSp.roll.x, LGc.maxRoll) + strafeRoll;

    // --- fener dönüşümü (root uzayı): T = (hold + ofset) · aim · pivot · Roff · pivot⁻¹ ---
    offQ.setFromEuler(euler.set(pitch, yaw, roll, 'YXZ'));
    fQuat.copy(aimBaseQ).multiply(offQ).multiply(rollQ);
    // pivot etrafında dönme → konum telafisi
    v1.copy(pivot).applyQuaternion(aimQ);           // pivotun ofsetsiz konumu
    v2.copy(pivot).applyQuaternion(fQuat);          // pivotun döndükten sonraki konumu
    fPos.copy(holdPos).add(v3.set(px, py, pz)).add(v1).sub(v2);
    tmpM.compose(fPos, fQuat, fScl.setScalar(flashScale));
    flashW.multiplyMatrices(root.matrixWorld, tmpM);
    if (cinematic && cineGrip.w > 1e-4) {
      // sinematik el hedefi: sanal fener dünya pozuna karışım (ölçek korunur → el boyu değişmez)
      flashW.decompose(_cp, _cq, _cs);
      const w = clamp01(cineGrip.w);
      _cp.lerp(cineGrip.pos, w);
      _cq.slerp(cineGrip.quat, w);
      flashW.compose(_cp, _cq, _cs);
    }
    handW.copy(flashW).multiply(m2.copy(gripLocalM).invert());
    handW.decompose(pH, qH, sH);

    for (const [b, q] of gripPoseR) b.quaternion.copy(q);
    if (thumbPress > 0.001) for (const [b, q] of pressPoseR) b.quaternion.copy(gripPoseR.get(b)).slerp(q, thumbPress);
    model.setSwitchPress(thumbPress);
    if (cinematic && cineOpen > 0.001) {
      const o = clamp01(cineOpen);
      for (const [b, q] of openPoseR) b.quaternion.slerp(q, o);
    }
    poleR.fromArray(tune.elbowPole);
    if (cinematic && cinePoleR.w > 1e-4) poleR.lerp(cinePoleR.v, clamp01(cinePoleR.w));
    solveArm(R, pH, qH, poleR);

    // Sol kol (kadraj dışı)
    pL.fromArray(LEFT_REST.p).applyMatrix4(root.matrixWorld);
    worldQuat(root, q1);
    handBasisQuat(lf.fromArray(LEFT_REST.f), ln.fromArray(LEFT_REST.n), 'L', qL).premultiply(q1);
    for (const [b, q] of leftPose) b.quaternion.copy(q);
    poleL.fromArray(LEFT_REST.e);
    if (cinematic && cineLeft.w > 1e-4) {
      // sinematik sol el: dünya hedefi (direksiyon 10 hizası, kapı kolu, kapı itme)
      const w = clamp01(cineLeft.w);
      pL.lerp(cineLeft.pos, w);
      qL.slerp(handBasisQuat(cineLeft.fingers, cineLeft.palm, 'L', _cqL), w);
      const c = clamp01(cineLeft.curl) * w;
      if (c > 0.001) for (const [b, q] of leftGripPose) b.quaternion.slerp(q, c);
      if (cineLeft.poleW > 1e-4) poleL.lerp(cineLeft.pole, clamp01(cineLeft.poleW) * w);
    }
    solveArm(L, pL, qL, poleL);
    arms.updateMatrixWorld(true);
    if (regripT >= 0 && !flashDetached) applyRegrip();
  }

  // ---------------------------------------------------------------------------
  // GÜNCELLEME
  // ---------------------------------------------------------------------------
  function update(dt, time, { lookYaw = null, lookPitch = 0, moving = false, running = false, camera = null } = {}) {
    if (state === 'hidden') { power = 0; model.setPower(0); return; }
    // --- durum makinesi ---
    stateT += dt;
    if (state === 'drawing') {
      if (!drawClicked && tune.clickOnDraw !== false && stateT >= FLASHLIGHT_TIMING.drawClick) {
        drawClicked = true;
        onEvent('click');
        setLight(true);
      }
      if (stateT >= FLASHLIGHT_TIMING.draw) { state = 'idle'; stateT = 0; }
    } else if (state === 'holstering') {
      if (stateT >= FLASHLIGHT_TIMING.holster) {
        state = 'hidden'; stateT = 0; root.visible = false;
        setLight(false, { silent: true });
        power = 0; model.setPower(0);
        onEvent('holstered');
        return;
      }
    }
    if (toggleT >= 0) {
      toggleT += dt;
      if (!toggleApplied && toggleT >= FLASHLIGHT_TIMING.togglePress) {
        toggleApplied = true;
        onEvent('click');
        setLight(!lightOn);
      }
      if (toggleT >= FLASHLIGHT_TIMING.toggle) toggleT = -1;
    }
    // eylem (inceleme/bekleme) klibi
    if (actionClip) {
      if (!actionCancel) {
        actionT += dt * actionSpeed;
        if (actionT >= actionClip[actionClip.length - 1].t) { actionClip = null; actionW = 0; actionLocked = false; }
      } else {
        actionW = THREE.MathUtils.damp(actionW, 0, 10, dt);
        actionT += dt * 0.5;
        if (actionW < 0.01) { actionClip = null; actionW = 0; actionLocked = false; }
      }
    }
    // --- ışık gücü ---
    if (lightOn) {
      if (flickerSeq) {
        flickerT += dt;
        power = sampleSeq(flickerSeq, flickerT);
        if (flickerT > flickerSeq[flickerSeq.length - 1].t) flickerSeq = null;
      } else {
        power = THREE.MathUtils.damp(power, 1, 30, dt);
        if (RARE_FLICKER_ENABLED) {
          rareFlickerTimer -= dt;
          if (rareFlickerTimer <= 0) {
            rareFlickerTimer = 35 + Math.random() * 70;
            flickerSeq = makeRareFlicker(); flickerT = 0;
            onEvent('flicker');
          }
        }
      }
    } else {
      power = THREE.MathUtils.damp(power, 0, 45, dt);
      if (power < 0.002) power = 0;
    }
    model.setPower(power);

    // --- bakış ataleti ---
    // Eski yöntem her karede fare deltasını yayın HIZINA darbe olarak ekliyordu: fare olayları
    // karelere düzensiz dağıldığından (ör. 125/1000 Hz fare, 60/144 Hz ekran) her kare farklı
    // büyüklükte darbe → fener dönüşte titriyordu; az sönümlü yaylar da durunca sallanıyordu.
    // Şimdi: açısal hız ölçülür → kısa zaman sabitiyle yumuşatılır → kritik sönümlü yaylar
    // bu hıza orantılı HEDEF sapmayı izler (kare hızından ve fare örnekleme hızından bağımsız).
    const g = tune.lag;
    if (lookYaw !== null && dt > 1e-4) {
      if (lastYaw === null) { lastYaw = lookYaw; lastPitch = lookPitch; }
      const dy = Math.atan2(Math.sin(lookYaw - lastYaw), Math.cos(lookYaw - lastYaw)), dp = lookPitch - lastPitch;
      lastYaw = lookYaw; lastPitch = lookPitch;
      // tek karelik sıçramalar (odak kaybı, sürücü hatası, ışınlanma) yayları tekmelemesin
      const wy = THREE.MathUtils.clamp(dy / dt, -g.maxVel, g.maxVel);
      const wp = THREE.MathUtils.clamp(dp / dt, -g.maxVel, g.maxVel);
      const a = expK(1 / g.smooth, dt);
      lookVelY += (wy - lookVelY) * a;
      lookVelP += (wp - lookVelP) * a;
    }
    lagSp.yaw.step(dt, -g.rot * lookVelY);
    lagSp.pitch.step(dt, -g.rot * lookVelP);
    lagSp.roll.step(dt, g.roll * lookVelY);
    lagSp.x.step(dt, g.pos * lookVelY);
    lagSp.y.step(dt, -g.pos * 0.8 * lookVelP);

    // --- oyuncu hızı: yan adım eğimi, zıplama/iniş ---
    if (camera) {
      camera.getWorldPosition(camNow);
      if (haveCam && dt > 1e-4) {
        v1.copy(camNow).sub(camPrev).divideScalar(dt);
        // ışınlanma/kayıt yükleme: hız örneği yok sayılır (sıçrama yok)
        if (v1.lengthSq() <= 100) camVel.lerp(v1, expK(10, dt));
      }
      camPrev.copy(camNow); haveCam = true;
      v2.set(1, 0, 0).transformDirection(camera.matrixWorld); v2.y = 0; v2.normalize();
      const lateral = camVel.dot(v2);
      strafeRoll = THREE.MathUtils.damp(strafeRoll, THREE.MathUtils.clamp(-lateral * 0.022, -0.06, 0.06), 5, dt);
      const dvy = camVel.y - prevVy; prevVy = camVel.y;
      if (Math.abs(dvy) > 0.4) landSp.v += -dvy * 0.012;
    }
    landSp.step(dt);

    // --- yürüme / koşma ---
    moveBlend = THREE.MathUtils.damp(moveBlend, moving ? 1 : 0, 6, dt);
    runBlend = THREE.MathUtils.damp(runBlend, running ? 1 : 0, 5, dt);
    bobPhase += dt * (running ? 12 : 8) * (0.25 + moveBlend * 0.75) * 0.5;
    fatigue = clamp01(fatigue + (running ? dt / 4 : -dt / 7));

    // --- bekleme hareketi ---
    const calm = !cinematic && state === 'idle' && !moving && toggleT < 0 && !actionClip;
    if (regripT >= 0) {
      regripT += dt;
      if (regripT >= regripDur) restoreFlashToHand();
    }
    idleClock = calm ? idleClock + dt : 0;
    if (idleClock > nextFidget) { startAction(FIDGET_KEYS); nextFidget = 14 + Math.random() * 8; idleClock = 0; }
    // kilitli eylem (sopa savuruşu) koşuyla kesilmez; indirme (holster) yine keser
    if (actionClip && !actionCancel && !actionLocked && (running || state !== 'idle')) actionCancel = true;

    pose(time);
  }

  // Kuşanma anahtar karesindeki poza en yakın indirme zamanı (kuşanma yarıda kesilince)
  const _d6 = new Float32Array(6), _h6 = new Float32Array(6);
  function holsterTimeForDraw(drawT) {
    sampleKeys(DRAW_KEYS, drawT, _d6);
    let best = 0, bestErr = Infinity;
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const h = (i / N) * FLASHLIGHT_TIMING.holster;
      sampleKeys(HOLSTER_KEYS, h, _h6);
      let e = 0;
      for (let c = 0; c < 3; c++) e += ((_d6[c] - _h6[c]) * 10) ** 2;   // konum (dm)
      for (let c = 3; c < 6; c++) e += ((_d6[c] - _h6[c]) / 10) ** 2;   // açı (10°)
      if (e < bestErr) { bestErr = e; best = h; }
    }
    return Math.min(best, FLASHLIGHT_TIMING.holster - 0.02);
  }

  let actionLocked = false, actionSpeed = 1;
  function startAction(keys, { locked = false, speed = 1 } = {}) {
    actionClip = keys; actionT = 0; actionW = 1; actionCancel = false;
    actionLocked = locked; actionSpeed = speed > 0 ? speed : 1;
  }
  const lockedActionPlaying = () => Boolean(actionClip && actionLocked && !actionCancel);

  function resetMotion() {
    for (const s of Object.values(lagSp)) s.reset();
    landSp.reset();
    lastYaw = null; lookVelY = 0; lookVelP = 0; camVel.set(0, 0, 0); haveCam = false; strafeRoll = 0; moveBlend = 0; runBlend = 0; fatigue = 0; prevVy = 0;
    actionClip = null; actionW = 0; toggleT = -1; idleClock = 0; actionLocked = false; actionSpeed = 1;
  }

  return {
    root,
    arms,
    model,
    flashPivot,
    lightMount,
    hand: handInfo,
    bones: { R, L },
    grip: GRIP,
    gripInfo,
    tune,
    /** Kuşan: aşağıdan kaldır, başparmakla düğmeye bas, ışık titreşerek yanar. */
    draw() {
      resetMotion();
      state = 'drawing'; stateT = 0; drawClicked = false;
      setLight(false, { silent: true }); power = 0;
      root.visible = true;
      onEvent('draw');
      pose(0);
    },
    /** İndir (ışık açık kalır; huzme yere doğru süpürülür, kadraj dışında söner). */
    holster() {
      if (state === 'hidden') return 0;
      if (state === 'holstering') return FLASHLIGHT_TIMING.holster - stateT;
      // kuşanma yarıdaysa kaldığı yerden geri iner: indirme eğrisinde aynı poza denk gelen
      // zamandan başlar (pozda sıçrama olmaz, kalan süre kısalır)
      const from = state === 'drawing' ? holsterTimeForDraw(stateT) : 0;
      state = 'holstering';
      stateT = from;
      toggleT = -1;
      if (actionClip) actionCancel = true;
      onEvent('holster');
      return FLASHLIGHT_TIMING.holster - from;
    },
    /** Anında elde (kayıt yükleme vb.). */
    setInstant(on = true) {
      resetMotion();
      if (on) { state = 'idle'; stateT = 0; root.visible = true; setLight(true, { silent: true, instant: true }); power = 1; }
      else { state = 'hidden'; root.visible = false; setLight(false, { silent: true }); power = 0; }
      model.setPower(power);
      pose(0);
    },
    toggle() {
      if (state !== 'idle' || toggleT >= 0) return false;
      toggleT = 0; toggleApplied = false;
      if (actionClip) actionCancel = true;
      return true;
    },
    inspect() {
      if (state !== 'idle' || toggleT >= 0 || lockedActionPlaying()) return false;
      if (actionClip === INSPECT_KEYS && !actionCancel && actionT < 2.2) return false;
      startAction(INSPECT_KEYS);
      return true;
    },
    fidget() { if (state === 'idle' && !actionClip) { startAction(FIDGET_KEYS); return true; } return false; },
    /**
     * Dışarıdan anahtar kare eylemi oynat (keys6 biçimi; ör. sopa savuruşu).
     * locked: koşu/inceleme/bekleme hareketi kesemez; speed: zaman çarpanı (<1 = yavaş).
     * Yalnızca 'idle' durumda başlar; başarılıysa true.
     */
    playAction(keys, { locked = false, speed = 1 } = {}) {
      if (state !== 'idle' || cinematic || !keys?.length) return false;
      if (lockedActionPlaying()) return false;
      startAction(keys, { locked, speed });
      return true;
    },
    isActionLocked: lockedActionPlaying,
    getActionTime: () => (actionClip ? actionT : -1),
    update,
    poseNow(time = 0) { pose(time); },
    resolveGrip() { solveGrip(); },
    recomputeAim() { computeAim(); },
    getState: () => state,
    isLightOn: () => lightOn,
    getLightPower: () => power,
    isVisible: () => root.visible,
    reset() {
      cinematic = false; cineGrip.w = 0; cinePoleR.w = 0; cineOpen = 0; cineLeft.w = 0; cineLeft.poleW = 0;
      restoreFlashToHand();
      setFlashVisible(true);
      state = 'hidden'; stateT = 0; root.visible = false;
      setLight(false, { silent: true }); power = 0; model.setPower(0);
      resetMotion();
    },

    // --- SİNEMATİK API (src/cutscenes/hospitalArrival.js) ---
    /** Sinemayı başlat: ışık sessizce kapanır, fener isteğe bağlı çapaya (torpido) taşınır. */
    cinematicBegin({ anchor = null } = {}) {
      cinematic = true;
      resetMotion();
      cineGrip.w = 0; cinePoleR.w = 0; cineOpen = 0; cineLeft.w = 0; cineLeft.curl = 0; cineLeft.poleW = 0;
      restoreFlashToHand();
      state = 'idle'; stateT = 0; root.visible = true;
      setLight(false, { silent: true }); power = 0; model.setPower(0);
      if (anchor) detachTo(anchor);
      pose(0);
    },
    /** Sinemayı bitir (handoff/atlama): fener ele döner, tüm override'lar sıfırlanır; ışık durumu korunur. */
    cinematicEnd() {
      cinematic = false;
      cineGrip.w = 0; cinePoleR.w = 0; cineOpen = 0; cineLeft.w = 0; cineLeft.curl = 0; cineLeft.poleW = 0;
      restoreFlashToHand();
      setFlashVisible(true);
      state = 'idle';
      stateT = 0; root.visible = true;
      resetMotion();
      pose(0);
    },
    /** Sert kesme: bakış/hız yaylarını sıfırla (toggle/eylem durumuna dokunmaz). */
    cinematicSnap() {
      for (const s of Object.values(lagSp)) s.reset();
      landSp.reset();
      lastYaw = null; lookVelY = 0; lookVelP = 0; camVel.set(0, 0, 0); haveCam = false; strafeRoll = 0; prevVy = 0;
    },
    isCinematic: () => cinematic,
    /** Sağ el (sanal fener) dünya hedefi: −Z lens, +Y düğme/başparmak. pos/quat null ise yalnız ağırlık değişir. */
    setGripTarget(posW, quatW, w = 1, poleRoot = null, poleW = 0) {
      if (posW) cineGrip.pos.copy(posW);
      if (quatW) cineGrip.quat.copy(quatW);
      cineGrip.w = w;
      if (poleRoot) cinePoleR.v.copy(poleRoot);
      cinePoleR.w = poleRoot ? poleW : 0;
    },
    setHandOpen(v) { cineOpen = v; },
    /** Sol el dünya hedefi: pos (bilek), fingers (bilek→parmak), palm (avuç normali), curl 0..1 kavrama. */
    setLeftHand({ w = 1, pos = null, fingers = null, palm = null, curl = null, pole = null, poleW = 0 } = {}) {
      cineLeft.w = w;
      if (pos) cineLeft.pos.copy(pos);
      if (fingers) cineLeft.fingers.copy(fingers).normalize();
      if (palm) cineLeft.palm.copy(palm).normalize();
      if (curl !== null) cineLeft.curl = curl;
      if (pole) cineLeft.pole.copy(pole);
      cineLeft.poleW = pole ? poleW : 0;
    },
    /** Feneri dünyadaki bir çapaya taşı (yerel kimlik, dünya ölçeği korunur). */
    detachTo,
    /** Feneri çapadan ele al: `dur` sn'de el-bağlı poza kayar. */
    regrip(dur = 0.25) {
      flashPivot.updateWorldMatrix(true, false);
      regripFrom.copy(flashPivot.matrixWorld);
      if (flashPivot.parent !== R.hand) R.hand.add(flashPivot);
      gripLocalM.decompose(flashPivot.position, flashPivot.quaternion, flashPivot.scale);
      flashDetached = false;
      regripDur = Math.max(1e-3, dur);
      regripT = 0;
      R.hand.updateWorldMatrix(true, false);
      applyRegrip();
    },
    isFlashDetached: () => flashDetached,
    /** Yalnız fener mesh'leri (ışık bağlantısı/flashPivot görünür kalır). */
    setFlashVisible,
    /** Omuz (root uzayı) + erişim (dünya birimi; solveArm kırpma sınırı). */
    getArmReach(side = 'R') {
      const A = side === 'L' ? L : R;
      return { shoulderLocal: shoulderRoot[side === 'L' ? 'L' : 'R'], reach: (A.lenUp + A.lenFore) * 0.9985 };
    },
    /** Sanal fener dünya pozu için bilek (el kemiği) dünya konumu. */
    wristForGrip(posW, quatW, out = new THREE.Vector3()) {
      root.matrixWorld.decompose(_cp2, _cq2, _cs2);
      _wM.compose(posW, quatW, _cv.setScalar(flashScale * _cs2.x));
      _wM.multiply(_gInv.copy(gripLocalM).invert());
      return out.setFromMatrixPosition(_wM);
    },
  };
}
