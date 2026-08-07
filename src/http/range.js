/**
 * Byte-range parsing for the media endpoint.
 *
 * <audio> and <video> ask for ranges in order to seek, and Chrome will not
 * give a voice note a scrubbable duration without a 206 coming back - so
 * "Accept-Ranges: bytes" has to be honoured, not just advertised.
 *
 * Only the single-range forms browsers actually send are supported:
 *   bytes=500-999   an explicit window
 *   bytes=500-      from an offset to the end (how playback opens)
 *   bytes=-500      the LAST 500 bytes, not the first
 *
 * @returns {null | {satisfiable: false} | {satisfiable: true, start: number, end: number}}
 *   null when there is no usable Range header at all and the caller should
 *   just send the whole body.
 */
function resolveRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  // "bytes=-" carries no numbers and means nothing.
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;

  if (!rawStart) {
    // Suffix form: the last N bytes. N larger than the file means the lot.
    const wanted = Number(rawEnd);
    if (wanted === 0) return { satisfiable: false };
    start = Math.max(0, size - wanted);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (end >= size) end = size - 1;
  }

  if (start >= size || start > end) return { satisfiable: false };
  return { satisfiable: true, start, end };
}

module.exports = { resolveRange };
