/* node --test tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, deanonymize, buildPayload, buildPrompt, parseAiJson, systemPrompt, cacheKey, nwpSummary } from '../lib/ai.js';

const WIN = { from: new Date(Date.UTC(2026, 8, 21, 0)), to: new Date(Date.UTC(2026, 8, 21, 3)) };
const CTX = {
  win: WIN,
  judges: { total: 'caution', 5: 'caution' },
  sigs: [{ title: '霧・低い雲', level: 'caution', text: '視程が下がる可能性。', basis: [{ what: '気温と露点の差 1.2℃' }] }],
  airfields: [{ icao: 'RJTC', metar: 'caution', taf: 'go', rule: 'VMC', p: { raw: 'METAR RJTC 210000Z 36006KT 9999 FEW020 20/19 Q1013', time: WIN.from }, t: { raw: 'TAF RJTC 202305Z 2100/2124 36006KT 9999 FEW020', issue: WIN.from } }],
  nwp: {
    times: [0, 1, 2, 3, 4, 5].map(h => new Date(Date.UTC(2026, 8, 21, h))),
    sfc: { t: [20, 20, 21, 22, 23, 23], td: [19, 19, 19, 18, 18, 18], windSpd: [5, 6, 8, 10, 12, 12], windDir: [180, 190, 200, 210, 220, 230], precip: [0, 0, 0.5, 1, 0, 0], mslp: [1013, 1012, 1011, 1010, 1010, 1011] },
    est: { baseFt: [800, 900, 1500, 2500, 3000, 3000], ssi: [2, 1, 0, -1, 0, 1], cape: [0, 100, 400, 900, 300, 0] },
    an: [{ freezingFt: 12000 }, {}, {}, {}, {}, {}],
    got: new Date(Date.UTC(2026, 8, 21, 0, 10)),
  },
  route: { rows: [{ legFrom: 'RJTC', legTo: '雁坂峠', tMid: WIN.from, level: 'caution', items: [{ label: '雲底(推定)', value: '2000ft MSL', level: 'caution' }, { label: '風', value: '10kt', level: 'go' }] }] },
  learn: false,
};

test('匿名化：飛行場コードと地点名を「地点A」等に置き換え、座標は落とす', () => {
  const { data, map } = anonymize(buildPayload(CTX));
  const json = JSON.stringify(data);
  assert.equal(json.includes('RJTC'), false, 'ICAOが残っている');
  assert.equal(json.includes('雁坂峠'), false, '地点名が残っている');
  assert.match(json, /地点[AB]/);
  /* 電文の中のコードも置き換わる */
  assert.match(data.airfields[0].metarRaw, /METAR 地点[AB] 210000Z/);
  /* 元に戻せる */
  const back = deanonymize({ sections: [{ talk: `${Object.keys(map)[0]}は雲が低い` }] }, map);
  assert.match(back.sections[0].talk, /RJTC|雁坂峠/);
  /* 匿名化を切ればそのまま */
  assert.match(JSON.stringify(anonymize(buildPayload(CTX), { enabled: false }).data), /RJTC/);
});

test('送るデータ：数値予報は3時間おきに間引き、判定とシグナルを入れる', () => {
  const p = buildPayload(CTX);
  assert.equal(p.nwp.rows.length <= 3, true, `行数 ${p.nwp.rows.length}`);
  assert.equal(p.nwp.rows[0].baseFt, 800);
  assert.equal(p.signals[0].title, '霧・低い雲');
  assert.equal(p.judges.total, 'caution');
  assert.equal(p.route[0].reasons.length, 1);  /* GOの項目は入れない */
  assert.equal(p.airfields[0].metar, 'caution');
});

test('プロンプト：役割・優先順位・JSONの形が入る', () => {
  const { text } = buildPrompt(CTX);
  assert.match(text, /ヘリコプター/);
  assert.match(text, /公式解説文/);
  assert.match(text, /可否は断定しない/);
  assert.match(text, /summary3/);
  assert.match(text, /--- ここからデータ（JSON） ---/);
  assert.equal(text.includes('RJTC'), false);
  /* 学習モードONで用語の補足を求める */
  assert.match(systemPrompt({ learn: true }), /学習モード/);
  assert.equal(/学習モード/.test(systemPrompt({ learn: false })), false);
});

