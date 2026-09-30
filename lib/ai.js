/* AI解説の入出力（純粋関数・DOMを使わない）
   ─────────────────────────────────────────
   - アプリが集めた判定・シグナル・数値予報の要約から、AIに渡す文章（プロンプト）を作る
   - AIの返事（JSON）を読み取って、画面に出せる形にする
   - つなぎ方は2通り。どちらも同じ入出力を使う：
     ① 手貼り：プロンプトをコピー → Claude等に貼る → 返事を貼り戻す（無料。開発中と、AIを使わない日）
     ② 中継：Vercelの中継経由でClaude API（フェーズ3の公開後。費用は月500円まで）
   - ⚠ 送る前に飛行場コード・地点名を「地点A」等に置き換える（仕様書 第4章「安全・運用」）
   テスト: tests/ai.test.mjs */

export const AI_SCHEMA = `{
  "summary3": ["総観場（1文）", "影響（1文）", "ヘリ運航（1文）"],
  "sections": [{"screen": 1, "talk": "話すポイント1〜2文", "basis": ["根拠：どの資料のどの値か"], "confidence": "high|mid|low"}],
  "cautions": ["時間帯と要素（雲底低下・強風・雷など）"],
  "unknowns": ["資料から読み取れなかった項目"]
}`;

/* 飛行場コードや地点名を伏せる。戻り値の map で元に戻す */
export function anonymize(payload, { enabled = true } = {}) {
  if (!enabled) return { data: payload, map: {} };
  const map = {}, rev = {};
  let n = 0;
  const label = code => {
    if (!rev[code]) { rev[code] = `地点${String.fromCharCode(65 + n)}`; map[rev[code]] = code; n++; }
    return rev[code];
  };
  const codes = new Set();
  for (const a of payload.airfields || []) if (a.icao) codes.add(a.icao);
  for (const r of payload.route || []) { if (r.from) codes.add(r.from); if (r.to) codes.add(r.to); }
  for (const p of payload.passes || []) if (p.name) codes.add(p.name);
  for (const c of codes) label(c);
  const sub = s => {
    let t = String(s ?? '');
    for (const [code, lab] of Object.entries(rev)) t = t.split(code).join(lab);
    return t;
  };
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === 'lat' || k === 'lon' || k === 'lng' ? undefined : walk(x);
      return o;
    }
    return typeof v === 'string' ? sub(v) : v;
  };
  return { data: walk(payload), map };
}
/* AIの返事の中の「地点A」を元のコードに戻す */
export function deanonymize(obj, map) {
  if (!map || !Object.keys(map).length) return obj;
  const sub = s => { let t = String(s ?? ''); for (const [lab, code] of Object.entries(map)) t = t.split(lab).join(code); return t };
  const walk = v => Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : (typeof v === 'string' ? sub(v) : v));
  return walk(obj);
}

