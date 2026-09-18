/* 鉛直プロファイルの計算(純粋関数・DOMを使わない)
   ─────────────────────────────────────────
   数値予報(Open-Meteo の気象庁モデル)の気圧面データから、断面図・メテオグラム・Skew-T と
   安定度の判定に使う値を出す。CAPE・LI・0℃高度は取得できないのでここで計算する。
   単位: 気圧 hPa、気温・露点 ℃、高度 m(ftへの換算は M_FT)、風 kt、混合比 g/kg
   式の出典: Bolton (1980, MWR) の LCL温度・相当温位、Tetens の飽和水蒸気圧
   テスト: tests/sounding.test.mjs (教科書の例題・標準大気と照合) */

export const M_FT = 3.280839895;
const CP = 1005.7, RD = 287.04, EPS = 0.622, LV0 = 2.501e6, G = 9.80665;

/* 飽和水蒸気圧(hPa)。氷点下も水に対する値(航空気象の露点と同じ扱い) */
export function esat(tC) {
  return 6.112 * Math.exp(17.67 * tC / (tC + 243.5));
}
export function dewpoint(tC, rhPct) {
  const rh = Math.max(0.1, Math.min(100, rhPct));
  const e = esat(tC) * rh / 100;
  const l = Math.log(e / 6.112);
  return 243.5 * l / (17.67 - l);
}
export function rhFrom(tC, tdC) {
  return Math.max(0, Math.min(100, 100 * esat(tdC) / esat(tC)));
}
/* 混合比 g/kg */
export function mixingRatio(pHpa, tdC) {
  const e = esat(tdC);
  return 1000 * EPS * e / (pHpa - e);
}
/* 温位 K */
export function theta(pHpa, tC) {
  return (tC + 273.15) * Math.pow(1000 / pHpa, RD / CP);
}
/* 持ち上げ凝結高度(LCL)。Bolton(1980) 式(15)+乾燥断熱 */
export function lcl(pHpa, tC, tdC) {
  const T = tC + 273.15, Td = tdC + 273.15;
  const tl = 1 / (1 / (Td - 56) + Math.log(T / Td) / 800) + 56;       /* LCLの温度 K */
  const pl = pHpa * Math.pow(tl / T, CP / RD);
  return { p: pl, tC: tl - 273.15, tK: tl };
}
/* 相当温位 K。Bolton(1980) 式(43) */
export function thetaE(pHpa, tC, tdC) {
  const T = tC + 273.15;
  const r = mixingRatio(pHpa, tdC) / 1000;
  const tl = lcl(pHpa, tC, tdC).tK;
  return T * Math.pow(1000 / pHpa, 0.2854 * (1 - 0.28 * r))
    * Math.exp((3.376 / tl - 0.00254) * r * 1000 * (1 + 0.81 * r));
}

