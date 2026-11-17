import json, sys
S = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/detector-v4'
for tag, lab in (('out_v3', 'v3 frozen detector'), ('out_c1', '+D3'), ('out_c2', '+D2'), ('', '+crowd phot (PSF_SYS 0) +A8'), ('out_c6', 'c5 without crowd phot'), ('out_c5', 'frozen v4')):
    e = json.load(open(f"{S}/eval_dev{'_' + tag if tag else ''}/eval.json")); r = {x[0]: x for x in e['rows']}; d = e['detail']
    PL = d['plants']['list']; leg = [p for p in PL if not p['crowd'] and p['w2'] <= 14.0]; cr = [p for p in PL if p['crowd']]
    cells = {k: v for k, v in d['plants']['cells'].items() if float(k.split(' x ')[1].split('-')[1]) <= 14.0}; worst = min(cells.values(), key=lambda v: int(v.split('/')[0]))
    print(f"| {lab} | {sum(p['found'] for p in leg)}/{len(leg)} (worst bin {worst}) | {sum(p['found'] for p in cr)}/{len(cr)} | {sum(x['outcome']=='recovered' for x in d['heldout'])}/{len(d['heldout'])} | {len(d['false']['list'])} | {len(d['artifacts']['hits'])} | {sum(c['valid'] for c in d['controls'] if c['kind']=='mdwarf')}/{sum(c['kind']=='mdwarf' for c in d['controls'])} | " + ', '.join(f"{v['candidates']}" for v in d['false']['nulls'].values()) + f" ({sum(v['runs'] for v in d['false']['nulls'].values())} runs) |")
