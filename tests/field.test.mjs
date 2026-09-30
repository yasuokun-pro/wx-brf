/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { centersAt, moveOf, coverAt, skyAt, nationwide, ridgeOf, placeName, dirName, distKm } from '../lib/field.js';

const T0 = Date.UTC(2026, 0, 15, 0);
const times = n => Array.from({ length: n }, (_, i) => new Date(T0 + i * 3 * 3600e3));
const LATS = [30, 32.5, 35, 37.5, 40, 42.5], LONS = [130, 132.5, 135, 137.5, 140, 142.5, 145];
/* 中心（lat,lon）からの距離で気圧が決まる、単純な高気圧／低気圧の場を作る */
function fieldOf({ n = 3, hi = null, lo = null, base = 1012, regions = [], cloud = 20, precip = 0 } = {}) {
  const pts = [];
  const val = (lat, lon, i) => {
    let v = base;
    if (hi) { const c = hi(i); v += c.amp * Math.exp(-(((lat - c.lat) ** 2 + (lon - c.lon) ** 2) / 20)) }
    if (lo) { const c = lo(i); v -= c.amp * Math.exp(-(((lat - c.lat) ** 2 + (lon - c.lon) ** 2) / 20)) }
    return Math.round(v * 10) / 10;
  };
  for (const lat of LATS) for (const lon of LONS) {
    pts.push({ kind: 'grid', lat, lon, mslp: Array.from({ length: n }, (_, i) => val(lat, lon, i)) });
  }
  for (const r of regions) {
    pts.push({
      kind: 'region', name: r.name, area: r.area, lat: r.lat, lon: r.lon,
      mslp: Array.from({ length: n }, (_, i) => val(r.lat, r.lon, i)),
      cloud: Array.from({ length: n }, (_, i) => (typeof cloud === 'function' ? cloud(r, i) : cloud)),
      precip: Array.from({ length: n }, (_, i) => (typeof precip === 'function' ? precip(r, i) : precip)),
    });
  }
  return { times: times(n), points: pts };
}
const REGIONS = [
  { name: '札幌', area: '北日本', lat: 43.06, lon: 141.35 }, { name: '仙台', area: '北日本', lat: 38.27, lon: 140.87 },
  { name: '東京', area: '東日本', lat: 35.69, lon: 139.69 }, { name: '新潟', area: '東日本', lat: 37.90, lon: 139.02 },
  { name: '大阪', area: '西日本', lat: 34.69, lon: 135.52 }, { name: '福岡', area: '西日本', lat: 33.59, lon: 130.40 },
];

test('位置の呼び名と方位・距離', () => {
  assert.equal(placeName(39.5, 144), '三陸沖');
  assert.equal(placeName(31, 138), '本州の南');
  assert.equal(placeName(26.4, 127.9), '沖縄');
  assert.equal(dirName({ lat: 33, lon: 138 }, { lat: 35, lon: 141 }), '北東');
  assert.equal(dirName({ lat: 40, lon: 140 }, { lat: 40, lon: 135 }), '西');
  assert.ok(Math.abs(distKm({ lat: 35, lon: 139 }, { lat: 36, lon: 139 }) - 111) < 2);
});

test('高気圧・低気圧の中心を、周りより高い（低い）点として拾う', () => {
  const f = fieldOf({ hi: () => ({ lat: 40, lon: 145, amp: 8 }), lo: () => ({ lat: 32.5, lon: 137.5, amp: 12 }) });
  const cs = centersAt(f, 0);
  const L = cs.find(c => c.type === 'L'), H = cs.find(c => c.type === 'H');
  /* 位置は格子の間に補間する（格子点そのものは gridLat/gridLon に残す） */
  assert.equal(L.gridLat, 32.5); assert.equal(L.gridLon, 137.5);
  assert.ok(Math.abs(L.lat - 32.5) <= 1.25 && Math.abs(L.lon - 137.5) <= 1.25);
  assert.ok(L.hPa < 1005, String(L.hPa));
  assert.equal(H.gridLat, 40); assert.equal(H.gridLon, 145);
  assert.equal(H.place, '三陸沖');
  /* 端の点は中心として拾わない */
  assert.ok(cs.every(c => c.lat !== 30 && c.lon !== 130));
});

