/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetar, parseTaf } from '../lib/metar.js';
import { judgeMetar, judgeTaf, judgeNwp, tafTimeline, worst, flightRule } from '../lib/judge.js';

const REF = new Date(Date.UTC(2026, 8, 17, 6, 0));
const MIN = {
  ceilFt: 1000, ceilMarginFt: 500, visM: 5000, visMarginM: 3000,
  windKt: 30, windMarginKt: 5, xwindKt: 20, xwindMarginKt: 5,
  nogoWx: ['TS', 'CB', 'FG', 'FZ', '+RA', 'SN', 'GR'], spreadC: 3, metarMaxAgeMin: 90,
};
const J = (raw, opt = {}) => judgeMetar(parseMetar(raw, { ref: REF }), MIN, { now: REF, ...opt });
const item = (r, k) => r.items.find(i => i.key === k);

test('総合は NO-GO → 灰 → 注意 → GO の順', () => {
  assert.equal(worst(['go', 'caution']), 'caution');
  assert.equal(worst(['go', 'none', 'caution']), 'none');
  assert.equal(worst(['none', 'nogo']), 'nogo');
  assert.equal(worst(['go', 'na']), 'go');
  assert.equal(worst([]), 'none');
});

test('良い天気は GO', () => {
  const r = J('METAR RJTT 170530Z 06016KT 9999 FEW025 24/15 Q1019');
  assert.equal(r.level, 'go');
  assert.equal(item(r, 'xwind').level, 'na'); /* 滑走路未登録は判定対象外 */
});

test('雲底：ミニマ未満はNO-GO、余裕幅未満は注意、境界はミニマちょうどでGO側', () => {
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 BKN009 20/10 Q1019'), 'ceil').level, 'nogo');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 BKN010 20/10 Q1019'), 'ceil').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 BKN014 20/10 Q1019'), 'ceil').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 BKN015 20/10 Q1019'), 'ceil').level, 'go');
  /* FEW/SCT はシーリングにならない */
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 SCT005 20/10 Q1019'), 'ceil').level, 'go');
  /* VV はシーリング */
  assert.equal(item(J('METAR RJTT 170530Z 00000KT 0200 FG VV002 15/15 Q1019'), 'ceil').level, 'nogo');
});

test('1000ft以下のSCTは注意（設定で変えられる）', () => {
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 SCT010 BKN030 20/10 Q1019'), 'lowsct').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 SCT005 20/10 Q1019'), 'lowsct').level, 'caution');
  assert.equal(J('METAR RJTT 170530Z 06010KT 9999 SCT008 20/10 Q1019').level, 'caution');
  /* 1100ft は対象外、FEW も対象外 */
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 SCT011 20/10 Q1019'), 'lowsct'), undefined);
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW005 20/10 Q1019'), 'lowsct'), undefined);
  assert.equal(judgeMetar(parseMetar('METAR RJTT 170530Z 06010KT 9999 SCT011 20/10 Q1019', { ref: REF }), { ...MIN, sctCautionFt: 1500 }, { now: REF }).items.find(i => i.key === 'lowsct').level, 'caution');
  /* TAFの本体でも注意 */
  const t = parseTaf('TAF RJTT 170505Z 1706/1812 02012KT 9999 SCT007 BKN030', { ref: REF });
  const r = judgeTaf(t, MIN, { from: new Date(Date.UTC(2026, 8, 17, 8)), to: new Date(Date.UTC(2026, 8, 17, 9)) });
  assert.equal(r.slots[0].level, 'caution');
  assert.ok(r.slots[0].hits.some(h => h.label.includes('SCT')));
});

test('視程：CAVOKはGO、SMも換算して判定', () => {
  assert.equal(item(J('METAR RJTT 170530Z 06010KT CAVOK 20/10 Q1019'), 'vis').level, 'go');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 4000 BR FEW010 20/17 Q1019'), 'vis').level, 'nogo');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 7000 FEW010 20/10 Q1019'), 'vis').level, 'caution');
  assert.equal(item(J('METAR RJTY 170530Z 06010KT 3SM BR FEW010 20/17 A2990'), 'vis').level, 'nogo');
});