test('返事の読み取り：コードフェンスや前後の文章があっても拾う', () => {
  const body = JSON.stringify({
    summary3: ['前線が接近', '午後から雨', '雲底が下がる'],
    sections: [{ screen: 1, talk: '上空にトラフ。', basis: ['500hPa 渦度'], confidence: 'high' },
      { screen: 5, talk: '地点Aは朝に霧の可能性。', basis: ['気温と露点の差1.2℃'], confidence: 'mid' }],
    cautions: ['朝方の視程'], unknowns: [],
  });
  const r = parseAiJson('はい、こちらです。\n```json\n' + body + '\n```\n以上です。');
  assert.equal(r.ok, true);
  assert.equal(r.data.summary3.length, 3);
  assert.equal(r.data.sections.length, 2);
  assert.equal(r.data.sections[0].confidence, 'high');
  /* 匿名化の対応表を渡すと元のコードに戻る */
  const r2 = parseAiJson(body, { map: { 地点A: 'RJTC' } });
  assert.match(r2.data.sections[1].talk, /RJTC/);
});

test('返事の読み取り：おかしな返事は理由つきで断る／足りない点は警告', () => {
  assert.equal(parseAiJson('').ok, false);
  assert.equal(parseAiJson('雲が低いので注意してください').ok, false);
  assert.match(parseAiJson('{壊れたJSON').error, /読めません/);
  assert.equal(parseAiJson('{"foo":1}').ok, false);
  /* screen が範囲外・talk が空の section は落とす */
  const r = parseAiJson(JSON.stringify({ summary3: ['a', 'b'], sections: [{ screen: 99, talk: 'x' }, { screen: 3, talk: '' }, { screen: 3, talk: '雨雲が近い' }] }));
  assert.equal(r.ok, true);
  assert.equal(r.data.sections.length, 1);
  assert.match(r.warn.join(), /summary3 が2行/);
  assert.match(r.warn.join(), /根拠\(basis\)が無い画面：3/);
});

test('キャッシュのキー：同じ資料なら同じ、電文が変われば変わる', () => {
  const k1 = cacheKey(CTX);
  assert.equal(cacheKey({ ...CTX }), k1);
  const ctx2 = { ...CTX, airfields: [{ ...CTX.airfields[0], p: { ...CTX.airfields[0].p, time: new Date(Date.UTC(2026, 8, 21, 1)) } }] };
  assert.notEqual(cacheKey(ctx2), k1);
});

test('compact：スマホで貼りやすいように短くする（電文の原文を外し、間引きを粗く）', () => {
  const full = buildPrompt(CTX).text, small = buildPrompt({ ...CTX, compact: true }).text;
  assert.ok(small.length < full.length, `${small.length} < ${full.length}`);
  /* 電文の原文（観測時刻や風の群）が入っていない。coverageの説明文にMETARの語は出てよい */
  assert.equal(/210000Z|36006KT/.test(small), false, '電文の原文が残っている');
  assert.equal(buildPayload({ ...CTX, compact: true }).airfields[0].metarRaw, undefined);
  /* 判定・シグナル・雲底は残す */
  assert.match(small, /霧・低い雲/);
  assert.match(small, /baseFt/);
  /* 経路は注意以上の区間だけ */
  const p = buildPayload({ ...CTX, compact: true });
  assert.equal(p.route.length, 1);
  assert.equal(buildPayload({ ...CTX, compact: true, route: { rows: [{ legFrom: 'A', legTo: 'B', level: 'go', items: [] }] } }).route.length, 0);
  /* 判定の「なし」は省き、週間は5日ぶんに絞る */
  const weekly = [1, 2, 3, 4, 5, 6, 7].map(d => ({ t: `2026-09-2${d}T00:00:00+09:00`, area: '東京地方', weather: '晴れ', pop: '10', reliability: 'A', tmax: '25', tmin: '18' }));
  const c = buildPayload({ ...CTX, compact: true, judges: { total: 'caution', 5: 'caution', 2: 'none' }, weekly });
  assert.equal(c.judges['2'], undefined);
  assert.equal(c.judges['5'], 'caution');
  assert.equal(c.weekly.length, 5);
  assert.equal(c.weekly[0].tmax, undefined);
  assert.equal(c.signals[0].text, undefined);
});

