/* メテオグラム・予報断面図・Skew-T の描画(Canvas)。
   ─────────────────────────────────────────
   - 数値予報(Open-Meteo の気象庁モデル)から自作する図。公式の飛行場時系列予報と並べて見る用
   - 画面の色は CSS 変数(--bg 等)から取り、ダーク表示に合わせる
   - 高解像度画面のために devicePixelRatio ぶん拡大して描く
   - 「推定」の値(雲底など)は必ず図の中に「推定」と書く */
import { M_FT, interp, parcelT, lcl, dryAdiabatT, moistAdiabatT, thetaE, inversions, moistLayers } from './sounding.js';

const CSS = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
export const COL = () => ({
  bg: CSS('--panel2'), line: CSS('--line'), txt: CSS('--txt'), dim: CSS('--dim'),
  grn: CSS('--grn'), amb: CSS('--amb'), red: CSS('--red'), cyn: CSS('--cyn'), blu: CSS('--blu'), mag: CSS('--mag'),
});

/* Canvas の下ごしらえ(高解像度対応)。戻り値は描画用の ctx と論理サイズ */
export function setup(cv, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = cv.clientWidth || cv.parentElement.clientWidth || 360;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = COL();
  ctx.fillStyle = c.bg; ctx.fillRect(0, 0, w, h);
  ctx.font = '11px ui-monospace,monospace';
  return { ctx, w, h, c };
}
const jstH = d => (d.getUTCHours() + 9) % 24;
const jstDay = d => new Date(d.getTime() + 9 * 3600e3).getUTCDate();

/* 共通の時間軸(JSTの3時間ごとに目盛り)。日付が変わるところは明るい線 */
function timeAxis(ctx, times, x0, x1, yTop, yBot, c, { labels = true } = {}) {
  const n = times.length;
  const X = i => x0 + (x1 - x0) * (n === 1 ? 0 : i / (n - 1));
  ctx.lineWidth = 1;
  times.forEach((t, i) => {
    const h = jstH(t);
    if (h % 3) return;
    const midnight = h === 0;
    ctx.strokeStyle = midnight ? c.dim : c.line;
    ctx.beginPath(); ctx.moveTo(X(i), yTop); ctx.lineTo(X(i), yBot); ctx.stroke();
    if (labels && h % 6 === 0) {
      ctx.fillStyle = midnight ? c.txt : c.dim;
      ctx.textAlign = 'center';
      ctx.fillText(midnight ? `${jstDay(t)}日` : String(h), X(i), yBot + 12);
    }
  });
  return X;
}

/* 矢羽(風速 kt)。短い羽=5kt、長い羽=10kt、旗=50kt。風が吹いてくる向きに伸ばす */
export function windBarb(ctx, x, y, dirDeg, spdKt, color, size = 16) {
  if (spdKt == null || dirDeg == null) return;
  ctx.save(); ctx.translate(x, y); ctx.rotate((dirDeg + 180) * Math.PI / 180);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.2;
  if (spdKt < 2.5) { ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.stroke(); ctx.restore(); return }
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -size); ctx.stroke();
  let left = Math.round(spdKt / 5) * 5, y0 = -size;
  const step = size / 5.5;
  while (left >= 50) { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(size * 0.55, y0 + step * 0.9); ctx.lineTo(0, y0 + step * 1.8); ctx.fill(); y0 += step * 2; left -= 50 }
  while (left >= 10) { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(size * 0.55, y0 + step * 0.9); ctx.stroke(); y0 += step; left -= 10 }
  if (left >= 5) { if (y0 === -size) y0 += step * 0.6; ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(size * 0.3, y0 + step * 0.5); ctx.stroke() }
  ctx.restore();
}

/* 雲量(%)→ 灰色の濃さ */
const cloudFill = v => `rgba(210,225,240,${Math.max(0, Math.min(1, v / 100)) * 0.75})`;
/* 相対湿度(%)→ 青の濃さ。90%以上は「雲ありの可能性」で濃くする */
export function rhColor(rh) {
  if (rh == null) return 'rgba(0,0,0,0)';
  if (rh >= 90) return `rgba(80,190,255,${0.55 + (rh - 90) / 10 * 0.35})`;
  if (rh >= 70) return `rgba(70,140,220,${0.18 + (rh - 70) / 20 * 0.3})`;
  if (rh >= 50) return `rgba(70,120,180,${0.08 + (rh - 50) / 20 * 0.1})`;
  return 'rgba(0,0,0,0)';
}

