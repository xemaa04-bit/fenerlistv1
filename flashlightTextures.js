// -----------------------------------------------------------------------------
// EL FENERİ — prosedürel dokular
// -----------------------------------------------------------------------------
// • Işık "cookie" deseni: gerçek bir reflektörlü fenerin projeksiyonu (sıcak nokta,
//   hafif karanlık halka, korona, reflektör dalgalanmaları, kenarda sarımsı ton kayması).
// • 3B toz yoğunluk gürültüsü (hacimsel ışık + toz bulutu).
// • Eloksal alüminyum gövde, elmas tırtıl (knurl), kauçuk düğme, krom reflektör dokuları.
// Hepsi açılışta bir kez üretilir; dışarıdan dosya gerekmez.
// -----------------------------------------------------------------------------
import * as THREE from 'three';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const fract = x => x - Math.floor(x);

/** Döşenebilir 2B değer gürültüsü (periyot = size kafes birimi). */
function tileNoise2D(rand, size) {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % size) + size) % size, y0 = ((yi % size) + size) % size;
    const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
    const a = g[y0 * size + x0], b = g[y0 * size + x1], c = g[y1 * size + x0], d = g[y1 * size + x1];
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  };
}

function fbm2(noise, x, y, oct = 4, base = 1) {
  let s = 0, amp = 0.5, f = base, tot = 0;
  for (let i = 0; i < oct; i++) { s += noise(x * f, y * f) * amp; tot += amp; amp *= 0.5; f *= 2; }
  return s / tot;
}