/* 湿潤断熱線に沿って持ち上げた気温(℃)。相当温位が保たれる温度を二分法で解く */
export function moistAdiabatT(pHpa, thetaEk) {
  let lo = -120, hi = 60;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    /* 飽和しているので露点=気温 */
    if (thetaE(pHpa, mid, mid) < thetaEk) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
/* 乾燥断熱線に沿って持ち上げた気温(℃) */
export function dryAdiabatT(pHpa, p0, t0C) {
  return (t0C + 273.15) * Math.pow(pHpa / p0, RD / CP) - 273.15;
}

/* 気圧面の並び(下から上)を作る。欠測の層は落とす */
export function makeProfile(levels) {
  return levels
    .filter(l => l && l.p != null && l.t != null && Number.isFinite(l.t))
    .map(l => ({ ...l, td: l.td != null ? l.td : (l.rh != null ? dewpoint(l.t, l.rh) : null) }))
    .sort((a, b) => b.p - a.p);
}
/* 気圧 p での環境の値を対数気圧で内挿 */
export function interp(prof, p, key = 't') {
  const xs = prof.filter(l => l[key] != null);
  if (!xs.length) return null;
  if (p >= xs[0].p) return xs[0][key];
  if (p <= xs[xs.length - 1].p) return xs[xs.length - 1][key];
  for (let i = 1; i < xs.length; i++) {
    if (p >= xs[i].p) {
      const a = xs[i - 1], b = xs[i];
      const f = Math.log(p / a.p) / Math.log(b.p / a.p);
      return a[key] + f * (b[key] - a[key]);
    }
  }
  return null;
}

/* 気塊を持ち上げたときの気温(℃)。LCLまで乾燥断熱、その上は湿潤断熱 */
export function parcelT(pHpa, start) {
  const l = lcl(start.p, start.t, start.td);
  if (pHpa >= l.p) return dryAdiabatT(pHpa, start.p, start.t);
  const the = thetaE(l.p, l.tC, l.tC);
  return moistAdiabatT(pHpa, the);
}

/* ショワルター安定指数：850hPaの気塊を500hPaまで持ち上げ、500hPaの環境気温との差 */
export function ssi(prof) {
  const t850 = interp(prof, 850, 't'), td850 = interp(prof, 850, 'td'), t500 = interp(prof, 500, 't');
  if (t850 == null || td850 == null || t500 == null) return null;
  return round1(t500 - parcelT(500, { p: 850, t: t850, td: td850 }));
}
/* リフテッドインデックス：地上(または指定気圧)の気塊を500hPaまで持ち上げた差 */
export function li(prof, sfc) {
  const s = sfc || prof[0];
  const t500 = interp(prof, 500, 't');
  if (!s || s.td == null || t500 == null) return null;
  return round1(t500 - parcelT(500, s));
}

/* CAPE・CIN(J/kg)と自由対流高度(LFC)・平衡高度(EL)。気塊は地上(または sfc)から */
export function cape(prof, sfc) {
  const s = sfc || prof[0];
  if (!s || s.td == null) return { cape: null, cin: null };
  const l = lcl(s.p, s.t, s.td);
  let capeV = 0, cinV = 0, lfc = null, el = null, prev = null;
  /* 5hPa刻みで積分する(気圧面が粗いので細かく刻む) */
  for (let p = s.p; p >= 100; p -= 5) {
    const tEnv = interp(prof, p, 't'), tdEnv = interp(prof, p, 'td');
    if (tEnv == null) break;
    const tPar = parcelT(p, s);
    /* 仮温度で比べる(水蒸気の分だけ軽い) */
    const rPar = p >= l.p ? mixingRatio(s.p, s.td) / 1000 : mixingRatio(p, tPar) / 1000;
    const rEnv = tdEnv != null ? mixingRatio(p, tdEnv) / 1000 : 0;
    const tvPar = (tPar + 273.15) * (1 + 0.608 * rPar), tvEnv = (tEnv + 273.15) * (1 + 0.608 * rEnv);
    const buoy = G * (tvPar - tvEnv) / tvEnv;
    if (prev) {
      /* 層の厚さ(静水圧) dz = -RD*Tv/g * dlnp */
      const dz = RD * ((tvEnv + prev.tvEnv) / 2) / G * Math.log(prev.p / p);
      const b = (buoy + prev.buoy) / 2;
      if (b > 0) { capeV += b * dz; if (lfc == null && p < l.p) lfc = p; }
      else if (lfc == null) cinV += b * dz;
      if (lfc != null && b < 0 && el == null && p < lfc) el = p;
    }
    prev = { p, buoy, tvEnv };
  }
  return { cape: Math.round(capeV), cin: Math.round(cinV), lfcP: lfc, elP: el, lclP: l.p };
}

/* 0℃高度(m)。下から見て最初に0℃を下回る高さを内挿 */
export function freezingLevel(prof) {
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1], b = prof[i];
    if (a.z == null || b.z == null) continue;
    if (a.t >= 0 && b.t < 0) return Math.round(a.z + (b.z - a.z) * (0 - a.t) / (b.t - a.t));
  }
  return prof[0] && prof[0].t < 0 ? (prof[0].z ?? 0) : null;
}

