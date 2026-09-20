/* 総合解析：資料の突き合わせ（純粋関数・DOMを使わない）
   ─────────────────────────────────────────
   仕様書 第4章「総合解析」のうち、コードで計算できる部分。
   数値予報・METAR/TAF・経路判定を突き合わせて「シグナル」を出す。
   AIはこの結果を文章にするだけで、数値の判断はここで決める（フェーズ3）。
   - 各シグナルは「根拠の数」で確度を付ける（多いほど確か）
   - 資料が食い違うときは結論を出さず「予報官に確認すること」にする
   テスト: tests/signals.test.mjs */

export const LEVELS = { info: 0, caution: 1, alert: 2 };

const M_FT = 3.280839895;
const inWin = (t, w) => !w || (t >= w.from && t <= w.to);
const fmtH = t => `${String((t.getUTCHours() + 9) % 24).padStart(2, '0')}時`;
const round = (x, n = 0) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

/* nwp: {times:[Date], sfc:{t,td,windSpd,windDir,precip,mslp}, est:{baseFt,ssi,cape}, an:[analyze()の結果]}
   metar/taf: lib/metar.js の解析結果（無くてもよい）
   window: 判定する時間帯 {from,to} */
export function signals({ nwp = null, metar = null, taf = null, route = null, window: win = null, minima = {} } = {}) {
  const out = [];
  const add = s => { if (s) out.push(s) };
  add(sigDeterioration(nwp, win));
  add(sigThunder(nwp, taf, win));
  add(sigFog(nwp, metar, taf, win));
  add(sigWind(nwp, taf, win, minima));
  add(sigFront(nwp, win));
  add(sigRoute(route));
  add(sigMismatch(nwp, taf, win));
  return out.sort((a, b) => (LEVELS[b.level] - LEVELS[a.level]) || (b.basis.length - a.basis.length));
}

/* 窓の中の添字 */
function idxIn(times, win) {
  if (!times?.length) return [];
  return times.map((t, i) => [t, i]).filter(([t]) => inWin(t, win)).map(([, i]) => i);
}
const nums = a => a.filter(v => v != null && Number.isFinite(v));

/* ① 天気の下り坂：雲底が下がる・降水が始まる・気圧が下がる */
export function sigDeterioration(nwp, win) {
  if (!nwp?.times?.length) return null;
  const ix = idxIn(nwp.times, win);
  if (ix.length < 2) return null;
  const basis = [];
  const base = ix.map(i => nwp.est?.baseFt?.[i]);
  const b0 = nums(base.slice(0, Math.ceil(base.length / 3))), b1 = nums(base.slice(-Math.ceil(base.length / 3)));
  const dropFt = b0.length && b1.length ? Math.round(avg(b0) - avg(b1)) : null;
  if (dropFt != null && dropFt >= 500) basis.push({ what: `雲底が ${Math.round(avg(b0))}ft → ${Math.round(avg(b1))}ft に下がる`, screen: 6 });
  const pr = ix.map(i => nwp.sfc?.precip?.[i] ?? 0);
  const firstRain = pr.findIndex(v => v >= 0.5);
  if (firstRain >= 0) basis.push({ what: `${fmtH(nwp.times[ix[firstRain]])}ごろから降水（${round(Math.max(...pr), 1)}mm/hまで）`, screen: 3 });
  const ps = nums(ix.map(i => nwp.sfc?.mslp?.[i]));
  const dP = ps.length > 1 ? round(ps[ps.length - 1] - ps[0], 1) : null;
  if (dP != null && dP <= -3) basis.push({ what: `海面気圧が ${dP}hPa 下がる`, screen: 6 });
  if (!basis.length) return null;
  return {
    key: 'deterioration', title: '天気の下り坂',
    level: basis.length >= 2 ? 'caution' : 'info',
    text: `${basis.length >= 2 ? '複数の資料で' : ''}時間とともに条件が悪くなる見込み。`,
    basis, screens: [1, 3, 6],
  };
}
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

