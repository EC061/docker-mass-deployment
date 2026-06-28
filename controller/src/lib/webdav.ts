/**
 * Tiny WebDAV client (PUT/GET/PROPFIND/DELETE/MKCOL) over fetch with HTTP basic auth.
 * Used to ship SQLite backups off-box and to list/prune/restore them.
 */

export interface WebdavConfig {
  url: string; // base collection URL, no trailing slash
  user: string;
  pass: string;
}

const TIMEOUT_MS = 15000;

function authHeader(cfg: WebdavConfig): Record<string, string> {
  if (!cfg.user) return {};
  const token = Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function dav(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export async function ensureCollection(cfg: WebdavConfig): Promise<void> {
  // MKCOL is not recursive, so walk the URL's path and create each segment from the root outward
  // (e.g. /db-backup, /db-backup/backups, /db-backup/backups/dev). Non-success statuses are ignored:
  // 405/301 means the collection already exists, and some servers disallow MKCOL on existing ones.
  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch {
    return;
  }
  let path = "";
  for (const seg of u.pathname.split("/").filter(Boolean)) {
    path += `/${seg}`;
    await dav(`${u.origin}${path}`, { method: "MKCOL", headers: authHeader(cfg) }).catch(() => {});
  }
}

export async function put(cfg: WebdavConfig, name: string, data: Buffer): Promise<void> {
  const res = await dav(`${cfg.url}/${name}`, {
    method: "PUT",
    headers: { ...authHeader(cfg), "Content-Type": "application/octet-stream" },
    body: new Uint8Array(data),
  });
  if (!res.ok) throw new Error(`WebDAV PUT ${name} failed: ${res.status} ${res.statusText}`);
}

export async function get(cfg: WebdavConfig, name: string): Promise<Buffer> {
  const res = await dav(`${cfg.url}/${name}`, { headers: authHeader(cfg) });
  if (!res.ok) throw new Error(`WebDAV GET ${name} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function del(cfg: WebdavConfig, name: string): Promise<void> {
  await dav(`${cfg.url}/${name}`, { method: "DELETE", headers: authHeader(cfg) });
}

/** List entry hrefs in the collection (Depth: 1). Returns basenames, excluding the collection itself. */
export async function list(cfg: WebdavConfig): Promise<string[]> {
  const res = await dav(cfg.url, {
    method: "PROPFIND",
    headers: { ...authHeader(cfg), Depth: "1", "Content-Type": "application/xml" },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>',
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const hrefs = [...xml.matchAll(/<[a-z]*:?href>([^<]+)<\/[a-z]*:?href>/gi)].map((m) =>
    decodeURIComponent(m[1]),
  );
  return hrefs
    .map((h) => h.replace(/\/$/, "").split("/").pop() ?? "")
    .filter((b) => b && !cfg.url.endsWith(b));
}
