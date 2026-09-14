/** Multipart File vs Value split used by original gin/mime parsers. */

export type MultipartFilePart = { name: string; filename: string; data: Uint8Array };

export type ParsedMultipart = {
  values: Record<string, string[]>;
  files: MultipartFilePart[];
};

export function multipartBoundary(contentType: string): string {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return (match?.[1] || match?.[2] || "").trim();
}

export function parseMultipartForm(rawBody: ArrayBuffer, contentType: string): ParsedMultipart {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error("multipart boundary is required");
  const text = new TextDecoder("latin1").decode(rawBody);
  const delim = `--${boundary}`;
  const start = text.indexOf(delim);
  if (start < 0) throw new Error("multipart boundary not found");
  const values: Record<string, string[]> = {};
  const files: MultipartFilePart[] = [];
  let pos = start + delim.length;
  while (pos < text.length) {
    if (text.startsWith("--", pos)) break;
    if (text.startsWith("\r\n", pos)) pos += 2;
    const next = text.indexOf(`\r\n${delim}`, pos);
    if (next < 0) break;
    const part = text.slice(pos, next);
    pos = next + 2 + delim.length;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4);
    const disp = /^content-disposition:\s*(.+)$/im.exec(headers)?.[1] || "";
    const name = /(?:^|;)\s*name="([^"]*)"/.exec(disp)?.[1] || /(?:^|;)\s*name=([^;]+)/.exec(disp)?.[1]?.trim() || "";
    if (!name) continue;
    const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/.exec(disp) || /(?:^|;)\s*filename=([^;]+)/.exec(disp);
    const data = Uint8Array.from(bodyText, (c) => c.charCodeAt(0));
    if (filenameMatch) files.push({ name, filename: (filenameMatch[1] || "").trim(), data });
    else {
      const value = new TextDecoder("utf-8").decode(data);
      if (!values[name]) values[name] = [];
      values[name].push(value);
    }
  }
  return { values, files };
}