test('風：平均とガストの大きい方', () => {
  assert.equal(item(J('METAR RJTT 170530Z 06020G31KT 9999 FEW025 24/15 Q1019'), 'wind').level, 'nogo');
  assert.equal(item(J('METAR RJTT 170530Z 06026KT 9999 FEW025 24/15 Q1019'), 'wind').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06025KT 9999 FEW025 24/15 Q1019'), 'wind').level, 'go');
});

test('横風：滑走路方位を登録すると判定', () => {
  const r = J('METAR RJTT 170530Z 07022KT 9999 FEW025 24/15 Q1019', { runways: [340, 160] });
  assert.equal(item(r, 'xwind').level, 'nogo');
  assert.equal(J('METAR RJTT 170530Z 07016KT 9999 FEW025 24/15 Q1019', { runways: [340, 160] }).items.find(i => i.key === 'xwind').level, 'caution');
});

test('天気現象：設定したものはNO-GO、その他の降水は注意、CBはNO-GO、TCUは注意', () => {
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 TS FEW025CB 24/15 Q1019'), 'wx').level, 'nogo');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW025CB 24/15 Q1019'), 'wx').level, 'nogo');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 -RA FEW025 24/15 Q1019'), 'wx').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 +RA FEW025 24/15 Q1019'), 'wx').level, 'nogo');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW025TCU 24/15 Q1019'), 'wx').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 VCSH FEW025 24/15 Q1019'), 'wx').level, 'caution');
  /* 過去天気(RE)は判定に使わない */
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW025 24/15 Q1019 RERA'), 'wx')?.level ?? 'go', 'go');
});

test('気温と露点の差3℃以下は注意', () => {
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW025 20/17 Q1019'), 'spread').level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW025 20/16 Q1019'), 'spread').level, 'go');
});

test('欠測はGOにしない（灰）', () => {
  assert.equal(J('METAR RJTF 170500Z AUTO /////KT //// ////// 20/10 Q////').level, 'none');
  assert.equal(J('METAR RJCC 170500Z 35007KT 9999 FEW020 BKN/// 17/10 Q1024').level, 'none');
  /* ただし分かっている要素でNO-GOならNO-GO */
  assert.equal(J('METAR RJCC 170500Z 35007KT 0800 FG ////// 17/17 Q1024').level, 'nogo');
});

test('METARの変化予報(TEMPO)で悪化するなら注意', () => {
  const r = J('METAR RJTT 170530Z 06010KT 9999 FEW025 24/15 Q1019 TEMPO 3000 SHRA BKN008');
  assert.equal(item(r, 'trend').level, 'caution');
  assert.equal(r.level, 'caution');
  assert.equal(item(J('METAR RJTT 170530Z 06010KT 9999 FEW025 24/15 Q1019 NOSIG'), 'trend'), undefined);
  /* 今の雨が続くだけ(変化群に天気が書かれていない)なら数えない */
  assert.equal(item(J('METAR RJAA 171200Z 02014KT 9999 -RA FEW011 BKN020 21/15 Q1021 BECMG FEW010 BKN025'), 'trend'), undefined);
});

test('古いMETARは灰', () => {
  const r = J('METAR RJTT 170300Z 06010KT 9999 FEW025 24/15 Q1019');
  assert.equal(r.level, 'none');
  assert.equal(item(r, 'age').level, 'none');
});

test('ミニマ未設定なら灰', () => {
  const r = judgeMetar(parseMetar('METAR RJTT 170530Z 06010KT 9999 BKN025 24/15 Q1019', { ref: REF }), {}, { now: REF });
  assert.equal(r.level, 'none');
});

const TAF = `TAF RJAA 170505Z 1706/1812 02012KT 9999 FEW015 BKN030
  BECMG 1709/1711 36018KT
  TEMPO 1712/1718 3000 -SHRA BKN008
  PROB40 TEMPO 1715/1716 TSRA FEW010CB
  FM180300 18008KT 9999 BKN005`;

