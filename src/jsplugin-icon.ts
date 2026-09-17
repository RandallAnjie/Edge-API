/**
 * Original QuantumNous `pkg/jsplugin` DecodeIconDataURI / ValidateIconImage.
 */

export const MAX_ICON_DATA_URI_BYTES = 512 * 1024;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isSpaceOrControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code <= 32 || (code >= 127 && code <= 159);
}

function svgValueReferencesExternal(value: string): boolean {
  let compact = "";
  for (const character of value) {
    if (isSpaceOrControl(character)) continue;
    compact += character.toLowerCase();
  }
  return compact.includes("javascript:") || compact.includes("http://") || compact.includes("https://");
}

function decodeStdBase64Strict(payload: string): Uint8Array {
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error("plugin icon payload is not valid base64");
  }
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  if (payload.slice(0, payload.length - pad).includes("=")) {
    throw new Error("plugin icon payload is not valid base64");
  }
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error("plugin icon payload is not valid base64");
  }
}

function xmlNameLocal(name: string): string {
  const idx = name.indexOf(":");
  return (idx >= 0 ? name.slice(idx + 1) : name).toLowerCase();
}

function parseAttributes(raw: string): { name: string; value: string }[] {
  const attrs: { name: string; value: string }[] = [];
  const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    attrs.push({ name: match[1], value: match[3] ?? match[4] ?? match[5] ?? "" });
  }
  return attrs;
}

/** Original `jsplugin.ValidateIconImage`. */
export function validateIconImage(mediaType: string, data: Uint8Array): void {
  if (mediaType === "image/png") {
    if (data.length < PNG_SIGNATURE.length) throw new Error("plugin icon PNG payload is not a PNG image");
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      if (data[i] !== PNG_SIGNATURE[i]) throw new Error("plugin icon PNG payload is not a PNG image");
    }
    return;
  }
  if (mediaType !== "image/svg+xml") throw new Error("plugin icon must be image/png or image/svg+xml");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  let i = 0;
  let rootSeen = false;
  let styleDepth = 0;
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  while (i < text.length) {
    if (text[i] !== "<") {
      const next = text.indexOf("<", i);
      const chunk = next < 0 ? text.slice(i) : text.slice(i, next);
      if (styleDepth > 0 && (svgValueReferencesExternal(chunk) || chunk.toLowerCase().includes("@import"))) {
        throw new Error("plugin icon SVG must not reference scripts or external resources");
      }
      i = next < 0 ? text.length : next;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) throw new Error("plugin icon SVG is not well-formed XML");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![", i) || text.startsWith("<!DOCTYPE", i) || text.startsWith("<!doctype", i) || text.startsWith("<!", i)) {
      throw new Error("plugin icon SVG must not contain a DOCTYPE or other directives");
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) throw new Error("plugin icon SVG is not well-formed XML");
      const target = text.slice(i + 2, end).trim().split(/\s/)[0] || "";
      if (target.toLowerCase() !== "xml") throw new Error("plugin icon SVG must not contain processing instructions");
      i = end + 2;
      continue;
    }
    if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i + 2);
      if (end < 0) throw new Error("plugin icon SVG is not well-formed XML");
      const local = xmlNameLocal(text.slice(i + 2, end).trim());
      if (local === "style" && styleDepth > 0) styleDepth -= 1;
      i = end + 1;
      continue;
    }
    const end = text.indexOf(">", i + 1);
    if (end < 0) throw new Error("plugin icon SVG is not well-formed XML");
    const body = text.slice(i + 1, end).trim();
    const selfClosing = body.endsWith("/");
    const nameAndAttrs = selfClosing ? body.slice(0, -1).trim() : body;
    const sp = nameAndAttrs.search(/\s/);
    const rawName = (sp < 0 ? nameAndAttrs : nameAndAttrs.slice(0, sp)).trim();
    const attrRaw = sp < 0 ? "" : nameAndAttrs.slice(sp);
    const local = xmlNameLocal(rawName);
    if (!rawName) throw new Error("plugin icon SVG is not well-formed XML");
    if (!rootSeen) {
      if (local !== "svg") throw new Error("plugin icon SVG root element must be svg");
      rootSeen = true;
    }
    if (local === "script" || local === "foreignobject") {
      throw new Error(`plugin icon SVG must not contain ${rawName.includes(":") ? rawName.split(":").pop() : rawName} elements`);
    }
    if (local === "style" && !selfClosing) styleDepth += 1;
    for (const attr of parseAttributes(attrRaw)) {
      const attrLocal = xmlNameLocal(attr.name);
      if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) continue;
      if (attrLocal.startsWith("on")) throw new Error("plugin icon SVG must not contain event handler attributes");
      if (svgValueReferencesExternal(attr.value)) {
        throw new Error("plugin icon SVG must not reference scripts or external resources");
      }
    }
    i = end + 1;
  }
  if (!rootSeen) throw new Error("plugin icon SVG root element must be svg");
}

/** Original `jsplugin.DecodeIconDataURI`. */
export function decodeIconDataURI(icon: string): { mediaType: string; data: Uint8Array } {
  if (icon.length > MAX_ICON_DATA_URI_BYTES) {
    throw new Error(`plugin icon must not exceed ${MAX_ICON_DATA_URI_BYTES} bytes`);
  }
  if (!icon.startsWith("data:")) {
    throw new Error("plugin icon must be data:image/png;base64,... or data:image/svg+xml;base64,...");
  }
  const rest = icon.slice("data:".length);
  const sep = rest.indexOf(";base64,");
  if (sep < 0) {
    throw new Error("plugin icon must be data:image/png;base64,... or data:image/svg+xml;base64,...");
  }
  const mediaType = rest.slice(0, sep);
  const payload = rest.slice(sep + ";base64,".length);
  if (mediaType !== "image/png" && mediaType !== "image/svg+xml") {
    throw new Error("plugin icon must be data:image/png;base64,... or data:image/svg+xml;base64,...");
  }
  const decoded = decodeStdBase64Strict(payload);
  validateIconImage(mediaType, decoded);
  return { mediaType, data: decoded };
}