/* システムプロンプト（仕様書 第4章「システムプロンプトの要点」） */
export function systemPrompt({ learn = false, compact = false } = {}) {
  /* compact：スマホからリンクで渡せるように短くした版（守らせる決まりは同じ） */
  if (compact) {
    return [
      'ヘリの有視界・低高度飛行向けの気象解説者として、操縦士が読み上げられる平易な日本語で書く。',
      '優先順位は 公式解説文＞アプリの判定・数値＞図の読み取り。値は推測せず、talk には必ず basis（どの値か）を付ける。',
      '可否は断定しない（注意・要確認まで）。資料が食い違うときは結論を出さず cautions に「気象担当者に確認」と書く。',
      'coverage.imageOnly の画面（天気図・レーダー・衛星）は画像が無いので talk を作らず、unknowns にも書かない。降水は nwp.precipMmh、週間は weekly の数値で話す。',
      'nwpSummary は極値と時刻。間引いた rows と違っても矛盾ではなく、極値を優先する。',
      'unknowns は「判定に必要なのに欠けている値」だけ（例：METAR未取得、TAF無し、ミニマ未設定）。',
    'metarValues / tafValues は電文から読み取った値。src が「手入力」なら写真から取り込んだ電文で、obsAgeMin が大きいときは古い実況として注意する。',
      'overview は気象庁の概況文（公式）。これが最優先で、数値の当てはめと食い違うときは概況文を採る。',
      'field は全国の気圧場から拾った高気圧・低気圧の中心と、本邦の覆われ方・晴天ベースかどうか。screen 1 は「本邦全域が高気圧に覆われて晴天ベース」のように全国→飛行する地方の順で書く。',
      'synoptic は数地点の気圧から機械的に当てはめた気圧配置（pattern / 変化 / trend=良くなる・悪くなる・変わらない / front）。screen 1 の talk はこれを土台に、関東甲信越を中心に「配置」「この先の振れ方」「前線の影響」の順で書く。前線の位置は天気図で確かめる前提にする。',
      learn ? '用語（トラフ・湿数・逆転層など）は1文で補う。' : '',
      '「地点A」等はそのまま使う。screen番号：0ホーム 1総観 2レーダー実況 3レーダー予想 4経路 5飛行場 6鉛直構造 7明日 8週間 9まとめ。',
      `次のJSONだけを返す：${AI_SCHEMA}`,
    ].filter(Boolean).join('\n');
  }
  return [
    'あなたはヘリコプターの有視界・低高度飛行のための気象解説者です。平易な日本語で、操縦士が声に出して確認できる文章を作ります。',
    '優先順位：①気象庁の公式解説文 ②アプリが計算した判定結果・数値 ③図の読み取り。①②と矛盾する読み取りは採用せず unknowns に書く。',
    '読めない値は推測しない。各 talk には必ず basis（どの資料のどの値か）を付ける。',
    '飛行の可否は断定しない（「注意」「要確認」まで）。最終判断は公式の気象ブリーフィングと運航規定に従う、という前提で書く。',
    '資料が食い違うときは結論を出さず、「気象担当者に確認すること」として cautions に書く。',
    learn ? '学習モード：トラフ・正渦度・湿数・逆転層などの用語が出たら、1文で意味を補う。' : '用語の解説は不要。',
    '入力の「地点A」などは伏せた飛行場・地点名。そのまま「地点A」と書く。',
    'metarValues / tafValues は電文から読み取った値（src が「手入力」なら写真から取り込んだもの）。obsAgeMin が大きい実況は古いものとして扱う。',
    'overview は気象庁が発表した概況文（公式の文章）。気圧配置と前線の位置はこれを最優先で使い、数値の当てはめ（field・synoptic）と食い違うときは概況文を採って、その旨を書く。',
    'field は全国80点の海面気圧から拾った高気圧・低気圧の中心（位置の呼び名・中心気圧・進む向きと速さ）と、本邦の覆われ方（cover）、晴天ベースかどうか（sky）。天気図の画像の代わりに、天気図のもとになる数値を読んだもの。',
    'screen 1 の talk は「本邦のほぼ全域が高気圧に覆われ、晴天ベースで推移する見込み」のように、まず全国の気圧配置と天気の傾向を述べ、そのあと飛行する地方（synoptic）に絞る。',
    'synoptic は、関東甲信越を囲む数地点の海面気圧・風・850hPa気温から機械的に当てはめた気圧配置。now（今の配置）・later（時間帯の後半に変わる配置）・trend（improving 良くなる／worsening 悪くなる／steady 変わらない）・front（前線・気圧の谷の通過）・basis（地点ごとの気圧差）が入っている。',
    'screen 1 の talk は、この synoptic を土台に、関東甲信越を中心として「今の気圧配置」「この先どう動いて天気が良くなるのか悪くなるのか」「前線・気圧の谷の影響」の順で、操縦士が読み上げられる形で書く。basis の気圧差をそのまま根拠に入れる。',
    'synoptic は数値からの当てはめなので、前線の位置や種類は断定せず「天気図で確かめる」と添える。synoptic があるときは screen 1 を imageOnly の扱いにしない。',
    'coverage に、どの画面の資料が入力に入っているか（sent）と、画像なので入力に入っていないか（imageOnly）が書いてある。',
    'imageOnly の画面（天気図・レーダー・衛星・予想図）は、画像を見ないと分からないので talk を作らない。unknowns にも書かない（「資料が無い」と繰り返さない）。',
    '降水の話は数値予報の precipMmh で、週間の話は weekly の数値で書く。レーダーそのものの話はしない。',
    'unknowns に書くのは「判定に必要なのに欠けている値」だけにする（例：METARが取得できていない、TAFが無い、ミニマ未設定）。',
    'nwpSummary は数値予報の極値（最小の気温露点差、最大風、最大降水、最低の推定雲底）とその時刻。rows は間引いた値なので、極値と rows が違っても矛盾ではない。極値を優先して書く。',
    `出力は次のJSONだけを返す（前後に説明やコードフェンスを付けない）：\n${AI_SCHEMA}`,
    'screen の番号：0ホーム 1総観 2レーダー実況 3レーダー予想 4経路 5飛行場 6鉛直構造 7明日の予想 8週間 9まとめ。',
  ].join('\n');
}

