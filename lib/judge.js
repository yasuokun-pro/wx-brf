/* ミニマ判定(純粋関数)。AIは使わず、値としきい値だけで決める。
   ─────────────────────────────────────────
   レベル: go(緑) / caution(黄) / nogo(赤) / none(灰=データなし・判定不能)
   総合 = NO-GO があれば NO-GO → 灰があれば灰(欠測をGOにしない) → 注意 → GO
   ミニマ(設定画面で入力、端末内だけに保存):
     ceilFt, ceilMarginFt, visM, visMarginM, windKt, windMarginKt, xwindKt, xwindMarginKt,
     nogoWx: ['TS','CB','FG','FZ','+RA','SN',…], spreadC(気温と露点の差の注意しきい値、既定3),
     metarMaxAgeMin(これより古いMETARは灰、既定90) */
import { ceiling, crosswind, windMax, windJa, visJa, mergeConditions } from './metar.js';

export const LEVELS = ['go', 'caution', 'none', 'nogo'];
export const LEVEL_JA = { go: 'GO', caution: '注意', nogo: 'NO-GO', none: 'データなし', na: '対象外' };

export function worst(levels) {
  const ls = levels.filter(l => l && l !== 'na');
  if (!ls.length) return 'none';
  if (ls.includes('nogo')) return 'nogo';
  if (ls.includes('none')) return 'none';
  if (ls.includes('caution')) return 'caution';
  return 'go';
}

const num = v => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);

/* 下限型(雲底・視程)：値 < ミニマ → NO-GO、< ミニマ＋余裕 → 注意 */
function lowerLimit(value, min, margin) {
  if (min == null) return { level: 'none', why: 'ミニマ未設定' };
  if (value < min) return { level: 'nogo', why: `ミニマ ${min} 未満` };
  if (value < min + (margin || 0)) return { level: 'caution', why: `ミニマ＋余裕 ${min + (margin || 0)} 未満` };
  return { level: 'go', why: '' };
}
/* 上限型(風・横風)：値 > 上限 → NO-GO、> 上限−余裕 → 注意 */
function upperLimit(value, max, margin) {
  if (max == null) return { level: 'none', why: '上限未設定' };
  if (value > max) return { level: 'nogo', why: `上限 ${max} 超過` };
  if (value > max - (margin || 0)) return { level: 'caution', why: `上限−余裕 ${max - (margin || 0)} 超過` };
  return { level: 'go', why: '' };
}

/* 天気現象がNO-GO設定に当たるか。設定値は 'TS' 'FG' 'FZ' 'SN' '+RA' 'CB' 'GR' 'SQ' 'FC' 'VA' など */
function wxHits(wx, clouds, list) {
  const hits = [];
  for (const w of wx || []) {
    if (w.recent) continue;
    const codes = [w.desc, ...w.phen].filter(Boolean);
    for (const k of list) {
      if (k.startsWith('+') || k.startsWith('-')) { if (w.intensity === k[0] && codes.includes(k.slice(1))) hits.push({ k, w }); }
      else if (codes.includes(k) && !(w.vicinity && k !== 'TS')) hits.push({ k, w });
      /* 周辺(VC)の現象は TS 以外は NO-GO にしない(注意側で拾う) */
    }
  }
  for (const c of clouds || []) if (c.type && list.includes(c.type)) hits.push({ k: c.type, cloud: c });
  return hits;
}