test('平らな場では中心を作らない', () => {
  assert.deepEqual(centersAt(fieldOf({}), 0), []);
});

test('中心の動き：後の時刻の同じ種類の中心と結んで、方位と速さを出す', () => {
  const f = fieldOf({ n: 3, lo: i => ({ lat: 32.5 + i, lon: 137.5 + i * 1.5, amp: 12 }) });
  const c = centersAt(f, 0).find(x => x.type === 'L');
  const mv = moveOf(f, 0, 2, c);
  assert.equal(mv.dir, '北東');
  assert.equal(mv.hours, 6);
  assert.equal(mv.slow, false);
  assert.ok(mv.kmh >= 40 && mv.kmh <= 80, String(mv.kmh));   /* 北へ2°・東へ3°を6時間＝約60km/h */
  assert.match(mv.text, /北東へ\d+km\/h/);
  /* 速さが出ない（ほぼ動かない）ときは「ほぼ停滞」 */
  const still = fieldOf({ n: 3, lo: () => ({ lat: 32.5, lon: 137.5, amp: 12 }) });
  const mv2 = moveOf(still, 0, 2, centersAt(still, 0)[0]);
  assert.equal(mv2.slow, true);
  assert.equal(mv2.text, 'ほぼ停滞');
  assert.equal(mv2.dir, null);
  /* 速すぎる（別の中心を取り違える）ものは追わない */
  const jump = fieldOf({ n: 3, lo: i => ({ lat: 32.5 + i * 2.5, lon: 137.5 + i * 2.5, amp: 12 }) });
  assert.equal(moveOf(jump, 0, 2, centersAt(jump, 0)[0]), null);
});

test('本邦の覆われ方：全域が高気圧のとき', () => {
  const f = fieldOf({ base: 1018, hi: () => ({ lat: 37.5, lon: 137.5, amp: 6 }), regions: REGIONS });
  const cov = coverAt(f, 0);
  assert.equal(cov.whole, 'high');
  assert.equal(cov.label, '本邦のほぼ全域が高気圧に覆われる');
  assert.equal(cov.byArea['東日本'].key, 'high');
});

test('本邦の覆われ方：地方で違うときは分けて言う', () => {
  const f = fieldOf({ base: 1012, hi: () => ({ lat: 33, lon: 131, amp: 8 }), lo: () => ({ lat: 40, lon: 141, amp: 10 }), regions: REGIONS });
  const cov = coverAt(f, 0);
  assert.equal(cov.whole, null);
  assert.equal(cov.byArea['北日本'].key, 'low');
  assert.equal(cov.byArea['西日本'].key, 'high');
  assert.match(cov.label, /北日本・東日本は低気圧・気圧の谷の影響を受ける/);  /* 同じ状態の地方はまとめて言う */
  assert.match(cov.label, /西日本は高気圧に覆われる/);
});

test('晴天ベースかどうかは雲量と降水から', () => {
  const dry = fieldOf({ regions: REGIONS, cloud: 15, precip: 0 });
  assert.equal(skyAt(dry, 0).key, 'fine');
  assert.equal(skyAt(dry, 0).label, '晴天ベース');
  const cloudy = fieldOf({ regions: REGIONS, cloud: 90, precip: 0 });
  assert.equal(skyAt(cloudy, 0).key, 'cloudy');
  const wet = fieldOf({ regions: REGIONS, cloud: 90, precip: (r) => (r.area === '北日本' || r.area === '東日本' ? 2 : 0) });
  assert.equal(skyAt(wet, 0).key, 'rain');
  const mid = fieldOf({ regions: REGIONS, cloud: 55, precip: 0 });
  assert.equal(skyAt(mid, 0).key, 'partly');
});

test('まとめ：高気圧に覆われて晴天ベース、と言えること', () => {
  const f = fieldOf({ n: 3, base: 1018, hi: () => ({ lat: 37.5, lon: 140, amp: 6 }), regions: REGIONS, cloud: 10 });
  const r = nationwide(f, { from: new Date(T0), to: new Date(T0 + 6 * 3600e3) });
  assert.match(r.text, /^本邦のほぼ全域が高気圧に覆われる見込みです。/);
  assert.match(r.text, /高気圧（中心\d+(\.\d)?hPa）/);
  assert.match(r.text, /天気は全国では晴天ベースで推移する見込みです。/);
  assert.ok(r.basis.some(b => /東日本の平均気圧/.test(b)));
  assert.ok(r.basis.some(b => /平均雲量/.test(b)));
});

