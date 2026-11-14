/* MTA Requests: the small service behind the customer meter request form.
   The customer's form (request.html on GitHub Pages) calls it; it reads and saves that one request
   in the SharePoint list "MTA Requests" with an app permission limited to the Meter Testing App site (Sites.Selected).
   Secrets/settings come from Cloudflare: TENANT_ID, CLIENT_ID, CLIENT_SECRET, SITE (host:path), ALLOWED_ORIGIN. */

import { handleQbo } from "./qbo.js";

const LIST_NAME = "MTA Requests";
const MAX_BODY = 200_000;      // bytes
const MAX_METER_ROWS = 100;
const MAX_QTY = 2000;
const STR = 500, LONG = 4000;  // max string lengths

let tokenCache = { value: "", exp: 0 };
let ids = { site: "", list: "" };

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "https://hayesbatson.github.io").split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "MTA Requests" });
    if (url.pathname === "/diag") return json(await diag(env));
    if (url.pathname.startsWith("/qbo/")) {
      try { return await handleQbo(req, env, G(env), url, json); }
      catch (e) { return json({ error: "Something went wrong reaching QuickBooks. Try again in a minute." }, 502); }
    }
    const m = url.pathname.match(/^\/r\/(\d{1,9})\.([A-Za-z0-9_-]{20,64})$/);
    if (!m) return json({ error: "Not found" }, 404);
    const [, itemId, token] = m;

    try {
      const item = await getItem(env, itemId);
      const data = item && safeParse(item.fields && item.fields.Data);
      if (!data || !data.token || !sameToken(data.token, token)) return json({ error: "This link isn't valid. Ask Mid America Meter for a new one." }, 404);
      if (data.status === "cancelled") return json({ error: "This request was cancelled. Contact Mid America Meter if you still need to send meters." }, 410);
      const expired = data.expires && Date.now() > data.expires;

      if (req.method === "GET") return json(publicView(data, itemId, expired));

      if (req.method === "POST") {
        if (expired) return json({ error: "This link has expired. Ask Mid America Meter for a new one." }, 410);
        if (data.status === "converted") return json({ error: "Mid America Meter has already received this request, so it can't be changed here. Please call or email them with any changes." }, 409);
        const text = await req.text();
        if (text.length > MAX_BODY) return json({ error: "That's too much information for one request. Split it into two, or contact Mid America Meter." }, 413);
        const sub = cleanSubmission(safeParse(text));
        if (!sub) return json({ error: "Some of the information couldn't be read. Check the form and try again." }, 400);
        if (!sub.meters.length) return json({ error: "Add at least one meter." }, 400);
        const now = Date.now();
        const next = { ...data, status: "submitted", submission: sub, submittedAt: now, firstSubmittedAt: data.firstSubmittedAt || now, submitCount: (data.submitCount || 0) + 1 };
        await patchItem(env, itemId, { Data: JSON.stringify(next), Status: "Submitted", Customer: (sub.company || data.customer || "").slice(0, 255) });
        return json({ ok: true, view: publicView(next, itemId, false) });
      }
      return json({ error: "Not allowed" }, 405);
    } catch (e) {
      return json({ error: "Something went wrong saving your request. Please try again in a minute, or contact Mid America Meter." }, 502);
    }
  },
};

/* only what the customer should see: what MAM pre-filled and what they sent */
function publicView(d, itemId, expired) {
  return {
    ref: "R" + itemId,
    status: d.status === "converted" ? "received" : d.status,
    expired: !!expired,
    expires: d.expires || null,
    submittedAt: d.submittedAt || null,
    prefill: {
      company: d.customer || "", contact: d.contact || "", email: d.email || "", phone: d.phone || "", po: d.po || "",
      billTo: d.billTo || null, shipTo: d.shipTo || null, message: d.messageToCustomer || "",
    },
    submission: d.submission || null,
  };
}

