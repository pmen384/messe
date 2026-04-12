const fs = require('fs');

function normalizeDate(mdStr, refDate) {
  if (!mdStr || mdStr === '?') return null;
  const [m, d] = mdStr.split('/').map(Number);
  if (isNaN(m) || isNaN(d)) return null;
  const year = refDate.getFullYear();
  const candidate = new Date(year, m - 1, d);
  if (candidate.getTime() > refDate.getTime() + 7 * 86400000) {
    return `${year-1}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  return `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

const files = [
  { file: 'graph_data_2026-04-06.json', ref: new Date('2026-04-06') },
  { file: 'graph_data_2026-04-07.json', ref: new Date('2026-04-07') },
  { file: 'graph_data_2026-04-11.json', ref: new Date('2026-04-11') },
];

const historyMap = {};
for (const { file, ref } of files) {
  const data = JSON.parse(fs.readFileSync(file));
  for (const u of data) {
    if (!historyMap[u.unit]) historyMap[u.unit] = { unit: u.unit, days: {} };
    const grouped = {};
    for (const p of u.points) {
      const absDate = normalizeDate(p.date, ref);
      if (!absDate) continue;
      if (!grouped[absDate]) grouped[absDate] = [];
      grouped[absDate].push(p.value);
    }
    Object.assign(historyMap[u.unit].days, grouped);
  }
}

const history = Object.values(historyMap).sort((a, b) => a.unit - b.unit);
fs.writeFileSync('history.json', JSON.stringify(history));
console.log('マイグレーション完了');
history.forEach(u => {
  const dates = Object.keys(u.days).sort();
  const total = Object.values(u.days).reduce((s, a) => s + a.length, 0);
  console.log(`  台${u.unit}: ${dates.join(', ')} (合計${total}pt)`);
});
