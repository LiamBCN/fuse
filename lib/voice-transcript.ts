// Merge the pre-recording composer text (base) with the recognizer's
// cumulative text (raw), never returning something shorter than what the
// user was already shown this session (prevShown). Whitespace-normalized.
export function mergeVoiceTranscript(base: string, raw: string, prevShown: string): string {
  const merged = (base + raw).replace(/\s+/g, " ");
  return merged.length >= prevShown.length ? merged : prevShown;
}