/* 湿潤層(気温と露点の差が小さい層)。雲がある高度帯の目安 */
export function moistLayers(prof, { maxSpread = 3, minRh = null } = {}) {
  const out = [];
  let cur = null;
  for (const l of prof) {
    const wet = minRh != null ? (l.rh != null && l.rh >= minRh) : (l.td != null && l.t - l.td <= maxSpread);
    if (wet) { if (!cur) cur = { fromP: l.p, fromZ: l.z, toP: l.p, toZ: l.z }; else { cur.toP = l.p; cur.toZ = l.z } }
    else if (cur) { out.push(cur); cur = null }
  }
  if (cur) out.push(cur);
  return out;
}

/* 逆転層(高さとともに気温が上がる層)。地上付近のものは霧・低い雲が残りやすい目安 */
export function inversions(prof) {
  const out = [];
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1], b = prof[i];
    if (b.t > a.t + 0.1) out.push({ fromP: a.p, toP: b.p, fromZ: a.z, toZ: b.z, dT: round1(b.t - a.t), surface: i === 1 });
  }
  return out;
}

/* 風の鉛直シアー：2つの高度(m)の風ベクトルの差(kt) */
export function shear(prof, z1, z2) {
  const w = z => {
    const xs = prof.filter(l => l.z != null && l.dir != null && l.spd != null);
    if (xs.length < 2) return null;
    let a = xs[0], b = xs[xs.length - 1];
    for (let i = 1; i < xs.length; i++) if (xs[i].z >= z) { a = xs[i - 1]; b = xs[i]; break }
    const f = Math.max(0, Math.min(1, (z - a.z) / ((b.z - a.z) || 1)));
    const uv = l => [-l.spd * Math.sin(l.dir * Math.PI / 180), -l.spd * Math.cos(l.dir * Math.PI / 180)];
    const [ua, va] = uv(a), [ub, vb] = uv(b);
    return [ua + f * (ub - ua), va + f * (vb - va)];
  };
  const a = w(z1), b = w(z2);
  if (!a || !b) return null;
  return round1(Math.hypot(b[0] - a[0], b[1] - a[1]));
}

/* 推定雲底(ft AGL)。地上の気温と露点の差から(Espyの式：125m/℃) */
export function cloudBaseEspy(tC, tdC) {
  if (tC == null || tdC == null) return null;
  return Math.round(125 * Math.max(0, tC - tdC) * M_FT);
}

/* まとめて出す。飛行高度帯(ft AGL)を渡すと着氷・湿潤層の重なりも見る */
export function analyze(levels, { sfc = null, flightFt = [0, 10000], elevM = 0 } = {}) {
  const prof = makeProfile(levels);
  if (!prof.length) return null;
  const base = sfc || prof[0];
  const c = cape(prof, base);
  const fz = freezingLevel(prof);
  const wet = moistLayers(prof, { maxSpread: 3 });
  const l = base.td != null ? lcl(base.p, base.t, base.td) : null;
  const lclZ = l ? Math.round(interpZ(prof, l.p) ?? 0) : null;
  const flightM = [flightFt[0] / M_FT + elevM, flightFt[1] / M_FT + elevM];
  return {
    prof,
    ssi: ssi(prof), li: li(prof, base), cape: c.cape, cin: c.cin,
    lclP: l ? round1(l.p) : null, lclFt: lclZ != null ? Math.round((lclZ - elevM) * M_FT) : null,
    freezingM: fz, freezingFt: fz == null ? null : Math.round(fz * M_FT),
    freezingInFlight: fz != null && fz >= flightM[0] && fz <= flightM[1],
    moist: wet.map(w => ({ ...w, fromFt: w.fromZ == null ? null : Math.round(w.fromZ * M_FT), toFt: w.toZ == null ? null : Math.round(w.toZ * M_FT) })),
    moistInFlight: wet.some(w => w.toZ != null && w.fromZ != null && w.toZ >= flightM[0] && w.fromZ <= flightM[1]),
    inversions: inversions(prof),
    shear0to5000: shear(prof, base.z ?? elevM, (base.z ?? elevM) + 5000 / M_FT),
    cloudBaseFt: cloudBaseEspy(base.t, base.td),
  };
}
function interpZ(prof, p) { return interp(prof, p, 'z') }
function round1(x) { return x == null ? null : Math.round(x * 10) / 10 }
