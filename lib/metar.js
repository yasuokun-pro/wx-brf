/* METAR / TAF のパーサと日本語デコード(純粋関数・DOMを使わない)
   ─────────────────────────────────────────
   - 解析できない要素は捨てずに unparsed に残す(画面で「未解析」と出す)
   - 欠測(//// 等)は値を null にして missing を立てる。判定側で灰色にする
   - 時刻は UTC の Date。METAR/TAF は日と時分しか持たないので、基準時刻(ref)から年月を補う
   - 国内配信の電文(末尾が "="、RMK が国内様式)も通るようにする
   テスト: node --test tests/ */

const SM_TO_M = 1609.344;

/* ───── 時刻 ───── */
/* 日(dd)時(hh)分(mm) を ref に一番近い日付にする(月またぎ対応) */
export function resolveDay(dd, hh, mm, ref) {
  const cands = [-1, 0, 1].map(k => {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + k, 1));
    /* その月に dd 日が無い(2月30日など)なら候補にしない */
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    if (dd > last) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dd, hh, mm));
  }).filter(Boolean);
  cands.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
  return cands[0];
}

/* ───── 要素ごとの解析 ───── */
const WX_DESC = { MI: '浅い', PR: '部分的', BC: '散在', DR: '低い地ふぶき等', BL: '高い地ふぶき等', SH: 'しゅう雨性', TS: '雷電', FZ: '着氷性' };
const WX_PHEN = {
  DZ: '霧雨', RA: '雨', SN: '雪', SG: '霧雪', IC: '細氷', PL: '凍雨', GR: 'ひょう', GS: '小さいひょう', UP: '不明の降水',
  BR: 'もや', FG: '霧', FU: '煙', VA: '火山灰', DU: 'ちり', SA: '砂', HZ: '煙霧', PY: 'しぶき',
  PO: 'じん旋風', SQ: 'スコール', FC: 'ろうと雲(竜巻等)', SS: '砂じん嵐', DS: '砂じん嵐',
};
const PRECIP = ['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP'];
const COVER = { FEW: '少し(1-2/8)', SCT: '散在(3-4/8)', BKN: '多い(5-7/8)', OVC: '全天(8/8)' };

export function parseWind(t) {
  const m = t.match(/^(\d{3}|VRB|\/{3})(\d{2,3}|\/{2})(?:G(\d{2,3}))?(KT|MPS)$/);
  if (!m) return null;
  const k = m[4] === 'MPS' ? 1.94384 : 1;
  const w = {
    dir: /^\d{3}$/.test(m[1]) ? +m[1] : null,
    vrb: m[1] === 'VRB',
    spd: /^\d+$/.test(m[2]) ? Math.round(+m[2] * k) : null,
    gust: m[3] ? Math.round(+m[3] * k) : null,
    unit: 'KT',
  };
  w.missing = w.spd == null || (!w.vrb && w.dir == null);
  return w;
}

export function parseVis(t) {
  if (t === '////') return { m: null, missing: true };
  let m = t.match(/^(\d{4})(NDV)?$/);
  if (m) return { m: +m[1] === 9999 ? 10000 : +m[1], ge10k: +m[1] === 9999 };
  m = t.match(/^(\d{4})(N|NE|E|SE|S|SW|W|NW)$/);
  if (m) return { m: +m[1], dirMin: m[2] };
  m = t.match(/^(P)?(\d+)?(?:\s?(\d)\/(\d))?SM$/);
  if (m && (m[2] || m[3])) {
    const sm = (m[2] ? +m[2] : 0) + (m[3] ? +m[3] / +m[4] : 0);
    return { m: Math.round(sm * SM_TO_M), sm, plus: !!m[1], ge10k: sm >= 6 && !!m[1] || sm >= 7 };
  }
  return null;
}