/* 1つの気象状態(METAR本体、またはTAFの1時点)をミニマで判定 */
export function judgeConditions(c, minima, { runways = [], temp = null, dew = null } = {}) {
  const m = {
    ceilFt: num(minima.ceilFt), ceilMarginFt: num(minima.ceilMarginFt) || 0,
    visM: num(minima.visM), visMarginM: num(minima.visMarginM) || 0,
    windKt: num(minima.windKt), windMarginKt: num(minima.windMarginKt) || 0,
    xwindKt: num(minima.xwindKt), xwindMarginKt: num(minima.xwindMarginKt) || 0,
    nogoWx: minima.nogoWx || [], spreadC: num(minima.spreadC) ?? 3,
  };
  const items = [];

  const cl = ceiling(c);
  if (cl.missing && cl.ft == null) items.push({ key: 'ceil', label: '雲底', value: '欠測', level: 'none', why: '雲の層が欠測' });
  else if (cl.none) items.push({ key: 'ceil', label: '雲底', value: 'シーリングなし', level: m.ceilFt == null ? 'none' : 'go', why: m.ceilFt == null ? 'ミニマ未設定' : '' });
  else {
    const r = lowerLimit(cl.ft, m.ceilFt, m.ceilMarginFt);
    /* 一部の層だけ欠測：分かっている層で NO-GO なら NO-GO、それ以外は灰 */
    if (cl.missing && r.level !== 'nogo') r.level = 'none', r.why = '一部の雲の層が欠測';
    items.push({ key: 'ceil', label: '雲底', value: `${cl.ft}ft`, ...r });
  }

  if (!c.vis || c.vis.missing) items.push({ key: 'vis', label: '視程', value: '欠測', level: 'none', why: '視程が欠測' });
  else items.push({ key: 'vis', label: '視程', value: visJa(c.vis).replace('視程 ', ''), ...lowerLimit(c.vis.m, m.visM, m.visMarginM) });

  const wm = windMax(c.wind);
  if (wm == null) items.push({ key: 'wind', label: '風速', value: '欠測', level: 'none', why: '風が欠測' });
  else items.push({ key: 'wind', label: '風速', value: windJa(c.wind), ...upperLimit(wm, m.windKt, m.windMarginKt) });

  if (!runways.length) items.push({ key: 'xwind', label: '横風', value: '—', level: 'na', why: '滑走路方位が未登録' });
  else {
    const x = crosswind(c.wind, runways);
    if (!x) items.push({ key: 'xwind', label: '横風', value: '欠測', level: 'none', why: '風が欠測' });
    else items.push({ key: 'xwind', label: '横風', value: x.vrb ? `${x.kt}kt(風向不定のため全成分)` : `${x.kt}kt(方位${String(x.rwy).padStart(3, '0')}°)`, ...upperLimit(x.kt, m.xwindKt, m.xwindMarginKt) });
  }

  const hits = wxHits(c.wx, c.clouds, m.nogoWx);
  const others = (c.wx || []).filter(w => !w.recent && (w.precip || w.desc === 'TS' || w.desc === 'SH' || w.vicinity) && !hits.some(h => h.w === w));
  const tcu = (c.clouds || []).filter(l => l.type && !hits.some(h => h.cloud === l));
  if (hits.length) items.push({ key: 'wx', label: '天気現象', value: hits.map(h => h.w ? h.w.raw : h.k).join(' '), level: 'nogo', why: `NO-GO設定 ${[...new Set(hits.map(h => h.k))].join('・')}` });
  else if (others.length || tcu.length) items.push({ key: 'wx', label: '天気現象', value: [...others.map(w => w.raw), ...tcu.map(l => l.type)].join(' '), level: 'caution', why: '降水・対流性の雲等' });
  else items.push({ key: 'wx', label: '天気現象', value: (c.wx || []).map(w => w.raw).join(' ') || 'なし', level: 'go', why: '' });

  if (temp != null && dew != null) {
    const sp = temp - dew;
    items.push({ key: 'spread', label: '気温−露点', value: `${sp}℃`, level: sp <= m.spreadC ? 'caution' : 'go', why: sp <= m.spreadC ? `${m.spreadC}℃以下：霧・低い雲に注意` : '' });
  }
  return { level: worst(items.map(i => i.level)), items };
}

/* VMC/IMC。既定は航空法施行規則第5条の「管制圏内の飛行場で離着陸するとき」の地上の基準：
   雲高(BKN/OVC/VV の一番低い層)300m≒1,000ft 以上、地上視程 5km 以上 → VMC。どちらかを下回れば IMC。
   ⚠ 空域・高度によって基準は違う(雲からの距離など地上観測では決まらない条件もある)。設定 vmcCeilFt・vmcVisM で変えられる。
   欠測：分かっている要素で IMC なら IMC、それ以外は null(不明) */
export function flightRule(c, minima = {}) {
  const ceilMin = num(minima.vmcCeilFt) ?? 1000, visMin = num(minima.vmcVisM) ?? 5000;
  const cl = ceiling(c), why = [];
  let unknown = false;
  if (cl.ft != null && cl.ft < ceilMin) why.push(`雲高 ${cl.ft}ft < ${ceilMin}ft`);
  else if (cl.missing) unknown = true;
  const v = c.vis && !c.vis.missing ? c.vis.m : null;
  if (v != null && v < visMin) why.push(`視程 ${v}m < ${visMin}m`);
  else if (v == null) unknown = true;
  if (why.length) return { rule: 'IMC', why: why.join('・') };
  if (unknown) return { rule: null, why: '雲か視程が欠測' };
  return { rule: 'VMC', why: `雲高${ceilMin}ft以上・視程${visMin}m以上` };
}

/* METAR の判定。古いMETARは灰(GOにしない) */
export function judgeMetar(metar, minima, { runways = [], now = new Date() } = {}) {
  if (!metar || metar.nil) return { level: 'none', items: [], note: 'METARなし' };
  const r = judgeConditions(metar, minima, { runways, temp: metar.temp, dew: metar.dew });
  /* 変化予報(TREND：2時間以内のBECMG・TEMPO)で悪くなるなら注意。一時的・予報なのでNO-GOにはしない */
  for (const g of metar.trend || []) {
    if (g.type === 'NOSIG') continue;
    const t = judgeConditions(mergeConditions(metar, g), minima, { runways });
    /* 今より悪くなる要素だけ(今の雨がそのまま続く、などは数えない) */
    const rank = l => ({ go: 0, caution: 1, nogo: 2 })[l] ?? -1;
    const bad = t.items.filter(i => rank(i.level) >= 1 && rank(i.level) > rank(r.items.find(x => x.key === i.key)?.level));
    if (bad.length) r.items.push({ key: 'trend', label: '変化予報', value: `${g.type} ${bad.map(i => `${i.label} ${i.value}`).join('、')}`, level: 'caution', why: '2時間以内に悪化の予報' });
  }
  r.level = worst(r.items.map(i => i.level));
  r.flight = flightRule(metar, minima);
  const maxAge = num(minima.metarMaxAgeMin) ?? 90;
  if (metar.time) {
    const age = (now - metar.time) / 60000;
    r.ageMin = Math.round(age);
    if (age > maxAge) {
      r.items.push({ key: 'age', label: '観測時刻', value: `${Math.round(age)}分前`, level: 'none', why: `${maxAge}分より古い` });
      if (r.level !== 'nogo') r.level = 'none';
    }
  }
  return r;
}