function dataTex(data, w, h, { srgb = false, repeat = true, mip = true, aniso = 8 } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mip;
  t.anisotropy = aniso;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Yükseklik alanından teğet uzayı normal haritası (döşenebilir). */
function heightToNormal(h, w, hgt, strength) {
  const out = new Uint8Array(w * hgt * 4);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w, yu = (y - 1 + hgt) % hgt, yd = (y + 1) % hgt;
      const dx = (h[y * w + xr] - h[y * w + xl]) * strength;
      const dy = (h[yd * w + x] - h[yu * w + x]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// IŞIK DESENİ (cookie)
// UV (0.5, 0.5) = ışın ekseni; r = 1 spot konisinin kenarı.
// Değerler doğrusal ışık çarpanıdır (HalfFloat → 8-bit bantlaşma yok).
// -----------------------------------------------------------------------------
export function createFlashlightCookie(size = 512, seed = 7) {
  const rand = mulberry32(seed);
  const n2 = tileNoise2D(rand, 64);
  const data = new Uint16Array(size * size * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  // reflektörün minik eksen kayması + LED çipinin kare izdüşümü
  const cx = 0.5 + 0.006, cy = 0.5 - 0.004;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const dx = (u - cx) * 2, dy = (v - cy) * 2;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      // LED çipi: merkezde hafif kare/yuvarlatılmış sıcak nokta
      const sq = Math.pow(Math.pow(Math.abs(dx), 4) + Math.pow(Math.abs(dy), 4), 0.25);
      const coreR = r * 0.65 + sq * 0.35;
      const core = Math.exp(-Math.pow(coreR / 0.16, 2.2));
      const hot = Math.exp(-Math.pow(r / 0.30, 2.0));
      // sıcak noktanın hemen dışında hafif karanlık halka (reflektör geçişi)
      const darkRing = 1 - 0.20 * Math.exp(-Math.pow((r - 0.34) / 0.045, 2));
      // korona / yan ışık
      const corona = 0.26 * (1 - smooth(0.30, 0.98, r)) + 0.06 * (1 - smooth(0.6, 1.0, r));
      // reflektör yüzeyinden gelen eşmerkezli dalgalanmalar
      const ripples = 1 + 0.045 * Math.sin(r * 92 + 0.6) * smooth(0.12, 0.3, r) * (1 - smooth(0.75, 1.0, r))
        + 0.025 * Math.sin(r * 211 + 1.7) * smooth(0.2, 0.4, r);
      // ışınsal hafif çizgiler + leke (kir/parmak izi lens üzerinde)
      const streak = 1 + 0.035 * (n2(ang * 10.2 + 3, r * 2) - 0.5) * smooth(0.15, 0.5, r);
      const smudge = 1 - 0.07 * smooth(0.55, 0.85, fbm2(n2, u * 6, v * 6, 3));
      const edge = 1 - smooth(0.90, 1.0, r);
      let I = (core * 1.0 + hot * 0.55 + corona) * darkRing * ripples * streak * smudge * edge;
      I = Math.max(0, I) * 1.18;
      // renk sıcaklığı: gerçek LED/reflektör tint kayması ÇOK hafiftir (merkez bir tık soğuk,
      // korona bir tık sıcak). Eski −%16 mavi, dış halkayı belirgin sarı-turuncu yapıyordu.
      const warm = smooth(0.32, 0.8, r);
      const cool = 1 - smooth(0.0, 0.3, r);
      const rC = I * (1.0 + 0.015 * warm - 0.01 * cool);
      const gC = I;
      const bC = I * (1.0 - 0.035 * warm + 0.02 * cool);
      const i = (y * size + x) * 4;
      data[i] = toHalf(rC);
      data[i + 1] = toHalf(gC);
      data[i + 2] = toHalf(bC);
      data[i + 3] = toHalf(1);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.flipY = false;
  t.needsUpdate = true;
  t.name = 'flashlightCookie';
  return t;
}

/** Silah fenerinin görünümünü değiştirmeyen düz beyaz desen (shader varyantı sabit kalsın diye). */
export function createWhiteCookie() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  t.name = 'whiteCookie';
  return t;
}

// -----------------------------------------------------------------------------
// 3B TOZ GÜRÜLTÜSÜ (döşenebilir, 64³) — R: büyük öbekler, G: ince tutam/iplikler
// -----------------------------------------------------------------------------
export function createDustNoise3D(size = 64, seed = 11) {
  const rand = mulberry32(seed);
  const P = 16;
  const lattice = new Float32Array(P * P * P);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const L = (x, y, z) => lattice[((z % P + P) % P) * P * P + ((y % P + P) % P) * P + ((x % P + P) % P)];
  const vnoise = (x, y, z, period) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const m = q => ((q % period) + period) % period;
    const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1), z0 = m(zi), z1 = m(zi + 1);
    const c000 = L(x0, y0, z0), c100 = L(x1, y0, z0), c010 = L(x0, y1, z0), c110 = L(x1, y1, z0);
    const c001 = L(x0, y0, z1), c101 = L(x1, y0, z1), c011 = L(x0, y1, z1), c111 = L(x1, y1, z1);
    const a = c000 + (c100 - c000) * u, b = c010 + (c110 - c010) * u;
    const c = c001 + (c101 - c001) * u, d = c011 + (c111 - c011) * u;
    const e = a + (b - a) * v, f = c + (d - c) * v;
    return e + (f - e) * w;
  };
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / size, fy = y / size, fz = z / size;
        // büyük, yumuşak toz öbekleri
        let big = 0, amp = 0.5, tot = 0;
        for (let o = 0, per = 4; o < 3; o++, per *= 2) {
          big += vnoise(fx * per, fy * per, fz * per, per) * amp; tot += amp; amp *= 0.5;
        }
        big /= tot;
        // ince ipliksi tutamlar (ridged)
        let fine = 0; amp = 0.5; tot = 0;
        for (let o = 0, per = 8; o < 3; o++, per *= 2) {
          const n = 1 - Math.abs(vnoise(fx * per + 7.3, fy * per + 1.1, fz * per + 3.7, per) * 2 - 1);
          fine += n * n * amp; tot += amp; amp *= 0.5;
        }
        fine /= tot;
        const i = ((z * size + y) * size + x) * 4;
        data[i] = clamp01(big) * 255;
        data[i + 1] = clamp01(fine) * 255;
        data[i + 2] = clamp01(vnoise(fx * 16 + 2.2, fy * 16, fz * 16 + 9.1, 16)) * 255;
        data[i + 3] = 255;
      }
    }
  }
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  t.name = 'dustNoise3D';
  return t;
}

