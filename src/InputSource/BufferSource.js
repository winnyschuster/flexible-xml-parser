import { ParseError, ErrorCode } from '../ParseError.js';

const Constants = {
  space: 32,
  tab: 9,
};

/**
 * BufferSource — input source backed by a Node.js Buffer (byte array).
 *
 * ### Memory reclamation
 *
 * The full document is available from the start, so there is no chunk-boundary
 * risk and rewindToMark() is a safe no-op. However, the parsed prefix of the
 * Buffer is held in memory until the parse finishes. flush() reclaims it by
 * slicing the Buffer and resetting startIndex to 0.
 *
 * The same mark/flush protocol used by FeedableSource is implemented here so
 * all reader functions work without source-type conditionals:
 *
 *   markTokenStart()  — save current read position at the start of a token
 *   rewindToMark()    — no-op for BufferSource (full doc always present)
 *   flush()           — drop the already-parsed prefix to free memory
 *
 * Auto-flush fires inside updateBufferBoundary() whenever the processed
 * portion exceeds flushThreshold and no token checkpoint is active.
 */
export default class BufferSource {
  /**
   * @param {Buffer} bytesArr — the full XML document as a Node.js Buffer
   * @param {object} [options]
   * @param {boolean} [options.autoFlush=true]      — enable automatic flushing
   * @param {number}  [options.flushThreshold=1024] — flush after this many processed bytes
   */
  constructor(bytesArr, options = {}) {
    this.line = 1;
    this.cols = 0;
    this.buffer = bytesArr;
    this.startIndex = 0;

    this.autoFlush = options.autoFlush !== false;
    this.flushThreshold = options.flushThreshold ?? 1024;

    // Token-start checkpoint for mark/rewind (mirrors FeedableSource API).
    this._tokenStart = -1;
  }

  // ─── Token-start checkpoint ───────────────────────────────────────────────

  /**
   * Save the current read position as the start of a new logical token.
   *
   * For BufferSource this primarily guards flush() from reclaiming data that
   * is still being read, mirroring the same safety invariant as FeedableSource.
   */
  markTokenStart() {
    this._tokenStart = this.startIndex;
  }

  /**
   * Restore startIndex to the last markTokenStart() position.
   *
   * BufferSource always has the full document available, so a mid-token end
   * of input cannot occur and this method is a safe no-op. It exists solely
   * so caller code can call rewindToMark() unconditionally without branching
   * on source type.
   */
  rewindToMark() {
    // No-op: the complete document is in memory; no rewind is ever needed.
  }

  /**
   * Discard the already-processed prefix of the buffer to free memory.
   *
   * Uses Buffer.subarray() (zero-copy view) rather than Buffer.slice() for
   * clarity, then copies to a fresh Buffer so the original allocation can be
   * GC'd. If a token checkpoint is active, the flush origin is moved back to
   * the checkpoint so the in-progress token is preserved.
   */
  flush() {
    const origin = this._tokenStart >= 0 ? this._tokenStart : this.startIndex;
    if (origin > 0) {
      // Buffer.from(subarray) copies the bytes so the original large Buffer
      // can be released by the GC once no other references remain.
      this.buffer = Buffer.from(this.buffer.subarray(origin));
      if (this._tokenStart >= 0) {
        this.startIndex -= origin;
        this._tokenStart = 0;
      } else {
        this.startIndex = 0;
      }
    }
  }

  // ─── Core read interface ──────────────────────────────────────────────────

  readCh() {
    const code = this.buffer[this.startIndex++];
    if (code === 10) { // '\n'
      this.line++;
      this.cols = 0;
    } else {
      this.cols++;
    }
    return String.fromCharCode(code);
  }

  readChAt(index) {
    return String.fromCharCode(this.buffer[this.startIndex + index]);
  }

  readStr(n, from) {
    if (typeof from === 'undefined') from = this.startIndex;
    return this.buffer.slice(from, from + n).toString();
  }

  /**
   * See StringSource.scanTagExpEnd() for full rationale. Byte-indexed —
   * quote/`>` are single-byte ASCII, safe for multi-byte UTF-8 content too
   * (a `>` byte never appears as a UTF-8 continuation byte). Buffer isn't a
   * rope, so no equivalent of FeedableSource's charCodeAt/flatten concern.
   */
  scanTagExpEnd() {
    const buf = this.buffer;
    const len = buf.length;
    const start = this.startIndex;
    let inSingle = false;
    let inDouble = false;
    for (let i = start; i < len; i++) {
      const c = buf[i];
      if (c === 39) { // '
        if (!inDouble) inSingle = !inSingle;
      } else if (c === 34) { // "
        if (!inSingle) inDouble = !inDouble;
      } else if (c === 62 && !inSingle && !inDouble) { // >
        return i - start;
      }
    }
    return -1;
  }