/* 送るデータ（できるだけ小さく。数値予報は3時間おきに間引く） */
export function buildPayload(ctx) {
  const { win, judges = {}, sigs = [], airfields = [], nwp = null, route = null, passes = [], office = null,
    fcst = null, weekly = null, synoptic = null, field = null, overview = null, learn = false, compact = false } = ctx;
  const fJ = d => (d ? new Date(d).toISOString() : null);
  const p = {
    window: { from: fJ(win?.from), to: fJ(win?.to), note: '時刻はUTC。表示はJST＝UTC+9' },
    /* compact：判定は「なし」を省き、シグナルは題と根拠だけにする */
    judges: compact ? Object.fromEntries(Object.entries(judges).filter(([k, v]) => v !== 'none' || k === 'total')) : judges,
    signals: sigs.map(s => (compact
      ? { title: s.title, level: s.level, basis: s.basis?.map(b => b.what) }
      : { title: s.title, level: s.level, text: s.text, basis: s.basis?.map(b => b.what) })),
    /* compact：電文の原文は外すが、読み取った値（雲底・視程・風など）は必ず渡す。
       貼り付けた電文（手入力）も中継のものと同じように入る */
    airfields: airfields.map(a => ({
      icao: a.icao, metar: a.metar, taf: a.taf, rule: a.rule,
      metarValues: a.metarSummary || null, tafValues: a.tafSummary || null,
      ...(compact ? {} : { metarRaw: a.p?.raw || null, tafRaw: a.t?.raw || null }),
    })),
    office,
    learn,
    /* どの画面の資料が入力に入っているか。画像だけの資料は入れられない（手貼りのため） */
    coverage: {
      sent: compact ? [4, 5, 6, 7, 8, 9] : ['0 ホーム（判定の一覧）', '4 経路（区間の判定・数値）', '5 飛行場（METAR/TAFの判定と原文）',
        '6 鉛直構造（数値予報の要約・安定度・推定雲底）', '7 府県天気予報の文', '8 週間予報の数値', '9 総合解析のシグナル'],
      imageOnly: compact ? [1, 2, 3] : ['1 総観（地上・高層天気図、衛星）', '2 レーダー実況', '3 レーダー予想', '7 予想天気図・電計資料', '8 週間天気図'],
      note: '画像の資料（天気図・レーダー・衛星・予想図）は入力に入っていない。降水はnwpのprecipMmh、週間はweeklyの数値で話す'
        + (synoptic?.now || field?.cover || overview?.text ? '。画面1は overview（概況文）・field（全国の気圧場）・synoptic（地方の気圧配置）があるので話せる' : ''),
    },
  };
  /* 気象庁の概況文（公式）。画面1の話の一番の土台 */
  if (overview?.text) p.overview = {
    office: overview.office || null, at: fJ(overview.at),
    text: compact ? String(overview.text).replace(/\s+/g, ' ').trim().slice(0, 300) : overview.text,
  };
  /* 全国の気圧場（天気図のもとになる数値から拾った高低気圧の中心） */
  if (field?.cover) p.field = {
    cover: field.cover.label, whole: field.cover.whole,
    sky: field.sky?.label || null, skyLater: field.skyLater?.label || null,
    centers: (field.centers || []).map(c => ({
      type: c.type === 'H' ? '高気圧' : '低気圧', place: c.place, hPa: c.hPa,
      move: c.move?.text || null, dHPa: c.move?.dHPa ?? null,
    })),
    ridge: field.ridge ? `${field.ridge.place}${field.ridge.edge ? '方面' : ''}から高気圧 ${field.ridge.hPa}hPa` : null,
    homeArea: field.homeArea || null, homeSky: field.homeSky ? `${field.homeArea}の平均雲量 ${field.homeSky.cloudPct}%` : null,
    basis: compact ? field.basis?.slice(0, 4) : field.basis,
    note: field.note,
  };
  /* 気圧配置（lib/synoptic.js の当てはめ）。画面1の話の土台にする */
  if (synoptic?.now) p.synoptic = {
    area: synoptic.area,
    now: synoptic.now.label, later: synoptic.later?.label || null,
    trend: synoptic.trend?.key || null, trendJa: synoptic.trend?.label || null,
    front: synoptic.front ? { t: fJ(synoptic.front.when), kind: synoptic.front.kind, cold: synoptic.front.cold } : null,
    basis: compact ? synoptic.basis?.slice(0, 5) : synoptic.basis,
    note: synoptic.note,
  };
  /* 府県天気予報（今日・明日の天気と風の文）と週間天気予報。compact は日数を絞る */
  if (fcst?.length) p.fcst = compact ? fcst.slice(0, 2) : fcst;
  if (weekly?.length) p.weekly = (compact ? weekly.slice(0, 5) : weekly)
    .map(w => (compact ? { t: String(w.t).slice(5, 10), weather: w.weather, pop: w.pop, reliability: w.reliability } : w));
  if (nwp?.times?.length) {
    const rows = [];
    const step = compact ? 6 : 3;
    for (let i = 0; i < nwp.times.length; i += step) {
      if (win && (nwp.times[i] < win.from || nwp.times[i] > new Date(win.to.getTime() + 12 * 3600e3))) continue;
      rows.push({
        t: fJ(nwp.times[i]),
        baseFt: nwp.est?.baseFt?.[i] ?? null, windKt: round(nwp.sfc?.windSpd?.[i]), windDir: round(nwp.sfc?.windDir?.[i]),
        tempC: round(nwp.sfc?.t?.[i], 1), dewC: round(nwp.sfc?.td?.[i], 1), precipMmh: round(nwp.sfc?.precip?.[i], 1),
        mslp: round(nwp.sfc?.mslp?.[i], 1), ssi: nwp.est?.ssi?.[i] ?? null, cape: nwp.est?.cape?.[i] ?? null,
        freezingFt: nwp.an?.[i]?.freezingFt ?? null,
      });
    }
    p.nwp = { note: '数値予報（気象庁モデル）の要約。雲底は推定値', rows, summary: nwpSummary(nwp, win) };
  }
  if (route?.rows?.length) {
    /* compact：注意以上の区間だけ送る */
    p.route = (compact ? route.rows.filter(r => r.level !== 'go') : route.rows).map(r => ({
      from: r.legFrom, to: r.legTo, t: fJ(r.tMid), level: r.level,
      reasons: r.items?.filter(i => i.level !== 'go').map(i => `${i.label} ${i.value}`),
    }));
  }
  if (passes?.length) p.passes = passes.map(x => ({ name: x.name, elevFt: x.elevFt, level: x.level, reasons: x.reasons }));
  return p;
}
const round = (v, n = 0) => (v == null || !Number.isFinite(+v) ? null : Math.round(+v * 10 ** n) / 10 ** n);

