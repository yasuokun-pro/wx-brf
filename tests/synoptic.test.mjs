import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAt, trendOf, frontPassage, describe as synDescribe } from '../lib/synoptic.js';

/* 09JST(00Z)から1時間ごと */
const T0 = Date.UTC(2026, 0, 15, 0, 0);
const times = n => Array.from({ length: n }, (_, i) => new Date(T0 + i * 3600e3));
const fill = (n, v) => Array.from({ length: n }, (_, i) => (typeof v === 'function' ? v(i) : v));
/* 地点を作る。省略した項目は一定値 */
const pt = (name, role, n, o = {}) => ({
  name, role,
  mslp: fill(n, o.mslp ?? 1013), windDir: fill(n, o.windDir ?? 180), windSpd: fill(n, o.windSpd ?? 10),
  precip: fill(n, o.precip ?? 0), t850: fill(n, o.t850 ?? 5),
});
const data = (n, pts) => ({ times: times(n), points: pts });
const win = (n) => ({ from: new Date(T0), to: new Date(T0 + (n - 1) * 3600e3) });

test('西高東低：西が高く北西風で上空が冷たい', () => {
  const n = 6, d = data(n, [
    pt('東京', 'center', n, { mslp: 1016, windDir: 320, t850: -8 }),
    pt('新潟', 'west', n, { mslp: 1024, windDir: 300 }),
    pt('銚子', 'east', n, { mslp: 1014 }),
    pt('八丈島', 'south', n, { mslp: 1012 }),
  ]);
  const r = classifyAt(d, 3);
  assert.equal(r.key, 'winter');
  assert.ok(r.basis.some(b => b.includes('西(新潟)−東(銚子) +10hPa')), r.basis.join('/'));
  assert.ok(r.basis.some(b => b.includes('850hPa気温 -8℃')));
});

test('高気圧に覆われる：気圧が高く地域内の差が小さい', () => {
  const n = 6, d = data(n, [
    pt('東京', 'center', n, { mslp: 1020, windDir: 200 }),
    pt('新潟', 'west', n, { mslp: 1021 }),
    pt('銚子', 'east', n, { mslp: 1019 }),
    pt('八丈島', 'south', n, { mslp: 1020 }),
  ]);
  assert.equal(classifyAt(d, 3).key, 'high');
});

test('気圧の谷・低気圧の接近：西が低く気圧が下がっている', () => {
  const n = 8, d = data(n, [
    pt('東京', 'center', n, { mslp: i => 1010 - i, windDir: 150 }),
    pt('新潟', 'west', n, { mslp: i => 1002 - i }),
    pt('銚子', 'east', n, { mslp: i => 1012 - i }),
    pt('八丈島', 'south', n, { mslp: i => 1011 - i }),
  ]);
  assert.equal(classifyAt(d, 4).key, 'trough');
});

test('通過後：同じ配置でも気圧が上がり始めていれば通過後', () => {
  const n = 8, d = data(n, [
    pt('東京', 'center', n, { mslp: i => 1000 + i * 1.5, windDir: 300 }),
    pt('新潟', 'west', n, { mslp: i => 996 + i * 1.5 }),
    pt('銚子', 'east', n, { mslp: i => 1004 + i * 1.5 }),
    pt('八丈島', 'south', n, { mslp: i => 1002 + i * 1.5 }),
  ]);
  assert.equal(classifyAt(d, 5).key, 'passed');
});

test('南岸低気圧：南の海上が低圧で関東は北〜東寄りの風', () => {
  const n = 6, d = data(n, [
    pt('東京', 'center', n, { mslp: 1010, windDir: 30 }),
    pt('新潟', 'west', n, { mslp: 1016 }),
    pt('銚子', 'east', n, { mslp: 1009 }),
    pt('八丈島', 'south', n, { mslp: 1002 }),
  ]);
  const r = classifyAt(d, 3);
  assert.equal(r.key, 'south');
  assert.ok(r.basis.some(b => b.includes('南(八丈島) 1002hPa')));
});

test('地点が足りなければ判定しない', () => {
  const n = 4, d = data(n, [pt('東京', 'center', n)]);
  assert.equal(classifyAt(d, 1).key, null);
  assert.equal(synDescribe(d, win(n)) && synDescribe(d, win(n)).now.key, null);
});

