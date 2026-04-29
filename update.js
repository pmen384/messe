/**
 * update.js
 * 全台データをHTTP取得し history.json に蓄積、graph.html を更新する
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const UNIT_LIST_URL = 'https://daidata.goraggio.com/100563/unit_list?model=e%E7%89%99%E7%8B%BC12%20XX-MJ&ballPrice=4.00&ps=P';
const UNITS_FILE = path.join(DIR, 'units.json');
const UNITS_FALLBACK = [41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57];
const HISTORY_FILE = path.join(DIR, 'history.json');
const TEMPLATE_FILE = path.join(DIR, 'graph_template.html');
const OUTPUT_FILE = path.join(DIR, 'graph.html');
const PRED_HISTORY_FILE = path.join(DIR, 'prediction_history.json');
const PRED_TEMPLATE_FILE = path.join(DIR, 'predictions_template.html');
const PRED_OUTPUT_FILE = path.join(DIR, 'predictions.html');
const KEEP_DAYS = 40; // 1ヶ月＋余裕

// 予測スコアのデフォルト重み
const DEFAULT_WEIGHTS = { consecutiveLoss: 20, recentCumLoss: 1.0, avgDaily: 1.0 };

// ============================================================
// HTTP取得
// ============================================================
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
        'Referer': 'https://daidata.goraggio.com/',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ============================================================
// HTMLからjqplotデータを抽出（全日別グラフを取得）
// ============================================================
function parseHtml(html) {
  const days = {};

  // 全jqplot呼び出しをマッチ
  const matches = [...html.matchAll(/\.jqplot\s*\(\s*(\[\[[\s\S]*?\]\])\s*,/g)];
  for (const m of matches) {
    let rawData;
    try { rawData = JSON.parse(m[1]); } catch (e) { continue; }
    if (!rawData.length) continue;

    const series = Array.isArray(rawData[0][0]) ? rawData[0] : rawData;
    if (!series.length) continue;

    if (typeof series[0][0] === 'string') {
      // 日別グラフ: [["YYYY-MM-DD HH:MM:SS", value], ...]
      for (const [ts, value] of series) {
        const date = ts.slice(0, 10);
        if (!days[date]) days[date] = [];
        days[date].push(value);
      }
    }
    // 週間グラフ（index形式）はスキップ（日別グラフで補完済み）
  }

  if (Object.keys(days).length === 0) return null;
  return { days };
}

// ============================================================
// "M/D" を "YYYY-MM-DD" に変換
// ============================================================
function normalizeDate(mdStr, fetchDate) {
  const [m, d] = mdStr.split('/').map(Number);
  const year = fetchDate.getFullYear();
  const candidate = new Date(year, m - 1, d);
  // 取得日より7日以上先なら前年
  if (candidate.getTime() > fetchDate.getTime() + 7 * 86400000) {
    return `${year - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ============================================================
// 台リストを動的取得
// ============================================================
async function fetchUnitList() {
  const html = await fetchHtml(UNIT_LIST_URL);
  const matches = [...html.matchAll(/detail\?unit=(\d+)/g)];
  const units = [...new Set(matches.map(m => parseInt(m[1])))].sort((a, b) => a - b);
  if (units.length === 0) throw new Error('台リストが空です');
  return units;
}

// ============================================================
// 全台取得
// ============================================================
async function fetchAll(fetchDate, units) {
  const results = [];
  for (const unit of units) {
    const url = `https://daidata.goraggio.com/100563/detail?unit=${unit}`;
    process.stdout.write(`取得中: 台${unit} ... `);
    try {
      const html = await fetchHtml(url);
const parsed = parseHtml(html);
      if (parsed) {
        results.push({ unit, days: parsed.days });
        const totalPts = Object.values(parsed.days).reduce((s, a) => s + a.length, 0);
        process.stdout.write(`OK (${totalPts}ポイント)\n`);
      } else {
        process.stdout.write('データなし\n');
      }
    } catch (e) {
      process.stdout.write(`エラー: ${e.message}\n`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

// ============================================================
// history.json にマージ（古いデータを削除）
// ============================================================
function mergeHistory(existing, newData, fetchDate) {
  // unit→{days} のマップに変換
  const map = {};
  for (const u of (existing || [])) map[u.unit] = { ...u };

  for (const u of newData) {
    if (!map[u.unit]) map[u.unit] = { unit: u.unit, days: {} };
    Object.assign(map[u.unit].days, u.days);
  }

  // KEEP_DAYS 日より古いデータを削除
  const cutoff = new Date(fetchDate.getTime() - KEEP_DAYS * 86400000)
    .toISOString().slice(0, 10);
  for (const u of Object.values(map)) {
    for (const date of Object.keys(u.days)) {
      if (date < cutoff) delete u.days[date];
    }
  }

  return Object.values(map).sort((a, b) => a.unit - b.unit);
}

// ============================================================
// graph.html を更新
// ============================================================
function updateHtml(history) {
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const html = template.replace('__GRAPH_DATA__', JSON.stringify(history));
  fs.writeFileSync(OUTPUT_FILE, html);
  console.log('graph.html を更新しました');
}

// ============================================================
// JST日付文字列を取得 (YYYY-MM-DD)
// ============================================================
function getJSTDateStr(date) {
  return new Date(date).toLocaleString('sv', { timeZone: 'Asia/Tokyo' }).slice(0, 10);
}

// ============================================================
// 予測スコア計算（サーバーサイド）
// ============================================================
function calcPrediction(history, weights = DEFAULT_WEIGHTS) {
  const allDates = [...new Set(history.flatMap(u => Object.keys(u.days)))].sort();
  const recentDates = allDates.slice(-7);

  return history.map(u => {
    const dayResults = allDates.map(date => {
      const pts = u.days[date];
      return pts && pts.length > 0 ? pts[pts.length - 1] : null;
    }).filter(v => v !== null);

    if (dayResults.length === 0) return null;

    const recentResults = recentDates.map(date => {
      const pts = u.days[date];
      return pts && pts.length > 0 ? pts[pts.length - 1] : null;
    }).filter(v => v !== null);

    let consecutiveLoss = 0;
    for (let i = recentDates.length - 1; i >= 0; i--) {
      const pts = u.days[recentDates[i]];
      const v = pts && pts.length > 0 ? pts[pts.length - 1] : null;
      if (v === null) break;
      if (v < 0) consecutiveLoss++; else break;
    }

    const recentCumLoss = recentResults.reduce((s, v) => s + Math.min(v, 0), 0);
    const avgDaily = dayResults.reduce((s, v) => s + v, 0) / dayResults.length;
    const recentAvg = recentResults.length > 0
      ? recentResults.reduce((s, v) => s + v, 0) / recentResults.length
      : avgDaily;
    const wins  = recentResults.filter(v => v > 0).length;
    const losses = recentResults.filter(v => v < 0).length;

    const score =
      consecutiveLoss * weights.consecutiveLoss
      + Math.max(0, -recentCumLoss) / 1000 * weights.recentCumLoss
      + Math.max(0, -avgDaily) / 500 * weights.avgDaily;

    return {
      unit: u.unit,
      score: Math.round(score * 10) / 10,
      consecutiveLoss,
      recentAvg: Math.round(recentAvg),
      recentCumLoss: Math.round(recentCumLoss),
      wins,
      losses,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

// ============================================================
// 予測結果を記録（当日の実績を過去の予測エントリに記入）
// ============================================================
function fillResults(predHistory, history, todayJST) {
  for (const entry of predHistory) {
    if (entry.predDate === todayJST && entry.results === null) {
      entry.results = {};
      for (const u of history) {
        const pts = u.days[todayJST];
        if (pts && pts.length > 0) {
          entry.results[String(u.unit)] = pts[pts.length - 1];
        }
      }
      const filled = Object.keys(entry.results).length;
      console.log(`予測結果記録: ${todayJST} (${filled}台)`);
    }
  }
}

// ============================================================
// PDCA: 過去の正解率からスコア重みを調整
// ============================================================
function calcPdcaWeights(predHistory) {
  const completed = predHistory.filter(
    e => e.results && Object.keys(e.results).length > 0
  ).slice(-14);

  if (completed.length < 5) return DEFAULT_WEIGHTS;

  // 各ファクターのホット台ヒット率を計算
  const factorHits = { consecutiveLoss: { hit: 0, total: 0 }, recentCumLoss: { hit: 0, total: 0 }, avgDaily: { hit: 0, total: 0 } };

  for (const entry of completed) {
    const hotPreds = entry.predictions.slice(0, 3);
    for (const p of hotPreds) {
      const result = entry.results[String(p.unit)];
      if (result === undefined) continue;
      const isHit = result > 0;
      for (const factor of Object.keys(factorHits)) {
        if (p[factor] !== undefined) {
          factorHits[factor].total++;
          if (isHit) factorHits[factor].hit++;
        }
      }
    }
  }

  // 全体ヒット率
  const totalHits  = Object.values(factorHits).reduce((s, f) => s + f.hit, 0);
  const totalTotal = Object.values(factorHits).reduce((s, f) => s + f.total, 0);
  const baseRate   = totalTotal > 0 ? totalHits / totalTotal : 0.5;

  const newWeights = { ...DEFAULT_WEIGHTS };
  for (const [factor, stat] of Object.entries(factorHits)) {
    if (stat.total === 0) continue;
    const hitRate = stat.hit / stat.total;
    // ヒット率が高いほど重みを上げる（最大2倍、最小0.5倍）
    const multiplier = Math.max(0.5, Math.min(2.0, 0.5 + hitRate / Math.max(baseRate, 0.1)));
    newWeights[factor] = Math.round(DEFAULT_WEIGHTS[factor] * multiplier * 10) / 10;
  }

  return newWeights;
}

// ============================================================
// predictions.html を更新
// ============================================================
function updatePredictionsHtml(predHistory) {
  if (!fs.existsSync(PRED_TEMPLATE_FILE)) return;
  const template = fs.readFileSync(PRED_TEMPLATE_FILE, 'utf8');
  const html = template.replace('__PREDICTION_DATA__', JSON.stringify(predHistory));
  fs.writeFileSync(PRED_OUTPUT_FILE, html);
  console.log('predictions.html を更新しました');
}

// ============================================================
// メイン
// ============================================================
(async () => {
  const fetchDate = new Date();
  const now = fetchDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[${now}] データ取得開始`);

  // 台リストを動的取得
  let activeUnits;
  try {
    activeUnits = await fetchUnitList();
    console.log(`台リスト取得: ${activeUnits.length}台 [${activeUnits.join(', ')}]`);
    const prev = fs.existsSync(UNITS_FILE)
      ? JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8'))
      : activeUnits;
    const added   = activeUnits.filter(u => !prev.includes(u));
    const removed = prev.filter(u => !activeUnits.includes(u));
    if (added.length)   console.log(`台追加: ${added.join(', ')}`);
    if (removed.length) console.log(`台削除: ${removed.join(', ')}`);
    fs.writeFileSync(UNITS_FILE, JSON.stringify(activeUnits));
  } catch (e) {
    console.log(`警告: 台リスト取得失敗 (${e.message})。前回リストを使用。`);
    activeUnits = fs.existsSync(UNITS_FILE)
      ? JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8'))
      : UNITS_FALLBACK;
  }

  const newData = await fetchAll(fetchDate, activeUnits);
  console.log(`\n取得完了: ${newData.length}台`);

  const existing = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    : [];

  if (newData.length === 0) {
    console.log('警告: 新規データなし。既存の history.json でグラフを更新します。');
    if (existing.length === 0) {
      console.log('エラー: 既存データもありません。終了します。');
      process.exit(1);
    }
    updateHtml(existing);
    updatePredictionsHtml(
      fs.existsSync(PRED_HISTORY_FILE)
        ? JSON.parse(fs.readFileSync(PRED_HISTORY_FILE, 'utf8'))
        : []
    );
    console.log('完了（既存データ使用）');
    return;
  }

  const history = mergeHistory(existing, newData, fetchDate);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  console.log(`history.json を更新しました（${activeUnits.length}台 × 最大${KEEP_DAYS}日）`);

  updateHtml(history);

  // ============================================================
  // 予測履歴の更新
  // ============================================================
  const todayJST = getJSTDateStr(fetchDate);
  const tomorrowJST = getJSTDateStr(new Date(fetchDate.getTime() + 86400000));

  const predHistory = fs.existsSync(PRED_HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(PRED_HISTORY_FILE, 'utf8'))
    : [];

  // 当日の実績を過去の予測エントリに記入
  fillResults(predHistory, history, todayJST);

  // PDCA: 過去実績から重みを調整
  const weights = calcPdcaWeights(predHistory);
  console.log(`PDCA重み: consecutiveLoss=${weights.consecutiveLoss}, recentCumLoss=${weights.recentCumLoss}, avgDaily=${weights.avgDaily}`);

  // 翌日の予測エントリを追加（重複しない場合のみ）
  if (!predHistory.find(e => e.predDate === tomorrowJST)) {
    const predictions = calcPrediction(history, weights).slice(0, 9);
    predHistory.push({ predDate: tomorrowJST, madeAt: todayJST, weights, predictions, results: null });
    console.log(`翌日予測を作成: ${tomorrowJST} (上位${predictions.length}台)`);
  }

  // 90日より古いエントリを削除
  const predCutoff = getJSTDateStr(new Date(fetchDate.getTime() - 90 * 86400000));
  const prunedPredHistory = predHistory.filter(e => e.predDate >= predCutoff);

  fs.writeFileSync(PRED_HISTORY_FILE, JSON.stringify(prunedPredHistory));
  console.log('prediction_history.json を更新しました');

  updatePredictionsHtml(prunedPredHistory);
  console.log('完了');
})();
