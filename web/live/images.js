// /api/images answers as a list of { t, key, obs }, whichever shape the Worker sent: the full one (an object per image,
// with coll) or fmt=2 (each image [t, folder, seq, sub] with its folder's text once, or [t, key, obs] when IRSA answered).
export function imagesOf(answer) {
  if (answer.fmt !== 2) return answer.images;
  const F = answer.folders || [];
  return answer.images.map(x => {
    if (typeof x[1] === 'string') return { t: x[0], key: x[1], obs: x[2] };
    const [pre, post, period] = F[x[1]], rest = `${String(x[2]).padStart(4, '0')}_${x[3]}`;
    return { t: x[0], key: pre + rest + post, obs: `${period}_${rest}` };
  });
}