/* ───────── メテオグラム ───────── */
/* d = {times, sfc:{t,td,windDir,windSpd,precip,mslp,cloudLow,cloudMid,cloudHigh}, est:{baseFt,ssi,cape}} */
export function meteogram(cv, d, { window: win = null, metar = null } = {}) {
  const rows = [
    { key: 'temp', h: 62, label: '気温/露点 ℃' },
    { key: 'wind', h: 40, label: '地上風 kt' },
    { key: 'cloud', h: 56, label: '雲量/推定雲底 ft' },
    { key: 'precip', h: 46, label: '降水 mm/h' },
    { key: 'mslp', h: 46, label: '海面気圧 hPa' },
    { key: 'stab', h: 46, label: '安定度 SSI/CAPE' },
  ];
  const padL = 44, padR = 8, padT = 6, padB = 18;
  const H = padT + padB + rows.reduce((a, r) => a + r.h + 6, 0);
  const { ctx, w, c } = setup(cv, H);
  const x0 = padL, x1 = w - padR;
  const n = d.times.length, X = i => x0 + (x1 - x0) * (n === 1 ? 0 : i / (n - 1));
  let y = padT;
  const band = (yTop, yBot) => {
    if (!win) return;
    const inWin = d.times.map(t => t >= win.from && t <= win.to);
    let s = -1;
    inWin.forEach((v, i) => {
      if (v && s < 0) s = i;
      if ((!v || i === n - 1) && s >= 0) {
        ctx.fillStyle = 'rgba(61,245,255,.10)';
        ctx.fillRect(X(s), yTop, X(v ? i : i - 1) - X(s), yBot - yTop);
        s = -1;
      }
    });
  };
  const frame = (r, min, max, fmt = v => String(Math.round(v))) => {
    const yTop = y, yBot = y + r.h;
    ctx.fillStyle = c.bg; ctx.fillRect(x0, yTop, x1 - x0, r.h);
    band(yTop, yBot);
    ctx.strokeStyle = c.line; ctx.strokeRect(x0, yTop, x1 - x0, r.h);
    timeAxis(ctx, d.times, x0, x1, yTop, yBot, c, { labels: r === rows[rows.length - 1] });
    ctx.fillStyle = c.dim; ctx.textAlign = 'right';
    ctx.fillText(fmt(max), x0 - 3, yTop + 9);
    ctx.fillText(fmt(min), x0 - 3, yBot - 2);
    ctx.textAlign = 'left'; ctx.fillStyle = c.dim;
    ctx.fillText(r.label, x0 + 3, yTop + 10);
    const Y = v => yBot - (yBot - yTop) * (v - min) / ((max - min) || 1);
    return { yTop, yBot, Y };
  };
  const line = (vals, Y, color, width = 1.6) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => { if (v == null) { started = false; return } const px = X(i), py = Y(v); started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true });
    ctx.stroke();
  };
  const nums = a => a.filter(v => v != null && Number.isFinite(v));
  const span = (a, pad) => { const v = nums(a); const mn = Math.min(...v), mx = Math.max(...v); return [Math.floor(mn - pad), Math.ceil(mx + pad)] };

  /* 気温・露点 */
  let r = rows[0]; let [mn, mx] = span([...d.sfc.t, ...d.sfc.td], 2);
  let f = frame(r, mn, mx);
  if (f.Y(0) > f.yTop && f.Y(0) < f.yBot) { ctx.strokeStyle = c.dim; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x0, f.Y(0)); ctx.lineTo(x1, f.Y(0)); ctx.stroke(); ctx.setLineDash([]) }
  line(d.sfc.t, f.Y, c.amb); line(d.sfc.td, f.Y, c.cyn);
  if (metar?.t != null) { ctx.fillStyle = c.amb; ctx.beginPath(); ctx.arc(X(metar.i), f.Y(metar.t), 3, 0, 7); ctx.fill() }
  if (metar?.td != null) { ctx.fillStyle = c.cyn; ctx.beginPath(); ctx.arc(X(metar.i), f.Y(metar.td), 3, 0, 7); ctx.fill() }
  y = f.yBot + 6;

  /* 地上風 */
  r = rows[1]; f = frame(r, 0, 1, () => '');
  const every = Math.max(1, Math.round(n / (w / 26)));
  d.times.forEach((t, i) => {
    if (i % every) return;
    const s = d.sfc.windSpd[i];
    windBarb(ctx, X(i), (f.yTop + f.yBot) / 2 + 6, d.sfc.windDir[i], s, s >= 25 ? c.red : s >= 15 ? c.amb : c.grn, 15);
  });
  y = f.yBot + 6;

  /* 雲量(下層・中層・上層)と推定雲底 */
  r = rows[2];
  const baseMax = Math.max(3000, ...nums(d.est.baseFt));
  f = frame(r, 0, baseMax, v => Math.round(v / 100) * 100);
  const bandH = (f.yBot - f.yTop) / 3;
  ['cloudHigh', 'cloudMid', 'cloudLow'].forEach((k, j) => {
    d.times.forEach((t, i) => {
      const v = d.sfc[k][i]; if (v == null) return;
      ctx.fillStyle = cloudFill(v);
      const bw = (x1 - x0) / (n - 1 || 1);
      ctx.fillRect(X(i) - bw / 2, f.yTop + j * bandH, bw, bandH);
    });
  });
  line(d.est.baseFt, f.Y, c.mag, 1.8);
  ctx.fillStyle = c.mag; ctx.textAlign = 'right'; ctx.fillText('推定雲底', x1 - 3, f.yTop + 10);
  y = f.yBot + 6;

  /* 降水量 */
  r = rows[3]; const pmax = Math.max(2, ...nums(d.sfc.precip));
  f = frame(r, 0, pmax, v => v.toFixed(v < 10 ? 1 : 0));
  d.times.forEach((t, i) => {
    const v = d.sfc.precip[i]; if (!v) return;
    const bw = Math.max(2, (x1 - x0) / n - 1);
    ctx.fillStyle = c.blu; ctx.fillRect(X(i) - bw / 2, f.Y(v), bw, f.yBot - f.Y(v));
  });
  y = f.yBot + 6;

  /* 海面気圧 */
  r = rows[4]; [mn, mx] = span(d.sfc.mslp, 1);
  f = frame(r, mn, mx); line(d.sfc.mslp, f.Y, c.txt);
  y = f.yBot + 6;

  /* 安定度：SSI(左目盛り)とCAPE(棒) */
  r = rows[5];
  const ssiSpan = span([...d.est.ssi, 0, 6], 1);
  f = frame(r, ssiSpan[0], ssiSpan[1]);
  const capeMax = Math.max(500, ...nums(d.est.cape));
  d.times.forEach((t, i) => {
    const v = d.est.cape[i]; if (!v) return;
    const bw = Math.max(2, (x1 - x0) / n - 1);
    ctx.fillStyle = 'rgba(255,61,245,.35)';
    const hgt = (f.yBot - f.yTop) * Math.min(1, v / capeMax);
    ctx.fillRect(X(i) - bw / 2, f.yBot - hgt, bw, hgt);
  });
  if (f.Y(0) > f.yTop && f.Y(0) < f.yBot) { ctx.strokeStyle = c.dim; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x0, f.Y(0)); ctx.lineTo(x1, f.Y(0)); ctx.stroke(); ctx.setLineDash([]) }
  line(d.est.ssi, f.Y, c.grn);
  ctx.fillStyle = c.mag; ctx.textAlign = 'right'; ctx.fillText(`CAPE 最大${Math.round(capeMax)}`, x1 - 3, f.yTop + 10);
  return { X, height: H };
}