/* 判定する時間帯の極値（間引いた rows では見えない最悪値を、時刻つきで渡す） */
export function nwpSummary(nwp, win) {
  const out = {};
  const inWin = i => !win || (nwp.times[i] >= win.from && nwp.times[i] <= win.to);
  const iso = i => nwp.times[i].toISOString();
  let best = null;
  for (let i = 0; i < nwp.times.length; i++) {
    if (!inWin(i)) continue;
    const t = nwp.sfc?.t?.[i], td = nwp.sfc?.td?.[i];
    if (t == null || td == null) continue;
    if (!best || t - td < best.v) best = { v: round(t - td, 1), t: iso(i) };
  }
  if (best) out.minSpreadC = best;
  const pick = (arr, cmp) => {
    let b = null;
    for (let i = 0; i < (arr?.length || 0); i++) {
      if (!inWin(i) || arr[i] == null) continue;
      if (!b || cmp(arr[i], b.v)) b = { v: round(arr[i], 1), t: iso(i) };
    }
    return b;
  };
  const maxW = pick(nwp.sfc?.windSpd, (a, b) => a > b); if (maxW) out.maxWindKt = maxW;
  const maxP = pick(nwp.sfc?.precip, (a, b) => a > b); if (maxP) out.maxPrecipMmh = maxP;
  const minB = pick(nwp.est?.baseFt, (a, b) => a < b); if (minB) out.minBaseFt = minB;
  const maxC = pick(nwp.est?.cape, (a, b) => a > b); if (maxC) out.maxCape = maxC;
  const minS = pick(nwp.est?.ssi, (a, b) => a < b); if (minS) out.minSsi = minS;
  return out;
}

