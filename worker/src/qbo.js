/* QuickBooks Online connection for the Meter Testing App.
   Only signed-in MAM staff can use it: every call carries the user's Microsoft token, which is checked with Microsoft.
   QuickBooks tokens are stored encrypted in the SharePoint list "MTA Config" (item "qbo-connection"). */

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const SCOPE = "com.intuit.quickbooks.accounting";
const MINOR = "75";
const CONN_KEY = "qbo-connection";

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = new TextEncoder();
const apiBase = env => (env.QBO_ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com");

/* ---------- who is calling: a MAM Microsoft 365 user ---------- */
const userCache = new Map();
async function verifyUser(req, env) {
  const h = req.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return null;
  const hit = userCache.get(tok);
  if (hit && hit.exp > Date.now()) return hit;
  let claims;
  try { claims = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch (e) { return null; }
  if (claims.tid !== env.TENANT_ID) return null;
  const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName,mail", { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) return null; // Microsoft rejected the token
  const me = await r.json();
  const u = { name: me.displayName || me.mail || "MAM user", exp: Math.min(Date.now() + 10 * 60_000, (claims.exp || 0) * 1000) };
  if (userCache.size > 200) userCache.clear();
  userCache.set(tok, u);
  return u;
}

/* ---------- encryption and signed state ---------- */
async function aesKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("mta-qbo-tokens|" + env.QBO_CLIENT_SECRET + "|" + env.CLIENT_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}
async function unseal(env, s) {
  const [iv, ct] = String(s || "").split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function hmac(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode("mta-qbo-state|" + env.QBO_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/* ---------- connection record in SharePoint (MTA Config) ---------- */
let connItemId = "";
async function readConn(env, g) {
  const lid = await g.listId("MTA Config");
  const res = await g.graph(`/sites/${await g.siteId()}/lists/${lid}/items?$expand=fields($select=Title,Data)&$top=200`);
  const it = (res.value || []).find(x => x.fields && x.fields.Title === CONN_KEY);
  if (!it) { connItemId = ""; return null; }
  connItemId = it.id;
  let d; try { d = JSON.parse(it.fields.Data); } catch (e) { return null; }
  if (!d || !d.sealed) return null;
  try { return { ...d, tokens: await unseal(env, d.sealed) }; } catch (e) { return null; } // keys changed: treat as not connected
}
async function writeConn(env, g, conn) {
  const lid = await g.listId("MTA Config");
  const { tokens, ...pub } = conn;
  const data = { key: CONN_KEY, ...pub, sealed: await seal(env, tokens) };
  const fields = { Title: CONN_KEY, Data: JSON.stringify(data) };
  if (!connItemId) await readConn(env, g).catch(() => {});
  if (connItemId) await g.graph(`/sites/${await g.siteId()}/lists/${lid}/items/${connItemId}/fields`, { method: "PATCH", json: fields });
  else { const r = await g.graph(`/sites/${await g.siteId()}/lists/${lid}/items`, { method: "POST", json: { fields } }); connItemId = r.id; }
}
async function deleteConn(env, g) {
  if (!connItemId) await readConn(env, g).catch(() => {});
  if (connItemId) { const lid = await g.listId("MTA Config"); await g.graph(`/sites/${await g.siteId()}/lists/${lid}/items/${connItemId}`, { method: "DELETE" }); connItemId = ""; }
}

/* ---------- Intuit tokens ---------- */
async function tokenCall(env, params) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.QBO_CLIENT_ID + ":" + env.QBO_CLIENT_SECRET), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || "QuickBooks sign-in failed (" + r.status + ")"); e.code = j.error; throw e; }
  return { access: j.access_token, accessExp: Date.now() + (j.expires_in || 3600) * 1000, refresh: j.refresh_token, refreshExp: Date.now() + (j.x_refresh_token_expires_in || 8640000) * 1000 };
}
let memConn = null; // this worker instance's copy, so one call doesn't re-read SharePoint every time
async function getConn(env, g, fresh) {
  if (!memConn || fresh) memConn = await readConn(env, g);
  const c = memConn;
  if (!c) return null;
  if (Date.now() > c.tokens.accessExp - 120_000) {
    const latest = await readConn(env, g); // another instance may have refreshed already (refresh tokens rotate)
    if (latest && latest.tokens.accessExp - 120_000 > Date.now()) { memConn = latest; return latest; }
    try {
      const t = await tokenCall(env, { grant_type: "refresh_token", refresh_token: (latest || c).tokens.refresh });
      memConn = { ...(latest || c), tokens: t, refreshedAt: Date.now() };
      await writeConn(env, g, memConn);
    } catch (e) {
      if (e.code === "invalid_grant") { memConn = { ...(latest || c), broken: true }; const err = new Error("QuickBooks needs to be reconnected. Go to Limits & lists → QuickBooks and click Reconnect."); err.status = 401; throw err; }
      throw e;
    }
  }
  return memConn;
}

/* ---------- QuickBooks API ---------- */
async function qb(env, g, path, opt = {}) {
  const c = await getConn(env, g);
  if (!c) { const e = new Error("QuickBooks isn't connected yet."); e.status = 409; throw e; }
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${apiBase(env)}/v3/company/${c.realmId}${path}${sep}minorversion=${MINOR}`, {
    method: opt.method || "GET",
    headers: { Authorization: "Bearer " + c.tokens.access, Accept: "application/json", ...(opt.json ? { "Content-Type": "application/json" } : {}) },
    body: opt.json ? JSON.stringify(opt.json) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const f = j.Fault && j.Fault.Error && j.Fault.Error[0];
    const e = new Error(f ? (f.Detail || f.Message) : "QuickBooks error " + r.status);
    e.status = r.status === 401 ? 401 : 502; e.qbCode = f && f.code; throw e;
  }
  return j;
}
const qstr = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function queryAll(env, g, base) {
  const out = []; let start = 1;
  for (let page = 0; page < 30; page++) {
    const j = await qb(env, g, "/query?query=" + encodeURIComponent(`${base} STARTPOSITION ${start} MAXRESULTS 1000`));
    const qr = j.QueryResponse || {}; const key = Object.keys(qr).find(k => Array.isArray(qr[k]));
    const rows = key ? qr[key] : [];
    out.push(...rows);
    if (rows.length < 1000) break;
    start += 1000;
  }
  return out;
}
const addrText = a => a ? [a.Line1, a.Line2, a.Line3, [a.City, [a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join("\n") : "";
const addrParts = a => a && (a.Line1 || a.City || a.PostalCode) ? { street1: a.Line1 || "", street2: [a.Line2, a.Line3].filter(Boolean).join(", "), city: a.City || "", state: String(a.CountrySubDivisionCode || "").toUpperCase(), zip: a.PostalCode || "" } : null;
function mapCustomer(c) {
  const emails = String((c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || "").split(/[,;\s]+/).filter(x => /@/.test(x));
  const ship = addrText(c.ShipAddr), bill = addrText(c.BillAddr);
  return {
    id: c.Id, name: c.FullyQualifiedName || c.DisplayName, contact: [c.GivenName, c.FamilyName].filter(Boolean).join(" "),
    phone: (c.PrimaryPhone && c.PrimaryPhone.FreeFormNumber) || "", emails, bill, ship: ship || bill, shipParts: addrParts(c.ShipAddr) || addrParts(c.BillAddr),
  };
}
function summarizeEstimate(e) {
  return {
    id: e.Id, docNumber: e.DocNumber || "", syncToken: e.SyncToken, total: e.TotalAmt, status: e.TxnStatus || "",
    updated: e.MetaData && e.MetaData.LastUpdatedTime, customer: e.CustomerRef && e.CustomerRef.name,
    lines: (e.Line || []).filter(l => l.DetailType === "SalesItemLineDetail").map(l => ({ item: l.SalesItemLineDetail.ItemRef && l.SalesItemLineDetail.ItemRef.name, qty: l.SalesItemLineDetail.Qty, desc: l.Description || "", amount: l.Amount })),
  };
}
async function findCustomer(env, g, name) {
  for (const field of ["FullyQualifiedName", "DisplayName"]) {
    const j = await qb(env, g, "/query?query=" + encodeURIComponent(`select Id, FullyQualifiedName from Customer where ${field} = '${qstr(name)}'`));
    const c = j.QueryResponse && j.QueryResponse.Customer && j.QueryResponse.Customer[0];
    if (c) return c;
  }
  return null;
}

/* ---------- routes under /qbo ---------- */
export async function handleQbo(req, env, g, url, json) {
  const path = url.pathname.replace(/^\/qbo/, "");
  if (!env.QBO_CLIENT_ID || !env.QBO_CLIENT_SECRET) return json({ error: "QuickBooks keys aren't set up on the service yet." }, 503);

  // Intuit sends the browser back here after the person approves the connection
  if (path === "/callback" && req.method === "GET") {
    const back = (frag) => Response.redirect(env.APP_URL + "#qbo" + (frag ? "-" + frag : ""), 302);
    const code = url.searchParams.get("code"), realmId = url.searchParams.get("realmId"), state = url.searchParams.get("state") || "";
    if (url.searchParams.get("error")) return back("cancelled");
    const [exp, nonce, who, sig] = state.split(".");
    if (!code || !realmId || !sig || sig !== await hmac(env, `${exp}.${nonce}.${who}`) || Date.now() > Number(exp)) return back("expired");
    try {
      const tokens = await tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: env.QBO_REDIRECT });
      memConn = { realmId, env: env.QBO_ENV || "sandbox", connectedAt: Date.now(), connectedBy: decodeURIComponent(who), tokens };
      try {
        const ci = await qb(env, g, `/companyinfo/${realmId}`);
        memConn.company = (ci.CompanyInfo && (ci.CompanyInfo.CompanyName || ci.CompanyInfo.LegalName)) || "";
      } catch (e) {}
      await writeConn(env, g, memConn);
      return back("connected");
    } catch (e) { return back("failed"); }
  }

  const user = await verifyUser(req, env);
  if (!user) return json({ error: "Sign in to the Meter Testing App first." }, 401);

  try {
    if (path === "/start" && req.method === "POST") {
      const exp = String(Date.now() + 15 * 60_000), nonce = b64url(crypto.getRandomValues(new Uint8Array(12))), who = encodeURIComponent(user.name).replace(/\./g, "%2E");
      const state = `${exp}.${nonce}.${who}.${await hmac(env, `${exp}.${nonce}.${who}`)}`;
      const q = new URLSearchParams({ client_id: env.QBO_CLIENT_ID, response_type: "code", scope: SCOPE, redirect_uri: env.QBO_REDIRECT, state });
      return json({ url: `${AUTH_URL}?${q}` });
    }
    if (path === "/status" && req.method === "GET") {
      const c = await readConn(env, g); memConn = c;
      if (!c) return json({ connected: false, env: env.QBO_ENV || "sandbox" });
      const out = { connected: true, env: c.env, company: c.company || "", realmId: c.realmId, connectedAt: c.connectedAt, connectedBy: c.connectedBy, refreshExp: c.tokens.refreshExp };
      if (c.env !== (env.QBO_ENV || "sandbox")) { out.connected = false; out.wrongEnv = true; }
      else { try { await getConn(env, g); } catch (e) { out.connected = false; out.needsReconnect = true; } }
      return json(out);
    }
    if (path === "/disconnect" && req.method === "POST") {
      const c = await readConn(env, g);
      if (c) {
        await fetch(REVOKE_URL, { method: "POST", headers: { Authorization: "Basic " + btoa(env.QBO_CLIENT_ID + ":" + env.QBO_CLIENT_SECRET), "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token: c.tokens.refresh }) }).catch(() => {});
        await deleteConn(env, g);
      }
      memConn = null;
      return json({ ok: true });
    }
    if (path === "/items" && req.method === "GET") {
      const rows = await queryAll(env, g, "select * from Item where Active = true");
      return json({ items: rows.filter(i => i.Type !== "Category").map(i => ({ id: i.Id, name: i.FullyQualifiedName || i.Name, type: i.Type, price: i.UnitPrice || 0, desc: i.Description || "" })) });
    }
    if (path === "/customers" && req.method === "GET") {
      const rows = await queryAll(env, g, "select * from Customer where Active = true");
      return json({ customers: rows.map(mapCustomer) });
    }
    let m = path.match(/^\/estimate\/(\d+)$/);
    if (m && req.method === "GET") return json(summarizeEstimate((await qb(env, g, `/estimate/${m[1]}`)).Estimate));
    if (path === "/estimate" && req.method === "POST") {
      const b = await req.json().catch(() => null);
      if (!b || !Array.isArray(b.lines) || !b.lines.length || b.lines.length > 400) return json({ error: "Nothing to send." }, 400);
      const cust = await findCustomer(env, g, String(b.customer || ""));
      if (!cust) return json({ error: `“${b.customer}” isn't a customer in QuickBooks. Pick the job's client from the QuickBooks list, or add the customer in QuickBooks first.` }, 400);
      const ids = [...new Set(b.lines.map(l => String(l.itemId)).filter(x => /^\d+$/.test(x)))];
      if (ids.length !== new Set(b.lines.map(l => String(l.itemId))).size) return json({ error: "Some lines aren't linked to a QuickBooks item." }, 400);
      const items = await queryAll(env, g, `select Id, Name, UnitPrice from Item where Id in (${ids.map(i => `'${i}'`).join(",")})`);
      const price = new Map(items.map(i => [i.Id, Number(i.UnitPrice) || 0]));
      const Line = b.lines.map(l => {
        const qty = Math.max(0, Number(l.qty) || 1), p = price.get(String(l.itemId)) || 0;
        return { DetailType: "SalesItemLineDetail", Amount: Math.round(qty * p * 100) / 100, Description: String(l.desc || "").slice(0, 4000), SalesItemLineDetail: { ItemRef: { value: String(l.itemId) }, Qty: qty, UnitPrice: p } };
      });
      const note = String(b.memo || "").slice(0, 4000);
      if (b.id) {
        const cur = (await qb(env, g, `/estimate/${encodeURIComponent(b.id)}`)).Estimate;
        if (b.syncToken != null && String(cur.SyncToken) !== String(b.syncToken) && !b.force) return json({ changed: true, current: summarizeEstimate(cur) }, 409);
        const j = await qb(env, g, "/estimate", { method: "POST", json: { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true, CustomerRef: { value: cust.Id }, Line, PrivateNote: note } });
        return json(summarizeEstimate(j.Estimate));
      }
      const est = { CustomerRef: { value: cust.Id }, Line, PrivateNote: note };
      const j = await qb(env, g, "/estimate", { method: "POST", json: est });
      return json(summarizeEstimate(j.Estimate));
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "QuickBooks error" }, e.status || 502);
  }
}
