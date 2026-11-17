"""Development driver: run the v4 detector with a development config (DET_V4_DEV) on development run directories,
writing out_<tag>.json beside out.json, then score. Usage: devrun.py <tag> <cfg json> <variants comma list> [score]"""
import sys, os, json
sys.path.insert(0, '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/wt-detector-v4/bake')
import detector_v4_eval as E
from concurrent.futures import ThreadPoolExecutor
tag, cfg, variants = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
ds = [E.run_dir('dev', f['field'], v) for f in E.valid_fields('dev') for v in variants if os.path.isdir(E.run_dir('dev', f['field'], v))]
with ThreadPoolExecutor(4) as ex: rc = list(ex.map(lambda d: E.detect(d, None, f'out_{tag}.json', dict(DET_V4_DEV=cfg)), ds))
print(tag, len(ds), 'runs, non-zero:', sum(r != 0 for r in rc), flush=True)
if len(sys.argv) > 4: E.score('dev', f'out_{tag}.json')
