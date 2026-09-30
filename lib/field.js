/* 全国の気圧場の読み取り（純粋関数・DOMを使わない）
   ─────────────────────────────────────────
   天気図（速報天気図）は画像なので、そこから高気圧・低気圧の記号を読むことはできない。
   代わりに、天気図のもとになる海面気圧を全国の格子で取り、同じことを数値から読み取る。
     ① 高気圧・低気圧の中心（位置・中心気圧・呼び名）と、その動き
     ② 本邦がどう覆われているか（全域が高気圧／西日本は高気圧で東日本は気圧の谷、など）
     ③ 晴天ベースか曇りベースか（雲量と降水から）
   - 気象庁の概況文が取れているときは、そちらが正。ここは数値での裏取りと、時間を追った変化に使う
   - 前線は気圧だけでは決められないので、この module では扱わない（天気図と lib/synoptic.js で見る）
   テスト: tests/field.test.mjs */

/* 中心の位置の呼び名（気象庁の天気図で使われる海域・地方名に寄せた代表点） */
export const PLACES = [
  ['オホーツク海', 46, 144], ['千島の東', 45, 150], ['北海道の北', 46.5, 141], ['北海道', 43.3, 142.5],
  ['北海道の西', 43, 139], ['沿海州', 44, 133.5], ['日本海北部', 41, 137], ['日本海中部', 38, 135],
  ['日本海西部', 36, 132], ['三陸沖', 39.5, 144], ['日本の東', 37, 147.5], ['日本のはるか東', 35, 153],
  ['東北', 39.5, 141], ['関東', 36, 139.8], ['関東の東', 35.5, 142.5], ['北陸', 36.8, 137.5],
  ['東海', 34.8, 137.5], ['近畿', 34.7, 135.7], ['中国', 34.7, 132.5], ['四国', 33.6, 133.5],
  ['九州', 32.3, 130.8], ['九州の南', 30, 131], ['本州の南', 31, 138], ['日本の南', 27, 137],
  ['東シナ海', 29, 126], ['黄海', 34.5, 123.5], ['朝鮮半島', 37, 127.5], ['奄美', 28.3, 129.5],
  ['沖縄', 26.4, 127.9], ['大東島', 25.8, 131.2], ['太平洋南部', 23, 142],
];

const R_KM = 111.32;
const at = (p, k, i) => (p?.[k]?.[i] == null || !Number.isFinite(+p[k][i]) ? null : +p[k][i]);
const round = (x, n = 0) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
/* 緯度経度の距離（km。平面近似で十分） */
export function distKm(a, b) {
  const dy = (a.lat - b.lat) * R_KM;
  const dx = (a.lon - b.lon) * R_KM * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}
/* 一番近い代表点の名前 */
export function placeName(lat, lon) {
  let best = null;
  for (const [name, la, lo] of PLACES) {
    const d = distKm({ lat, lon }, { lat: la, lon: lo });
    if (!best || d < best.d) best = { name, d };
  }
  return best.name;
}
const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
export function dirName(fromPt, toPt) {
  const dy = toPt.lat - fromPt.lat;
  const dx = (toPt.lon - fromPt.lon) * Math.cos((fromPt.lat * Math.PI) / 180);
  const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return DIR8[Math.round(deg / 45) % 8];
}

/* 格子だけを取り出して、緯度経度の並びに直す */
function gridOf(field) {
  const pts = (field.points || []).filter(p => p.kind === 'grid');
  const lats = [...new Set(pts.map(p => p.lat))].sort((a, b) => a - b);
  const lons = [...new Set(pts.map(p => p.lon))].sort((a, b) => a - b);
  const map = new Map(pts.map(p => [`${p.lat},${p.lon}`, p]));
  return { lats, lons, get: (a, b) => map.get(`${lats[a]},${lons[b]}`) || null };
}

/* 格子の間の中心を出す（放物線あてはめ）。格子は2.5度刻みなので、これをしないと
   中心が格子点に貼り付いたままになり、動きが出ない。ずれは半目盛りまでに抑える */
function refine(vm, v0, vp, step) {
  const den = vm - 2 * v0 + vp;
  if (!Number.isFinite(den) || den === 0) return 0;
  const d = (vm - vp) / (2 * den);
  return Math.max(-0.5, Math.min(0.5, d)) * step;
}

