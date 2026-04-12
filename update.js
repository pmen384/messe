/**
 * update.js
 * 全台データをHTTP取得し history.json に蓄積、graph.html を更新する
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const UNITS = [41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57];
const HISTORY_FILE = path.join(DIR, 'history.json');
const TEMPLATE_FILE = path.join(DIR, 'graph_template.html');
const OUTPUT_FILE = path.join(DIR, 'graph.html');
const KEEP_DAYS = 40; // 1ヶ月＋余裕

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
// HTMLからjqplotデータを抽出
// ============================================================
function parseHtml(html) {
  const dataMatch = html.match(/\.jqplot\s*\(\s*(\[\s*\[[\s\S]*?\]\s*\])\s*,/);
  if (!dataMatch) return null;
  let rawData;
  try { rawData = JSON.parse(dataMatch[1]); } catch (e) { return null; }

  const ticksMatch = html.match(/ticks\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  let ticks = [];
  if (ticksMatch) { try { ticks = JSON.parse(ticksMatch[1]); } catch (e) {} }

  const dateTicks = ticks.filter(t => Array.isArray(t) && t[1] !== '');
  const dateMap = dateTicks.map((t, i) => ({
    date: t[1], // "M/D" 形式
    startIdx: t[0],
    endIdx: dateTicks[i + 1] ? dateTicks[i + 1][0] - 1 : rawData.length - 1,
  }));

  return { rawData, dateMap };
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
// 全台取得
// ============================================================
async function fetchAll(fetchDate) {
  const results = [];
  for (const unit of UNITS) {
    const url = `https://daidata.goraggio.com/100563/detail?unit=${unit}`;
    process.stdout.write(`取得中: 台${unit} ... `);
    try {
      const html = await fetchHtml(url);
      const parsed = parseHtml(html);
      if (parsed && parsed.rawData.length > 0) {
        // 日付ごとにvalues配列を作成
        const days = {};
        for (const dm of parsed.dateMap) {
          const absDate = normalizeDate(dm.date, fetchDate);
          days[absDate] = parsed.rawData
            .filter(([idx]) => idx >= dm.startIdx && idx <= dm.endIdx)
            .map(([, v]) => v);
        }
        results.push({ unit, days });
        const totalPts = Object.values(days).reduce((s, a) => s + a.length, 0);
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
// メイン
// ============================================================
(async () => {
  const fetchDate = new Date();
  const now = fetchDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[${now}] データ取得開始`);

  const newData = await fetchAll(fetchDate);
  console.log(`\n取得完了: ${newData.length}台`);

  if (newData.length === 0) {
    console.log('警告: データが取得できませんでした。処理を中断します。');
    process.exit(1);
  }

  // 履歴をマージ
  const existing = fs.existsSync(HISTORY_FILE)
    ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    : [];
  const history = mergeHistory(existing, newData, fetchDate);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  console.log(`history.json を更新しました（${UNITS.length}台 × 最大${KEEP_DAYS}日）`);

  updateHtml(history);
  console.log('完了');
})();