// -----------------------------------------------------------------------------
// GÖVDE DOKULARI
// u = çevre (0..1), v = profil boyunca yay uzunluğu (0..1)
// ORM paketi: R = aşınma maskesi gürültüsü, G = pürüzlülük, B = metalik
// -----------------------------------------------------------------------------
export function createAnodizedMaps(seed = 3) {
  const W = 1024, H = 512;
  const rand = mulberry32(seed);
  const n = tileNoise2D(rand, 128);
  const h = new Float32Array(W * H);
  const albedo = new Uint8Array(W * H * 4);
  const orm = new Uint8Array(W * H * 4);
  const scratch = new Float32Array(W * H);
  // çizikler: gövde yuvarlanırken/kılıfa girerken oluşan çevresel ince çizgiler
  const plot = (x, y, a) => {
    const xi = ((Math.round(x) % W) + W) % W, yi = Math.round(y);
    if (yi < 0 || yi >= H) return;
    const k = yi * W + xi;
    scratch[k] = Math.max(scratch[k], a);
  };
  for (let s = 0; s < 110; s++) {
    const x0 = rand() * W, y0 = rand() * H;
    const ang = (rand() - 0.5) * (rand() < 0.75 ? 0.6 : 3.0);
    const len = 8 + Math.pow(rand(), 3) * 150;
    const a = (0.12 + Math.pow(rand(), 2) * 0.5);
    const curve = (rand() - 0.5) * 0.004;
    for (let t = 0; t < len; t += 0.5) {
      const an = ang + curve * t;
      const fade = Math.sin((t / len) * Math.PI);
      plot(x0 + Math.cos(an) * t, y0 + Math.sin(an) * t, a * Math.pow(fade, 0.6));
    }
  }
  // minik vuruk izleri
  for (let d = 0; d < 35; d++) {
    const x0 = rand() * W, y0 = rand() * H, r = 0.8 + rand() * 1.6;
    for (let yy = -4; yy <= 4; yy++) for (let xx = -4; xx <= 4; xx++) {
      const q = Math.hypot(xx, yy) / r;
      if (q < 1) plot(x0 + xx, y0 + yy, (1 - q) * 0.8);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x, i = k * 4;
      const u = x / W, v = y / H;
      const big = fbm2(n, u * 8, v * 4, 4);
      const fine = n(u * 128, v * 64);
      const sc = scratch[k];
      // torna işleme izleri (v yönünde ince halkalar) → pürüzlülükte hafif anizotropik his
      const lathe = 0.5 + 0.5 * Math.sin(v * H * 1.7 + fine * 2.0);
      // eloksal: koyu gri-siyah, çok hafif renk dalgalanması; çizikte çıplak alüminyum
      const base = 0.050 + (big - 0.5) * 0.012 + (fine - 0.5) * 0.006;
      const alu = 0.42 + (fine - 0.5) * 0.08;
      const c = base + (alu - base) * sc * 0.7;
      albedo[i] = Math.min(255, Math.pow(c, 1 / 2.2) * 255);
      albedo[i + 1] = Math.min(255, Math.pow(c * 1.005, 1 / 2.2) * 255);
      albedo[i + 2] = Math.min(255, Math.pow(c * 1.02, 1 / 2.2) * 255);
      albedo[i + 3] = 255;
      // pürüzlülük: yarı mat eloksal + yağlı parmak lekeleri + işleme izi
      const smudge = smooth(0.58, 0.78, fbm2(n, u * 5 + 11, v * 3 + 7, 3));
      let rough = 0.44 + (big - 0.5) * 0.10 + (lathe - 0.5) * 0.04 - smudge * 0.12;
      rough = rough + (0.30 - rough) * sc;
      const metal = 0.55 + sc * 0.45;
      orm[i] = clamp01(fbm2(n, u * 22 + 3, v * 11 + 5, 4)) * 255; // aşınma gürültüsü
      orm[i + 1] = clamp01(rough) * 255;
      orm[i + 2] = clamp01(metal) * 255;
      orm[i + 3] = 255;
      h[k] = -sc * 0.6 + (fine - 0.5) * 0.06 + (lathe - 0.5) * 0.05;
    }
  }
  const normal = heightToNormal(h, W, H, 2.2);
  return {
    map: dataTex(albedo, W, H, { srgb: true }),
    orm: dataTex(orm, W, H),
    normal: dataTex(normal, W, H),
  };
}

