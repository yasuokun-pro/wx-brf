/* 気圧配置の判定（純粋関数・DOMを使わない）
   ─────────────────────────────────────────
   1地点の気圧だけでは「配置」が分からないので、関東甲信越を囲む数地点の海面気圧・風・850hPa気温を
   突き合わせて、よくある気圧配置に当てはめる。出すのは次の3つ。
     ① 今の配置と、飛行の時間帯の終わりの配置
     ② 天気の振れ方（良くなる／悪くなる／変わらない）
     ③ 前線・気圧の谷の通過
   - しきい値は目安。断定せず、根拠（どの地点の気圧差か）を必ず付ける
   - 実際の前線の位置は天気図（画面1）で確かめる前提。ここは数値から言えることだけを言う
   テスト: tests/synoptic.test.mjs

   地点の役割（sources.json の synoptic.points で決める）
     center 中心（東京）／west 西・日本海側（新潟）／east 東（銚子）／south 南の海上（八丈島）／north 北（福島） */

export const PATTERNS = {
  winter: '西高東低（冬型）',
  high: '高気圧に覆われる',
  trough: '気圧の谷・低気圧の接近',
  south: '南岸を低気圧が通る',
  passed: '気圧の谷・低気圧の通過後',
  flat: '気圧の傾きが小さい（はっきりした配置なし）',
};

const at = (p, k, i) => (p?.[k]?.[i] == null || !Number.isFinite(+p[k][i]) ? null : +p[k][i]);
const role = (points, r) => (points || []).find(p => p.role === r) || null;
const round = (x, n = 1) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);
const sign = x => (x > 0 ? '+' : '');
const jstH = t => `${String((new Date(t).getUTCHours() + 9) % 24).padStart(2, '0')}時`;
/* 風向が北西寄り（280〜360,0〜20度） */
const isNW = d => d != null && (d >= 280 || d <= 20);
/* 風向が北〜東寄り（340〜360,0〜110度）＝南岸低気圧のときの関東の風 */
const isNE = d => d != null && (d >= 340 || d <= 110);
/* 3時間の気圧変化（無ければ取れるだけ前と比べる） */
function tendency(c, i) {
  for (const back of [3, 2, 1]) {
    const a = at(c, 'mslp', i - back), b = at(c, 'mslp', i);
    if (a != null && b != null) return { d: b - a, hours: back };
  }
  return null;
}

/* ある時刻の気圧配置 */
export function classifyAt(data, i) {
  const P = data?.points || [];
  const c = role(P, 'center'), w = role(P, 'west'), e = role(P, 'east'), s = role(P, 'south');
  const all = P.map(p => at(p, 'mslp', i)).filter(v => v != null);
  const pc = c ? at(c, 'mslp', i) : null;
  if (pc == null || all.length < 3) return { key: null, label: '判定できず', basis: ['気圧のデータが足りない'] };
  const pw = w ? at(w, 'mslp', i) : null, pe = e ? at(e, 'mslp', i) : null, ps = s ? at(s, 'mslp', i) : null;
  const spread = Math.max(...all) - Math.min(...all);
  const we = pw != null && pe != null ? pw - pe : null;   /* 西−東。プラスなら西高東低 */
  const t850 = at(c, 't850', i), dir = at(c, 'windDir', i);
  const tend = tendency(c, i);
  const basis = [`${c.name} ${round(pc)}hPa`];
  if (we != null) basis.push(`西(${w.name})−東(${e.name}) ${sign(round(we))}${round(we)}hPa`);
  if (ps != null) basis.push(`南(${s.name}) ${round(ps)}hPa`);
  if (tend) basis.push(`${c.name}の気圧変化 ${sign(round(tend.d))}${round(tend.d)}hPa/${tend.hours}h`);

  /* 西高東低：西が高く東が低い＋北西風＋上空が冷たい */
  if (we != null && we >= 6 && isNW(dir) && (t850 == null || t850 <= 0)) {
    if (t850 != null) basis.push(`850hPa気温 ${round(t850)}℃`);
    return { key: 'winter', label: PATTERNS.winter, basis };
  }
  /* 南岸を低気圧が通る：南の海上が中心より低圧＋関東は北〜東寄りの風 */
  if (ps != null && pc - ps >= 2 && isNE(dir)) return { key: 'south', label: PATTERNS.south, basis };
  /* 谷・低気圧：中心が地域で一番低い、または西が低く東が高い */
  const low = (we != null && we <= -3) || (pc <= Math.min(...all) + 0.3 && spread >= 3);
  if (low) {
    /* 気圧が上がり始めていれば通過後 */
    if (tend && tend.d >= 1) return { key: 'passed', label: PATTERNS.passed, basis };
    return { key: 'trough', label: PATTERNS.trough, basis };
  }
  basis.push(`地域内の気圧差 ${round(spread)}hPa`);
  /* 高気圧に覆われる：気圧が高く、地域内の差が小さい */
  if (pc >= 1016 && spread <= 4) return { key: 'high', label: PATTERNS.high, basis };
  return { key: 'flat', label: PATTERNS.flat, basis };
}

