/**
 * update.js
 * 全台データを取得し graph.html を更新する
 * 使い方: node update.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const UNITS = [41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57];
const DATA_FILE = path.join(DIR, 'graph_data.json');
const TEMPLATE_FILE = path.join(DIR, 'graph_template.html');
const OUTPUT_FILE = path.join(DIR, 'graph.html');

// ============================================================
// データ取得
// ============================================================
async function fetchUnit(page, unit) {
  const url = `https://daidata.goraggio.com/100563/detail?unit=${unit}`;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const c = document.querySelector('[id^="WeeklyCanvas"]');
    return c && $(c).data('jqplot');
  }, { timeout: 15000 }).catch(() => {});

  return page.evaluate(() => {
    const canvas = document.querySelector('[id^="WeeklyCanvas"]');
    if (!canvas) return null;
    const inst = $(canvas).data('jqplot');
    if (!inst) return null;
    return {
      data: inst.series[0]?.data || [],
      xaxis: inst.axes?.xaxis?.ticks || [],
    };
  });
}

function buildPoints(raw) {
  const ticks = raw.xaxis.filter(t => t[1] !== '');
  const dateMap = ticks.map((t, i) => ({
    date: t[1],
    startIdx: t[0],
    endIdx: ticks[i + 1] ? ticks[i + 1][0] - 1 : raw.data.length - 1,
  }));
  return raw.data.map(([idx, value]) => {
    const entry = dateMap.find(d => idx >= d.startIdx && idx <= d.endIdx);
    return { idx, date: entry?.date || '?', value };
  });
}

async function fetchAll() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results = [];

  for (const unit of UNITS) {
    process.stdout.write(`取得中: 台${unit} ... `);
    try {
      const raw = await fetchUnit(page, unit);
      if (raw) {
        results.push({ unit, points: buildPoints(raw), dateMap: buildDateMap(raw) });
        process.stdout.write('OK\n');
      } else {
        process.stdout.write('データなし\n');
      }
    } catch (e) {
      process.stdout.write(`エラー: ${e.message}\n`);
    }
  }

  await browser.close();
  return results;
}

function buildDateMap(raw) {
  const ticks = raw.xaxis.filter(t => t[1] !== '');
  return ticks.map((t, i) => ({
    date: t[1],
    startIdx: t[0],
    endIdx: ticks[i + 1] ? ticks[i + 1][0] - 1 : raw.data.length - 1,
  }));
}

// ============================================================
// graph.html を更新
// ============================================================
function updateHtml(data) {
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const html = template.replace('__GRAPH_DATA__', JSON.stringify(data));
  fs.writeFileSync(OUTPUT_FILE, html);
  console.log(`graph.html を更新しました`);
}

// ============================================================
// メイン
// ============================================================
(async () => {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`[${now}] データ取得開始`);

  const data = await fetchAll();

  // JSONを保存（日付付きアーカイブ + 最新版）
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(DIR, `graph_data_${dateStr}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`データを graph_data_${dateStr}.json に保存しました`);

  updateHtml(data);
  console.log('完了');
})();