test('TAFの時間軸展開：BECMG期間中は新旧両方、TEMPOとPROBの重なり', () => {
  const t = parseTaf(TAF, { ref: REF });
  const sl = tafTimeline(t, new Date(Date.UTC(2026, 8, 17, 8)), new Date(Date.UTC(2026, 8, 18, 5)));
  const at = h => sl.find(s => s.from.getTime() === Date.UTC(2026, 8, 17, h));
  /* 08Z：本体だけ */
  assert.deepEqual(at(8).states.map(s => s.kind), ['prevailing']);
  /* 10Z：BECMG期間中 → 本体(旧)と新の2つ */
  assert.equal(at(10).states.length, 2);
  assert.deepEqual(at(10).states.map(s => s.wind.dir), [20, 360]);
  /* 12Z：BECMG完了後の本体＋TEMPO */
  assert.deepEqual(at(12).states.map(s => s.kind), ['prevailing', 'temporary']);
  assert.equal(at(12).states[0].wind.dir, 360);
  /* TEMPOは書かれていない要素(風)を本体から引き継ぐ */
  assert.equal(at(12).states[1].wind.dir, 360);
  assert.equal(at(12).states[1].vis.m, 3000);
  /* 15Z：TEMPOとPROB40 TEMPOが重なる */
  assert.deepEqual(at(15).states.map(s => s.src.split(' ')[0]), ['BECMG', 'TEMPO', 'PROB40']);
  /* 16Z：PROBは16Zで終わる(to=16Z)ので入らない */
  assert.equal(at(16).states.length, 2);
  /* 18/03Z 以降は FM で入れ替わる */
  const h03 = sl.find(s => s.from.getTime() === Date.UTC(2026, 8, 18, 3));
  assert.equal(h03.states[0].wind.dir, 180);
  assert.equal(h03.states[0].clouds[0].base, 500);
});

test('TAF判定：本体・BECMGのミニマ未満はNO-GO、TEMPO・PROBは注意', () => {
  const t = parseTaf(TAF, { ref: REF });
  const r = judgeTaf(t, MIN, { from: new Date(Date.UTC(2026, 8, 17, 8)), to: new Date(Date.UTC(2026, 8, 18, 5)) });
  const lv = h => r.slots.find(s => s.from.getTime() === h).level;
  assert.equal(lv(Date.UTC(2026, 8, 17, 8)), 'go');
  /* TEMPO 3000m BKN008 はミニマ未満だが一時的なので注意 */
  assert.equal(lv(Date.UTC(2026, 8, 17, 13)), 'caution');
  /* PROB40 TEMPO の TS・CB も注意 */
  assert.equal(lv(Date.UTC(2026, 8, 17, 15)), 'caution');
  assert.ok(r.slots.find(s => s.from.getTime() === Date.UTC(2026, 8, 17, 15)).hits.some(h => h.src.startsWith('PROB40') && h.label === '天気現象'));
  /* FM 以降の本体 BKN005 は NO-GO */
  assert.equal(lv(Date.UTC(2026, 8, 18, 3)), 'nogo');
  assert.equal(r.level, 'nogo');
});

test('TAFの有効期間外は灰', () => {
  const t = parseTaf('TAF RJTT 170505Z 1706/1812 02012KT 9999 FEW015 BKN030', { ref: REF });
  const r = judgeTaf(t, MIN, { from: new Date(Date.UTC(2026, 8, 18, 11)), to: new Date(Date.UTC(2026, 8, 18, 14)) });
  assert.equal(r.slots[0].level, 'go');
  assert.equal(r.slots[1].level, 'none');
  assert.equal(r.level, 'none');
});

test('FM が時間の途中なら、その時間は変化前後の両方を見る', () => {
  const t = parseTaf('TAF RJTT 170505Z 1706/1812 02012KT 9999 FEW015 FM171730 18025KT 9999 BKN005', { ref: REF });
  const sl = tafTimeline(t, new Date(Date.UTC(2026, 8, 17, 17)), new Date(Date.UTC(2026, 8, 17, 19)));
  assert.equal(sl[0].states.length, 2);
  assert.equal(sl[1].states.length, 1);
  assert.equal(sl[1].states[0].wind.dir, 180);
});

