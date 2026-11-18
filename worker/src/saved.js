// Which /api/images answers are kept in D1 for outages (index.js withSaved). Saving runs in waitUntil and its CPU counts
// against the request: a deep-field answer of 880 KB cost 13 to 21 ms to save to D1 and about 25 ms to put in R2
// (preview, 2026-11-18), against a 10 ms plan. Ordinary answers are about 10 KB (the showcase spot 10.9 KB), so answers
// over 64 KB are not saved: they come from our own sky index in R2 (the deep fields at the ecliptic poles), which does not
// go down with IRSA, so the outage copy matters least for them.
export const SAVE_MAX_BYTES = 64 << 10;
export const worthSaving = res => !(Number(res.headers.get('X-Answer-Bytes')) > SAVE_MAX_BYTES);
// The header only skips the work early. The limit itself is measured on the text when saving, so image answers without
// the header (IRSA's, and answers cached before the header existed) obey it too. Characters: the answers are ASCII.
export const fitsSave = (id, body) => !id.startsWith('/api/images') || body.length <= SAVE_MAX_BYTES;
// An answer saved before clients asked with fmt=2 (its key has no fmt) in the fmt=2 shape: IRSA's, folders null
export const toFmt2 = text => { const a = JSON.parse(text); return JSON.stringify({ ...a, fmt: 2, folders: null, images: a.images.map(x => [x.t, x.key, x.obs]) }); };