export function parseWx(t) {
  const m = t.match(/^(\+|-|VC|RE)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)+|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)?$/);
  if (!m || (!m[2] && !m[3])) return null;
  const phen = m[3] ? (m[3].match(/../g) || []) : [];
  const ja = [
    m[1] === '+' ? '強い' : m[1] === '-' ? '弱い' : m[1] === 'VC' ? '周辺で' : m[1] === 'RE' ? '直前まで' : '',
    m[2] ? WX_DESC[m[2]] : '',
    phen.map(p => WX_PHEN[p]).join('・'),
  ].join('');
  return {
    raw: t,
    intensity: m[1] === '+' || m[1] === '-' ? m[1] : null,
    vicinity: m[1] === 'VC',
    recent: m[1] === 'RE',
    desc: m[2] || null,
    phen,
    precip: phen.some(p => PRECIP.includes(p)),
    ja: ja || t,
  };
}

export function parseCloud(t) {
  let m = t.match(/^(FEW|SCT|BKN|OVC)(\d{3}|\/{3})(CB|TCU|\/{3})?$/);
  if (m) return { cover: m[1], base: /^\d+$/.test(m[2]) ? +m[2] * 100 : null, type: m[3] === 'CB' || m[3] === 'TCU' ? m[3] : null, missing: !/^\d+$/.test(m[2]) };
  m = t.match(/^VV(\d{3}|\/{3})$/);
  if (m) return { cover: 'VV', base: /^\d+$/.test(m[1]) ? +m[1] * 100 : null, type: null, missing: !/^\d+$/.test(m[1]) };
  m = t.match(/^\/{6}(CB|TCU)?$/);
  if (m) return { cover: null, base: null, type: m[1] || null, missing: true };
  return null;
}

/* 1群ぶんの「天気の状態」を読み取る共通処理(METAR本体・TREND・TAFの各群で使う)。
   読めた要素だけを持つ部分オブジェクトを返す。TAFの変化群は読めた要素だけ上書きする */
function readConditions(tokens, i, stopRe) {
  const c = { wx: undefined, clouds: undefined };
  const parts = [];
  const unparsed = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (stopRe && stopRe.test(t)) break;
    let x;
    if ((x = parseWind(t))) { c.wind = x; parts.push({ t, kind: 'wind', ja: windJa(x) }); continue; }
    if (/^(\d{3})V(\d{3})$/.test(t) && c.wind) {
      const [, a, b] = t.match(/^(\d{3})V(\d{3})$/); c.wind.varFrom = +a; c.wind.varTo = +b;
      parts.push({ t, kind: 'wind', ja: `風向 ${a}°〜${b}° で変動` }); continue;
    }
    if (t === 'CAVOK') { c.cavok = true; c.vis = { m: 10000, ge10k: true }; c.clouds = []; c.wx = []; parts.push({ t, kind: 'cavok', ja: '視程10km以上・5,000ft未満に雲なし・CBなし・天気現象なし' }); continue; }
    /* "1 1/2SM" のように2語に分かれた視程 */
    if (/^\d$/.test(t) && /^\d\/\dSM$/.test(tokens[i + 1] || '')) {
      x = parseVis(`${t} ${tokens[i + 1]}`); c.vis = x; parts.push({ t: `${t} ${tokens[i + 1]}`, kind: 'vis', ja: visJa(x) }); i++; continue;
    }
    if ((x = parseVis(t))) {
      if (c.vis && x.dirMin) { c.vis.dirMin = x; parts.push({ t, kind: 'vis', ja: `${x.dirMin}方向の最短視程 ${x.m}m` }); continue; }
      c.vis = x; parts.push({ t, kind: 'vis', ja: visJa(x) }); continue;
    }
    if (/^R\d{2}[LRC]?\//.test(t)) {
      const m = t.match(/^R(\d{2}[LRC]?)\/(P|M)?(\d{4})(?:V(P|M)?(\d{4}))?(FT)?\/?([UDN])?$/);
      if (m) {
        (c.rvr = c.rvr || []).push({ rwy: m[1], m: +m[3], mod: m[2] || null, max: m[5] ? +m[5] : null, trend: m[7] || null });
        parts.push({ t, kind: 'rvr', ja: `滑走路${m[1]}のRVR ${m[2] === 'P' ? '>' : m[2] === 'M' ? '<' : ''}${m[3]}m${m[5] ? `〜${m[5]}m` : ''}${{ U: '(増加)', D: '(減少)', N: '(変化なし)' }[m[7]] || ''}` });
        continue;
      }
    }
    if (/^QNH\d{4}INS$/.test(t)) { parts.push({ t, kind: 'qnh', ja: `最低QNH ${+t.slice(3, 7) / 100}inHg(海外様式のTAF)` }); continue; }
    if (t === 'NSW') { c.wx = []; parts.push({ t, kind: 'wx', ja: '顕著な天気現象の終了' }); continue; }
    if ((x = parseWx(t))) { (c.wx = c.wx || []).push(x); parts.push({ t, kind: 'wx', ja: x.ja }); continue; }
    if (t === 'NSC' || t === 'NCD' || t === 'SKC' || t === 'CLR') {
      c.clouds = []; c.nsc = true; parts.push({ t, kind: 'cloud', ja: t === 'NSC' ? '顕著な雲なし' : '雲なし' }); continue;
    }
    if ((x = parseCloud(t))) { (c.clouds = c.clouds || []).push(x); parts.push({ t, kind: 'cloud', ja: cloudJa(x) }); continue; }
    unparsed.push(t); parts.push({ t, kind: 'unparsed', ja: '未解析' });
  }
  return { c, parts, unparsed, i };
}