test('振れ方：気圧が下がり降水が増えれば悪くなる方向', () => {
  const n = 6, d = data(n, [pt('東京', 'center', n, { mslp: i => 1012 - i, precip: i => (i >= 3 ? 1.5 : 0) })]);
  const r = trendOf(d, win(n));
  assert.equal(r.key, 'worsening');
  assert.ok(r.basis[0].includes('-5hPa'), r.basis[0]);
  assert.ok(r.basis[1].includes('後半 4.5mm'), r.basis[1]);
});

test('振れ方：気圧が上がり降水が止まれば良くなる方向', () => {
  const n = 6, d = data(n, [pt('東京', 'center', n, { mslp: i => 1004 + i, precip: i => (i < 2 ? 2 : 0) })]);
  assert.equal(trendOf(d, win(n)).key, 'improving');
});

test('振れ方：気圧も降水も動かなければ変わらない', () => {
  const n = 6, d = data(n, [pt('東京', 'center', n, { mslp: 1015 })]);
  const r = trendOf(d, win(n));
  assert.equal(r.key, 'steady');
  assert.equal(r.basis.length, 1);
});

test('前線の通過：風向が変わり気圧が下げ止まる（上空が冷えれば寒冷前線側）', () => {
  const n = 7;
  const mslp = [1008, 1005, 1002, 1000, 1002, 1005, 1008];
  const dirs = [150, 160, 170, 300, 310, 320, 320];
  const d = data(n, [pt('東京', 'center', n, { mslp: i => mslp[i], windDir: i => dirs[i], t850: i => 8 - i })]);
  const r = frontPassage(d, win(n));
  assert.ok(r);
  assert.equal(r.cold, true);
  assert.equal(r.kind, '寒冷前線または気圧の谷');
  assert.ok(r.text.includes('12時前後'), r.text);          /* 03Z = 12JST */
  assert.ok(r.basis.some(b => b.includes('気圧が下げ止まる')));
});

test('前線の通過：風向だけ変わって気圧が下げ止まらなければ前線とは言わない', () => {
  const n = 6;
  const dirs = [150, 300, 310, 310, 320, 320];
  const d = data(n, [pt('東京', 'center', n, { mslp: i => 1010 - i, windDir: i => dirs[i] })]);
  assert.equal(frontPassage(d, win(n)), null);
});

test('まとめ：配置が変わる場合は変化も入れる', () => {
  const n = 8;
  const mslp = [1002, 1001, 1001, 1003, 1006, 1009, 1012, 1015];
  const dirs = [150, 160, 300, 310, 320, 320, 320, 320];
  const d = data(n, [
    pt('東京', 'center', n, { mslp: i => mslp[i], windDir: i => dirs[i], t850: i => 4 - i, precip: i => (i < 3 ? 2 : 0) }),
    pt('新潟', 'west', n, { mslp: i => mslp[i] + (i < 3 ? -4 : 8) }),
    pt('銚子', 'east', n, { mslp: i => mslp[i] + 2 }),
    pt('八丈島', 'south', n, { mslp: i => mslp[i] + 1 }),
  ]);
  const r = synDescribe(d, win(n), { area: '関東甲信' });
  assert.equal(r.now.key, 'trough');
  assert.equal(r.later.key, 'winter');
  assert.equal(r.trend.key, 'improving');
  assert.ok(r.front);
  assert.ok(r.text.startsWith('関東甲信は気圧の谷・低気圧の接近。'), r.text);
  assert.ok(r.text.includes('に変わる見込み'), r.text);
  assert.ok(r.text.includes('天気は良くなる方向'), r.text);
  assert.ok(r.basis.length >= 4);
});

test('まとめ：時間帯にデータが無ければ null', () => {
  const n = 4, d = data(n, [pt('東京', 'center', n), pt('新潟', 'west', n), pt('銚子', 'east', n)]);
  assert.equal(synDescribe(d, { from: new Date(T0 + 48 * 3600e3), to: new Date(T0 + 50 * 3600e3) }), null);
});
