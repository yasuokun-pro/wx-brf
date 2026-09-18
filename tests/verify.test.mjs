/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addObs, addSnapshot, pairs, stats, correction, applyCorrection, LEAD_BUCKETS } from '../lib/verify.js';

const T = (d, h) => new Date(Date.UTC(2026, 8, d, h)).toISOString();
const NOW = new Date(Date.UTC(2026, 8, 18, 12));

test('観測の記録：同じ時刻は新しい方で置き換え、古いものは落ちる', () => {
  let log = [];
  log = addObs(log, { t: T(18, 3), baseFt: 1200, temp: 20 }, { now: NOW });
  log = addObs(log, { t: T(18, 3), baseFt: 900, temp: 21 }, { now: NOW });
  assert.equal(log.length, 1);
  assert.equal(log[0].baseFt, 900);
  /* 分がずれていても同じ「時」にまとめる */
  log = addObs(log, { t: new Date(Date.UTC(2026, 8, 18, 4, 30)).toISOString(), baseFt: 800 }, { now: NOW });
  assert.equal(log.length, 2);
  assert.equal(log[1].t, T(18, 5));   /* 4:30 は5時に丸める */
  /* 14日より古い記録は捨てる */
  log = addObs(log, { t: T(1, 0), baseFt: 500 }, { now: NOW });
  assert.equal(log.some(x => x.t === T(1, 0)), false);
});

test('予報の記録：近い時刻に取り直したら1つにまとめ、古い順に上限で切る', () => {
  let snaps = [];
  snaps = addSnapshot(snaps, { made: T(18, 0), rows: [{ t: T(18, 6), baseFt: 1000 }] }, { now: NOW });
  snaps = addSnapshot(snaps, { made: new Date(Date.UTC(2026, 8, 18, 0, 20)).toISOString(), rows: [{ t: T(18, 6), baseFt: 1100 }] }, { now: NOW });
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].rows[0].baseFt, 1100);
  snaps = addSnapshot(snaps, { made: T(18, 3), rows: [{ t: T(18, 6), baseFt: 900 }] }, { now: NOW });
  assert.equal(snaps.length, 2);
  for (let i = 0; i < 20; i++) snaps = addSnapshot(snaps, { made: T(17, i % 24), rows: [{ t: T(18, 6), baseFt: 1000 }] }, { maxKeep: 5, now: NOW });
  assert.ok(snaps.length <= 5);
});

test('突き合わせ：同じ時刻の予報と実測を、リード時間つきで組にする', () => {
  const log = [{ t: T(18, 6), baseFt: 700, temp: 19 }, { t: T(18, 9), baseFt: 1500, temp: 22 }];
  const snaps = [
    { made: T(18, 0), rows: [{ t: T(18, 6), baseFt: 1000, temp: 20 }, { t: T(18, 9), baseFt: 1800, temp: 23 }] },
    { made: T(18, 5), rows: [{ t: T(18, 6), baseFt: 800, temp: 19.5 }, { t: T(18, 12), baseFt: 2000, temp: 24 }] },
  ];
  const ps = pairs(log, snaps);
  assert.equal(ps.length, 3);                       /* 18/12 は実測が無いので入らない */
  const p6 = ps.filter(p => p.t === T(18, 6));
  assert.deepEqual(p6.map(p => p.leadH), [1, 6]);   /* 5時発の1時間先と、0時発の6時間先 */
  /* 先の時刻ほどリード時間が長い */
  assert.equal(ps.find(p => p.t === T(18, 9)).leadH, 9);
});

test('集計：ずれ（予報−実測）の平均・中央値・平均誤差をリード時間帯ごとに出す', () => {
  const log = [], snaps = [];
  /* 予報が実測より常に300ft高い雲底、気温は±の誤差 */
  const obs = [{ h: 6, base: 700, t: 19 }, { h: 9, base: 1000, t: 21 }, { h: 12, base: 1200, t: 23 }];
  for (const o of obs) log.push({ t: T(18, o.h), baseFt: o.base, temp: o.t });
  snaps.push({ made: T(18, 3), rows: obs.map(o => ({ t: T(18, o.h), baseFt: o.base + 300, temp: o.t + (o.h === 9 ? 1 : -1) })) });
  const st = stats(pairs(log, snaps));
  assert.equal(st.baseFt.all.n, 3);
  assert.equal(st.baseFt.all.bias, 300);
  assert.equal(st.baseFt.all.mae, 300);
  assert.equal(st.baseFt.all.median, 300);
  /* 気温は +1,-1,-1 → 平均 -0.3、誤差の大きさは 1 */
  assert.equal(st.temp.all.mae, 1);
  assert.ok(Math.abs(st.temp.all.bias + 0.33) < 0.1);
  /* リード時間帯で分かれる（3時発の6時＝3時間先、9時＝6時間先、12時＝9時間先） */
  assert.equal(st.baseFt['0-6'].n, 1);
  assert.equal(st.baseFt['6-12'].n, 2);
  assert.equal(st.baseFt['12-24'].n, 0);
  assert.equal(LEAD_BUCKETS.length, 4);
});

test('欠測は数えない', () => {
  const log = [{ t: T(18, 6), baseFt: null, temp: 19 }, { t: T(18, 9), baseFt: 1000, temp: null }];
  const snaps = [{ made: T(18, 3), rows: [{ t: T(18, 6), baseFt: 1000, temp: 20 }, { t: T(18, 9), baseFt: 1300, temp: 22 }] }];
  const st = stats(pairs(log, snaps));
  assert.equal(st.baseFt.all.n, 1);
  assert.equal(st.temp.all.n, 1);
  assert.equal(st.baseFt.all.bias, 300);
});

test('補正：件数が足りないときは補正しない', () => {
  const st = { baseFt: { all: { n: 5, median: 300 } } };
  assert.equal(correction(st, 'baseFt'), null);
  assert.equal(correction({ baseFt: { all: { n: 12, median: 300 } } }, 'baseFt'), 300);
  /* 予報が300ft高めなら、その分下げる。0未満にはしない */
  assert.equal(applyCorrection(1200, 300), 900);
  assert.equal(applyCorrection(100, 300), 0);
  assert.equal(applyCorrection(null, 300), null);
  assert.equal(applyCorrection(1200, null), 1200);
});
