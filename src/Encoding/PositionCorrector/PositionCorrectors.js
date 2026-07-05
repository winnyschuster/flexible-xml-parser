/**
 * PositionCorrector — picks which of the two counters ByteScanStrategy
 * maintains (`cols`, byte-counted; `_charCol`, character-counted, kept in
 * lockstep at O(1) per call — see ByteScanStrategy.js) is the right one to
 * report as `col` in a ParseError or TagDetail.
 *
 * Single-byte encodings and CharScanStrategy sources never need this at all
 * (byte offset == char offset already, or scanning already happens on
 * decoded characters) — they get NoOpPositionCorrector, exactly as cheap as
 * reading `cols` directly. Only self-synchronizing *variable-width*
 * encodings (UTF-8) need `_charCol`.
 *
 * Both are plain O(1) field reads — no rescanning of any kind here. An
 * earlier version of this file recomputed the column by walking the buffer
 * on every call; that call site (Xml2JsParser's main loop, once per
 * character) turned an intended "only pay at error time" optimization into
 * an O(line length) cost per character — O(n²) overall. Fixed by having
 * ByteScanStrategy maintain `_charCol` incrementally instead, so there is
 * nothing left to correct lazily.
 */
export const NoOpPositionCorrector = {
  pick(byteCol, _charCol) {
    return byteCol;
  },
};

export const Utf8BytePositionCorrector = {
  pick(_byteCol, charCol) {
    return charCol;
  },
};