export function windJa(w) {
  if (w.missing) return '風 欠測';
  const d = w.vrb ? '風向不定' : `${String(w.dir).padStart(3, '0')}°`;
  return w.spd === 0 ? '静穏' : `${d} ${w.spd}kt${w.gust ? ` 最大瞬間${w.gust}kt` : ''}`;
}
export function visJa(v) {
  if (v.missing) return '視程 欠測';
  if (v.sm != null) return `視程 ${v.plus ? '>' : ''}${v.sm}SM(約${v.m}m)`;
  return v.ge10k ? '視程 10km以上' : `視程 ${v.m}m`;
}
export function cloudJa(c) {
  const type = c.type === 'CB' ? ' 積乱雲' : c.type === 'TCU' ? ' 塔状積雲' : '';
  if (c.cover === 'VV') return c.base == null ? '鉛直視程 欠測' : `鉛直視程 ${c.base}ft`;
  if (c.cover == null) return `雲 欠測${type}`;
  return `${COVER[c.cover]} ${c.base == null ? '雲底欠測' : `${c.base}ft`}${type}`;
}

/* ───── METAR ───── */
export function parseMetar(raw, { ref = new Date() } = {}) {
  const text = String(raw || '').replace(/=\s*$/, '').replace(/\s+/g, ' ').trim();
  const tokens = text.split(' ').filter(Boolean);
  const out = { raw: text, kind: 'METAR', station: null, time: null, auto: false, cor: false, nil: false, parts: [], unparsed: [], trend: [], rmk: '' };
  let i = 0;
  const push = (t, kind, ja) => out.parts.push({ t, kind, ja });
  if (/^(METAR|SPECI)$/.test(tokens[i])) { out.kind = tokens[i]; push(tokens[i], 'head', tokens[i] === 'SPECI' ? '特別観測' : '定時観測'); i++; }
  if (tokens[i] === 'COR') { out.cor = true; push('COR', 'head', '訂正報'); i++; }
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] || '')) { out.station = tokens[i]; push(tokens[i], 'head', '地点'); i++; }
  const tm = (tokens[i] || '').match(/^(\d{2})(\d{2})(\d{2})Z$/);
  if (tm) { out.time = resolveDay(+tm[1], +tm[2], +tm[3], ref); push(tokens[i], 'time', `観測 ${tm[1]}日 ${tm[2]}:${tm[3]}UTC`); i++; }
  for (; tokens[i] === 'AUTO' || tokens[i] === 'COR' || tokens[i] === 'NIL'; i++) {
    if (tokens[i] === 'AUTO') { out.auto = true; push('AUTO', 'head', '自動観測'); }
    if (tokens[i] === 'COR') { out.cor = true; push('COR', 'head', '訂正報'); }
    if (tokens[i] === 'NIL') { out.nil = true; push('NIL', 'head', '欠報'); }
  }
  /* 本体は 気温/露点・QNH・TREND・RMK の手前まで */
  const body = readConditions(tokens, i, /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$|^[QA](\d{4}|\/{4})$|^(NOSIG|BECMG|TEMPO|RMK|WS)$/);
  Object.assign(out, body.c);
  out.parts.push(...body.parts); out.unparsed.push(...body.unparsed);
  i = body.i;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    let m;
    if ((m = t.match(/^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/))) {
      const f = s => (s && /\d/.test(s) ? (s[0] === 'M' ? -1 : 1) * +s.replace('M', '') : null);
      out.temp = f(m[1]); out.dew = f(m[2]);
      push(t, 'temp', `気温 ${out.temp ?? '欠測'}℃ 露点 ${out.dew ?? '欠測'}℃`); continue;
    }
    if ((m = t.match(/^Q(\d{4}|\/{4})$/))) { out.qnh = /\d/.test(m[1]) ? +m[1] : null; push(t, 'qnh', `QNH ${out.qnh ?? '欠測'}hPa`); continue; }
    if ((m = t.match(/^A(\d{4})$/))) { out.qnh = Math.round(+m[1] / 100 * 33.8639); out.altimInHg = +m[1] / 100; push(t, 'qnh', `高度計規正値 ${+m[1] / 100}inHg(約${out.qnh}hPa)`); continue; }
    if (t === 'WS') {
      const w = [t]; while (tokens[i + 1] && !/^(NOSIG|BECMG|TEMPO|RMK)$/.test(tokens[i + 1])) w.push(tokens[++i]);
      out.windshear = w.join(' '); push(out.windshear, 'ws', '低層ウインドシア'); continue;
    }
    if (t === 'NOSIG') { out.trend.push({ type: 'NOSIG' }); push(t, 'trend', '2時間以内に著しい変化なし'); continue; }
    if (t === 'BECMG' || t === 'TEMPO') {
      const g = { type: t, raw: [t] };
      push(t, 'trend', t === 'BECMG' ? '次第に変化(2時間以内)' : '一時的に変化(2時間以内)');
      i++;
      const tl = [];
      while (tokens[i] && /^(FM|TL|AT)\d{4}$/.test(tokens[i])) { tl.push(tokens[i]); push(tokens[i], 'trend', `${{ FM: 'から', TL: 'まで', AT: 'に' }[tokens[i].slice(0, 2)]} ${tokens[i].slice(2, 4)}:${tokens[i].slice(4)}UTC`); i++; }
      const r = readConditions(tokens, i, /^(NOSIG|BECMG|TEMPO|RMK)$/);
      Object.assign(g, r.c, { when: tl }); out.parts.push(...r.parts); out.unparsed.push(...r.unparsed);
      i = r.i - 1; out.trend.push(g); continue;
    }
    if (t === 'RMK') { out.rmk = tokens.slice(i + 1).join(' '); push(`RMK ${out.rmk}`, 'rmk', '付加情報(国内様式等。判定には使わない)'); break; }
    out.unparsed.push(t); push(t, 'unparsed', '未解析');
  }
  return out;
}