test('VMC/SVFR/IMC：既定は雲高1000ft・地上視程5000mでVMC、IMCのうち地上視程1500m以上はSVFR', () => {
  const P = raw => parseMetar(raw, { ref: REF });
  const R = (raw, mn) => flightRule(P(raw), mn).rule;
  assert.equal(R('METAR RJTT 170530Z 06010KT 9999 FEW025 24/15 Q1019'), 'VMC');
  assert.equal(R('METAR RJTT 170530Z 06010KT CAVOK 24/15 Q1019'), 'VMC');
  /* 境界：ちょうど1000ft・5000mはVMC */
  assert.equal(R('METAR RJTT 170530Z 06010KT 5000 BR BKN010 20/18 Q1019'), 'VMC');
  /* 雲高だけ足りない → 視程が十分なのでSVFR */
  assert.equal(R('METAR RJTT 170530Z 06010KT 9999 BKN009 20/15 Q1019'), 'SVFR');
  assert.equal(R('METAR RJTT 170530Z 06010KT 4900 BR FEW010 20/18 Q1019'), 'SVFR');
  /* SVFRの境界：ちょうど1500mはSVFR、1499m相当(1400m)はIMC */
  assert.equal(R('METAR RJTT 170530Z 06010KT 1500 BR BKN004 20/19 Q1019'), 'SVFR');
  assert.equal(R('METAR RJTT 170530Z 06010KT 1400 BR BKN004 20/19 Q1019'), 'IMC');
  assert.equal(R('METAR RJTT 170530Z 00000KT 0200 FG VV001 15/15 Q1019'), 'IMC');
  /* SM表記：1SM(1609m)はSVFR */
  assert.equal(R('METAR RJTY 170530Z 00000KT 1SM BR OVC003 15/15 A2990'), 'SVFR');
  /* SCT の低い雲は雲高にならない */
  assert.equal(R('METAR RJTT 170530Z 06010KT 9999 SCT005 20/15 Q1019'), 'VMC');
  /* 欠測：雲も視程も不明なら不明。視程3000mが分かれば雲が欠測でもVMCではなく、SVFR */
  assert.equal(R('METAR RJTF 170500Z AUTO /////KT //// ////// 20/10 Q////'), null);
  assert.equal(R('METAR RJTF 170500Z 36005KT 3000 BR ////// 20/19 Q1019'), 'SVFR');
  /* 雲高がIMCで視程が欠測 → IMC(SVFRかどうか分からない) */
  const u = flightRule(P('METAR RJTF 170500Z 36005KT //// BKN005 20/19 Q1019'));
  assert.equal(u.rule, 'IMC');
  assert.match(u.why, /SVFR/);
  /* 基準は設定で変えられる */
  assert.equal(R('METAR RJTT 170530Z 06010KT 9999 BKN009 20/15 Q1019', { vmcCeilFt: 500, vmcVisM: 1500 }), 'VMC');
  assert.equal(R('METAR RJTT 170530Z 06010KT 1400 BR BKN004 20/19 Q1019', { svfrVisM: 800 }), 'SVFR');
});

test('VMC/SVFR/IMC：METAR判定とTAFの時間ごとに付く', () => {
  assert.equal(J('METAR RJTT 170530Z 06010KT 9999 BKN008 24/15 Q1019').flight.rule, 'SVFR');
  assert.equal(J('METAR RJTT 170530Z 00000KT 0800 FG BKN002 15/15 Q1019').flight.rule, 'IMC');
  const t = parseTaf(TAF + ' TEMPO 1720/1722 1000 BR BKN003', { ref: REF });
  const jt = judgeTaf(t, MIN, { from: new Date(Date.UTC(2026, 8, 17, 8)), to: new Date(Date.UTC(2026, 8, 18, 5)) });
  const f = h => { const s = jt.slots.find(x => x.from.getTime() === h).flight; return [f0(s.rule), f0(s.tempo)]; };
  const f0 = x => x ?? null;
  assert.deepEqual(f(Date.UTC(2026, 8, 17, 8)), ['VMC', null]);
  /* 本体はVMC、TEMPO 3000m BKN008 は SVFR */
  assert.deepEqual(f(Date.UTC(2026, 8, 17, 13)), ['VMC', 'SVFR']);
  /* 21Z：TEMPO 3000m と TEMPO 1000m が重なる → 一時の悪い方 IMC */
  assert.deepEqual(f(Date.UTC(2026, 8, 17, 21)), ['VMC', 'IMC']);
  /* FM 以降の BKN005 9999 は本体がSVFR */
  assert.deepEqual(f(Date.UTC(2026, 8, 18, 3)), ['SVFR', null]);
});

test('数値予報からの推定の判定：視程は見ない', () => {
  const cond = { clouds: [{ cover: 'BKN', base: 800 }], wind: { dir: 200, spd: 12 }, wx: [] };
  const r = judgeNwp(cond, MIN, { runways: [340, 160] });
  assert.equal(r.items.some(i => i.key === 'vis'), false);
  assert.equal(r.items.find(i => i.key === 'ceil').level, 'nogo');
  assert.equal(r.level, 'nogo');
  assert.equal(r.estimated, true);
  /* 雲底が高く風も弱ければGO（視程が無くても灰にならない） */
  assert.equal(judgeNwp({ clouds: [{ cover: 'BKN', base: 4000 }], wind: { dir: 200, spd: 8 }, wx: [] }, MIN, {}).level, 'go');
});