/* 手貼り用の文章（システム＋データを1つにまとめる） */
export function buildPrompt(ctx) {
  const { data, map } = anonymize(buildPayload(ctx), { enabled: ctx.anonymize !== false });
  const text = [
    systemPrompt({ learn: ctx.learn, compact: ctx.compact }),
    '',
    '--- ここからデータ（JSON） ---',
    JSON.stringify(data, null, 1),
    '--- データここまで ---',
    '',
    '上のデータだけを使って、指定のJSONを返してください。',
  ].join('\n');
  return { text, map, data };
}

/* AIの返事を読み取る。コードフェンスや前後の文章が付いていても拾う */
export function parseAiJson(text, { map = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '空です' };
  let body = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1];
  else {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) body = raw.slice(s, e + 1);
  }
  let o;
  try { o = JSON.parse(body) } catch (e) { return { ok: false, error: 'JSONとして読めません：' + e.message } }
  if (!o || typeof o !== 'object') return { ok: false, error: 'JSONの形が違います' };
  const arr = v => (Array.isArray(v) ? v : []);
  const out = {
    summary3: arr(o.summary3).slice(0, 3).map(String),
    sections: arr(o.sections).map(s => ({
      screen: Number.isInteger(s?.screen) && s.screen >= 0 && s.screen <= 9 ? s.screen : null,
      talk: String(s?.talk ?? ''),
      basis: arr(s?.basis).map(String),
      confidence: ['high', 'mid', 'low'].includes(s?.confidence) ? s.confidence : 'mid',
    })).filter(s => s.screen != null && s.talk),
    cautions: arr(o.cautions).map(String),
    unknowns: arr(o.unknowns).map(String),
  };
  if (!out.summary3.length && !out.sections.length) return { ok: false, error: 'summary3 も sections も入っていません' };
  const warn = [];
  if (out.summary3.length !== 3) warn.push(`summary3 が${out.summary3.length}行（3行の想定）`);
  const noBasis = out.sections.filter(s => !s.basis.length).map(s => s.screen);
  if (noBasis.length) warn.push(`根拠(basis)が無い画面：${noBasis.join('・')}`);
  return { ok: true, data: map ? deanonymize(out, map) : out, warn };
}

/* 同じ資料で作り直さないためのキー（発表時刻の組み合わせ） */
export function cacheKey(ctx) {
  const parts = [
    ctx.win?.from?.toISOString?.() || '', ctx.win?.to?.toISOString?.() || '',
    ...(ctx.airfields || []).map(a => `${a.icao}:${a.p?.time?.toISOString?.() || ''}:${a.t?.issue?.toISOString?.() || ''}`),
    ctx.nwp?.got ? new Date(ctx.nwp.got).toISOString().slice(0, 13) : '',
    ctx.route?.rows?.length ? `r${ctx.route.rows.length}` : '',
  ];
  return parts.join('|');
}