/* 判定する時間帯の中の添字 */
function idxIn(times, win) {
  if (!times?.length) return [];
  return times.map((t, i) => [t, i]).filter(([t]) => !win || (t >= win.from && t <= win.to)).map(([, i]) => i);
}

/* これからの振れ方：気圧の傾向と降水の増減から */
export function trendOf(data, win) {
  const c = role(data?.points, 'center');
  const ix = idxIn(data?.times, win);
  if (!c || ix.length < 2) return { key: null, label: '判定できず', basis: [] };
  const first = ix[0], last = ix[ix.length - 1];
  const p0 = at(c, 'mslp', first), p1 = at(c, 'mslp', last);
  const dP = p0 != null && p1 != null ? round(p1 - p0) : null;
  const pr = ix.map(i => at(c, 'precip', i) ?? 0);
  const half = Math.ceil(pr.length / 2);
  const prFirst = round(pr.slice(0, half).reduce((a, b) => a + b, 0));
  const prLast = round(pr.slice(-half).reduce((a, b) => a + b, 0));
  const basis = [];
  if (dP != null) basis.push(`${c.name}の気圧 ${sign(dP)}${dP}hPa（${jstH(data.times[first])}→${jstH(data.times[last])}）`);
  if (prFirst || prLast) basis.push(`降水量 前半 ${prFirst}mm → 後半 ${prLast}mm`);
  const worse = (dP != null && dP <= -2) || prLast > prFirst + 0.5;
  const better = (dP != null && dP >= 2 && prLast <= prFirst) || (prFirst > 0.5 && prLast === 0);
  if (worse && !better) return { key: 'worsening', label: '悪くなる方向', basis };
  if (better && !worse) return { key: 'improving', label: '良くなる方向', basis };
  return { key: 'steady', label: '大きく変わらない', basis };
}

/* 前線・気圧の谷の通過：風向が大きく変わる＋気圧が下げ止まる（850hPa気温が下がれば寒冷前線側） */
export function frontPassage(data, win) {
  const c = role(data?.points, 'center');
  const ix = idxIn(data?.times, win);
  if (!c || ix.length < 3) return null;
  let turn = null;
  for (let k = 1; k < ix.length; k++) {
    const a = at(c, 'windDir', ix[k - 1]), b = at(c, 'windDir', ix[k]);
    if (a == null || b == null) continue;
    const d = 180 - Math.abs(Math.abs(b - a) - 180);   /* 風向の変化量（0〜180度） */
    if (d >= 60) { turn = { i: ix[k], from: a, to: b }; break }
  }
  if (!turn) return null;
  const ps = ix.map(i => at(c, 'mslp', i));
  const lo = ps.indexOf(Math.min(...ps.filter(v => v != null)));
  const trough = lo > 0 && lo < ps.length - 1;
  if (!trough) return null;                            /* 風向だけでは前線と言わない */
  const t0 = at(c, 't850', ix[0]), t1 = at(c, 't850', ix[ix.length - 1]);
  const cold = t0 != null && t1 != null && t1 - t0 <= -3;
  const basis = [`${jstH(data.times[turn.i])}ごろ風向が ${Math.round(turn.from)}°→${Math.round(turn.to)}° に変わる`,
    `${jstH(data.times[ix[lo]])}ごろ気圧が下げ止まる`];
  if (cold) basis.push(`850hPa気温 ${round(t0)}℃→${round(t1)}℃`);
  return {
    when: data.times[turn.i], cold,
    kind: cold ? '寒冷前線または気圧の谷' : '前線または気圧の谷',
    text: `${jstH(data.times[turn.i])}前後に${cold ? '寒冷前線または気圧の谷' : '前線または気圧の谷'}が通る見込みで、前後で風向が変わり、雲と降水が入れ替わります。${cold ? '通過後は北西風が強まり、低高度の揺れに注意します。' : ''}`,
    basis,
  };
}

/* まとめ：台本とAIに渡す形にする */
export function describe(data, win, { area = '関東甲信' } = {}) {
  const ix = idxIn(data?.times, win);
  if (!data?.points?.length || !ix.length) return null;
  const now = classifyAt(data, ix[0]);
  const later = classifyAt(data, ix[ix.length - 1]);
  const trend = trendOf(data, win);
  const front = frontPassage(data, win);
  const changed = !!(now.key && later.key && now.key !== later.key);
  const text = [
    `${area}は${now.label}。`,
    changed ? `${jstH(data.times[ix[ix.length - 1]])}ごろには${later.label}に変わる見込み。` : '',
    `天気は${trend.label}。`,
    front ? front.text : '',
  ].filter(Boolean).join('');
  return {
    area, now, later: changed ? later : null, trend, front, text,
    basis: [...now.basis, ...trend.basis, ...(front?.basis || [])],
    note: '数値予報の気圧・風・850hPa気温から機械的に当てはめたもの。前線の位置は天気図で確かめる',
  };
}
