/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetar, parseTaf, ceiling, crosswind, resolveDay, mergeConditions } from '../lib/metar.js';

const REF = new Date(Date.UTC(2026, 8, 17, 6, 0));

test('基本のMETAR：風・視程・雲・気温・QNH・NOSIG', () => {
  const m = parseMetar('METAR RJTT 170530Z 06016KT 9999 FEW025 24/19 Q1019 NOSIG', { ref: REF });
  assert.equal(m.station, 'RJTT');
  assert.equal(m.time.toISOString(), '2026-09-17T05:30:00.000Z');
  assert.deepEqual([m.wind.dir, m.wind.spd, m.wind.gust, m.wind.vrb], [60, 16, null, false]);
  assert.equal(m.vis.m, 10000);
  assert.equal(m.clouds[0].cover, 'FEW');
  assert.equal(m.clouds[0].base, 2500);
  assert.deepEqual([m.temp, m.dew, m.qnh], [24, 19, 1019]);
  assert.equal(m.trend[0].type, 'NOSIG');
  assert.deepEqual(m.unparsed, []);
  assert.equal(ceiling(m).none, true);
});

test('CAVOK：視程10km以上・雲なし・天気なし', () => {
  const m = parseMetar('METAR RJFF 170500Z 34005KT CAVOK 27/18 Q1015', { ref: REF });
  assert.equal(m.cavok, true);
  assert.equal(m.vis.m, 10000);
  assert.deepEqual(m.clouds, []);
  assert.deepEqual(m.wx, []);
  assert.equal(ceiling(m).none, true);
});

test('VRB・ガスト・変動幅', () => {
  const a = parseMetar('METAR RJAA 170500Z VRB03KT 9999 SCT030 25/18 Q1018', { ref: REF });
  assert.equal(a.wind.vrb, true);
  assert.equal(a.wind.dir, null);
  assert.equal(a.wind.missing, false);
  const b = parseMetar('METAR RJCC 170500Z 33018G32KT 300V020 8000 -SHRA BKN020 15/12 Q1008', { ref: REF });
  assert.deepEqual([b.wind.dir, b.wind.spd, b.wind.gust, b.wind.varFrom, b.wind.varTo], [330, 18, 32, 300, 20]);
  assert.equal(b.wx[0].desc, 'SH');
  assert.deepEqual(b.wx[0].phen, ['RA']);
  assert.equal(b.wx[0].intensity, '-');
  assert.equal(ceiling(b).ft, 2000);
});

test('MPSの風はktに換算', () => {
  const m = parseMetar('METAR UUWW 170500Z 18005MPS 9999 BKN020 10/05 Q1010', { ref: REF });
  assert.equal(m.wind.spd, 10);
});

test('VV（鉛直視程）と霧', () => {
  const m = parseMetar('METAR RJSS 162100Z 00000KT 0100 R27/0200N FG VV001 16/16 Q1012', { ref: REF });
  assert.equal(m.vis.m, 100);
  assert.equal(m.rvr[0].rwy, '27');
  assert.equal(m.rvr[0].m, 200);
  assert.equal(m.wx[0].phen[0], 'FG');
  assert.equal(m.clouds[0].cover, 'VV');
  assert.equal(ceiling(m).ft, 100);
});

test('NSC は雲なし扱い', () => {
  const m = parseMetar('METAR RJOO 170500Z 22008KT 9999 NSC 28/17 Q1014', { ref: REF });
  assert.equal(m.nsc, true);
  assert.deepEqual(m.clouds, []);
  assert.equal(ceiling(m).none, true);
});

test('欠測（////）は null と missing', () => {
  const m = parseMetar('METAR RJTF 170500Z AUTO /////KT //// ////// ///CB //// Q////', { ref: REF });
  assert.equal(m.auto, true);
  assert.equal(m.wind.missing, true);
  assert.equal(m.vis.missing, true);
  assert.equal(m.clouds[0].missing, true);
  assert.equal(ceiling(m).missing, true);
  assert.equal(m.qnh, null);
});

test('BKN///（雲底欠測）はシーリング欠測', () => {
  const m = parseMetar('METAR RJCC 162330Z 35007KT 9999 FEW020 BKN/// 17/13 Q1024', { ref: REF });
  const c = ceiling(m);
  assert.equal(c.missing, true);
  assert.equal(c.ft, null);
});

test('国内配信の電文（末尾=、RMK国内様式）', () => {
  const m = parseMetar('METAR RJTC 170500Z 36006KT 9999 FEW020 SCT040 25/16 Q1019 RMK 1CU020 3SC040 A3011=', { ref: REF });
  assert.equal(m.station, 'RJTC');
  assert.equal(m.rmk, '1CU020 3SC040 A3011');
  assert.deepEqual(m.unparsed, []);
});

test('マイル表記(SM)・inHg の電文', () => {
  const m = parseMetar('METAR RODN 170455Z 09012KT 10SM FEW020TCU SCT250 30/24 A2983 RMK AO2A', { ref: REF });
  assert.equal(m.vis.sm, 10);
  assert.equal(m.vis.m, 16093);
  assert.equal(m.clouds[0].type, 'TCU');
  assert.equal(m.qnh, 1010);
  const f = parseMetar('METAR RJTY 170455Z 00000KT 1 1/2SM BR OVC004 18/18 A2990', { ref: REF });
  assert.equal(f.vis.sm, 1.5);
  assert.equal(f.vis.m, 2414);
});

