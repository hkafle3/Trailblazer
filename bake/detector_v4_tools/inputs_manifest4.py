"""v4 summary input manifest: final fields from detector-v4/cache, development fields from their v3 cache, plus the ePSF
and UltracoolSheet snapshots. A final field without manifest.json is MISSING (INVALID, never a pass).
Usage: python inputs_manifest4.py <out json>"""
import sys, json, hashlib, os
S = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad'; B = S + '/wt-detector-v4/bake'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
FL = json.load(open(B + '/detector_v4_fields.json')); DV = json.load(open(B + '/detector_v4_dev.json')); res = dict(note='summary of each field cache manifest.json; a field without a manifest is INVALID', fields={})
for k, items in (('final', [(f['field'], f"{S}/detector-v4/cache/{f['field']}") for f in FL['final']]), ('dev', [(f['field'], f['cache']) for f in DV['fields']])):
    for name, d in items:
        p = d + '/manifest.json'
        if not os.path.exists(p): res['fields'][name] = dict(set=k, status='MISSING (no manifest)'); continue
        m = json.load(open(p))
        res['fields'][name] = dict(set=k, cache=d, status='complete', manifest_sha256=sha(p), retrieved=m['retrieved'], exposures=m['exposures'], listed=m['listed'], off_patch=m['off_patch'], by_det=m['by_det'], by_coll=m['by_coll'],
                                   versions=m['versions'], mjd_range=m['mjd_range'], d6_passes=m['d6_passes'], catalogues={c: dict(source=v['source'], rows=v['rows'], sha256=v['sha256']) for c, v in m['catalogues'].items()})
res['epsf'] = json.load(open(f'{S}/detector-v3/cache/epsf/manifest.json')); res['ultracoolsheet'] = {f: sha(f'{S}/detector-v3/cache/ucs/{f}') for f in sorted(os.listdir(f'{S}/detector-v3/cache/ucs'))}
json.dump(res, open(sys.argv[1], 'w'), indent=1)
for k in ('final', 'dev'): print(k, sum(v['status'] == 'complete' for v in res['fields'].values() if v['set'] == k), 'complete of', sum(v['set'] == k for v in res['fields'].values()))
