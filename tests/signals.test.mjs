/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signals, sigDeterioration, sigThunder, sigFog, sigWind, sigFront, sigRoute, sigMismatch, script } from '../lib/signals.js';
import { parseTaf } from '../lib/metar.js';

const REF = new Date(Date.UTC(2026, 8, 20, 0));
const H = h => new Date(Date.UTC(2026, 8, 20, h));
const WIN = { from: H(0), to: H(9) };
/* 10時間ぶんの数値予報の形（index 0 が 0Z＝9時JST） */
function nwpOf(o = {}) {
  const n = 10, idx = [...Array(n).keys()];
  return {
    times: idx.map(H),
    sfc: {
      t: idx.map(i => o.t?.(i) ?? 20), td: idx.map(i => o.td?.(i) ?? 10),
      windSpd: idx.map(i => o.wind?.(i) ?? 8), windDir: idx.map(i => o.dir?.(i) ?? 180),
      precip: idx.map(i => o.precip?.(i) ?? 0), mslp: idx.map(i => o.mslp?.(i) ?? 1015),
    },
    est: { baseFt: idx.map(i => o.base?.(i) ?? 4000), ssi: idx.map(i => o.ssi?.(i) ?? 4), cape: idx.map(i => o.cape?.(i) ?? 0) },
    an: idx.map(i => ({ shear0to5000: o.shear?.(i) ?? 10, inversions: o.inv?.(i) ?? [] })),
  };
}

test('天気の下り坂：雲底が下がる・降水が始まる・気圧が下がる', () => {
  const s = sigDeterioration(nwpOf({ base: i => 5000 - i * 400, precip: i => (i >= 6 ? 1.5 : 0), mslp: i => 1015 - i * 0.8 }), WIN);
  assert.equal(s.key, 'deterioration');
  assert.equal(s.level, 'caution');
  assert.equal(s.basis.length, 3);
  assert.match(s.basis[0].what, /雲底/);
  assert.match(s.basis[1].what, /ごろから降水/);
  /* 変化が無ければシグナルは出ない */
  assert.equal(sigDeterioration(nwpOf(), WIN), null);
});

test('雷：CAPEとSSI、TAFのTS/CBを突き合わせる', () => {
  const taf = parseTaf('TAF RJTT 200505Z 2006/2112 18010KT 9999 FEW020 TEMPO 2007/2010 TSRA FEW015CB', { ref: REF });
  const s = sigThunder(nwpOf({ cape: i => (i >= 4 ? 1200 : 100), ssi: () => -1 }), taf, WIN);
  assert.equal(s.level, 'alert');
  assert.equal(s.basis.length, 3);
  assert.match(s.basis.map(b => b.what).join(), /CAPE/);
  assert.match(s.basis.map(b => b.what).join(), /TAFに/);
  /* 安定していてTAFにも無ければ出ない */
  assert.equal(sigThunder(nwpOf(), parseTaf('TAF RJTT 200505Z 2006/2112 18010KT 9999 FEW020', { ref: REF }), WIN), null);
});

test('霧・低い雲：気温と露点の差・弱風・逆転層・TAF', () => {
  const taf = parseTaf('TAF RJTT 200505Z 2006/2112 00000KT 0800 FG VV002', { ref: REF });
  const s = sigFog(nwpOf({ td: () => 19.5, wind: () => 3, inv: i => (i === 0 ? [{ surface: true, dT: 2 }] : []) }),
    { temp: 20, dew: 19 }, taf, WIN);
  assert.equal(s.level, 'alert');
  assert.ok(s.basis.length >= 4);
  assert.equal(sigFog(nwpOf(), { temp: 20, dew: 10 }, null, WIN), null);
});

