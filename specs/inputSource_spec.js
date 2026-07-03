import XMLParser from "../src/XMLParser.js";
import FeedableSource from '../src/InputSource/FeedableSource.js';
import BufferSource from '../src/InputSource/BufferSource.js';

describe("Input Sources", function () {

  it("should parse from string", function () {
    const xmlString = "<root><tag>value</tag></root>";
    const parser = new XMLParser();
    const result = parser.parse(xmlString);

    expect(result.root.tag).toBe("value");
  });

  it("should parse from Buffer", function () {
    const xmlString = "<root><tag>123</tag></root>";
    const buffer = Buffer.from(xmlString);
    const parser = new XMLParser();
    const result = parser.parse(buffer);

    expect(result.root.tag).toBe(123);
  });

  it("should parse from Uint8Array using parseBytesArr", function () {
    const xmlString = "<root><tag>test</tag></root>";
    const uint8Array = new Uint8Array(Buffer.from(xmlString));
    const parser = new XMLParser();
    const result = parser.parseBytesArr(uint8Array);

    expect(result.root.tag).toBe("test");
  });

  it("should handle UTF-8 encoded content", function () {
    const xmlString = "<root><tag>Hello 世界 🌍</tag></root>";
    const parser = new XMLParser();
    const result = parser.parse(xmlString);

    expect(result.root.tag).toBe("Hello 世界 🌍");
  });

  it("should use feed/end API for streaming", function () {
    const parser = new XMLParser();

    parser.feed("<root>");
    parser.feed("<tag>value</tag>");
    parser.feed("</root>");
    const result = parser.end();

    expect(result.root.tag).toBe("value");
  });

  it("should handle chunked streaming data", function () {
    const parser = new XMLParser();
    const chunks = [
      "<root>",
      "<items>",
      "<item>first</item>",
      "<item>second</item>",
      "</items>",
      "</root>"
    ];

    chunks.forEach(chunk => parser.feed(chunk));
    const result = parser.end();

    expect(Array.isArray(result.root.items.item)).toBe(true);
    expect(result.root.items.item[0]).toBe("first");
    expect(result.root.items.item[1]).toBe("second");
  });

});

describe('FeedableSource autoFlush', function () {

  it('never trims the buffer once parseXml()\'s level-0 mark pattern is in play', function () {
    // Mirrors real usage: parseXml()'s main loop calls markTokenStart(0) once
    // per iteration and only clears it via rewindToMark() (the error/retry
    // path). On the success path the level-0 mark is simply overwritten by
    // the next markTokenStart(0), never nulled — so _marks[0] is non-null
    // essentially forever. updateBufferBoundary()'s flush gate requires BOTH
    // marks to be null, so flush() should never actually run in this pattern.
    const source = new FeedableSource({ flushThreshold: 16, autoFlush: true });

    let fed = '';
    for (let i = 0; i < 50; i++) {
      const chunk = `x${i}`.padEnd(10, '_');
      source.feed(chunk);
      fed += chunk;

      // Simulate parseXml()'s loop: mark before "reading a token", then
      // advance the cursor as if a token of the chunk's length was consumed.
      source.markTokenStart(0);
      source.updateBufferBoundary(chunk.length);
    }

    // We've advanced well past flushThreshold (16) many times over.
    expect(source.startIndex).toBeGreaterThan(source.flushThreshold * 5);

    // BUG: buffer.length should have been trimmed by flush() at least once
    // if autoFlush were actually doing its job. Instead the buffer still
    // holds the entire fed document — flush() never ran.
    expect(source.buffer.length).toBe(fed.length);
    expect(source.buffer).toBe(fed);
  });

  it('trims correctly if the level-0 mark is explicitly cleared (proves flush() itself is fine)', function () {
    // Sanity check / isolation: flush()'s trimming logic is correct — the
    // bug is specifically that nothing in the codebase ever clears _marks[0]
    // on the success path (clearMark() exists but is never called anywhere
    // in src/, confirmed by grep).
    const source = new FeedableSource({ flushThreshold: 16, autoFlush: true });

    let fed = '';
    for (let i = 0; i < 50; i++) {
      const chunk = `x${i}`.padEnd(10, '_');
      source.feed(chunk);
      fed += chunk;

      source.markTokenStart(0);
      source._marks[0] = null; // what a "clearMark()" call would achieve
      source.updateBufferBoundary(chunk.length);
    }

    expect(source.buffer.length).toBeLessThan(fed.length);
  });

  it('end-to-end via XMLParser.feed(): internal buffer grows to full document size on a real parse session', function () {
    // Same bug, through the public API, so it can't be dismissed as an
    // artifact of calling FeedableSource methods in an unrealistic order.
    const parser = new XMLParser({ feedable: { flushThreshold: 64 } });

    const item = '<item><name>value</name></item>';
    const chunkSize = 8; // small chunks to force many feed()/parseXml() cycles
    let totalFed = 0;

    for (let n = 0; n < 200; n++) {
      for (let i = 0; i < item.length; i += chunkSize) {
        const chunk = item.slice(i, i + chunkSize);
        parser.feed(chunk);
        totalFed += chunk.length;
      }
    }
    // Check the live buffer just before end() (which nulls _feedSource).
    const bufferLenBeforeEnd = parser._feedSource.buffer.length;
    parser.end();

    // If autoFlush worked, the live buffer would stay small (bounded by
    // flushThreshold plus a bit of slack), regardless of how much total data
    // was fed across the whole session. Instead it grows unboundedly with
    // totalFed, confirming flush() never fires in a real feed() session.
    expect(bufferLenBeforeEnd).toBeGreaterThan(totalFed - 100);
  });

});

