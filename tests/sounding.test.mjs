/* node --test tests/
   数値は教科書・標準大気の値と照合する（実装に合わせて期待値を書かない） */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esat, dewpoint, rhFrom, mixingRatio, theta, thetaE, lcl, moistAdiabatT, dryAdiabatT,
  makeProfile, interp, parcelT, ssi, li, cape, freezingLevel, moistLayers, inversions, shear,
  cloudBaseEspy, analyze, M_FT,
} from '../lib/sounding.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg||''} ${a} ≒ ${b} (±${tol})`);

test('飽和水蒸気圧：理科年表の値', () => {
  near(esat(0), 6.11, 0.05, '0℃');
  near(esat(10), 12.27, 0.1, '10℃');
  near(esat(20), 23.37, 0.2, '20℃');
  near(esat(30), 42.43, 0.4, '30℃');
  near(esat(-10), 2.86, 0.05, '-10℃');
});

test('露点と相対湿度：気温＝露点で100%、往復して元に戻る', () => {
  near(rhFrom(20, 20), 100, 0.01);
  near(dewpoint(20, 100), 20, 0.05);
  /* 20℃・湿度50% の露点は約9.3℃（湿度表） */
  near(dewpoint(20, 50), 9.3, 0.3);
  near(rhFrom(20, dewpoint(20, 62)), 62, 0.1);
});

test('混合比：1000hPa・露点20℃ で約14.9g/kg（湿り空気表）', () => {
  near(mixingRatio(1000, 20), 14.9, 0.2);
  near(mixingRatio(850, 0), 4.5, 0.2);   /* 850hPa・露点0℃ ≒ 4.5g/kg */
});

test('温位：1000hPaでは気温そのもの、850hPa・0℃で約286K', () => {
  near(theta(1000, 16.85), 290, 0.2);
  near(theta(850, 0), 286.1, 0.5);
  /* 乾燥断熱で持ち上げると温位は変わらない */
  near(theta(700, dryAdiabatT(700, 1000, 20)), theta(1000, 20), 0.01);
});

test('LCL：Espyの目安（地上の気温と露点の差×125m）と近い高さになる', () => {
  const l = lcl(1000, 30, 20);
  /* 気圧高度の目安：1250m ≒ 862hPa（標準大気） */
  near(l.p, 862, 12, 'LCLの気圧');
  /* LCLの温度は乾燥断熱で下がった温度 */
  near(l.tC, dryAdiabatT(l.p, 1000, 30), 0.2);
  /* 湿っているほどLCLは低い */
  assert.ok(lcl(1000, 30, 28).p > lcl(1000, 30, 15).p);
});

test('相当温位：湿潤断熱線に沿って持ち上げても保たれる', () => {
  const the = thetaE(1000, 20, 20);
  /* 湿球温位20℃ ↔ 相当温位 約335K（相当温位・湿球温位の対応表） */
  near(the, 335, 1.5, '1000hPa・20℃飽和の相当温位');
  /* 同じ湿潤断熱線を1000hPaに戻すと元の20℃ */
  near(moistAdiabatT(1000, the), 20, 0.05, '1000hPaに戻す');
  const t500 = moistAdiabatT(500, the);
  /* 湿球温位20℃の湿潤断熱線は500hPaで約-9℃（エマグラム） */
  near(t500, -9, 2, '500hPaの気温');
  /* 1000→500hPa の平均減率は湿潤断熱の範囲(4〜6℃/km) */
  const lapse = (20 - t500) / 5.5;
  assert.ok(lapse > 4 && lapse < 6, `減率 ${lapse.toFixed(1)}℃/km`);
  near(thetaE(500, t500, t500), the, 0.5, '持ち上げても相当温位は同じ');
});

test('気塊の持ち上げ：LCLまでは乾燥断熱、その上は湿潤断熱', () => {
  const s = { p: 1000, t: 25, td: 15 };
  const l = lcl(1000, 25, 15);
  near(parcelT(950, s), dryAdiabatT(950, 1000, 25), 0.05, 'LCLより下');
  /* LCLより上は湿潤断熱なので、乾燥断熱より暖かい */
  assert.ok(parcelT(600, s) > dryAdiabatT(600, 1000, 25) + 5);
});

const STD = [];   /* 国際標準大気（15℃・6.5℃/km・湿度50%） */
for (const p of [1000, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300]) {
  const z = 44330.77 * (1 - Math.pow(p / 1013.25, 0.190263));
  STD.push({ p, z: Math.round(z), t: Math.round((15 - 6.5 * z / 1000) * 10) / 10, rh: 50, dir: 270, spd: 10 + z / 100 });
}

