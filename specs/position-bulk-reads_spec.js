/**
 * position-bulk-reads_spec.js
 *
 * Regression coverage for line/col tracking through bulk-read paths that
 * bypass readCh() entirely: readUpto/readUptoChar/readUptoCloseTag, as used
 * by CDATA, comments, and DOCTYPE internal-subset parsing.
 *
 * These paths were NOT covered by the v1.5.0 updateBufferBoundary() fix
 * (which only covers text runs via Xml2JsParser's explicit
 * updateBufferBoundary(runLen) call) — readUpto* mutated startIndex directly
 * without ever touching line/cols. Fixed by routing them through a shared
 * _advanceLineCol() helper on each InputSource.
 */
import XMLParser from "../src/XMLParser.js";
import { CompactBuilderFactory, CompactBuilder } from "@nodable/compact-builder";
import { runAcrossAllInputSourcesWithFactory } from "./helpers/testRunner.js";

function makeRecordingParser(parserOptions = {}) {
  const events = [];
  const factory = {
    getInstance(parserOpts, readonlyMatcher) {
      const base = new CompactBuilderFactory();
      return new (class extends CompactBuilder {
        addElement(tag, matcher) {
          events.push({ name: tag.name, line: tag.line, col: tag.col, index: tag.index });
          super.addElement(tag, matcher);
        }
      })(parserOpts, base.builderOptions, readonlyMatcher, base.registry);
    }
  };
  const parser = new XMLParser({ ...parserOptions, OutputBuilder: factory });
  parser._events = events;
  return parser;
}

describe("Position metadata — bulk-read paths (CDATA / comment / DOCTYPE)", function () {

  runAcrossAllInputSourcesWithFactory(
    "tag after a multi-line CDATA section reports the correct line/col",
    `<root><![CDATA[l1\nl2\nl3]]><tail/></root>`,
    (result, inputType, parser) => {
      const tail = parser._events.find(e => e.name === "tail");
      expect(tail.line).toBe(3);
      expect(tail.col).toBe(5); // line 3 is "l3]]>" before <tail -> col 5
    },
    () => makeRecordingParser()
  );

  runAcrossAllInputSourcesWithFactory(
    "tag after a multi-line comment reports the correct line/col",
    `<root><!-- l1\nl2\nl3 --><tail/></root>`,
    (result, inputType, parser) => {
      const tail = parser._events.find(e => e.name === "tail");
      expect(tail.line).toBe(3);
    },
    () => makeRecordingParser()
  );

  runAcrossAllInputSourcesWithFactory(
    "tag after a multi-line DOCTYPE internal subset reports the correct line/col",
    `<!DOCTYPE root [\n<!ENTITY foo "bar">\n<!ENTITY baz "qux">\n]><root/>`,
    (result, inputType, parser) => {
      const root = parser._events.find(e => e.name === "root");
      // 3 newlines inside the DOCTYPE block before <root/>
      expect(root.line).toBe(4);
    },
    () => makeRecordingParser()
  );

  runAcrossAllInputSourcesWithFactory(
    "single-line CDATA does not disturb col tracking on the same line",
    `<root><a/><![CDATA[x]]><b/></root>`,
    (result, inputType, parser) => {
      const b = parser._events.find(e => e.name === "b");
      expect(b.line).toBe(1);
      // <root><a/><![CDATA[x]]> = 6+4+13 = 23 chars before <b/>
      expect(b.col).toBe(23);
    },
    () => makeRecordingParser()
  );

});