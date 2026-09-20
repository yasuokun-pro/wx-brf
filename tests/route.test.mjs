/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { distNM, bearing, splitRoute, passTimes, routeNM, judgeSegment, judgeRoute, parseRouteCode } from '../lib/route.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} ≒ ${b} (±${tol})`);
const RJTT = { lat: 35.5497, lng: 139.787, name: 'RJTT' };
const RJTC = { lat: 35.7121, lng: 139.4032, name: 'RJTC' };
const RJAA = { lat: 35.7686, lng: 140.3887, name: 'RJAA' };

test('距離と方位：羽田〜成田は約31NM・東北東', () => {
  near(distNM(RJTT, RJAA), 31, 1.5, '距離');
  near(bearing(RJTT, RJAA), 66, 3, '方位');
  /* 緯度1度は60NM */
  near(distNM({ lat: 35, lng: 139 }, { lat: 36, lng: 139 }), 60, 0.3);
  /* 真北・真東 */
  near(bearing({ lat: 35, lng: 139 }, { lat: 36, lng: 139 }), 0, 0.1);
  near(bearing({ lat: 35, lng: 139 }, { lat: 35, lng: 140 }), 90, 0.5);
});

test('区間分け：変針点で切り、長い区間は等分する', () => {
  const segs = splitRoute([RJTT, RJTC, RJAA], { maxNM: 10 });
  /* 羽田→立川 約20NM → 2区間、立川→成田 約49NM → 5区間 */
  assert.ok(segs.length >= 6 && segs.length <= 9, `区間数 ${segs.length}`);
  assert.ok(segs.every(s => s.nm <= 10.01), '1区間は10NM以下');
  near(routeNM(segs), distNM(RJTT, RJTC) + distNM(RJTC, RJAA), 0.5, '合計距離');
  /* 変針点をまたがない（leg が変わるところで区切られている） */
  assert.equal(segs[0].legFrom, 'RJTT');
  assert.equal(segs[segs.length - 1].legTo, 'RJAA');
  assert.deepEqual([...new Set(segs.map(s => s.leg))], [0, 1]);
  /* 同じ点が続く経路は区間を作らない */
  assert.equal(splitRoute([RJTT, { ...RJTT }]).length, 0);
  assert.equal(splitRoute([RJTT]).length, 0);
});

test('通過時刻：対地速度から出す', () => {
  const start = new Date(Date.UTC(2026, 8, 20, 0, 0));
  const segs = passTimes(splitRoute([RJTT, RJAA], { maxNM: 10 }), { start, gsKt: 120 });
  assert.equal(segs[0].tFrom.getTime(), start.getTime());
  /* 120kt で 31NM ≒ 15.5分 */
  near((segs[segs.length - 1].tTo - start) / 60000, 31 / 120 * 60, 1.5);
  /* 区間の時刻は前の区間の終わりから続く */
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].tFrom.getTime(), segs[i - 1].tTo.getTime());
  assert.ok(segs[0].tMid > segs[0].tFrom && segs[0].tMid < segs[0].tTo);
});

const M = { altFt: 2000, clearanceFt: 500, terrainClearFt: 500, precipMmh: 1, windKt: 25, icingRh: 80, mountainFt: 3000 };
const item = (r, k) => r.items.find(i => i.key === k);

test('区間判定：雲底と飛行高度の間隔', () => {
  /* 雲底 3000ft AGL・地形 0ft → 3000ft MSL、飛行高度2000ft との差 1000ft → GO */
  assert.equal(item(judgeSegment({ baseFt: 3000, elevM: 0 }, M), 'cloud').level, 'go');
  /* 差 400ft → 注意 */
  assert.equal(item(judgeSegment({ baseFt: 2400, elevM: 0 }, M), 'cloud').level, 'caution');
  /* 雲底が飛行高度より下 → NO-GO（雲の中） */
  assert.equal(item(judgeSegment({ baseFt: 1500, elevM: 0 }, M), 'cloud').level, 'nogo');
  /* 地形が高いと雲底(MSL)も上がる */
  assert.equal(item(judgeSegment({ baseFt: 1500, elevM: 500 }, M), 'cloud').level, 'go');
  /* 飛行高度が未設定なら灰 */
  assert.equal(item(judgeSegment({ baseFt: 1500, elevM: 0 }, {}), 'cloud').level, 'none');
});