/* ───── TAF ───── */
export function parseTaf(raw, { ref = new Date() } = {}) {
  const text = String(raw || '').replace(/=\s*$/, '').replace(/\s+/g, ' ').trim();
  const tokens = text.split(' ').filter(Boolean);
  const out = { raw: text, station: null, issue: null, from: null, to: null, amd: false, cor: false, cnl: false, nil: false, base: null, changes: [], parts: [], unparsed: [] };
  const push = (t, kind, ja) => out.parts.push({ t, kind, ja });
  let i = 0;
  if (tokens[i] === 'TAF') { push('TAF', 'head', '飛行場予報'); i++; }
  for (; /^(AMD|COR)$/.test(tokens[i] || ''); i++) { out[tokens[i].toLowerCase()] = true; push(tokens[i], 'head', tokens[i] === 'AMD' ? '修正報' : '訂正報'); }
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] || '')) { out.station = tokens[i]; push(tokens[i], 'head', '地点'); i++; }
  const it = (tokens[i] || '').match(/^(\d{2})(\d{2})(\d{2})Z$/);
  if (it) { out.issue = resolveDay(+it[1], +it[2], +it[3], ref); push(tokens[i], 'time', `発表 ${it[1]}日 ${it[2]}:${it[3]}UTC`); i++; }
  const ref2 = out.issue || ref;
  const period = t => {
    const m = t.match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/);
    if (!m) return null;
    return [periodTime(+m[1], +m[2], ref2), periodTime(+m[3], +m[4], ref2)];
  };
  const p0 = period(tokens[i] || '');
  if (p0) { [out.from, out.to] = p0; push(tokens[i], 'time', `有効 ${tokens[i].slice(0, 2)}日${tokens[i].slice(2, 4)}時〜${tokens[i].slice(5, 7)}日${tokens[i].slice(7, 9)}時UTC`); i++; }
  if (tokens[i] === 'NIL') { out.nil = true; push('NIL', 'head', '欠報'); return out; }
  if (tokens[i] === 'CNL') { out.cnl = true; push('CNL', 'head', '取り消し'); return out; }

  const STOP = /^(BECMG|TEMPO|PROB\d{2}|FM\d{6}|T[XN]M?\d{2}\/\d{4}Z|RMK)$/;
  const b = readConditions(tokens, i, STOP);
  out.base = b.c; out.parts.push(...b.parts); out.unparsed.push(...b.unparsed); i = b.i;
  while (i < tokens.length) {
    const t = tokens[i];
    let m;
    if ((m = t.match(/^T([XN])(M?\d{2})\/(\d{2})(\d{2})Z$/))) {
      push(t, 'temp', `${m[1] === 'X' ? '最高' : '最低'}気温 ${m[2].replace('M', '-')}℃(${m[3]}日${m[4]}時UTC)`); i++; continue;
    }
    if (t === 'RMK') { push(tokens.slice(i).join(' '), 'rmk', '付加情報'); break; }
    let g = null;
    if ((m = t.match(/^FM(\d{2})(\d{2})(\d{2})$/))) {
      g = { type: 'FM', from: resolveDay(+m[1], +m[2], +m[3], ref2), to: out.to };
      push(t, 'change', `${m[1]}日${m[2]}:${m[3]}UTCから(この時刻で全要素が入れ替わる)`); i++;
    } else if (t === 'BECMG' || t === 'TEMPO' || /^PROB\d{2}$/.test(t)) {
      let type = t;
      push(t, 'change', t === 'BECMG' ? '次第に変化' : t === 'TEMPO' ? '一時的に変化' : `発生確率${t.slice(4)}%`);
      i++;
      if (/^PROB\d{2}$/.test(t) && tokens[i] === 'TEMPO') { type = `${t} TEMPO`; push('TEMPO', 'change', '一時的に'); i++; }
      const p = period(tokens[i] || '');
      if (!p) { out.unparsed.push(t); continue; }
      push(tokens[i], 'time', `${tokens[i].slice(0, 2)}日${tokens[i].slice(2, 4)}時〜${tokens[i].slice(5, 7)}日${tokens[i].slice(7, 9)}時UTC`); i++;
      g = { type, from: p[0], to: p[1] };
    } else {
      out.unparsed.push(t); push(t, 'unparsed', '未解析'); i++; continue;
    }
    const r = readConditions(tokens, i, STOP);
    Object.assign(g, r.c); out.parts.push(...r.parts); out.unparsed.push(...r.unparsed);
    i = r.i; out.changes.push(g);
  }
  return out;
}
/* TAF の期間は 24時 がある(ddhh の hh=24 は翌日0時) */
function periodTime(dd, hh, ref) {
  if (hh === 24) return new Date(resolveDay(dd, 0, 0, ref).getTime() + 24 * 3600e3);
  return resolveDay(dd, hh, 0, ref);
}

