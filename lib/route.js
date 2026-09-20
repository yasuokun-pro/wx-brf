/* 経路の分割・通過時刻・区間判定(純粋関数・DOMを使わない)
   ─────────────────────────────────────────
   - 経路はナビPWAと同じ形（[{lat,lng,name}] の並び）で受け取る
   - 変針点で区切ったうえで、長い区間はさらに等間隔に割る
   - 判定は「数値予報の値＋設定したしきい値」で決める。AIは使わない
   - 数値予報は谷霧などの局地現象を表現しきれない。山岳区間は常に注意を出す
   テスト: tests/route.test.mjs */
import { worst } from './judge.js';

export const R_NM = 3440.065, KM_NM = 0.539957, M_FT = 3.280839895;
const D = Math.PI / 180;

export function distNM(a, b) {
  const dLat = (b.lat - a.lat) * D, dLng = (b.lng - a.lng) * D;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLng / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(h));
}
/* 大圏の初期方位(真方位) */
export function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * D) * Math.cos(b.lat * D);
  const x = Math.cos(a.lat * D) * Math.sin(b.lat * D) - Math.sin(a.lat * D) * Math.cos(b.lat * D) * Math.cos((b.lng - a.lng) * D);
  return (Math.atan2(y, x) / D + 360) % 360;
}
/* 2点の間を f(0〜1)で内分した点。短い区間なので直線で十分 */
export function along(a, b, f) {
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

/* 経路を区間に分ける。変針点で必ず切り、1区間が maxNM を超えるときは等分する */
export function splitRoute(wps, { maxNM = 10 } = {}) {
  const pts = (wps || []).filter(w => Number.isFinite(w?.lat) && Number.isFinite(w?.lng));
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = distNM(a, b);
    if (d < 1e-6) continue;
    const n = Math.max(1, Math.ceil(d / maxNM));
    for (let k = 0; k < n; k++) {
      const from = along(a, b, k / n), to = along(a, b, (k + 1) / n);
      segs.push({
        i: segs.length, from, to, mid: along(a, b, (k + 0.5) / n),
        nm: Math.round(d / n * 10) / 10, brg: Math.round(bearing(a, b)),
        legFrom: a.name || `P${i}`, legTo: b.name || `P${i + 1}`, leg: i - 1,
      });
    }
  }
  return segs;
}

/* 通過時刻を出す。gsKt は対地速度。区間ごとに上書きしたい時は seg.gsKt を入れておく */
export function passTimes(segs, { start, gsKt = 100 } = {}) {
  let t = start instanceof Date ? start.getTime() : new Date(start).getTime();
  return segs.map(s => {
    const gs = s.gsKt || gsKt;
    const dt = (s.nm / Math.max(1, gs)) * 3600e3;
    const out = { ...s, tFrom: new Date(t), tMid: new Date(t + dt / 2), tTo: new Date(t + dt), minutes: Math.round(dt / 60000 * 10) / 10 };
    t += dt;
    return out;
  });
}
export const routeNM = segs => Math.round(segs.reduce((a, s) => a + s.nm, 0) * 10) / 10;
export const routeMinutes = (segs, gsKt) => Math.round(routeNM(segs) / Math.max(1, gsKt) * 60);

/* 1区間の判定。w は数値予報からその区間・その時刻に取り出した値
   w = {baseFt(推定雲底 AGL), elevM(地形標高), windKt, windDir, precipMmh, freezingFt(MSL), rhAtAlt, thunder}
   m は設定 {altFt(飛行高度 MSL), clearanceFt(雲底との間隔), terrainClearFt(地形との間隔),
            precipMmh, windKt, icingRh} */
