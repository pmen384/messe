/**
 * update.js
 * 全台データをHTTP取得（regexで解析）し graph.html を更新する
 * Playwrightを使わないので GitHub Actions でも安定動作
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const UNITS = [41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57];
const DATA_FILE = path.join(DIR, 'graph_data.json');
const TEMPLATE_FILE = path.join(DIR, 'graph_template.html');
const OUTPUT_FILE = path.join(DIR, 'graph.html');

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
  // jqplot配列データを抽出
  const dataMatch = html.match(/\.jqplot\s*\(\s*(\[\s*\[[\s\S]*?\]\s*\])\s*,/);
  if (!dataMatch) return null;

  let rawData;
  try {
    rawData = JSON.parse(dataMatch[1]);
  } catch (e) {
    return null;
  }

  // X軸ラベル（日付）を抽出
  const ticksMatch = html.match(/ticks\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  let ticks = [];
  if (ticksMatch) {
    try { ticks = JSON.parse(ticksMatch[1]); } catch (e) {}
  }

  // 日付マッピング
  const dateTicks = ticks.filter(t => Array.isArray(t) && t[1] !== '');
  const dateMap = dateTicks.map((t, i) => ({
    date: t[1],
    startIdx: t[0],
    endIdx: dateTicks[i + 1] ? dateTicks[i + 1][0] - 1 : rawData.length - 1,
  }));

  const points = rawData.map(([idx, value]) => {
    const entry = dateMap.find(d => idx >= d.startIdx && idx <= d.endIdx);
    return { idx, date: entry?.date || '?', value };
  });

  return { points, dateMap };
}

// ============================================================
// 全台取得
// ============================================================
async function fetchAll() {
  const results = [];
  for (const unit of UNITS) {
    const url = `https://daidata.goraggio.com/100563/detail?unit=${unit}`;
    process.stdout.write(`取得中: 台${unit} ... `);
    try {
      const html = await fetchHtml(url);
      const parsed = parseHtml(html);
      if (parsed && parsed.points.length > 0) {
        results.push({ unit, ...parsed });
        process.stdout.write(`OK (${parsed.points.length}ポイント)\n`);
      } else {
        process.stdout.write('データなし\n');
      }
    } catch (e) {
      process.stdout.write(`エラー: ${e.message}\n`);
    }
    // サーバー負荷軽減のため少し待機
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

// ============================================================
// graph.html を更新
// ============================================================
function updateHtml(data) {
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const html = template.replace('__GRAPH_DATA__', JSON.stringify(data));
  fs.writeFileSync(OUTPUT_FILE, html);
  console.log('graph.html を更新しました');
}

// ============================================================
// メイン
// ============================================================
(async () => {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[${now}] データ取得開始`);

  const data = await fetchAll();
  console.log(`\n取得完了: ${data.length}台`);

  if (data.length === 0) {
    console.log('警告: データが取得できませんでした。graph.html は更新しません。');
    process.exit(1);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(DIR, `graph_data_${dateStr}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`graph_data_${dateStr}.json に保存しました`);

  updateHtml(data);
  console.log('完了');
})();