/* ② 雷・にわか雨：不安定（SSI/CAPE）＋ TAFのTS/CB */
export function sigThunder(nwp, taf, win) {
  const basis = [];
  let worstCape = 0, worstSsi = null, when = null;
  if (nwp?.times?.length) {
    for (const i of idxIn(nwp.times, win)) {
      const c = nwp.est?.cape?.[i] ?? 0, s = nwp.est?.ssi?.[i];
      if (c > worstCape) { worstCape = c; when = nwp.times[i] }
      if (s != null && (worstSsi == null || s < worstSsi)) worstSsi = s;
    }
    if (worstCape >= 500) basis.push({ what: `CAPE 最大 ${Math.round(worstCape)} J/kg（${when ? fmtH(when) : ''}ごろ）`, screen: 6 });
    if (worstSsi != null && worstSsi <= 0) basis.push({ what: `SSI ${worstSsi}（0以下は雷の可能性）`, screen: 6 });
  }
  const tafTs = tafHas(taf, w => w.desc === 'TS' || w.phen?.includes('TS'), c => c.type === 'CB');
  if (tafTs) basis.push({ what: `TAFに ${tafTs}`, screen: 5 });
  if (!basis.length) return null;
  return {
    key: 'thunder', title: '雷・にわか雨',
    level: basis.length >= 2 || worstCape >= 1000 ? 'alert' : 'caution',
    text: '大気が不安定で、発達した雲やにわか雨・雷の可能性がある。',
    basis, screens: [2, 3, 6],
  };
}
/* TAFの本体・変化群に、指定の天気や雲があるか */
function tafHas(taf, wxFn, cloudFn) {
  if (!taf) return null;
  const groups = [taf.base, ...(taf.changes || [])].filter(Boolean);
  for (const g of groups) {
    for (const w of g.wx || []) if (wxFn && wxFn(w)) return w.raw;
    for (const c of g.clouds || []) if (cloudFn && cloudFn(c)) return `${c.cover || ''}${c.base != null ? String(c.base / 100).padStart(3, '0') : ''}${c.type || ''}`;
  }
  return null;
}

/* ③ 霧・低い雲：気温と露点が近い＋弱風＋逆転層＋TAFのFG/BR */
export function sigFog(nwp, metar, taf, win) {
  const basis = [];
  if (nwp?.times?.length) {
    const ix = idxIn(nwp.times, win);
    let minSpread = null, when = null, lightWind = false;
    for (const i of ix) {
      const t = nwp.sfc?.t?.[i], td = nwp.sfc?.td?.[i], w = nwp.sfc?.windSpd?.[i];
      if (t == null || td == null) continue;
      const sp = t - td;
      if (minSpread == null || sp < minSpread) { minSpread = sp; when = nwp.times[i]; lightWind = (w ?? 99) <= 5 }
    }
    if (minSpread != null && minSpread <= 2) basis.push({ what: `気温と露点の差が ${round(minSpread, 1)}℃（${when ? fmtH(when) : ''}ごろ）`, screen: 6 });
    if (lightWind && minSpread != null && minSpread <= 2) basis.push({ what: '地上風が弱く、放射霧が出やすい', screen: 6 });
    const inv = nwp.an?.find?.(a => a?.inversions?.some(x => x.surface));
    if (inv) basis.push({ what: '地上付近に逆転層（低い雲・霧が残りやすい）', screen: 6 });
  }
  if (metar?.temp != null && metar?.dew != null && metar.temp - metar.dew <= 2) basis.push({ what: `METARの気温と露点の差 ${round(metar.temp - metar.dew, 1)}℃`, screen: 5 });
  const tafFog = tafHas(taf, w => w.phen?.some(p => p === 'FG' || p === 'BR'), null);
  if (tafFog) basis.push({ what: `TAFに ${tafFog}`, screen: 5 });
  if (!basis.length) return null;
  return {
    key: 'fog', title: '霧・低い雲',
    level: basis.length >= 3 ? 'alert' : basis.length >= 2 ? 'caution' : 'info',
    text: '視程・雲底が下がる可能性。朝方と日没後は特に注意。',
    basis, screens: [5, 6],
  };
}