/* ───── 状態の合成と派生値 ───── */
/* TAF の変化群は、書かれた要素だけを上書きする(CAVOK は視程・雲・天気をまとめて上書き) */
export function mergeConditions(base, g) {
  const c = { ...base };
  for (const k of ['wind', 'vis', 'wx', 'clouds', 'cavok', 'nsc', 'rvr']) if (g[k] !== undefined) c[k] = g[k];
  if (g.cavok) { c.vis = g.vis; c.clouds = []; c.wx = []; }
  else if (g.vis !== undefined || g.clouds !== undefined || g.wx !== undefined) {
    /* CAVOK の後に視程や雲が書かれたら、CAVOK は取り消し */
    if (base.cavok && !g.cavok) c.cavok = false;
  }
  return c;
}

/* 雲底(シーリング)：BKN/OVC/VV の一番低い層。欠測層があれば null+missing */
export function ceiling(c) {
  if (c.cavok || (Array.isArray(c.clouds) && c.clouds.length === 0)) return { ft: null, none: true };
  if (!Array.isArray(c.clouds)) return { ft: null, missing: true };
  const layers = c.clouds.filter(l => l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV');
  const miss = c.clouds.some(l => l.missing && (l.cover == null || l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV'));
  const known = layers.filter(l => l.base != null).map(l => l.base);
  if (miss) return { ft: known.length ? Math.min(...known) : null, missing: true };
  if (!known.length) return { ft: null, none: true };
  return { ft: Math.min(...known) };
}

/* 横風成分：一番横風が小さくなる滑走路で計算する(ヘリは使う向きを選べるため)。
   風向不定(VRB)は最悪(全成分が横風)とみなす */
export function crosswind(wind, runways) {
  if (!wind || wind.missing || !runways || !runways.length) return null;
  const spd = Math.max(wind.spd || 0, wind.gust || 0);
  if (spd === 0) return { kt: 0, head: 0, rwy: runways[0] };
  if (wind.vrb) return { kt: spd, rwy: null, vrb: true };
  /* 変動幅(例 330V040)があれば、その範囲で一番厳しい向きも見る */
  const dirs = [wind.dir];
  if (wind.varFrom != null) {
    const span = ((wind.varTo - wind.varFrom) + 360) % 360;
    for (let k = 0; k <= span; k += 10) dirs.push((wind.varFrom + k) % 360);
    dirs.push(wind.varTo);
  }
  let best = null;
  for (const r of runways) {
    let worst = null;
    for (const d of dirs) {
      const a = (d - r) * Math.PI / 180;
      const x = Math.abs(spd * Math.sin(a)), h = spd * Math.cos(a);
      if (!worst || x > worst.kt) worst = { kt: x, head: h, rwy: r, dir: d };
    }
    if (!best || worst.kt < best.kt) best = worst;
  }
  best.kt = Math.round(best.kt * 10) / 10;
  best.head = Math.round(best.head * 10) / 10;
  return best;
}

export function windMax(w) {
  if (!w || w.missing) return null;
  return Math.max(w.spd || 0, w.gust || 0);
}
