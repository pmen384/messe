const { chromium } = require('playwright');

async function fetchGraphData(page, unit) {
  const url = `https://daidata.goraggio.com/100563/detail?unit=${unit}`;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  // jqplotの初期化を待つ
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[id^="WeeklyCanvas"]');
    return canvas && $(canvas).data('jqplot');
  }, { timeout: 15000 }).catch(() => {});

  const result = await page.evaluate(() => {
    const canvas = document.querySelector('[id^="WeeklyCanvas"]');
    if (!canvas) return null;

    const jqplotInstance = $(canvas).data('jqplot');
    if (!jqplotInstance) return null;

    return {
      data: jqplotInstance.series[0]?.data || [],
      xaxis: jqplotInstance.axes?.xaxis?.ticks || [],
    };
  });

  if (!result) return null;

  // X軸ラベルから日付マッピングを生成
  const ticks = result.xaxis.filter(t => t[1] !== '');
  const dateMap = [];
  for (let i = 0; i < ticks.length; i++) {
    const startIdx = ticks[i][0];
    const endIdx = ticks[i + 1] ? ticks[i + 1][0] - 1 : result.data.length - 1;
    dateMap.push({ date: ticks[i][1], startIdx, endIdx });
  }

  // 各データポイントに日付・時刻を付与
  const points = result.data.map(([idx, value]) => {
    const dateEntry = dateMap.find(d => idx >= d.startIdx && idx <= d.endIdx);
    const date = dateEntry?.date || '?';
    const hourOffset = dateEntry ? idx - dateEntry.startIdx : 0;
    // 営業開始を10時と仮定
    const hour = 10 + hourOffset;
    return { idx, date, hour: `${hour}:00`, value };
  });

  return { unit, url, points, dateMap };
}

async function fetchMultipleUnits(units) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results = [];

  for (const unit of units) {
    process.stderr.write(`台番号 ${unit} を取得中...\n`);
    try {
      const data = await fetchGraphData(page, unit);
      if (data) results.push(data);
      else process.stderr.write(`  -> データなし\n`);
    } catch (e) {
      process.stderr.write(`  -> エラー: ${e.message}\n`);
    }
  }

  await browser.close();
  return results;
}

function printResults(results) {
  for (const result of results) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`台番号: ${result.unit}  |  ${result.url}`);
    console.log('='.repeat(60));
    console.log(`${'日付'.padEnd(6)} ${'時刻'.padEnd(6)} ${'持ち玉推移'.padStart(10)}`);
    console.log('-'.repeat(30));

    let prevDate = null;
    for (const p of result.points) {
      if (p.date !== prevDate) {
        if (prevDate !== null) console.log('');
        prevDate = p.date;
      }
      const bar = p.value >= 0
        ? ' +' + '█'.repeat(Math.min(Math.round(p.value / 2000), 20))
        : ' -' + '░'.repeat(Math.min(Math.round(-p.value / 2000), 20));
      console.log(`${p.date.padEnd(6)} ${p.hour.padEnd(6)} ${String(p.value).padStart(10)}  ${bar}`);
    }
  }
}

(async () => {
  // 引数: node fetch_graph_data.js 41 46 57  (複数指定可)
  const args = process.argv.slice(2);
  const units = args.length > 0 ? args.map(Number) : [41];

  const results = await fetchMultipleUnits(units);
  printResults(results);

  // JSONも出力
  const fs = require('fs');
  const outFile = `graph_data_${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  process.stderr.write(`\nJSONを ${outFile} に保存しました\n`);
})();