/* ④ 強風・乱気流：地上風＋上空とのシアー＋TAFの強風 */
export function sigWind(nwp, taf, win, minima = {}) {
  const basis = [];
  const wTh = Number.isFinite(+minima.windKt) ? +minima.windKt : 25;
  let maxW = 0, when = null, maxShear = 0;
  if (nwp?.times?.length) {
    for (const i of idxIn(nwp.times, win)) {
      const w = nwp.sfc?.windSpd?.[i] ?? 0;
      if (w > maxW) { maxW = w; when = nwp.times[i] }
      const sh = nwp.an?.[i]?.shear0to5000;
      if (sh != null && sh > maxShear) maxShear = sh;
    }
    if (maxW >= wTh * 0.8) basis.push({ what: `地上風 最大 ${Math.round(maxW)}kt（${when ? fmtH(when) : ''}ごろ）`, screen: 6 });
    if (maxShear >= 25) basis.push({ what: `地上〜5,000ftのシアー ${round(maxShear, 1)}kt`, screen: 6 });
  }
  const tafWind = tafWindMax(taf);
  if (tafWind >= wTh) basis.push({ what: `TAFの風 最大 ${tafWind}kt`, screen: 5 });
  if (!basis.length) return null;
  return {
    key: 'wind', title: '強風・乱気流',
    level: maxW >= wTh || tafWind >= wTh ? 'alert' : 'caution',
    text: '低高度で揺れやすい。山越え・ビル風のある場所は特に注意。',
    basis, screens: [4, 5, 6],
  };
}
function tafWindMax(taf) {
  if (!taf) return 0;
  const groups = [taf.base, ...(taf.changes || [])].filter(Boolean);
  let m = 0;
  for (const g of groups) if (g.wind && !g.wind.missing) m = Math.max(m, g.wind.spd || 0, g.wind.gust || 0);
  return m;
}

/* ⑤ 前線の通過：風向が変わる＋気圧が下がって上がる */
export function sigFront(nwp, win) {
  if (!nwp?.times?.length) return null;
  const ix = idxIn(nwp.times, win);
  if (ix.length < 3) return null;
  const dirs = ix.map(i => nwp.sfc?.windDir?.[i]);
  const basis = [];
  let turn = null;
  for (let k = 1; k < dirs.length; k++) {
    if (dirs[k] == null || dirs[k - 1] == null) continue;
    const d = Math.abs(((dirs[k] - dirs[k - 1] + 540) % 360) - 180);
    if (180 - d >= 60) { turn = nwp.times[ix[k]]; break }   /* 1時間で60度以上変わる */
  }
  if (turn) basis.push({ what: `${fmtH(turn)}ごろに風向が大きく変わる`, screen: 6 });
  const ps = ix.map(i => nwp.sfc?.mslp?.[i]);
  const lo = ps.indexOf(Math.min(...nums(ps)));
  if (lo > 0 && lo < ps.length - 1) basis.push({ what: `${fmtH(nwp.times[ix[lo]])}ごろに気圧が下げ止まる（谷の通過）`, screen: 6 });
  if (basis.length < 2) return null;
  return {
    key: 'front', title: '前線・気圧の谷の通過',
    level: 'caution',
    text: `${basis[0].what.replace('ごろに風向が大きく変わる', '')}前後で風向が変わり、その前後で雲と降水が変わる。`,
    basis, screens: [1, 3, 6],
  };
}

/* ⑥ 経路の弱点：一番悪い区間を拾う */
export function sigRoute(route) {
  if (!route?.rows?.length) return null;
  const bad = route.rows.filter(r => r.level === 'nogo' || r.level === 'caution');
  if (!bad.length) return null;
  const worstRow = bad.find(r => r.level === 'nogo') || bad[0];
  const reasons = worstRow.items.filter(i => i.level !== 'go').map(i => `${i.label} ${i.value}`);
  return {
    key: 'route', title: '経路の弱いところ',
    level: worstRow.level === 'nogo' ? 'alert' : 'caution',
    text: `${worstRow.legFrom}→${worstRow.legTo} の区間が一番厳しい。`,
    basis: [{ what: reasons.join(' ／ ') || '判定を参照', screen: 4 }, { what: `注意以上の区間 ${bad.length}/${route.rows.length}`, screen: 4 }],
    screens: [4],
  };
}

