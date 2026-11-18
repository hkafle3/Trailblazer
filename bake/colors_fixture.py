"""Write one colors_ref field directory as a fixture Node can read (web/tests/colors_parity.mjs): the catalogue files as
they are, and every cutout as raw little-endian bytes (IMAGE float32, FLAGS int32) with its header text, origin and time.
These are the bytes the page's worker reads for the same exposures (checked by colors_parity.mjs --s3 on a sample).
Run: python -I bake/colors_fixture.py <field_dir> <out_dir>
"""
import sys, os, json, shutil, numpy as np

def main(d, out):
    os.makedirs(f'{out}/exp', exist_ok=True)
    for f in ('twomass.csv', 'catwise.csv', 'allwise.csv', 'gaia.csv', 'simbad.csv', 'vsx.tsv', 'field.json'):
        shutil.copyfile(f'{d}/{f}', f'{out}/{f}')
    E = json.load(open(f'{d}/exposures.json')); idx = []
    for e in E:
        z = np.load(f"{d}/{e['file']}"); img = z['img'].astype('<f4'); flg = z['flg'].astype('<i4'); h, w = img.shape
        name = os.path.basename(e['file'])[:-4]
        open(f'{out}/exp/{name}.img', 'wb').write(img.tobytes()); open(f'{out}/exp/{name}.flg', 'wb').write(flg.tobytes())
        idx.append(dict(obs=e['obs'], det=e['det'], key=e['key'], t=float(z['t']), x0=int(z['x0']), y0=int(z['y0']), w=int(w), h=int(h), hdr=str(z['hdr']), file=f'exp/{name}'))
    json.dump(idx, open(f'{out}/exposures.json', 'w'))
    print(out, len(idx), 'exposures')

if __name__ == '__main__':
    main(*sys.argv[1:3])
