// Which /api/images answers are kept in D1 for outages (index.js withSaved). Saving runs in waitUntil and its CPU counts
// against the request: a deep-field answer of 880 KB cost 13 to 21 ms to save to D1 and about 25 ms to put in R2
// (preview, 2026-11-18), against a 10 ms plan. Ordinary answers are about 10 KB (the showcase spot 10.9 KB), so answers
// over 64 KB are not saved: they come from our own sky index in R2 (the deep fields at the ecliptic poles), which does not
// go down with IRSA, so the outage copy matters least for them.
export const SAVE_MAX_BYTES = 64 << 10;
export const worthSaving = res => !(Number(res.headers.get('X-Answer-Bytes')) > SAVE_MAX_BYTES);