/* ───────── 予報断面図(時間×高度) ───────── */
/* d = {times, prof:[[{p,t,td,rh,z,dir,spd}...]...], elevM} */
export function crossSection(cv, d, { window: win = null, topFt = 10000, judge = null } = {}) {
  const padL = 46, padR = 46, padT = 16, padB = 34, H = 300;
  const { ctx, w, c } = setup(cv, H + padT + padB);
  const x0 = padL, x1 = w - padR, yTop = padT + 10, yBot = yTop + H;
  const n = d.times.length, X = i => x0 + (x1 - x0) * (n === 1 ? 0 : i / (n - 1));
  const Y = ft => yBot - (yBot - yTop) * ft / topFt;                 /* 高度はft(地上からの高さ) */
  const ftOf = l => (l.z - d.elevM) * M_FT;

  /* 相対湿度の塗り(1時間×100ftの格子で内挿) */
  const stepFt = 200, bw = (x1 - x0) / Math.max(1, n - 1);
  d.times.forEach((t, i) => {
    const prof = d.prof[i]; if (!prof?.length) return;
    for (let ft = 0; ft < topFt; ft += stepFt) {
      const rh = interpByFt(prof, ft / M_FT + d.elevM, 'rh');
      if (rh == null) continue;
      ctx.fillStyle = rhColor(rh);
      ctx.fillRect(X(i) - bw / 2, Y(ft + stepFt), bw, Y(ft) - Y(ft + stepFt));
    }
  });

  /* 0℃高度の線 */
  ctx.strokeStyle = c.cyn; ctx.lineWidth = 1.6; ctx.setLineDash([6, 3]); ctx.beginPath();
  let started = false;
  d.times.forEach((t, i) => {
    const prof = d.prof[i]; if (!prof?.length) return;
    let z = null;
    for (let k = 1; k < prof.length; k++) if (prof[k - 1].t >= 0 && prof[k].t < 0) { const a = prof[k - 1], b = prof[k]; z = a.z + (b.z - a.z) * (0 - a.t) / (b.t - a.t); break }
    if (z == null) { started = false; return }
    const py = Y((z - d.elevM) * M_FT);
    started ? ctx.lineTo(X(i), py) : ctx.moveTo(X(i), py); started = true;
  });
  ctx.stroke(); ctx.setLineDash([]);

  /* 各層の矢羽 */
  const every = Math.max(1, Math.round(n / (w / 30)));
  d.times.forEach((t, i) => {
    if (i % every) return;
    const prof = d.prof[i]; if (!prof?.length) return;
    for (const l of prof) {
      const ft = ftOf(l);
      if (ft < 100 || ft > topFt - 200) continue;
      windBarb(ctx, X(i), Y(ft), l.dir, l.spd, l.spd >= 30 ? c.red : l.spd >= 20 ? c.amb : c.txt, 13);
    }
  });

  /* 枠と目盛り(ftとhPa) */
  ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.strokeRect(x0, yTop, x1 - x0, yBot - yTop);
  ctx.fillStyle = c.dim; ctx.textAlign = 'right';
  for (let ft = 0; ft <= topFt; ft += 2000) {
    ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(x0, Y(ft)); ctx.lineTo(x1, Y(ft)); ctx.stroke();
    ctx.fillText(`${ft / 1000}k`, x0 - 3, Y(ft) + 4);
  }
  ctx.textAlign = 'left';
  const prof0 = d.prof.find(p => p?.length);
  if (prof0) for (const l of prof0) { const ft = ftOf(l); if (ft > 0 && ft < topFt) ctx.fillText(`${l.p}`, x1 + 3, Y(ft) + 4) }
  ctx.fillText('hPa', x1 + 3, yTop - 3);
  ctx.textAlign = 'right'; ctx.fillText('ft AGL', x0 - 3, yTop - 3);
  timeAxis(ctx, d.times, x0, x1, yTop, yBot, c);

  /* 飛行予定の時間帯 */
  if (win) {
    const i0 = d.times.findIndex(t => t >= win.from), i1 = d.times.findIndex(t => t > win.to);
    if (i0 >= 0) {
      const xa = X(i0), xb = X(i1 < 0 ? n - 1 : Math.max(i0, i1 - 1));
      ctx.strokeStyle = c.cyn; ctx.lineWidth = 1.5; ctx.setLineDash([4, 2]);
      ctx.strokeRect(xa, yTop, Math.max(2, xb - xa), yBot - yTop); ctx.setLineDash([]);
    }
  }
  /* 上の判定の色帯 */
  if (judge) {
    const colOf = { go: c.grn, caution: c.amb, nogo: c.red, none: c.dim };
    d.times.forEach((t, i) => {
      const lv = judge[i]; if (!lv) return;
      ctx.fillStyle = colOf[lv] || c.dim;
      ctx.fillRect(X(i) - bw / 2, padT - 6, bw, 6);
    });
  }
  return { X, Y };
}
function interpByFt(prof, zM, key) {
  const xs = prof.filter(l => l.z != null && l[key] != null);
  if (xs.length < 2) return null;
  if (zM <= xs[0].z) return xs[0][key];
  for (let i = 1; i < xs.length; i++) if (zM <= xs[i].z) {
    const a = xs[i - 1], b = xs[i], f = (zM - a.z) / ((b.z - a.z) || 1);
    return a[key] + f * (b[key] - a[key]);
  }
  return null;
}