describe('BufferSource.readFromBuffer (item 10b fix)', function () {

  it('peek (shouldUpdate=false) does not mutate line/cols/startIndex', function () {
    const source = new BufferSource(Buffer.from('ab\ncd'));
    const before = { line: source.line, cols: source.cols, startIndex: source.startIndex };
    source.readFromBuffer(3, false); // peeks "ab\n" without consuming
    expect(source.line).toBe(before.line);
    expect(source.cols).toBe(before.cols);
    expect(source.startIndex).toBe(before.startIndex);
  });

  it('single-char consume matches readCh() line/col semantics (cols=0 after \\n, not 1)', function () {
    const viaReadFromBuffer = new BufferSource(Buffer.from('a\nb'));
    viaReadFromBuffer.readFromBuffer(1, true); // 'a'
    viaReadFromBuffer.readFromBuffer(1, true); // '\n'

    const viaReadCh = new BufferSource(Buffer.from('a\nb'));
    viaReadCh.readCh(); // 'a'
    viaReadCh.readCh(); // '\n'

    expect(viaReadFromBuffer.line).toBe(viaReadCh.line);
    expect(viaReadFromBuffer.cols).toBe(viaReadCh.cols);
    expect(viaReadFromBuffer.cols).toBe(0); // was 1 before the fix
  });

  it('multi-char consume does not double-count a newline in the span', function () {
    const source = new BufferSource(Buffer.from('ab\ncd'));
    source.readFromBuffer(5, true); // consume entire buffer in one call
    // Exactly one '\n' in the span -> line should advance by exactly 1.
    expect(source.line).toBe(2);
    // cols = chars after the last '\n' = "cd".length = 2, not 5 (old cols+=n bug)
    // and not double-applied via a second independent line/col pass.
    expect(source.cols).toBe(2);
  });

  it('multi-char consume matches char-by-char readCh() for line/col, across a newline', function () {
    const viaBulk = new BufferSource(Buffer.from('12\n345'));
    viaBulk.readFromBuffer(6, true);

    const viaChars = new BufferSource(Buffer.from('12\n345'));
    for (let i = 0; i < 6; i++) viaChars.readCh();

    expect(viaBulk.line).toBe(viaChars.line);
    expect(viaBulk.cols).toBe(viaChars.cols);
  });

  it('returns the correct substring for both single-char and multi-char reads', function () {
    const source = new BufferSource(Buffer.from('hello'));
    expect(source.readFromBuffer(1, false)).toBe('h');
    expect(source.readFromBuffer(5, false)).toBe('hello');
  });

});