/* ① 高気圧・低気圧の中心：周りの8点より高い（低い）ところ。
   minDelta 未満の出っ張りは拾わない（細かい凹凸で中心だらけにしない） */
export function centersAt(field, i, { minDelta = 0.5 } = {}) {
  const g = gridOf(field);
  const out = [];
  for (let a = 0; a < g.lats.length; a++) for (let b = 0; b < g.lons.length; b++) {
    const p = g.get(a, b), v = at(p, 'mslp', i);
    if (v == null) continue;
    const ns = [];
    for (const da of [-1, 0, 1]) for (const db of [-1, 0, 1]) {
      if (!da && !db) continue;
      const q = g.get(a + da, b + db), w = at(q, 'mslp', i);
      if (w != null) ns.push(w);
    }
    if (ns.length < 5) continue;                     /* 端の点は中心にしない */
    const isH = v >= Math.max(...ns) + minDelta, isL = v <= Math.min(...ns) - minDelta;
    if (!isH && !isL) continue;
    const n = at(g.get(a - 1, b), 'mslp', i), sth = at(g.get(a + 1, b), 'mslp', i);
    const w2 = at(g.get(a, b - 1), 'mslp', i), e2 = at(g.get(a, b + 1), 'mslp', i);
    const dLat = n != null && sth != null ? refine(n, v, sth, g.lats[a] - g.lats[a - 1]) : 0;
    const dLon = w2 != null && e2 != null ? refine(w2, v, e2, g.lons[b] - g.lons[b - 1]) : 0;
    const lat = round(p.lat - dLat, 2), lon = round(p.lon - dLon, 2);
    out.push({ type: isH ? 'H' : 'L', lat, lon, gridLat: p.lat, gridLon: p.lon, hPa: round(v, 1), place: placeName(lat, lon) });
  }
  /* 低気圧は深いもの、高気圧は強いものを先に */
  return out.sort((x, y) => (x.type === y.type ? (x.type === 'L' ? x.hPa - y.hPa : y.hPa - x.hPa) : x.type === 'L' ? -1 : 1));
}

/* 張り出し：中心が領域の外にある高気圧（例「日本の東の高気圧」）は上の方法では拾えないので、
   領域の中で一番気圧が高いところを見て、それが端なら「◯◯方面から張り出す」と言えるようにする */
export function ridgeOf(field, i, { minHPa = 1014 } = {}) {
  const g = gridOf(field);
  let best = null;
  for (let a = 0; a < g.lats.length; a++) for (let b = 0; b < g.lons.length; b++) {
    const p = g.get(a, b), v = at(p, 'mslp', i);
    if (v == null) continue;
    if (!best || v > best.hPa) best = { hPa: round(v, 1), lat: p.lat, lon: p.lon, a, b };
  }
  if (!best || best.hPa < minHPa) return null;
  const edge = best.a === 0 || best.b === 0 || best.a === g.lats.length - 1 || best.b === g.lons.length - 1;
  return { place: placeName(best.lat, best.lon), hPa: best.hPa, lat: best.lat, lon: best.lon, edge };
}

/* 中心の動き：後の時刻の同じ種類の中心のうち、一番近いものを同じ中心とみなす。
   追える範囲は「その時間で進みうる距離」までにする（既定 70km/h 相当） */
export function moveOf(field, i, j, c, { maxKmh = 70, slowKmh = 10 } = {}) {
  if (j == null || j === i || !field.times?.[j]) return null;
  const hours = Math.abs(field.times[j] - field.times[i]) / 3600e3;
  if (!hours) return null;
  const maxKm = maxKmh * hours;
  const later = centersAt(field, j).filter(x => x.type === c.type);
  let best = null;
  for (const x of later) {
    const d = distKm(c, x);
    if (d <= maxKm && (!best || d < best.d)) best = { d, x };
  }
  if (!best) return null;
  const kmh = Math.round(best.d / hours / 5) * 5;    /* 5km/h 刻み */
  const slow = kmh < slowKmh;
  return {
    to: best.x, dir: slow ? null : dirName(c, best.x), kmh, slow,
    dHPa: round(best.x.hPa - c.hPa, 1), hours,
    text: slow ? 'ほぼ停滞' : `${dirName(c, best.x)}へ${kmh}km/h`,
  };
}

