"""A19 diagnostic (development): the proposal path alone (SEED_PATH off) on the development control fields' baseline
inputs and on null runs: what the M-dwarf controls get when only an archive proposal can find them, and what the path
produces on shifted/reversed catalogues."""
import sys, os, json, numpy as np
sys.path.insert(0, '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/wt-detector-v4/bake'); import detector_v4_eval as E
from concurrent.futures import ThreadPoolExecutor
cfg = json.loads(open(sys.argv[1]).read()); cfg['SEED_PATH'] = False; cfg = json.dumps(cfg)
F = [f for f in E.DEV['fields'] if f['kind'] == 'mdwarf']
ds = [(f, E.run_dir('dev', f['field'], v), v) for f in F for v in ('base', 'null0', 'null4')]
with ThreadPoolExecutor(4) as ex: list(ex.map(lambda q: E.detect(q[1], None, 'out_prop.json', dict(DET_V4_DEV=cfg)), ds))
for f, d, v in ds:
    o = json.load(open(d + '/out_prop.json')); t = f['target']
    if v == 'base':
        mv = E.one_to_one(o['movers'], [t]); q = o['movers'][mv[0]] if 0 in mv else None
        print(f['field'], t['name'], 'proposal-only:', (q['stage'], q['verdict'], round(q['pm'], 3), round((q.get('spectrum') or {}).get('dchi2', -1), 1), round((q.get('spectrum') or {}).get('dwarf_share_45', -1), 2)) if q else 'no record', 'candidates', len(o['candidates']), o['link'])
    else: print('  ', v, 'movers', len(o['movers']), 'spectrum stage', sum(m['stage'] == 'spectrum' for m in o['movers']), 'candidates', len(o['candidates']))