  /**
   * Scan buffer[this.startIndex, end) for byte code 10 ('\n') and advance
   * line/cols to match, mirroring readCh()'s per-byte logic. Does NOT touch
   * startIndex — callers set that themselves afterwards (their "end" is not
   * always startIndex + n; readUptoCloseTag's consumed span includes the
   * matched stop string).
   *
   * Shared by updateBufferBoundary() and the readUpto*() family so every path
   * that advances the cursor in bulk keeps line/col accurate, not just the
   * single-byte readCh() path.
   *
   * @param {number} end — exclusive end of the span being skipped
   */
  _advanceLineCol(end) {
    let lastNewlineIdx = -1;
    for (let i = this.startIndex; i < end; i++) {
      if (this.buffer[i] === 10) {
        this.line++;
        lastNewlineIdx = i;
      }
    }
    if (lastNewlineIdx >= 0) {
      this.cols = end - lastNewlineIdx - 1;
    } else {
      this.cols += end - this.startIndex;
    }
  }

  readUpto(stopStr) {
    const inputLength = this.buffer.length;
    const stopLength = stopStr.length;
    const stopBuffer = Buffer.from(stopStr);

    for (let i = this.startIndex; i < inputLength; i++) {
      let match = true;
      for (let j = 0; j < stopLength; j++) {
        if (this.buffer[i + j] !== stopBuffer[j]) { match = false; break; }
      }
      if (match) {
        const result = this.buffer.slice(this.startIndex, i).toString();
        this._advanceLineCol(i + stopLength);
        this.startIndex = i + stopLength;
        return result;
      }
    }

    throw new ParseError(`Unexpected end of source reading '${stopStr}'`, ErrorCode.UNEXPECTED_END);
  }

  /**
   * Single-character variant of readUpto — faster because there is no inner
   * match loop.  Reads until `stopChar` is found, consumes it, and returns
   * the text before it.
   *
   * @param {string} stopChar  Exactly one character.
   * @returns {string}
   */
  readUptoChar(stopChar) {
    const stopCode = stopChar.charCodeAt(0);
    const buf = this.buffer;
    const len = buf.length;
    for (let i = this.startIndex; i < len; i++) {
      if (buf[i] === stopCode) {
        const result = buf.slice(this.startIndex, i).toString();
        this._advanceLineCol(i + 1);
        this.startIndex = i + 1;
        return result;
      }
    }
    throw new ParseError(`Unexpected end of source reading '${stopChar}'`, ErrorCode.UNEXPECTED_END);
  }

  readUptoCloseTag(stopStr) { // stopStr: "</tagname"
    const inputLength = this.buffer.length;
    const stopLength = stopStr.length;
    const stopBuffer = Buffer.from(stopStr);
    const GT = 62; // '>'
    let tagMatchStart = -1;
    let state = 0; // 0=scanning, 1=tag-name matched (scanning for '>'), 2=full match

    for (let i = this.startIndex; i < inputLength; i++) {
      if (state === 1) {
        const b = this.buffer[i];
        if (b === Constants.space || b === Constants.tab) continue;
        if (b === GT) { state = 2; }
        else { state = 0; tagMatchStart = -1; } // false match e.g. </scriptX>
      } else {
        // Try to match stopStr at position i
        let matched = true;
        for (let j = 0; j < stopLength; j++) {
          if (this.buffer[i + j] !== stopBuffer[j]) { matched = false; break; }
        }
        if (matched) {
          state = 1;
          tagMatchStart = i;
          i += stopLength - 1; // skip past matched string
        }
      }
      if (state === 2) {
        const result = this.buffer.slice(this.startIndex, tagMatchStart).toString();
        this._advanceLineCol(i + 1);
        this.startIndex = i + 1;
        return result;
      }
    }

    throw new ParseError(`Unexpected end of source reading '${stopStr}'`, ErrorCode.UNEXPECTED_END);
  }

  readFromBuffer(n, shouldUpdate) {
    let ch;
    if (n === 1) {
      ch = this.buffer[this.startIndex];
      if (ch === 10) { // '\n'
        this.line++;
        this.cols = 1;
      } else {
        this.cols++;
      }
      ch = String.fromCharCode(ch);
    } else {
      this.cols += n;
      ch = this.buffer.slice(this.startIndex, this.startIndex + n).toString();
    }
    if (shouldUpdate) this.updateBufferBoundary(n);
    return ch;
  }

  /**
   * Advance the read cursor by n bytes.
   *
   * Triggers an automatic flush of already-processed data when autoFlush is
   * enabled, the processed portion has grown past flushThreshold, and no
   * token checkpoint is currently active (a flush while a checkpoint is live
   * would invalidate the saved position).
   *
   * @param {number} [n=1]
   */
  updateBufferBoundary(n = 1) {
    const end = this.startIndex + n;
    this._advanceLineCol(end);
    this.startIndex = end;
    if (this.autoFlush && this.startIndex >= this.flushThreshold && this._tokenStart < 0) {
      this.flush();
    }
  }

  canRead(n) {
    n = (n !== undefined) ? n : this.startIndex;
    return this.buffer.length - n > 0;
  }
}