/* ② 本邦の覆われ方。地方ごとに「高気圧に覆われる／気圧の谷・低気圧の影響／どちらでもない」を決める */
const AREAS = ['北日本', '東日本', '西日本', '沖縄'];
export function coverAt(field, i, { nearKm = 600 } = {}) {
  const regions = (field.points || []).filter(p => p.kind === 'region' && p.area);
  if (!regions.length) return null;
  const cs = centersAt(field, i);
  const byArea = {};
  for (const area of AREAS) {
    const rs = regions.filter(r => r.area === area);
    if (!rs.length) continue;
    const ps = rs.map(r => at(r, 'mslp', i)).filter(v => v != null);
    if (!ps.length) continue;
    const mean = avg(ps);
    const nearL = cs.some(c => c.type === 'L' && rs.some(r => distKm(c, r) <= nearKm));
    const nearH = cs.some(c => c.type === 'H' && rs.some(r => distKm(c, r) <= nearKm));
    let key = 'flat';
    if (nearL || mean <= 1006) key = 'low';
    else if (nearH || mean >= 1014) key = 'high';
    byArea[area] = { key, meanHPa: round(mean, 1) };
  }
  const keys = Object.keys(byArea);
  if (!keys.length) return null;
  const vals = keys.map(k => byArea[k].key);
  const same = vals.every(v => v === vals[0]);
  const word = { high: '高気圧に覆われる', low: '低気圧・気圧の谷の影響を受ける', flat: '気圧の傾きが小さい' };
  let label;
  if (same) label = `本邦のほぼ全域が${word[vals[0]]}`;
  else {
    const groups = {};
    for (const k of keys) (groups[byArea[k].key] ||= []).push(k);
    label = Object.entries(groups).map(([v, as]) => `${as.join('・')}は${word[v]}`).join('、');
  }
  return { byArea, label, whole: same ? vals[0] : null };
}

/* ③ 晴天ベースかどうか（本邦の地点の雲量と降水から）。
   i は時刻の添字、または添字の配列（時間帯ぜんぶをならす）。
   全国がおおむね晴れでも飛ぶ地方だけ曇り、ということがあるので地方ごとにも出す */
export function skyAt(field, i) {
  const regions = (field.points || []).filter(p => p.kind === 'region');
  const idx = Array.isArray(i) ? i : [i];
  if (!regions.length || !idx.length) return null;
  const tone = (rs) => {
    const cloud = [], rain = [];
    for (const r of rs) for (const k of idx) {
      const c = at(r, 'cloud', k); if (c != null) cloud.push(c);
      rain.push(at(r, 'precip', k) ?? 0);
    }
    if (!cloud.length) return null;
    const mean = avg(cloud), wet = rain.filter(v => v >= 0.5).length, n = rain.length;
    const key = wet >= n / 4 ? 'rain' : (mean < 40 && !wet) ? 'fine' : mean < 70 ? 'partly' : 'cloudy';
    return { key, cloudPct: Math.round(mean), wetRatio: round(wet / n, 2), n };
  };
  const all = tone(regions);
  if (!all) return null;
  const byArea = {};
  for (const area of AREAS) {
    const rs = regions.filter(r => r.area === area);
    const t = rs.length ? tone(rs) : null;
    if (t) byArea[area] = t;
  }
  const label = SKY_JA[all.key];
  return {
    ...all, label, byArea,
    basis: [`本邦${regions.length}地点の平均雲量 ${all.cloudPct}%`,
      `降水のある地点・時刻 ${Math.round(all.wetRatio * 100)}%`,
      ...Object.entries(byArea).map(([a, v]) => `${a}の平均雲量 ${v.cloudPct}%`)],
  };
}
const SKY_JA = { fine: '晴天ベース', partly: '晴れ間もあるが雲も多い天気', cloudy: '曇りベース', rain: '雨や雲の多い天気' };

const jstH = t => `${String((new Date(t).getUTCHours() + 9) % 24).padStart(2, '0')}時`;
const idxIn = (times, win) => (times || []).map((t, i) => [t, i])
  .filter(([t]) => !win || (t >= win.from && t <= win.to)).map(([, i]) => i);