test('区間判定：地形・降水・風・着氷・山岳', () => {
  /* 地形 1500ft、飛行高度 2000ft → 差 500ft でちょうど基準 → GO */
  assert.equal(item(judgeSegment({ elevM: 1500 / 3.280839895 }, M), 'terrain').level, 'go');
  assert.equal(item(judgeSegment({ elevM: 1600 / 3.280839895 }, M), 'terrain').level, 'caution');
  assert.equal(item(judgeSegment({ elevM: 2100 / 3.280839895 }, M), 'terrain').level, 'nogo');
  assert.equal(item(judgeSegment({ precipMmh: 0.4 }, M), 'precip').level, 'go');
  assert.equal(item(judgeSegment({ precipMmh: 1.2 }, M), 'precip').level, 'caution');
  assert.equal(item(judgeSegment({ precipMmh: 4 }, M), 'precip').level, 'nogo');
  assert.equal(item(judgeSegment({ windKt: 20 }, M), 'wind').level, 'go');
  assert.equal(item(judgeSegment({ windKt: 26, windDir: 270 }, M), 'wind').level, 'caution');
  assert.equal(item(judgeSegment({ windKt: 40 }, M), 'wind').level, 'nogo');
  assert.equal(judgeSegment({ thunder: true }, M).level, 'nogo');
  /* 着氷：0℃高度が飛行高度の近くで湿っていれば注意 */
  assert.equal(item(judgeSegment({ freezingFt: 2500, rhAtAlt: 90 }, M), 'icing').level, 'caution');
  assert.equal(item(judgeSegment({ freezingFt: 2500, rhAtAlt: 40 }, M), 'icing').level, 'go');
  assert.equal(item(judgeSegment({ freezingFt: 9000, rhAtAlt: 90 }, M), 'icing').level, 'go');
  /* 山岳区間は常に注意 */
  const mt = judgeSegment({ elevM: 1200, altFt: 9000 }, { ...M, altFt: 9000 });
  assert.equal(mt.mountain, true);
  assert.equal(item(mt, 'local').level, 'caution');
});

test('経路全体：一番悪い区間が総合になる', () => {
  const segs = splitRoute([RJTT, RJAA], { maxNM: 15 });
  const samples = segs.map((s, i) => ({ baseFt: i === 1 ? 1500 : 4000, elevM: 0, windKt: 10, precipMmh: 0 }));
  const r = judgeRoute(segs, samples, M);
  assert.equal(r.level, 'nogo');
  assert.equal(r.rows[1].level, 'nogo');
  assert.equal(r.rows[0].level, 'go');
  /* データが無ければ灰 */
  assert.equal(judgeRoute(segs, [], M).level, 'none');
  assert.equal(judgeRoute([], [], M).level, 'none');
});

test('ナビPWAの共有コードとJSONを取り込む', () => {
  const obj = { v: 1, set: { tas: 110 }, wp: [[35.5497, 139.787, 'RJTT'], [35.7121, 139.4032, '立川'], [35.7686, 140.3887]] };
  const b64 = s => Buffer.from(s, 'binary').toString('base64');
  const code = 'HNAV1.' + b64(unescape(encodeURIComponent(JSON.stringify(obj))));
  const atobFn = s => Buffer.from(s, 'base64').toString('binary');
  const wp = parseRouteCode(code, { atob: atobFn });
  assert.equal(wp.length, 3);
  assert.equal(wp[1].name, '立川');
  near(wp[0].lat, 35.5497, 1e-6);
  /* JSONをそのまま貼っても読める */
  assert.equal(parseRouteCode(JSON.stringify(obj), { atob: atobFn }).length, 3);
  /* 複数ルートの共有コード（HNAVL1.）は先頭のルートを使う */
  const multi = 'HNAVL1.' + b64(unescape(encodeURIComponent(JSON.stringify([obj, obj]))));
  assert.equal(parseRouteCode(multi, { atob: atobFn }).length, 3);
  assert.throws(() => parseRouteCode('ただの文字', { atob: atobFn }));
  assert.throws(() => parseRouteCode('', { atob: atobFn }));
});