test('標準大気：0℃高度は約2300m、SSIは正（安定）、CAPEは0', () => {
  const prof = makeProfile(STD);
  near(freezingLevel(prof), 2308, 60, '0℃高度');
  assert.ok(ssi(prof) > 0, 'SSI>0');
  const c = cape(prof, prof[0]);
  assert.equal(c.cape, 0);
  assert.ok(c.cin <= 0);
  assert.ok(li(prof, prof[0]) > 0, 'LI>0');
});

test('不安定な大気：CAPEが出て、SSI・LIが負になる', () => {
  /* 地上30℃・露点24℃、上空は標準大気より冷たい（8.5℃/km） */
  const lv = STD.map(l => ({ ...l, t: Math.round((30 - 8.5 * l.z / 1000) * 10) / 10, rh: l.p >= 900 ? 70 : 40 }));
  const prof = makeProfile(lv);
  const c = cape(prof, prof[0]);
  assert.ok(c.cape > 500, `CAPE=${c.cape}`);
  assert.ok(ssi(prof) < 0, `SSI=${ssi(prof)}`);
  assert.ok(li(prof, prof[0]) < 0, `LI=${li(prof, prof[0])}`);
  assert.ok(c.lclP < prof[0].p && c.lclP > 800);
});

test('内挿：気圧面の間の値を対数気圧で求める', () => {
  const prof = makeProfile(STD);
  /* 1000hPaは標準大気で約110m なので 15−6.5×0.11 ≒ 14.3℃ */
  near(interp(prof, 1000, 't'), 14.3, 0.2);
  near(interp(prof, 875, 't'), (interp(prof, 900, 't') + interp(prof, 850, 't')) / 2, 0.2);
  /* 範囲外は端の値 */
  assert.equal(interp(prof, 1050, 't'), prof[0].t);
});

test('湿潤層・逆転層・シアー・推定雲底', () => {
  const lv = [
    { p: 1000, z: 110, t: 20, rh: 95, dir: 180, spd: 10 },
    { p: 950, z: 540, t: 22, rh: 95, dir: 200, spd: 15 },   /* 地上付近の逆転層 */
    { p: 900, z: 990, t: 18, rh: 40, dir: 220, spd: 20 },
    { p: 850, z: 1460, t: 15, rh: 30, dir: 240, spd: 30 },
  ];
  const prof = makeProfile(lv);
  const wet = moistLayers(prof, { maxSpread: 3 });
  assert.equal(wet.length, 1);
  assert.deepEqual([wet[0].fromP, wet[0].toP], [1000, 950]);
  const inv = inversions(prof);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].surface, true);
  near(inv[0].dT, 2, 0.01);
  /* 地上180/10kt → 1460m付近 240/30kt のシアー */
  assert.ok(shear(prof, 110, 1460) > 20);
  /* 気温20℃・湿度95% → 露点19.2℃ → 雲底は約100m ≒ 330ft */
  near(cloudBaseEspy(20, dewpoint(20, 95)), 330, 60);
});

test('analyze：飛行高度帯に0℃高度や湿潤層がかかるかを返す', () => {
  const lv = STD.map(l => ({ ...l, rh: l.p >= 850 ? 95 : 30 }));
  const a = analyze(lv, { flightFt: [0, 10000], elevM: 0 });
  assert.equal(a.freezingInFlight, true);            /* 0℃高度 約2300m ≒ 7600ft */
  assert.equal(a.moistInFlight, true);               /* 地上〜850hPa が湿潤 */
  assert.ok(a.freezingFt > 7000 && a.freezingFt < 8200);
  assert.ok(a.lclFt != null && a.lclFt >= 0);
  assert.ok(a.shear0to5000 != null);
  /* 飛行高度帯を 0〜3000ft にすると 0℃高度はかからない */
  assert.equal(analyze(lv, { flightFt: [0, 3000] }).freezingInFlight, false);
});

test('欠測の層は落として計算する', () => {
  const lv = [{ p: 1000, z: 100, t: 20, rh: 80 }, { p: 925, z: 800, t: null, rh: null }, { p: 850, z: 1500, t: 10, rh: 60 }];
  const prof = makeProfile(lv);
  assert.equal(prof.length, 2);
  assert.equal(prof[0].p, 1000);
  assert.ok(prof.every(l => l.td != null));
});

test('高度の換算：1000m は約3281ft', () => {
  near(1000 * M_FT, 3281, 1);
});
