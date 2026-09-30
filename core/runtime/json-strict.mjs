// 严格 JSON 解析（contracts §6.5 / C19）：拒绝重复键、深度超限、NaN/Infinity 字面量、尾随内容。
// 用于 config/cache 等有界（≤1MiB）文件；比 JSON.parse 严格，错误带固定 reasonCode。

export class StrictJsonError extends Error {
  constructor(reasonCode, message) { super(message); this.reasonCode = reasonCode; }
}

export function parseStrictJson(text, { maxDepth = 32, limit = 1024 * 1024 } = {}) {
  if (typeof text !== "string") throw new StrictJsonError("file-malformed", "not text");
  if (text.length > limit) throw new StrictJsonError("file-malformed", "over limit");
  let i = 0;
  const n = text.length;

  function ws() {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  }

  function value(depth) {
    if (depth > maxDepth) throw new StrictJsonError("file-malformed", `depth > ${maxDepth}`);
    ws();
    if (i >= n) throw new StrictJsonError("file-malformed", "unexpected end");
    const c = text[i];
    if (c === "{") return object(depth);
    if (c === "[") return array(depth);
    if (c === '"') return string();
    if (c === "t") { expect("true"); return true; }
    if (c === "f") { expect("false"); return false; }
    if (c === "n") { expect("null"); return null; }
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    throw new StrictJsonError("file-malformed", `unexpected char ${JSON.stringify(c)}`);
  }

  function expect(word) {
    if (text.startsWith(word, i)) { i += word.length; return; }
    throw new StrictJsonError("file-malformed", `expected ${word}`);
  }

  function number() {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (text[i] >= "1" && text[i] <= "9") { while (i < n && text[i] >= "0" && text[i] <= "9") i++; }
    else throw new StrictJsonError("file-malformed", "bad number");
    if (text[i] === ".") {
      i++;
      if (!(text[i] >= "0" && text[i] <= "9")) throw new StrictJsonError("file-malformed", "bad frac");
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!(text[i] >= "0" && text[i] <= "9")) throw new StrictJsonError("file-malformed", "bad exp");
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    const raw = text.slice(start, i);
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new StrictJsonError("file-malformed", "non-finite number");
    return v;
  }

  function string() {
    if (text[i] !== '"') throw new StrictJsonError("file-malformed", "bad string");
    i++;
    let out = "";
    for (;;) {
      if (i >= n) throw new StrictJsonError("file-malformed", "unterminated string");
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c === "\\") {
        i++;
        const e = text[i];
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new StrictJsonError("file-malformed", "bad \\u");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else throw new StrictJsonError("file-malformed", "bad escape");
        i++;
        continue;
      }
      const cp = c.codePointAt(0);
      if (cp < 0x20) throw new StrictJsonError("file-malformed", "raw control char in string");
      out += c;
      i++;
    }
  }

  function array(depth) {
    i++; // [
    const out = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value(depth + 1));
      ws();
      if (text[i] === ",") { i++; ws(); continue; }
      if (text[i] === "]") { i++; return out; }
      throw new StrictJsonError("file-malformed", "bad array");
    }
  }

  function object(depth) {
    i++; // {
    const out = Object.create(null); // 无原型：重复键检测 + 原型污染防护
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') throw new StrictJsonError("file-malformed", "bad key");
      const key = string();
      ws();
      if (text[i] !== ":") throw new StrictJsonError("file-malformed", "bad colon");
      i++;
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new StrictJsonError("duplicate-key", `duplicate key "${key}"`);
      }
      out[key] = value(depth + 1);
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      throw new StrictJsonError("file-malformed", "bad object");
    }
  }

  const v = value(0);
  ws();
  if (i !== n) throw new StrictJsonError("file-malformed", "trailing content");
  return v;
}