export function judgeSegment(w, m = {}) {
  const items = [];
  const num = v => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
  const alt = num(m.altFt), clr = num(m.clearanceFt) ?? 500, tclr = num(m.terrainClearFt) ?? 500;
  const pTh = num(m.precipMmh) ?? 1, wTh = num(m.windKt) ?? 25, icRh = num(m.icingRh) ?? 80;
  const elevFt = w.elevM == null ? null : Math.round(w.elevM * M_FT);

  /* 雲底(MSL)と飛行高度の間隔。雲底は地表からの高さなので地形標高を足す */
  if (w.baseFt == null || alt == null) {
    items.push({ key: 'cloud', label: '雲底', value: w.baseFt == null ? '—' : `${w.baseFt}ft AGL`, level: 'none', why: alt == null ? '飛行高度が未設定' : '推定できず' });
  } else {
    const baseMsl = w.baseFt + (elevFt || 0);
    const gap = baseMsl - alt;
    items.push({
      key: 'cloud', label: '雲底(推定)', value: `${baseMsl}ft MSL（飛行高度との差 ${gap >= 0 ? '+' : ''}${gap}ft）`,
      level: gap < 0 ? 'nogo' : gap < clr ? 'caution' : 'go',
      why: gap < 0 ? '飛行高度が雲の中' : gap < clr ? `間隔 ${clr}ft 未満` : '',
    });
  }
  /* 地形との間隔 */
  if (elevFt != null && alt != null) {
    const gap = alt - elevFt;
    items.push({
      key: 'terrain', label: '地形', value: `標高 ${elevFt}ft（差 ${gap}ft）`,
      level: gap < 0 ? 'nogo' : gap < tclr ? 'caution' : 'go',
      why: gap < 0 ? '飛行高度が地形より低い' : gap < tclr ? `間隔 ${tclr}ft 未満` : '',
    });
  }
  /* 降水 */
  if (w.precipMmh != null) {
    items.push({
      key: 'precip', label: '降水', value: `${w.precipMmh}mm/h`,
      level: w.precipMmh >= pTh * 3 ? 'nogo' : w.precipMmh >= pTh ? 'caution' : 'go',
      why: w.precipMmh >= pTh ? `${pTh}mm/h 以上` : '',
    });
  }
  /* 雷 */
  if (w.thunder) items.push({ key: 'thunder', label: '雷', value: '活動あり', level: 'nogo', why: '雷ナウキャスト/不安定' });
  /* 低高度の風 */
  if (w.windKt != null) {
    items.push({
      key: 'wind', label: '風', value: `${w.windDir == null ? '' : String(Math.round(w.windDir)).padStart(3, '0') + '° '}${Math.round(w.windKt)}kt`,
      level: w.windKt >= wTh * 1.4 ? 'nogo' : w.windKt >= wTh ? 'caution' : 'go',
      why: w.windKt >= wTh ? `${wTh}kt 以上` : '',
    });
  }
  /* 着氷：0℃高度が飛行高度の近くで、湿っているとき */
  if (w.freezingFt != null && alt != null) {
    const near = Math.abs(w.freezingFt - alt) <= 2000 || w.freezingFt < alt;
    const wet = w.rhAtAlt == null ? null : w.rhAtAlt >= icRh;
    items.push({
      key: 'icing', label: '着氷', value: `0℃高度 ${w.freezingFt}ft${w.rhAtAlt == null ? '' : ` / 湿度 ${Math.round(w.rhAtAlt)}%`}`,
      level: near && wet ? 'caution' : 'go',
      why: near && wet ? '0℃高度が飛行高度付近で湿っている' : '',
    });
  }
  /* 山岳区間：数値予報では谷霧・局地的な下降流を表現しきれない */
  const mountain = elevFt != null && elevFt >= (num(m.mountainFt) ?? 3000);
  if (mountain) items.push({ key: 'local', label: '山岳', value: `標高 ${elevFt}ft`, level: 'caution', why: '局地的な悪化（谷霧・乱気流）に注意' });

  return { level: worst(items.map(i => i.level)), items, mountain };
}

/* 全区間の判定。samples[i] が segs[i] に対応 */
export function judgeRoute(segs, samples, m = {}) {
  const rows = segs.map((s, i) => ({ ...s, ...judgeSegment(samples?.[i] || {}, m), wx: samples?.[i] || {} }));
  return { level: rows.length ? worst(rows.map(r => r.level)) : 'none', rows };
}

/* ナビPWAの共有コード（HNAV1.base64）や JSON から経路を取り込む */
export function parseRouteCode(text, { atob: b64 = (typeof atob === 'function' ? atob : null) } = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('空です');
  let obj = null;
  if (/^\s*[[{]/.test(t)) obj = JSON.parse(t);
  else {
    const m = t.match(/HNAVL?1\.([A-Za-z0-9+/=]+)/);
    if (!m) throw new Error('共有コード（HNAV1.…）かJSONを貼ってください');
    if (!b64) throw new Error('base64を読めません');
    obj = JSON.parse(decodeURIComponent(escape(b64(m[1]))));
  }
  const one = o => (Array.isArray(o?.wp) ? o.wp : null);
  const wp = one(obj) || one(obj?.[0]) || (Array.isArray(obj?.routes) ? one(obj.routes[0]) : null);
  if (!wp) throw new Error('経路が入っていません');
  return wp.map(w => (Array.isArray(w)
    ? { lat: +w[0], lng: +w[1], name: w[2] || '' }
    : { lat: +w.lat, lng: +(w.lng ?? w.lon), name: w.name || '' }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}
