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
export function systemPrompt({ learn = false } = {}) {
  return [
    'あなたはヘリコプターの有視界・低高度飛行のための気象解説者です。平易な日本語で、操縦士が声に出して確認できる文章を作ります。',
    '優先順位：①気象庁の公式解説文 ②アプリが計算した判定結果・数値 ③図の読み取り。①②と矛盾する読み取りは採用せず unknowns に書く。',
    '読めない値は推測しない。各 talk には必ず basis（どの資料のどの値か）を付ける。',
    '飛行の可否は断定しない（「注意」「要確認」まで）。最終判断は予報官ブリーフィングと規定に従う、という前提で書く。',
    '資料が食い違うときは結論を出さず、「予報官に確認すること」として cautions に書く。',
    learn ? '学習モード：トラフ・正渦度・湿数・逆転層などの用語が出たら、1文で意味を補う。' : '用語の解説は不要。',
    '入力の「地点A」などは伏せた飛行場・地点名。そのまま「地点A」と書く。',
    `出力は次のJSONだけを返す（前後に説明やコードフェンスを付けない）：\n${AI_SCHEMA}`,
    'screen の番号：0ホーム 1総観 2レーダー実況 3レーダー予想 4経路 5飛行場 6鉛直構造 7明日の予想 8週間 9まとめ。',
  ].join('\n');
}

/* 送るデータ（できるだけ小さく。数値予報は3時間おきに間引く） */
export function buildPayload(ctx) {
  const { win, judges = {}, sigs = [], airfields = [], nwp = null, route = null, passes = [], office = null, learn = false } = ctx;
  const fJ = d => (d ? new Date(d).toISOString() : null);
  const p = {
    window: { from: fJ(win?.from), to: fJ(win?.to), note: '時刻はUTC。表示はJST＝UTC+9' },
    judges,
    signals: sigs.map(s => ({ title: s.title, level: s.level, text: s.text, basis: s.basis?.map(b => b.what) })),
    airfields: airfields.map(a => ({
      icao: a.icao, metar: a.metar, taf: a.taf, rule: a.rule,
      metarRaw: a.p?.raw || null, tafRaw: a.t?.raw || null,
    })),
    office,
    learn,
  };
  if (nwp?.times?.length) {
    const rows = [];
    for (let i = 0; i < nwp.times.length; i += 3) {
      if (win && (nwp.times[i] < win.from || nwp.times[i] > new Date(win.to.getTime() + 12 * 3600e3))) continue;
      rows.push({
        t: fJ(nwp.times[i]),
        baseFt: nwp.est?.baseFt?.[i] ?? null, windKt: round(nwp.sfc?.windSpd?.[i]), windDir: round(nwp.sfc?.windDir?.[i]),
        tempC: round(nwp.sfc?.t?.[i], 1), dewC: round(nwp.sfc?.td?.[i], 1), precipMmh: round(nwp.sfc?.precip?.[i], 1),
        mslp: round(nwp.sfc?.mslp?.[i], 1), ssi: nwp.est?.ssi?.[i] ?? null, cape: nwp.est?.cape?.[i] ?? null,
        freezingFt: nwp.an?.[i]?.freezingFt ?? null,
      });
    }
    p.nwp = { note: '数値予報（気象庁モデル）の要約。雲底は推定値', rows };
  }
  if (route?.rows?.length) {
    p.route = route.rows.map(r => ({
      from: r.legFrom, to: r.legTo, t: fJ(r.tMid), level: r.level,
      reasons: r.items?.filter(i => i.level !== 'go').map(i => `${i.label} ${i.value}`),
    }));
  }
  if (passes?.length) p.passes = passes.map(x => ({ name: x.name, elevFt: x.elevFt, level: x.level, reasons: x.reasons }));
  return p;
}
const round = (v, n = 0) => (v == null || !Number.isFinite(+v) ? null : Math.round(+v * 10 ** n) / 10 ** n);

/* 手貼り用の文章（システム＋データを1つにまとめる） */
export function buildPrompt(ctx) {
  const { data, map } = anonymize(buildPayload(ctx), { enabled: ctx.anonymize !== false });
  const text = [
    systemPrompt({ learn: ctx.learn }),
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