/* ───────── Skew-T ───────── */
/* 標準の Skew-T log-P。ヘリ向けに地上〜10,000ft を広く見るため既定は 1050〜500hPa */
export function skewT(cv, prof, { pTop = 500, pBot = 1050, tMin = -40, tMax = 45, parcel = null, obs = null, elevM = 0, highlight = null } = {}) {
  const padL = 58, padR = 46, padT = 10, padB = 26, H = 380;
  const { ctx, w, c } = setup(cv, H);
  const x0 = padL, x1 = w - padR, yTop = padT, yBot = H - padB;
  /* ⚠ 斜め軸は「上へ行くほど右へずらす」。逆にすると暖かい側が画面の外に出る */
  const SKEW = (x1 - x0) * 0.45;
  const Yp = p => yTop + (yBot - yTop) * Math.log(p / pTop) / Math.log(pBot / pTop);
  const yFrac = p => (Yp(p) - yTop) / (yBot - yTop);
  const Xt = (t, p) => x0 + (x1 - x0) * (t - tMin) / (tMax - tMin) + SKEW * (1 - yFrac(p));

  /* ⚠ 枠の外にはみ出す線を隠すため、罫線と曲線はクリップの中で描く(目盛りの文字は外で描く) */
  ctx.save(); ctx.beginPath(); ctx.rect(x0, yTop, x1 - x0, yBot - yTop); ctx.clip();
  /* 等圧線 */
  ctx.strokeStyle = c.line; ctx.lineWidth = 1;
  for (const p of [1000, 950, 900, 850, 800, 700, 600, 500]) {
    if (p > pBot || p < pTop) continue;
    ctx.beginPath(); ctx.moveTo(x0, Yp(p)); ctx.lineTo(x1, Yp(p)); ctx.stroke();
  }
  /* 斜めの等温線 */
  for (let t = -60; t <= 50; t += 10) {
    ctx.strokeStyle = t === 0 ? c.cyn : c.line; ctx.lineWidth = t === 0 ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(Xt(t, pBot), Yp(pBot)); ctx.lineTo(Xt(t, pTop), Yp(pTop)); ctx.stroke();
  }
  /* 乾燥断熱線・湿潤断熱線・等飽和混合比線 */
  const curve = (fn, style, dash) => {
    ctx.strokeStyle = style; ctx.lineWidth = 1; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let first = true;
    for (let p = pBot; p >= pTop; p -= 10) { const t = fn(p); if (t == null) continue; const px = Xt(t, p), py = Yp(p); first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false }
    ctx.stroke(); ctx.setLineDash([]);
  };
  for (let t0 = -40; t0 <= 60; t0 += 10) curve(p => dryAdiabatT(p, 1000, t0), 'rgba(255,176,46,.35)');
  for (let t0 = -10; t0 <= 35; t0 += 5) { const the = thetaE(1000, t0, t0); curve(p => moistAdiabatT(p, the), 'rgba(56,224,123,.35)', [4, 3]) }
  for (const r of [1, 2, 4, 7, 10, 16, 24]) curve(p => { const e = p * (r / 1000) / (0.622 + r / 1000); return e <= 0 ? null : 243.5 * Math.log(e / 6.112) / (17.67 - Math.log(e / 6.112)) }, 'rgba(61,245,255,.25)', [1, 4]);

  /* 学習モードの強調表示：見るべき場所を塗って名前を出す */
  if (highlight === 'inversion') {
    for (const iv of inversions(prof)) {
      const y1 = Yp(Math.min(pBot, iv.fromP)), y2 = Yp(Math.max(pTop, iv.toP));
      ctx.fillStyle = 'rgba(255,176,46,.22)'; ctx.fillRect(x0, y2, x1 - x0, y1 - y2);
      ctx.fillStyle = CSS('--amb'); ctx.textAlign = 'left';
      ctx.fillText(`逆転層 +${iv.dT}℃`, x0 + 6, (y1 + y2) / 2 + 4);
    }
  }
  if (highlight === 'moist') {
    for (const m of moistLayers(prof, { maxSpread: 3 })) {
      const y1 = Yp(Math.min(pBot, m.fromP)), y2 = Yp(Math.max(pTop, m.toP));
      ctx.fillStyle = 'rgba(61,245,255,.18)'; ctx.fillRect(x0, y2, x1 - x0, Math.max(3, y1 - y2));
      ctx.fillStyle = CSS('--cyn'); ctx.textAlign = 'left';
      ctx.fillText('湿潤層（気温と露点が近い＝雲）', x0 + 6, Math.min(y1, y2 + 14));
    }
  }
  if (highlight === 'parcel' && parcel) {
    /* 気塊が環境より暖かい範囲(浮力＝CAPEの面積) */
    ctx.fillStyle = 'rgba(255,61,245,.20)'; ctx.beginPath();
    const up = [], down = [];
    for (let p = parcel.p; p >= pTop; p -= 5) {
      const tp = parcelT(p, parcel), te = interp(prof, p, 't');
      if (te == null || tp <= te) continue;
      up.push([Xt(tp, p), Yp(p)]); down.unshift([Xt(te, p), Yp(p)]);
    }
    if (up.length > 1) {
      ctx.moveTo(...up[0]); for (const q of up.slice(1)) ctx.lineTo(...q);
      for (const q of down) ctx.lineTo(...q);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = CSS('--mag'); ctx.textAlign = 'left';
      ctx.fillText('気塊が環境より暖かい＝上がり続ける', x0 + 6, up[Math.floor(up.length / 2)][1]);
    }
  }

  /* 気温・露点 */
  const draw = (key, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let first = true;
    for (const l of prof) { if (l[key] == null || l.p > pBot || l.p < pTop) continue; const px = Xt(l[key], l.p), py = Yp(l.p); first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false }
    ctx.stroke();
  };
  if (obs?.length) { /* 実測(高層観測)は細い線で重ねる */
    ctx.save(); ctx.globalAlpha = .6;
    for (const [key, col] of [['t', c.txt], ['td', c.cyn]]) {
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.beginPath();
      let first = true;
      for (const l of obs) { if (l[key] == null) continue; const px = Xt(l[key], l.p), py = Yp(l.p); first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  }
  draw('t', c.amb, 2.2); draw('td', c.cyn, 2.2);

  /* 気塊の経路(LCLまで乾燥断熱、その上は湿潤断熱) */
  if (parcel) {
    ctx.strokeStyle = c.mag; ctx.lineWidth = 1.6; ctx.setLineDash([5, 3]); ctx.beginPath();
    let first = true;
    for (let p = parcel.p; p >= pTop; p -= 5) { const t = parcelT(p, parcel); const px = Xt(t, p), py = Yp(p); first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false }
    ctx.stroke(); ctx.setLineDash([]);
    const l = lcl(parcel.p, parcel.t, parcel.td);
    if (l.p <= pBot && l.p >= pTop) {
      ctx.fillStyle = c.mag; ctx.beginPath(); ctx.arc(Xt(l.tC, l.p), Yp(l.p), 4, 0, 7); ctx.fill();
      ctx.textAlign = 'left'; ctx.fillText('LCL', Xt(l.tC, l.p) + 6, Yp(l.p) - 4);
    }
  }
  ctx.restore();   /* クリップ終わり */

  /* 目盛りの文字(枠の外) */
  ctx.fillStyle = c.dim; ctx.textAlign = 'right';
  for (const p of [1000, 950, 900, 850, 800, 700, 600, 500]) {
    if (p > pBot || p < pTop) continue;
    const z = interp(prof, p, 'z');
    ctx.fillText(String(p), x0 - 30, Yp(p) + 4);
    /* 高度は「19.4k ft」のように短く(気圧の数字と重ならないように) */
    if (z != null) { ctx.font = '10px ui-monospace,monospace'; ctx.fillText(`${(Math.round((z - elevM) * M_FT / 100) / 10).toFixed(1)}k`, x0 - 3, Yp(p) + 4); ctx.font = '11px ui-monospace,monospace' }
  }
  ctx.textAlign = 'center';
  for (let t = -60; t <= 50; t += 10) {
    const xx = Xt(t, pBot);
    if (xx > x0 + 6 && xx < x1 - 6) { ctx.fillStyle = t === 0 ? c.cyn : c.dim; ctx.fillText(String(t), xx, yBot + 12) }
  }

  /* 右端に各層の矢羽 */
  for (const l of prof) {
    if (l.p > pBot || l.p < pTop || l.dir == null) continue;
    windBarb(ctx, x1 + 24, Yp(l.p), l.dir, l.spd, l.spd >= 30 ? c.red : l.spd >= 20 ? c.amb : c.txt, 12);
  }
  ctx.strokeStyle = c.line; ctx.strokeRect(x0, yTop, x1 - x0, yBot - yTop);
  /* 単位は下に置く(上に置くと一番上の目盛りと重なる) */
  ctx.fillStyle = c.dim; ctx.textAlign = 'right'; ctx.fillText('hPa', x0 - 30, yBot + 12); ctx.fillText('千ft', x0 - 3, yBot + 12);
  ctx.textAlign = 'left'; ctx.fillText('℃', x0 + 2, yBot + 12);
  return { Xt, Yp };
}