test('TREND（BECMG・TEMPO）', () => {
  const m = parseMetar('METAR RJTT 170500Z 18010KT 9999 FEW020 24/19 Q1012 TEMPO 3000 SHRA BKN010', { ref: REF });
  assert.equal(m.trend[0].type, 'TEMPO');
  assert.equal(m.trend[0].vis.m, 3000);
  assert.equal(m.trend[0].clouds[0].base, 1000);
  assert.equal(m.clouds[0].base, 2000); /* 本体は上書きされない */
});

test('解析できない要素は捨てずに未解析へ', () => {
  const m = parseMetar('METAR RJTT 170500Z 18010KT 9999 FEW020 XYZ12 24/19 Q1012', { ref: REF });
  assert.deepEqual(m.unparsed, ['XYZ12']);
  assert.ok(m.parts.some(p => p.kind === 'unparsed' && p.t === 'XYZ12'));
});

test('日付の月またぎ（ref=10/1 で 30日の電文は9月30日）', () => {
  const d = resolveDay(30, 23, 0, new Date(Date.UTC(2026, 9, 1, 1, 0)));
  assert.equal(d.toISOString(), '2026-09-30T23:00:00.000Z');
});

test('TAF：有効期間・24時・変化群', () => {
  const t = parseTaf(`TAF RJAA 171105Z 1712/1818 02016KT 9999 FEW015 BKN030
    BECMG 1714/1716 36010KT
    TEMPO 1806/1818 FEW003 BKN008
    PROB30 TEMPO 1720/1724 3000 BR`, { ref: REF });
  assert.equal(t.from.toISOString(), '2026-09-17T12:00:00.000Z');
  assert.equal(t.to.toISOString(), '2026-09-18T18:00:00.000Z');
  assert.equal(t.changes.length, 3);
  assert.equal(t.changes[0].type, 'BECMG');
  assert.equal(t.changes[0].wind.dir, 360);
  assert.equal(t.changes[1].clouds[1].base, 800);
  assert.equal(t.changes[2].type, 'PROB30 TEMPO');
  assert.equal(t.changes[2].to.toISOString(), '2026-09-18T00:00:00.000Z');
  assert.deepEqual(t.unparsed, []);
});

test('TAF：FM群と CAVOK の後の雲', () => {
  const t = parseTaf('TAF RJFF 170505Z 1706/1812 34008KT CAVOK FM171500 18012KT 6000 -RA BKN015 TX28/1705Z TN20/1720Z', { ref: REF });
  assert.equal(t.base.cavok, true);
  assert.equal(t.changes[0].type, 'FM');
  assert.equal(t.changes[0].from.toISOString(), '2026-09-17T15:00:00.000Z');
  const merged = mergeConditions(t.base, { clouds: t.changes[0].clouds });
  assert.equal(merged.cavok, false);
  assert.equal(ceiling(merged).ft, 1500);
});

test('QNH....INS を含むTAF は解析済みとして扱う', () => {
  const t = parseTaf('TAF RODN 171100Z 1712/1818 09012KT 9999 FEW020 QNH2984INS BECMG 1800/1802 12010KT 9999 SCT025 QNH2987INS', { ref: REF });
  assert.deepEqual(t.unparsed, []);
});

test('横風：境界値', () => {
  const rw = [340, 160];
  /* 滑走路と同じ向き → 0 */
  assert.equal(crosswind({ dir: 340, spd: 20 }, rw).kt, 0);
  /* 360度と滑走路360：差0（0度と360度を同じに扱う） */
  assert.equal(crosswind({ dir: 360, spd: 15 }, [0]).kt, 0);
  assert.equal(crosswind({ dir: 10, spd: 15 }, [360]).kt, 2.6);
  /* 真横 → 全成分 */
  assert.equal(crosswind({ dir: 70, spd: 20 }, rw).kt, 20);
  /* 30度 → sin30 × 20 = 10 */
  assert.equal(crosswind({ dir: 10, spd: 20 }, rw).kt, 10);
  /* 滑走路が2本あれば横風の小さい方 */
  assert.equal(crosswind({ dir: 90, spd: 20 }, [340, 90]).kt, 0);
  /* ガストがあれば大きい方で計算 */
  assert.equal(crosswind({ dir: 70, spd: 10, gust: 25 }, rw).kt, 25);
  /* 風向不定は全成分 */
  assert.deepEqual([crosswind({ vrb: true, spd: 5 }, rw).kt, crosswind({ vrb: true, spd: 5 }, rw).vrb], [5, true]);
  /* 変動幅があれば範囲の中の一番厳しい向き */
  assert.equal(crosswind({ dir: 340, spd: 20, varFrom: 310, varTo: 10 }, [340]).kt, 10);
  /* 風が欠測・滑走路未登録なら計算しない */
  assert.equal(crosswind({ missing: true }, rw), null);
  assert.equal(crosswind({ dir: 70, spd: 20 }, []), null);
});