test('強風・乱気流：地上風とシアー、TAFの風', () => {
  const s = sigWind(nwpOf({ wind: i => (i === 5 ? 28 : 12), shear: () => 30 }), null, WIN, { windKt: 25 });
  assert.equal(s.level, 'alert');
  assert.equal(s.basis.length, 2);
  /* しきい値を上げれば出ない */
  assert.equal(sigWind(nwpOf({ wind: () => 12, shear: () => 10 }), null, WIN, { windKt: 40 }), null);
  /* TAFだけでも出る */
  const taf = parseTaf('TAF RJTT 200505Z 2006/2112 18025G35KT 9999 FEW020', { ref: REF });
  assert.equal(sigWind(nwpOf({ wind: () => 5, shear: () => 5 }), taf, WIN, { windKt: 25 }).level, 'alert');
});

test('前線の通過：風向の変化と気圧の谷が両方あるときだけ', () => {
  const s = sigFront(nwpOf({ dir: i => (i < 5 ? 180 : 320), mslp: i => 1010 + Math.abs(i - 5) }), WIN);
  assert.equal(s.key, 'front');
  assert.equal(s.basis.length, 2);
  /* 風向だけ変わっても気圧の谷が無ければ出ない */
  assert.equal(sigFront(nwpOf({ dir: i => (i < 5 ? 180 : 320), mslp: i => 1015 - i })), null);
});

test('経路：一番厳しい区間を拾う', () => {
  const route = { rows: [
    { legFrom: 'A', legTo: 'B', level: 'go', items: [] },
    { legFrom: 'B', legTo: 'C', level: 'nogo', items: [{ label: '雲底(推定)', value: '1200ft MSL', level: 'nogo' }, { label: '風', value: '30kt', level: 'caution' }] },
  ] };
  const s = sigRoute(route);
  assert.equal(s.level, 'alert');
  assert.match(s.text, /B→C/);
  assert.match(s.basis[0].what, /雲底/);
  assert.equal(sigRoute({ rows: [{ level: 'go', items: [] }] }), null);
});

test('資料の食い違い：TAFと数値予報の雲底が1500ft以上違えば「気象担当者に確認」', () => {
  const taf = parseTaf('TAF RJTT 200505Z 2006/2112 18010KT 9999 BKN005', { ref: REF });
  const s = sigMismatch(nwpOf({ base: () => 4000 }), taf, WIN);
  assert.equal(s.ask, true);
  assert.match(s.text, /気象担当者に確認/);
  /* 近ければ出ない */
  assert.equal(sigMismatch(nwpOf({ base: () => 1200 }), taf, WIN), null);
});

test('まとめて出すと、重いものから順に並ぶ', () => {
  const taf = parseTaf('TAF RJTT 200505Z 2006/2112 18028KT 9999 FEW020 TEMPO 2007/2010 TSRA FEW015CB', { ref: REF });
  const sigs = signals({
    nwp: nwpOf({ cape: () => 1500, ssi: () => -2, wind: () => 28, base: i => 5000 - i * 300, precip: i => (i > 5 ? 2 : 0) }),
    taf, window: WIN, minima: { windKt: 25 },
  });
  assert.ok(sigs.length >= 3);
  assert.equal(sigs[0].level, 'alert');
  /* 並び順：alert が caution より前 */
  const levels = sigs.map(s => s.level);
  assert.ok(levels.indexOf('caution') === -1 || levels.indexOf('alert') < levels.indexOf('caution'));
});

test('ブリーフィング台本：判定と根拠から文章を作る', () => {
  const sigs = signals({ nwp: nwpOf({ cape: () => 1200, ssi: () => -1 }), window: WIN });
  const lines = script({
    sigs, judges: { total: 'caution' }, window: WIN,
    airfields: [{ icao: 'RJTT', metar: 'go', taf: 'caution', rule: 'VMC' }],
    route: { rows: [{ legFrom: 'A', legTo: 'B', level: 'caution', items: [] }] },
  });
  const text = lines.map(l => l.text).join('\n');
  assert.match(text, /9時から18時の飛行/);
  assert.match(text, /雷・にわか雨/);
  assert.match(text, /RJTT/);
  assert.match(text, /経路は1区間のうち1区間/);
  assert.match(text, /総合判定は注意/);
  assert.match(text, /公式の気象ブリーフィング/);
  /* 画面番号が付いていて、そこへ飛べる */
  assert.ok(lines.every(l => Number.isInteger(l.screen)));
});