/* TAF を時間帯で展開する。1時間ごとに
   - 本体(prevailing)：FM で入れ替え、BECMG は期間の終わりから新しい値。期間中は新旧の両方を見る
   - TEMPO・PROB：期間中だけ、その時点の本体に上書きした状態を追加で見る
   を作る。TEMPO・PROB 由来の NO-GO は「注意」に下げる(仕様 第5章) */
export function tafTimeline(taf, from, to) {
  const out = [];
  if (!taf || !taf.base || !taf.from) return out;
  const H = 3600e3;
  const start = new Date(Math.floor(from.getTime() / H) * H);
  for (let t = start.getTime(); t < to.getTime(); t += H) {
    const t0 = new Date(t), t1 = new Date(t + H);
    const slot = { from: t0, to: t1, covered: t0 >= taf.from && t1 <= taf.to, states: [] };
    if (!slot.covered) { out.push(slot); continue; }
    let prev = { ...taf.base, src: '本体' };
    let transitional = [];
    for (const g of taf.changes) {
      if (g.type === 'FM') {
        const fm = { ...mergeConditions({}, g), src: `FM ${hhmm(g.from)}` };
        if (g.from <= t0) { prev = fm; transitional = []; }
        else if (g.from < t1) transitional.push(fm); /* 時間の途中で入れ替わる → その時間は前後の両方を見る */
      }
      if (g.type === 'BECMG') {
        const merged = { ...mergeConditions(prev, g), src: `BECMG ${hhmm(g.from)}-${hhmm(g.to)}` };
        if (g.to <= t0) { prev = merged; transitional = []; }
        else if (g.from < t1) transitional.push(merged);
      }
    }
    slot.states.push({ ...prev, kind: 'prevailing' });
    for (const s of transitional) slot.states.push({ ...s, kind: 'prevailing' });
    for (const g of taf.changes) {
      if (!/TEMPO|PROB/.test(g.type)) continue;
      if (g.from < t1 && g.to > t0) slot.states.push({ ...mergeConditions(prev, g), kind: 'temporary', src: `${g.type} ${hhmm(g.from)}-${hhmm(g.to)}` });
    }
    out.push(slot);
  }
  return out;
}
function hhmm(d) { return `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}`; }

export function judgeTaf(taf, minima, { runways = [], from, to } = {}) {
  if (!taf || taf.nil || taf.cnl) return { level: 'none', slots: [], items: [], note: 'TAFなし' };
  const slots = tafTimeline(taf, from, to).map(s => {
    if (!s.covered) return { ...s, level: 'none', flight: { rule: null, why: 'TAFの有効期間外', tempo: null }, hits: [{ src: '—', label: '有効期間外', value: '', level: 'none', why: 'TAFの有効期間外' }] };
    const hits = [];
    const levels = s.states.map(st => {
      const r = judgeConditions(st, minima, { runways });
      let lv = r.level;
      if (st.kind === 'temporary') lv = lv === 'nogo' ? 'caution' : lv;
      for (const it of r.items) {
        if (it.level === 'go' || it.level === 'na') continue;
        const l = st.kind === 'temporary' && it.level === 'nogo' ? 'caution' : it.level;
        hits.push({ src: st.src, label: it.label, value: it.value, level: l, why: it.why + (st.kind === 'temporary' && it.level === 'nogo' ? '(一時的・確率のためNO-GOを注意に)' : '') });
      }
      return lv;
    });
    /* VMC/IMC：本体(BECMG期間中は新旧)で1つでもIMCならIMC。TEMPO・PROBだけのIMCは tempo に分けて出す */
    const pre = s.states.filter(st => st.kind === 'prevailing').map(st => flightRule(st, minima));
    const tmp = s.states.filter(st => st.kind === 'temporary').map(st => ({ ...flightRule(st, minima), src: st.src }));
    const rule = pre.some(f => f.rule === 'IMC') ? 'IMC' : pre.some(f => f.rule == null) ? null : 'VMC';
    const tImc = tmp.filter(f => f.rule === 'IMC');
    const flight = { rule, why: pre.filter(f => f.rule === rule).map(f => f.why)[0] || '', tempo: rule !== 'IMC' && tImc.length ? 'IMC' : null, tempoSrc: tImc.map(f => f.src.split(' ')[0]).join('・') };
    return { ...s, level: worst(levels), hits, flight };
  });
  return { level: slots.length ? worst(slots.map(s => s.level)) : 'none', slots };
}
