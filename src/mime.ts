// What the gateway does with an entry by the extension of its name: whether a
// site rewrites it as it streams (the gateway rewrites the types mime_guess
// maps these extensions to:
// https://github.com/decdn/decdn/blob/main/crates/cli/src/commands/gateway/rewrite.rs),
// and the type a site serves it as, for the common web types.

/** Extensions a site serves as `text/html` or `text/css`, rewritten as they stream. */
const REWRITTEN = /\.(html?|hxt|shtml|css)$/i;

/** Whether a site rewrites the entry at `path`, so its bytes need not hash to the entry hash. */
export function rewritten(path: string): boolean {
  return REWRITTEN.test(path);
}

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "text/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** The type a site serves the entry at `path` as: text in UTF-8, bytes for an unknown extension. */
export function siteType(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  const t = TYPES[ext] ?? "application/octet-stream";
  return t.startsWith("text/") ? `${t}; charset=utf-8` : t;
}
