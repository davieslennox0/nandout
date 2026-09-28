#!/usr/bin/env python3
"""Regenerates deweb/index.html (the on-chain mirror) from the latest attestor cycle. Numbers are a labelled snapshot."""
import json, datetime, html
cyc = json.load(open('attestor/logs/cycle-latest.json'))
s, f = cyc['summary'], cyc.get('filters') or {}
n = lambda k: len(f[k]['pass']) if k in f else None
at = datetime.datetime.fromisoformat(s['at'].replace('Z', '+00:00')).strftime('%Y-%m-%d %H:%M UTC')
def row(name, kind, rule, gates, k=None):
    c = n(k or name) if kind in ('filter', 'latch', 'unlock') else None
    cnt = '<span class="chip">—</span>' if c is None else f'<span class="chip{" g" if c else ""}">{c}</span>'
    return f'<tr><td>{name}</td><td><span class="chip">{kind}</span></td><td class="rule">{html.escape(rule)}</td><td class="r">{gates}</td><td class="r">{cnt}</td></tr>'
rows = [
 row('BASIC_SAFETY','filter','LP_LOCKED ∧ TOP10_LT_40 ∧ DEV_NO_SELL_7D',4),
 row('MARKET_SAFE','filter','(LP_LOCKED ∨ HOLDERS_GE_100) ∧ DEV_NO_SELL_7D ∧ ¬LP_PULLED',8),
 row('REVENUE_AGENTS','filter','AGENT_LINKED ∧ REV_GT_0 ∧ LP_LOCKED',4),
 row('STRICT','filter','AGENT_LINKED ∧ REV_GT_0 ∧ LP_LOCKED ∧ TOP10_LT_25 ∧ DEV_NO_SELL_7D ∧ (LATCH_LOCKED ∨ AGE_GE_30D)',13),
 row('STICKY_SAFETY','latch','set: TOP10_LT_40 ∧ DEV_NO_SELL_7D ∧ HOLDERS_GE_100 · reset: ¬DEV_NO_SELL_7D ∨ LP_PULLED',11),
 row('UNLOCK_T1','unlock','AGE_GE_7D ∧ LP_LOCKED ∧ HOLDERS_GE_100',4),
 row('UNLOCK_T2','unlock','AGE_GE_30D ∧ REV_GE_10 ∧ HOLDERS_GE_300 ∧ LP_LOCKED',6),
 row('VOL_GUARD','fee tier','VOL_HIGH ∨ (VOL_ELEVATED ∧ (DEPTH_THIN ∨ DEPTH_DRAIN))',6),
 row('DEPTH_GUARD','fee tier','DEPTH_THIN ∨ DEPTH_CRITICAL ∨ DEPTH_DRAIN',6),
 row('ROUTE_SPLIT','fee route','¬IS_BUY',1),
 row('ROUTE_GUARD','fee route','VOL_HIGH ∨ DEPTH_THIN',3),
]
tpl = open('deweb/index.template.html', encoding='utf-8').read()
out = (tpl.replace('{{BLOCK}}', f"{s['block']:,}").replace('{{AT}}', at).replace('{{LAUNCHES}}', f"{s['launches']:,}")
          .replace('{{GRADUATED}}', str(s['graduated'])).replace('{{AGENTS}}', str(s['agentLinked'])).replace('{{ROWS}}', '\n'.join(rows)))
assert '{{' not in out
open('deweb/index.html', 'w', encoding='utf-8').write(out)
print(len(out.encode()), 'bytes; MARKET_SAFE', n('MARKET_SAFE'))