test('まとめ：飛ぶ地方だけ天気が違うときは、そこを言い足す', () => {
  const f = fieldOf({
    n: 3, base: 1018, hi: () => ({ lat: 37.5, lon: 140, amp: 6 }), regions: REGIONS,
    cloud: r => (r.area === '東日本' ? 95 : 10),   /* 全国は晴れでも東日本だけ曇り */
  });
  const r = nationwide(f, { from: new Date(T0), to: new Date(T0 + 6 * 3600e3) }, { homeArea: '東日本' });
  assert.equal(r.sky.key, 'fine');
  assert.equal(r.homeSky.key, 'cloudy');
  assert.match(r.text, /天気は全国では晴天ベース/);
  assert.match(r.text, /ただし東日本は曇りベース（平均雲量95%）の見込みです。/);
  /* 飛ぶ地方が全国と同じなら言い足さない */
  assert.equal(/ただし/.test(nationwide(f, { from: new Date(T0), to: new Date(T0 + 6 * 3600e3) }, { homeArea: '西日本' }).text), false);
});

test('まとめ：低気圧が近づいて天気が変わるときは、動きと変化を言う', () => {
  const f = fieldOf({
    n: 3, base: 1012, lo: i => ({ lat: 31 + i * 0.8, lon: 134 + i * 1.2, amp: 14 }), regions: REGIONS,
    cloud: (r, i) => (i >= 2 ? 95 : 20), precip: (r, i) => (i >= 2 ? 2 : 0),
  });
  const r = nationwide(f, { from: new Date(T0), to: new Date(T0 + 6 * 3600e3) });
  assert.match(r.text, /低気圧（中心\d+(\.\d)?hPa）があり、(.+へ\d+km\/h|ほぼ停滞)で進む見込み/);
  assert.equal(r.skyLater.key, 'rain');
  assert.match(r.text, /に変わる見込みです。/);
  assert.ok(r.sky.basis.some(b => /東日本の平均雲量/.test(b)));
});

test('データが無ければ null', () => {
  assert.equal(nationwide(null, null), null);
  assert.equal(nationwide(fieldOf({ regions: REGIONS }), { from: new Date(T0 + 99 * 3600e3), to: new Date(T0 + 100 * 3600e3) }), null);
});

test('張り出し：高気圧の中心が領域の外にあるときは「◯◯方面から張り出す」と言う', () => {
  /* 東の端ほど気圧が高い場（中心は領域の外） */
  const pts = [];
  for (const lat of LATS) for (const lon of LONS) pts.push({ kind: 'grid', lat, lon, mslp: [1008 + (lon - 130) * 0.8] });
  for (const r of REGIONS) pts.push({ kind: 'region', name: r.name, area: r.area, lat: r.lat, lon: r.lon, mslp: [1008 + (r.lon - 130) * 0.8], cloud: [10], precip: [0] });
  const f = { times: [new Date(T0)], points: pts };
  const rg = ridgeOf(f, 0);
  assert.equal(rg.edge, true);
  assert.equal(rg.lon, 145);
  assert.ok(rg.hPa >= 1018, String(rg.hPa));
  const r = nationwide(f, { from: new Date(T0), to: new Date(T0) });
  assert.equal(centersAt(f, 0).length, 0);            /* 中心そのものは拾えない */
  assert.match(r.text, /方面から高気圧（\d+(\.\d)?hPa）が張り出しています/);
  assert.ok(r.basis.some(b => /中心は図の外/.test(b)));
});

test('張り出し：気圧が低いときは張り出しとは言わない', () => {
  const pts = [];
  for (const lat of LATS) for (const lon of LONS) pts.push({ kind: 'grid', lat, lon, mslp: [1004] });
  assert.equal(ridgeOf({ times: [new Date(T0)], points: pts }, 0), null);
});