test('coverage：画像だけの資料は「入っていない」と伝え、無いものを並べさせない', () => {
  const p = buildPayload(CTX);
  assert.ok(p.coverage.sent.some(x => x.startsWith('6')));
  assert.ok(p.coverage.imageOnly.some(x => x.startsWith('2')));
  const sp = systemPrompt({});
  assert.match(sp, /imageOnly/);
  assert.match(sp, /unknowns にも書かない/);
  assert.match(sp, /precipMmh/);
});

test('極値：間引いた行では見えない最悪値を時刻つきで渡す', () => {
  const s = nwpSummary(CTX.nwp, { from: new Date(Date.UTC(2026, 8, 21, 0)), to: new Date(Date.UTC(2026, 8, 21, 5)) });
  /* 気温露点差の最小は 3時（22-18=4）ではなく 0〜2時の 1℃ */
  assert.equal(s.minSpreadC.v, 1);
  assert.equal(s.minSpreadC.t, '2026-09-21T00:00:00.000Z');
  assert.equal(s.maxWindKt.v, 12);
  assert.equal(s.maxPrecipMmh.v, 1);
  assert.equal(s.minBaseFt.v, 800);
  assert.equal(s.maxCape.v, 900);
  assert.equal(s.minSsi.v, -1);
  /* 送るデータにも入る */
  assert.ok(buildPayload(CTX).nwp.summary.minBaseFt);
});

test('府県天気予報と週間予報も送る（画面7・8の話ができるように）', () => {
  const p = buildPayload({ ...CTX,
    fcst: [{ t: '2026-09-21T00:00:00+09:00', area: '東京地方', weather: 'くもり', wind: '北の風' }],
    weekly: [{ t: '2026-09-22T00:00:00+09:00', area: '東京地方', weather: '晴れ', pop: '20', reliability: 'A', tmax: '25', tmin: '18' }] });
  assert.equal(p.fcst.length, 1);
  assert.equal(p.weekly[0].reliability, 'A');
  /* 無ければ入れない */
  assert.equal(buildPayload(CTX).weekly, undefined);
});

test('短いシステムプロンプト：決まりは残したまま短くなる', () => {
  const full = systemPrompt({}), small = systemPrompt({ compact: true });
  assert.ok(small.length < full.length * 0.8, `${small.length} < ${full.length}`);
  for (const must of [/basis/, /断定しない/, /気象担当者に確認/, /imageOnly/, /summary3/, /screen番号|screen の番号/]) assert.match(small, must);
  assert.match(systemPrompt({ compact: true, learn: true }), /用語/);
});

test('貼り付けた電文（手入力）の値も送る。短く送るモードでも数値は残る', () => {
  const ctx = { ...CTX, airfields: [{ ...CTX.airfields[0],
    metarSummary: { src: '手入力', obsAgeMin: 25, ceilFt: 900, visM: 4000, windDir: 340, windKt: 12, wx: ['-RA'], tempC: 18, dewC: 17 },
    tafSummary: { src: '中継', worst: 'caution', firstBad: { t: '2026-09-21T02:00:00.000Z', level: 'caution', why: ['TEMPO 視程 3000m'] }, changes: ['BECMG', 'TEMPO'] } }] };
  for (const compact of [false, true]) {
    const p = buildPayload({ ...ctx, compact });
    assert.equal(p.airfields[0].metarValues.ceilFt, 900, `compact=${compact}`);
    assert.equal(p.airfields[0].metarValues.src, '手入力');
    assert.equal(p.airfields[0].tafValues.firstBad.level, 'caution');
  }
  /* 原文は compact のときだけ外れる */
  assert.ok(buildPayload({ ...ctx, compact: false }).airfields[0].metarRaw);
  assert.equal(buildPayload({ ...ctx, compact: true }).airfields[0].metarRaw, undefined);
  /* 匿名化しても値は残る */
  const { data } = anonymize(buildPayload({ ...ctx, compact: true }));
  assert.equal(data.airfields[0].metarValues.ceilFt, 900);
  assert.match(systemPrompt({ compact: true }), /metarValues/);
});