/* ⑦ 資料の食い違い：TAFと数値予報の雲底が大きく違う */
export function sigMismatch(nwp, taf, win) {
  if (!nwp?.times?.length || !taf?.base) return null;
  const ix = idxIn(nwp.times, win);
  const nwpBase = nums(ix.map(i => nwp.est?.baseFt?.[i]));
  if (!nwpBase.length) return null;
  const tafBase = tafLowestCeil(taf);
  if (tafBase == null) return null;
  const diff = Math.round(avg(nwpBase) - tafBase);
  if (Math.abs(diff) < 1500) return null;
  return {
    key: 'mismatch', title: '資料の食い違い（予報官に確認）',
    level: 'caution',
    text: `TAFの雲底 ${tafBase}ft と、数値予報の推定雲底 ${Math.round(avg(nwpBase))}ft が ${Math.abs(diff)}ft 違う。どちらを採るかは予報官に確認する。`,
    basis: [{ what: `TAF ${tafBase}ft`, screen: 5 }, { what: `数値予報の推定 ${Math.round(avg(nwpBase))}ft`, screen: 6 }],
    screens: [5, 6], ask: true,
  };
}
function tafLowestCeil(taf) {
  const groups = [taf.base, ...(taf.changes || [])].filter(Boolean);
  let m = null;
  for (const g of groups) for (const c of g.clouds || []) {
    if ((c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV') && c.base != null) m = m == null ? c.base : Math.min(m, c.base);
  }
  return m;
}

/* ブリーフィング台本（読み上げ用）。AI解説が無くても使える下書き */
export function script({ sigs = [], judges = {}, window: win = null, airfields = [], route = null }) {
  const lines = [];
  const lv = { go: '問題なし', caution: '注意', nogo: 'ミニマ未満', none: 'データなし' };
  const when = win ? `${fmtH(win.from)}から${fmtH(win.to)}` : 'これから';
  lines.push({ screen: 0, text: `${when}の飛行について、気象の確認結果です。` });
  const top = sigs.slice(0, 3);
  if (top.length) lines.push({ screen: 1, text: `主な注意点は、${top.map(s => s.title).join('、')}です。` });
  else lines.push({ screen: 1, text: '大きな注意点はありません。' });
  for (const s of top) lines.push({ screen: s.screens?.[0] ?? 1, text: `${s.title}：${s.text}根拠は、${s.basis.map(b => b.what).join('、')}。` });
  for (const a of airfields) {
    const parts = [];
    if (a.metar) parts.push(`実況は${lv[a.metar] || a.metar}`);
    if (a.taf) parts.push(`予報は${lv[a.taf] || a.taf}`);
    if (a.rule) parts.push(a.rule);
    lines.push({ screen: 5, text: `${a.icao}は、${parts.join('、') || 'データなし'}。` });
  }
  if (route?.rows?.length) {
    const bad = route.rows.filter(r => r.level !== 'go');
    lines.push({ screen: 4, text: bad.length ? `経路は${route.rows.length}区間のうち${bad.length}区間で注意以上。一番厳しいのは${(bad.find(r => r.level === 'nogo') || bad[0]).legFrom}以降です。` : '経路は全区間で問題ありません。' });
  }
  const asks = sigs.filter(s => s.ask);
  if (asks.length) lines.push({ screen: 0, text: `予報官に確認すること：${asks.map(s => s.text).join(' ')}` });
  lines.push({ screen: 0, text: `総合判定は${lv[judges.total] || 'データなし'}です。最終判断は予報官ブリーフィングと規定に従います。` });
  return lines;
}
