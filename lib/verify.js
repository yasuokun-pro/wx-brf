/* 予報の答え合わせ(純粋関数・DOMを使わない)
   ─────────────────────────────────────────
   数値予報の値を取った時点で「予報の記録」を残し、あとから来たMETARの「実測の記録」と
   同じ時刻どうしで突き合わせて、この飛行場での外れ方(くせ)を出す。
   - ずれ = 予報 − 実測。プラスなら予報が大きめ(雲底なら高めに出る)
   - リード時間 = 予報を取った時刻から対象時刻までの時間。長いほど外れやすいので分けて集計する
   - 記録は端末内だけに置く(外に送らない)
   テスト: tests/verify.test.mjs */

export const LEAD_BUCKETS = [
  { key: '0-6', min: 0, max: 6, label: '0〜6時間先' },
  { key: '6-12', min: 6, max: 12, label: '6〜12時間先' },
  { key: '12-24', min: 12, max: 24, label: '12〜24時間先' },
  { key: '24+', min: 24, max: 1e9, label: '24時間先〜' },
];
export const VARS = [
  { key: 'baseFt', label: '雲底', unit: 'ft' },
  { key: 'temp', label: '気温', unit: '℃' },
  { key: 'dew', label: '露点', unit: '℃' },
  { key: 'wspd', label: '風速', unit: 'kt' },
];

const hourKey = t => new Date(Math.round(new Date(t).getTime() / 3600e3) * 3600e3).toISOString();

/* 観測の記録を1件足す。同じ時刻は新しい方で置き換え、古いものは捨てる */
export function addObs(log, rec, { maxDays = 14, now = new Date() } = {}) {
  if (!rec || !rec.t) return log || [];
  const t = hourKey(rec.t);
  const out = (log || []).filter(x => x.t !== t);
  out.push({ ...rec, t });
  const limit = now.getTime() - maxDays * 86400e3;
  return out.filter(x => new Date(x.t).getTime() >= limit).sort((a, b) => a.t.localeCompare(b.t));
}

/* 予報の記録(1回ぶん)を足す。made=予報を取った時刻、rows=[{t, …}] */
export function addSnapshot(list, snap, { maxKeep = 16, minGapMin = 60, now = new Date() } = {}) {
  if (!snap || !snap.made || !snap.rows?.length) return list || [];
  const out = [...(list || [])];
  const made = new Date(snap.made).getTime();
  /* 短い間に何度も取ったときは1つにまとめる(同じ予報を何度も記録しない) */
  const near = out.findIndex(s => Math.abs(new Date(s.made).getTime() - made) < minGapMin * 60e3);
  if (near >= 0) out.splice(near, 1);
  out.push(snap);
  out.sort((a, b) => a.made.localeCompare(b.made));
  const limit = now.getTime() - 14 * 86400e3;
  return out.filter(s => new Date(s.made).getTime() >= limit).slice(-maxKeep);
}

/* 予報と実測を同じ時刻で突き合わせる。1つの時刻に複数の予報があれば、リード時間ごとに残す */
export function pairs(log, snaps, { maxLeadH = 48 } = {}) {
  const obsBy = new Map((log || []).map(o => [o.t, o]));
  const out = [];
  for (const s of snaps || []) {
    const made = new Date(s.made).getTime();
    for (const r of s.rows || []) {
      const t = hourKey(r.t);
      const ob = obsBy.get(t);
      if (!ob) continue;
      const leadH = (new Date(t).getTime() - made) / 3600e3;
      if (leadH < 0 || leadH > maxLeadH) continue;
      out.push({ t, leadH: Math.round(leadH * 10) / 10, fc: r, ob });
    }
  }
  return out.sort((a, b) => a.t.localeCompare(b.t) || a.leadH - b.leadH);
}

const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

/* 要素ごと・リード時間帯ごとの集計。bias=平均のずれ、mae=平均の誤差の大きさ */
export function stats(ps, { vars = VARS } = {}) {
  const out = {};
  for (const v of vars) {
    out[v.key] = {};
    for (const b of LEAD_BUCKETS) {
      const ds = ps.filter(p => p.leadH >= b.min && p.leadH < b.max)
        .map(p => [p.fc?.[v.key], p.ob?.[v.key]])
        .filter(([f, o]) => f != null && o != null && Number.isFinite(f) && Number.isFinite(o))
        .map(([f, o]) => f - o);
      out[v.key][b.key] = ds.length
        ? { n: ds.length, bias: round1(ds.reduce((a, x) => a + x, 0) / ds.length), mae: round1(ds.reduce((a, x) => a + Math.abs(x), 0) / ds.length), median: round1(median(ds)) }
        : { n: 0, bias: null, mae: null, median: null };
    }
    const all = ps.map(p => [p.fc?.[v.key], p.ob?.[v.key]])
      .filter(([f, o]) => f != null && o != null && Number.isFinite(f) && Number.isFinite(o))
      .map(([f, o]) => f - o);
    out[v.key].all = all.length
      ? { n: all.length, bias: round1(all.reduce((a, x) => a + x, 0) / all.length), mae: round1(all.reduce((a, x) => a + Math.abs(x), 0) / all.length), median: round1(median(all)) }
      : { n: 0, bias: null, mae: null, median: null };
  }
  return out;
}

/* 補正値：件数が十分あるときだけ、中央値のずれを返す(平均は外れ値に引っ張られるため) */
export function correction(st, key, { minN = 10 } = {}) {
  const s = st?.[key]?.all;
  return s && s.n >= minN ? s.median : null;
}
/* 予報値に補正をかける(予報が高めに出るなら、その分だけ下げる) */
export function applyCorrection(value, corr, { min = 0 } = {}) {
  if (value == null || corr == null) return value;
  return Math.max(min, Math.round(value - corr));
}
