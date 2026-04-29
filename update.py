#!/usr/bin/env python3
"""
update.py
全台データをHTTP取得し history.json に蓄積、graph.html を更新する
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

DIR = os.path.dirname(os.path.abspath(__file__))
UNIT_LIST_URL = 'https://daidata.goraggio.com/100563/unit_list?model=e%E7%89%99%E7%8B%BC12%20XX-MJ&ballPrice=4.00&ps=P'
UNITS_FILE = os.path.join(DIR, 'units.json')
UNITS_FALLBACK = [11,12,13,14,15,16,17,18,19,20,52,53,54,55,56,57,58,59,60]
HISTORY_FILE = os.path.join(DIR, 'history.json')
TEMPLATE_FILE = os.path.join(DIR, 'graph_template.html')
OUTPUT_FILE = os.path.join(DIR, 'graph.html')
PRED_HISTORY_FILE = os.path.join(DIR, 'prediction_history.json')
PRED_TEMPLATE_FILE = os.path.join(DIR, 'predictions_template.html')
PRED_OUTPUT_FILE = os.path.join(DIR, 'predictions.html')
KEEP_DAYS = 40

DEFAULT_WEIGHTS = {'consecutiveLoss': 20, 'recentCumLoss': 1.0, 'avgDaily': 1.0}
JST = timezone(timedelta(hours=9))
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
    'Referer': 'https://daidata.goraggio.com/',
}

# ============================================================
# HTTP取得
# ============================================================
def fetch_html(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read().decode('utf-8')
    except urllib.error.URLError as e:
        raise Exception(str(e))

# ============================================================
# 台リストを動的取得
# ============================================================
def fetch_unit_list():
    html = fetch_html(UNIT_LIST_URL)
    matches = re.findall(r'detail\?unit=(\d+)', html)
    units = sorted(set(int(m) for m in matches))
    if not units:
        raise Exception('台リストが空です')
    return units

# ============================================================
# HTMLからjqplotデータを抽出
# ============================================================
def parse_html(html):
    days = {}
    matches = re.findall(r'\.jqplot\s*\(\s*(\[\[[\s\S]*?\]\])\s*,', html)
    for m in matches:
        try:
            raw_data = json.loads(m)
        except Exception:
            continue
        if not raw_data:
            continue
        series = raw_data[0] if isinstance(raw_data[0][0], list) else raw_data
        if not series:
            continue
        if isinstance(series[0][0], str):
            for ts, value in series:
                date = ts[:10]
                if date not in days:
                    days[date] = []
                days[date].append(value)
    if not days:
        return None
    return {'days': days}

# ============================================================
# JST日付文字列を取得
# ============================================================
def get_jst_date_str(dt=None):
    if dt is None:
        dt = datetime.now(JST)
    return dt.strftime('%Y-%m-%d')

# ============================================================
# 全台取得
# ============================================================
def fetch_all(units):
    results = []
    for unit in units:
        url = f'https://daidata.goraggio.com/100563/detail?unit={unit}'
        sys.stdout.write(f'取得中: 台{unit} ... ')
        sys.stdout.flush()
        try:
            html = fetch_html(url)
            parsed = parse_html(html)
            if parsed:
                results.append({'unit': unit, 'days': parsed['days']})
                total_pts = sum(len(v) for v in parsed['days'].values())
                print(f'OK ({total_pts}ポイント)')
            else:
                print('データなし')
        except Exception as e:
            print(f'エラー: {e}')
        time.sleep(0.5)
    return results

# ============================================================
# history.json にマージ
# ============================================================
def merge_history(existing, new_data, fetch_date):
    map_ = {}
    for u in (existing or []):
        map_[u['unit']] = {'unit': u['unit'], 'days': dict(u['days'])}
    for u in new_data:
        if u['unit'] not in map_:
            map_[u['unit']] = {'unit': u['unit'], 'days': {}}
        map_[u['unit']]['days'].update(u['days'])

    cutoff = (fetch_date - timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%d')
    for u in map_.values():
        u['days'] = {d: v for d, v in u['days'].items() if d >= cutoff}

    return sorted(map_.values(), key=lambda u: u['unit'])

# ============================================================
# graph.html を更新
# ============================================================
def update_html(history):
    with open(TEMPLATE_FILE, 'r', encoding='utf-8') as f:
        template = f.read()
    html = template.replace('__GRAPH_DATA__', json.dumps(history))
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(html)
    print('graph.html を更新しました')

# ============================================================
# predictions.html を更新
# ============================================================
def update_predictions_html(pred_history):
    if not os.path.exists(PRED_TEMPLATE_FILE):
        return
    with open(PRED_TEMPLATE_FILE, 'r', encoding='utf-8') as f:
        template = f.read()
    html = template.replace('__PREDICTION_DATA__', json.dumps(pred_history))
    with open(PRED_OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(html)
    print('predictions.html を更新しました')

# ============================================================
# 予測スコア計算
# ============================================================
def calc_prediction(history, weights=None):
    if weights is None:
        weights = DEFAULT_WEIGHTS

    all_dates = sorted(set(d for u in history for d in u['days']))
    recent_dates = all_dates[-7:]

    results = []
    for u in history:
        day_results = [u['days'][d][-1] for d in all_dates if d in u['days'] and u['days'][d]]
        if not day_results:
            continue

        recent_results = [u['days'][d][-1] for d in recent_dates if d in u['days'] and u['days'][d]]

        consecutive_loss = 0
        for d in reversed(recent_dates):
            if d in u['days'] and u['days'][d]:
                v = u['days'][d][-1]
                if v < 0:
                    consecutive_loss += 1
                else:
                    break
            else:
                break

        recent_cum_loss = sum(min(v, 0) for v in recent_results)
        avg_daily = sum(day_results) / len(day_results)
        recent_avg = sum(recent_results) / len(recent_results) if recent_results else avg_daily
        wins = sum(1 for v in recent_results if v > 0)
        losses = sum(1 for v in recent_results if v < 0)

        score = (
            consecutive_loss * weights['consecutiveLoss']
            + max(0, -recent_cum_loss) / 1000 * weights['recentCumLoss']
            + max(0, -avg_daily) / 500 * weights['avgDaily']
        )

        results.append({
            'unit': u['unit'],
            'score': round(score * 10) / 10,
            'consecutiveLoss': consecutive_loss,
            'recentAvg': round(recent_avg),
            'recentCumLoss': round(recent_cum_loss),
            'wins': wins,
            'losses': losses,
        })

    return sorted(results, key=lambda x: -x['score'])

# ============================================================
# 当日の実績を過去の予測エントリに記入
# ============================================================
def fill_results(pred_history, history, today_jst):
    for entry in pred_history:
        if entry['predDate'] == today_jst and entry['results'] is None:
            entry['results'] = {}
            for u in history:
                pts = u['days'].get(today_jst)
                if pts:
                    entry['results'][str(u['unit'])] = pts[-1]
            print(f'予測結果記録: {today_jst} ({len(entry["results"])}台)')

# ============================================================
# PDCA: 過去の正解率からスコア重みを調整
# ============================================================
def calc_pdca_weights(pred_history):
    completed = [e for e in pred_history if e.get('results') and len(e['results']) > 0][-14:]
    if len(completed) < 5:
        return DEFAULT_WEIGHTS

    factor_hits = {k: {'hit': 0, 'total': 0} for k in DEFAULT_WEIGHTS}

    for entry in completed:
        hot_preds = entry['predictions'][:3]
        for p in hot_preds:
            result = entry['results'].get(str(p['unit']))
            if result is None:
                continue
            is_hit = result > 0
            for factor in factor_hits:
                if factor in p:
                    factor_hits[factor]['total'] += 1
                    if is_hit:
                        factor_hits[factor]['hit'] += 1

    total_hits = sum(f['hit'] for f in factor_hits.values())
    total_total = sum(f['total'] for f in factor_hits.values())
    base_rate = total_hits / total_total if total_total > 0 else 0.5

    new_weights = dict(DEFAULT_WEIGHTS)
    for factor, stat in factor_hits.items():
        if stat['total'] == 0:
            continue
        hit_rate = stat['hit'] / stat['total']
        multiplier = max(0.5, min(2.0, 0.5 + hit_rate / max(base_rate, 0.1)))
        new_weights[factor] = round(DEFAULT_WEIGHTS[factor] * multiplier * 10) / 10

    return new_weights

# ============================================================
# メイン
# ============================================================
def main():
    fetch_date = datetime.now(JST)
    print(f'[{fetch_date.strftime("%Y/%m/%d %H:%M:%S")}] データ取得開始')

    # 台リストを動的取得
    try:
        active_units = fetch_unit_list()
        print(f'台リスト取得: {len(active_units)}台 [{", ".join(map(str, active_units))}]')
        if os.path.exists(UNITS_FILE):
            with open(UNITS_FILE) as f:
                prev = json.load(f)
        else:
            prev = active_units
        added = [u for u in active_units if u not in prev]
        removed = [u for u in prev if u not in active_units]
        if added:
            print(f'台追加: {", ".join(map(str, added))}')
        if removed:
            print(f'台削除: {", ".join(map(str, removed))}')
        with open(UNITS_FILE, 'w') as f:
            json.dump(active_units, f)
    except Exception as e:
        print(f'警告: 台リスト取得失敗 ({e})。前回リストを使用。')
        if os.path.exists(UNITS_FILE):
            with open(UNITS_FILE) as f:
                active_units = json.load(f)
        else:
            active_units = UNITS_FALLBACK

    new_data = fetch_all(active_units)
    print(f'\n取得完了: {len(new_data)}台')

    existing = []
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE) as f:
            existing = json.load(f)

    if not new_data:
        print('警告: 新規データなし。既存の history.json でグラフを更新します。')
        if not existing:
            print('エラー: 既存データもありません。終了します。')
            sys.exit(1)
        update_html(existing)
        pred_history = []
        if os.path.exists(PRED_HISTORY_FILE):
            with open(PRED_HISTORY_FILE) as f:
                pred_history = json.load(f)
        update_predictions_html(pred_history)
        print('完了（既存データ使用）')
        return

    history = merge_history(existing, new_data, fetch_date)
    with open(HISTORY_FILE, 'w') as f:
        json.dump(history, f)
    print(f'history.json を更新しました（{len(active_units)}台 × 最大{KEEP_DAYS}日）')

    update_html(history)

    today_jst = get_jst_date_str(fetch_date)
    tomorrow_jst = get_jst_date_str(fetch_date + timedelta(days=1))

    pred_history = []
    if os.path.exists(PRED_HISTORY_FILE):
        with open(PRED_HISTORY_FILE) as f:
            pred_history = json.load(f)

    fill_results(pred_history, history, today_jst)

    weights = calc_pdca_weights(pred_history)
    print(f'PDCA重み: consecutiveLoss={weights["consecutiveLoss"]}, recentCumLoss={weights["recentCumLoss"]}, avgDaily={weights["avgDaily"]}')

    if not any(e['predDate'] == tomorrow_jst for e in pred_history):
        predictions = calc_prediction(history, weights)[:9]
        pred_history.append({
            'predDate': tomorrow_jst,
            'madeAt': today_jst,
            'weights': weights,
            'predictions': predictions,
            'results': None,
        })
        print(f'翌日予測を作成: {tomorrow_jst} (上位{len(predictions)}台)')

    pred_cutoff = get_jst_date_str(fetch_date - timedelta(days=90))
    pruned = [e for e in pred_history if e['predDate'] >= pred_cutoff]

    with open(PRED_HISTORY_FILE, 'w') as f:
        json.dump(pruned, f)
    print('prediction_history.json を更新しました')

    update_predictions_html(pruned)
    print('完了')

if __name__ == '__main__':
    main()