/* まとめ：全国の気圧配置を1〜2文にする（台本の頭・AIの土台）
   homeArea：飛ぶ地方（北日本／東日本／西日本／沖縄）。全国と違うときは、そこだけ言い足す
   aheadH：中心の動きを見る先の時間（既定12時間。飛行の時間帯が短くても動きが出るように） */
export function nationwide(field, win, { maxCenters = 2, homeArea = null, aheadH = 12 } = {}) {
  const ix = idxIn(field?.times, win);
  if (!field?.points?.length || !ix.length) return null;
  const i = ix[0], last = ix[ix.length - 1];
  /* 動きを見る時刻：時間帯の終わり、または i から aheadH 時間先（取れる範囲で遠い方） */
  let ahead = last;
  for (let k = i + 1; k < field.times.length; k++) {
    if ((field.times[k] - field.times[i]) / 3600e3 <= aheadH) ahead = k; else break;
  }
  /* 天気の傾向は「時間帯の前半」と「先の時刻」を比べて、変わるかどうかを見る */
  const firstHalf = ix.slice(0, Math.max(1, Math.ceil(ix.length / 2)));
  const cover = coverAt(field, i), sky = skyAt(field, firstHalf), skyLater = skyAt(field, [ahead]);
  if (!cover) return null;
  /* 本邦に近い中心から順に、2つまで文にする */
  const regions = field.points.filter(p => p.kind === 'region');
  const near = c => Math.min(...regions.map(r => distKm(c, r)));
  const cs = centersAt(field, i).filter(c => near(c) <= 1500).sort((a, b) => near(a) - near(b)).slice(0, maxCenters)
    .map(c => ({ ...c, move: moveOf(field, i, ahead, c) }));
  const cText = cs.map(c => {
    const kind = c.type === 'H' ? '高気圧' : '低気圧';
    /* 中心気圧が下がる＝発達、上がる＝衰える。3hPa以上のときだけ言う */
    const dev = c.move && Math.abs(c.move.dHPa) >= 3 ? `（${c.move.hours}時間で${Math.abs(c.move.dHPa)}hPa${c.move.dHPa < 0 ? '下がり発達' : '上がり衰える'}）` : '';
    return `${c.place}に${kind}（中心${c.hPa}hPa）${c.move ? `があり、${c.move.text}で進む見込み${dev}` : 'があります'}`;
  });
  /* 高気圧の中心が見つからないのに本邦が高圧なら、外から張り出しているとして言う */
  const ridge = cs.some(c => c.type === 'H') ? null : ridgeOf(field, i);
  const covHigh = Object.values(cover.byArea).some(v => v.key === 'high');
  if (ridge && covHigh) cText.push(`${ridge.place}${ridge.edge ? '方面' : ''}から高気圧（${ridge.hPa}hPa）が張り出しています`);
  /* 飛ぶ地方が全国と違うとき（全国は晴れでも関東だけ曇り、など） */
  const home = homeArea && sky?.byArea?.[homeArea] ? sky.byArea[homeArea] : null;
  const homeDiff = home && home.key !== sky.key ? `ただし${homeArea}は${SKY_JA[home.key]}（平均雲量${home.cloudPct}%）の見込みです。` : '';
  const changed = sky && skyLater && sky.key !== skyLater.key;
  const text = [
    `${cover.label}見込みです。`,
    cText.length ? `${cText.join('。')}。` : '',
    sky ? `天気は全国では${sky.label}で${changed ? `、${jstH(field.times[ahead])}ごろには${skyLater.label}に変わる` : '推移する'}見込みです。` : '',
    homeDiff,
  ].filter(Boolean).join('');
  return {
    cover, sky, skyLater: changed ? skyLater : null, homeArea, homeSky: home, centers: cs,
    ridge: ridge && covHigh ? ridge : null, text,
    basis: [
      ...Object.entries(cover.byArea).map(([a, v]) => `${a}の平均気圧 ${v.meanHPa}hPa`),
      ...cs.map(c => `${c.place} ${c.type === 'H' ? '高' : '低'} ${c.hPa}hPa`),
      ...(ridge && covHigh ? [`領域内の最高気圧 ${ridge.place} ${ridge.hPa}hPa${ridge.edge ? '（中心は図の外）' : ''}`] : []),
      ...(sky?.basis || []),
    ],
    note: '天気図の画像は読めないので、天気図のもとになる海面気圧・雲量の数値から当てはめたもの。前線は含まない',
  };
}