/** Elmas tırtıl (knurl): u = çevre, v = bant uzunluğu. Tepe noktaları aşınmış/parlak. */
export function createKnurlMaps({ pyramidsU = 24, pyramidsV = 24, seed = 5 } = {}) {
  const W = 512, H = 512;
  const rand = mulberry32(seed);
  const n = tileNoise2D(rand, 64);
  const h = new Float32Array(W * H);
  const albedo = new Uint8Array(W * H * 4);
  const orm = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      const a = fract(u * pyramidsU + v * pyramidsV);
      const b = fract(u * pyramidsU - v * pyramidsV);
      const ta = 1 - Math.abs(a * 2 - 1), tb = 1 - Math.abs(b * 2 - 1);
      // piramit: iki helisel olugun kesişimi; tepe hafif düzleşmiş (aşınma)
      let p = Math.min(ta, tb);
      const wornTop = smooth(0.62, 0.9, p);
      p = Math.min(p, 0.82);
      const k = y * W + x, i = k * 4;
      const nn = n(u * 48, v * 48), big = fbm2(n, u * 4, v * 4, 3);
      h[k] = p + (nn - 0.5) * 0.04;
      // tepe noktaları çıplak alüminyuma aşınmış, oluk dipleri kirli/koyu
      const wear = clamp01(wornTop * (0.35 + big * 0.9));
      const groove = 1 - smooth(0.0, 0.35, p);
      let c = 0.048 + (nn - 0.5) * 0.01;
      c = c + (0.55 - c) * wear;
      c *= 1 - groove * 0.45;
      albedo[i] = Math.pow(c, 1 / 2.2) * 255;
      albedo[i + 1] = Math.pow(c, 1 / 2.2) * 255;
      albedo[i + 2] = Math.pow(c * 1.02, 1 / 2.2) * 255;
      albedo[i + 3] = 255;
      orm[i] = 255;
      orm[i + 1] = clamp01(0.5 - wear * 0.22 + groove * 0.2) * 255;
      orm[i + 2] = clamp01(0.6 + wear * 0.4) * 255;
      orm[i + 3] = 255;
    }
  }
  const normal = heightToNormal(h, W, H, 3.2);
  return {
    map: dataTex(albedo, W, H, { srgb: true }),
    orm: dataTex(orm, W, H),
    normal: dataTex(normal, W, H),
  };
}

/** Kauçuk düğme: ince gözenekli doku. */
export function createRubberNormal(seed = 9) {
  const W = 256, H = 256;
  const rand = mulberry32(seed);
  const n = tileNoise2D(rand, 64);
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    h[y * W + x] = fbm2(n, x / W * 32, y / H * 32, 3) * 0.5 + n(x / W * 64, y / H * 64) * 0.5;
  }
  return dataTex(heightToNormal(h, W, H, 1.6), W, H);
}

/** Krom reflektör: "portakal kabuğu" (OP) yüzey dokusu. */
export function createOrangePeelNormal(seed = 13) {
  const W = 256, H = 256;
  const rand = mulberry32(seed);
  const n = tileNoise2D(rand, 32);
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    h[y * W + x] = n(u * 24, v * 12) * 0.7 + n(u * 48, v * 24) * 0.3;
  }
  return dataTex(heightToNormal(h, W, H, 1.1), W, H);
}
