import XMLParser from "../src/XMLParser.js";

/**
 * Regression coverage for the flush-architecture fix.
 *
 * Background: updateBufferBoundary() used to gate flush() behind an
 * "anyMarkActive" check. Since _marks[0] is set on every parseXml() loop
 * iteration and only ever nulled by rewindToMark() (an error path),
 * that gate was permanently true in normal operation, so flush() never ran —
 * FeedableSource/StringSource silently retained the entire document in
 * memory regardless of flushThreshold, and (as a second-order effect) every
 * substring()/readStr() call on the ever-growing buffer made parsing
 * approach O(n^2) on large documents.
 */
describe("FeedableSource flush architecture", () => {

  it("trims the buffer below flushThreshold repeatedly across many feed() calls", () => {
    const parser = new XMLParser({ feedable: { flushThreshold: 200, bufferSize: 50 } });
    let xml = "<root>";
    for (let i = 0; i < 50; i++) xml += `<item id="${i}">padding text here</item>`;
    xml += "</root>";

    let sawShrinkBelowThreshold = false;
    for (let i = 0; i < xml.length; i += 30) {
      parser.feed(xml.slice(i, i + 30));
      if (parser._feedSource.buffer.length < 200) sawShrinkBelowThreshold = true;
    }

    expect(sawShrinkBelowThreshold).toBe(true);
    expect(parser._feedSource.buffer.length).toBeLessThan(xml.length);
  });

  it("keeps peak buffer size bounded (not ~= full document) on a large document", () => {
    const chunk = `<item id="ID" attr="value">some text content padding data here</item>\n`;
    let parts = [];
    let total = 6;
    while (total < 2 * 1024 * 1024) { parts.push(chunk); total += chunk.length; }
    const xml = "<root>" + parts.join("") + "</root>";

    const parser = new XMLParser({ feedable: { flushThreshold: 1024, maxBufferSize: 200 * 1024 * 1024 } });
    let peakBuffer = 0;
    for (let i = 0; i < xml.length; i += 4096) {
      parser.feed(xml.slice(i, i + 4096));
      peakBuffer = Math.max(peakBuffer, parser._feedSource.buffer.length);
    }
    parser.end();

    expect(peakBuffer).toBeLessThan(xml.length / 2);
  });

  it("still produces the correct parsed result after flush is applied (correctness, not just size)", () => {
    const parser = new XMLParser({ feedable: { flushThreshold: 50, bufferSize: 20 } });
    const xml = "<root><a>1</a><b>2</b><c>3</c></root>";
    for (let i = 0; i < xml.length; i += 7) parser.feed(xml.slice(i, i + 7));
    const result = parser.end();
    expect(result.root.a).toBe(1);
    expect(result.root.b).toBe(2);
    expect(result.root.c).toBe(3);
  });

  // ── Highest-risk area: flush() actually running now interacting with
  // rewindToMark() on a token split across a feed() boundary. This
  // combination was never exercised before (flush was always dead), so it
  // has no prior coverage anywhere else in the suite.

  it("correctly resumes a CDATA section split across a feed() boundary, with a low flushThreshold active", () => {
    const parser = new XMLParser({ feedable: { flushThreshold: 10, bufferSize: 10 } });
    const cdataContent = "x".repeat(200) + "SPLIT_MARKER" + "y".repeat(200);
    const xml = `<root><data><![CDATA[${cdataContent}]]></data></root>`;

    for (let i = 0; i < xml.length; i += 5) parser.feed(xml.slice(i, i + 5));
    const result = parser.end();

    const text = typeof result.root.data === "string" ? result.root.data : JSON.stringify(result.root.data);
    expect(text).toContain("SPLIT_MARKER");
    expect(text.length).toBeGreaterThanOrEqual(cdataContent.length);
  });

  it("correctly resumes an opening tag with attributes split across a feed() boundary, with a low flushThreshold active", () => {
    const parser = new XMLParser({ feedable: { flushThreshold: 15, bufferSize: 8 }, skip: { attributes: false } });
    let xml = "<root>";
    for (let i = 0; i < 30; i++) {
      xml += `<item id="${i}" label="item-number-${i}" flag="true">value-${i}</item>`;
    }
    xml += "</root>";

    for (let i = 0; i < xml.length; i += 3) parser.feed(xml.slice(i, i + 3));
    const result = parser.end();

    const items = result.root.item;
    expect(items.length).toBe(30);
    expect(items[0]["@_id"]).toBe(0);
    expect(items[29]["@_label"]).toBe("item-number-29");
  });

  it("correctly resumes a DOCTYPE internal subset split across a feed() boundary, with a low flushThreshold active", () => {
    const parser = new XMLParser({
      feedable: { flushThreshold: 12, bufferSize: 8 },
      doctypeOptions: { enabled: true },
    });
    const xml = `<!DOCTYPE root [
      <!ENTITY foo "bar">
      <!ELEMENT root (child)>
      <!ATTLIST root id CDATA #IMPLIED>
    ]>
    <root><child>ok</child></root>`;

    for (let i = 0; i < xml.length; i += 4) parser.feed(xml.slice(i, i + 4));
    const result = parser.end();

    expect(result.root.child).toBe("ok");
  });

  it("StringSource (one-shot parse()) also flushes — sanity check the same fix applies there", () => {
    const parser = new XMLParser({ feedable: {} }); // n/a to parse(), StringSource has its own defaults
    const chunk = "<item>padding text here</item>";
    let xml = "<root>" + chunk.repeat(200) + "</root>";
    const result = parser.parse(xml);
    expect(result.root.item.length).toBe(200);
  });
});
