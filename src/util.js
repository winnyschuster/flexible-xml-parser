export function getAllMatches(string, regex) {
  const matches = [];
  let match = regex.exec(string);
  while (match) {
    const allmatches = [];
    allmatches.startIndex = regex.lastIndex - match[0].length;
    const len = match.length;
    for (let index = 0; index < len; index++) {
      allmatches.push(match[index]);
    }
    matches.push(allmatches);
    match = regex.exec(string);
  }
  return matches;
}



export function isSpace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}


export function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12; // space \t \n \r \f
}

export function isExist(v) {
  return typeof v !== 'undefined';
}

export function isEmptyObject(obj) {
  return Object.keys(obj).length === 0;
}

export function getValue(v) {
  if (isExist(v)) {
    return v;
  } else {
    return '';
  }
}

export const DANGEROUS_PROPERTY_NAMES = [
  'hasOwnProperty',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  "toLocaleString",
  "isPrototypeOf",
  "propertyIsEnumerable"
];

export const criticalProperties = ["__proto__", "constructor", "prototype"];

/**
 * Uniform error-position accessor across all InputSource types.
 *
 * Only BufferSource (UTF-8 byte-scan) currently needs real correction —
 * see Encoding/PositionCorrector/PositionCorrectors.js. Every other source
 * (StringSource, FeedableSource, and BufferSource on decode-first/
 * single-byte encodings) already tracks accurate line/col, so this is a
 * cheap passthrough for them, not a new cost on the hot path — correction
 * only ever runs here, once, at the moment a ParseError is being built.
 */
export function errorPositionOf(source) {
  if (typeof source.correctedPosition === 'function') {
    return source.correctedPosition();
  }
  return { line: source.line, col: source.cols, index: source.startIndex };
}