const s = (v, n = STR) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n);
function addr(a) {
  if (!a || typeof a !== "object") return null;
  const o = { company: s(a.company), attn: s(a.attn), street1: s(a.street1), street2: s(a.street2), city: s(a.city), state: s(a.state, 20), zip: s(a.zip, 20) };
  return Object.values(o).some(Boolean) ? o : null;
}
function cleanSubmission(x) {
  if (!x || typeof x !== "object" || !Array.isArray(x.meters)) return null;
  const meters = x.meters.slice(0, MAX_METER_ROWS).map(m => ({
    qty: Math.max(1, Math.min(MAX_QTY, Math.round(Number(m && m.qty) || 1))),
    size: s(m.size, 60), type: s(m.type, 60), brand: s(m.brand, 120), model: s(m.model, 120),
    gpm: s(m.gpm, 40), location: s(m.location, 200), serials: s(m.serials, LONG),
    service: ["test", "clean"].includes(m.service) ? m.service : "test", notes: s(m.notes, LONG),
  })).filter(m => m.size || m.type || m.brand || m.serials || m.notes);
  return {
    company: s(x.company), contact: s(x.contact), phone: s(x.phone, 60), email: s(x.email, 200), po: s(x.po, 100),
    billTo: addr(x.billTo), shipTo: addr(x.shipTo), callFirst: !!x.callFirst, instructions: s(x.instructions, LONG), meters,
  };
}
function safeParse(t) { try { return JSON.parse(t) } catch (e) { return null } }
function sameToken(a, b) { // compare without leaking timing
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

/* ---- Microsoft Graph with the app's own permission (client credentials) ---- */
async function appToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.exp - 60_000) return tokenCache.value;
  const body = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body });
  if (!r.ok) throw new Error("token " + r.status);
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tokenCache.value;
}
async function graph(env, path, opt = {}) {
  const r = await fetch("https://graph.microsoft.com/v1.0" + path, {
    method: opt.method || "GET",
    headers: { Authorization: "Bearer " + await appToken(env), ...(opt.json ? { "Content-Type": "application/json" } : {}) },
    body: opt.json ? JSON.stringify(opt.json) : undefined,
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("graph " + r.status);
  return r.status === 204 ? {} : r.json();
}
const listCache = {};
const G = env => ({
  graph: (path, opt) => graph(env, path, opt),
  siteId: async () => (await resolveIds(env)).site,
  listId: async name => {
    if (listCache[name]) return listCache[name];
    const site = (await resolveIds(env)).site;
    const lists = await graph(env, `/sites/${site}/lists?$select=id,displayName&$top=200`);
    const l = (lists.value || []).find(x => x.displayName === name);
    if (!l) throw new Error("list " + name);
    return (listCache[name] = l.id);
  },
});
async function resolveIds(env) {
  if (ids.site && ids.list) return ids;
  const site = await graph(env, `/sites/${env.SITE}`);
  if (!site) throw new Error("site");
  const lists = await graph(env, `/sites/${site.id}/lists?$select=id,displayName&$top=200`);
  const l = (lists.value || []).find(x => x.displayName === LIST_NAME);
  if (!l) throw new Error("list");
  ids = { site: site.id, list: l.id };
  return ids;
}
async function getItem(env, id) {
  const { site, list } = await resolveIds(env);
  return graph(env, `/sites/${site}/lists/${list}/items/${id}?$expand=fields($select=Data,Status)`);
}
async function patchItem(env, id, fields) {
  const { site, list } = await resolveIds(env);
  return graph(env, `/sites/${site}/lists/${list}/items/${id}/fields`, { method: "PATCH", json: fields });
}

/* step-by-step check of the Microsoft side; shows only which step failed and Microsoft's error code (no secrets) */
async function diag(env) {
  const out = { clientIdSet: !!env.CLIENT_ID, secretSet: !!env.CLIENT_SECRET, site: env.SITE };
  try {
    const body = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const r = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { out.signIn = `failed ${r.status}: ${j.error || ""} ${(j.error_description || "").split("\r\n")[0].slice(0, 200)}`; return out; }
    out.signIn = "ok";
    try { const p = JSON.parse(atob(j.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); out.roles = p.roles || []; out.appId = p.appid; } catch (e) {}
    const h = { Authorization: "Bearer " + j.access_token };
    const sr = await fetch(`https://graph.microsoft.com/v1.0/sites/${env.SITE}?$select=id,displayName`, { headers: h });
    const sj = await sr.json().catch(() => ({}));
    if (!sr.ok) { out.siteAccess = `failed ${sr.status}: ${sj.error && sj.error.code}`; return out; }
    out.siteAccess = "ok (" + sj.displayName + ")";
    const lr = await fetch(`https://graph.microsoft.com/v1.0/sites/${sj.id}/lists?$select=id,displayName&$top=200`, { headers: h });
    const lj = await lr.json().catch(() => ({}));
    if (!lr.ok) { out.lists = `failed ${lr.status}: ${lj.error && lj.error.code}`; return out; }
    out.requestsList = (lj.value || []).some(x => x.displayName === LIST_NAME) ? "found" : "missing";
  } catch (e) { out.error = String(e && e.message || e).slice(0, 200); }
  return out;
}
