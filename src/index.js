// Byty Lískovec – Cloudflare Worker
// Stahuje pronájmy z několika realitních webů, ukládá je do D1, dohledává polohu a datum,
// posílá upozornění přes ntfy a servíruje API pro aplikaci.

const UA = "Mozilla/5.0 (byty-liskovec; osobni hlidac pronajmu)";
const BROWSER = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Accept-Language": "cs-CZ,cs;q=0.9",
};
const MAX_KM_STORE = 8;      // ukládáme vše do 8 km od práce, jemné filtrování dělá aplikace
const MAX_PRICE_STORE = 30000;
const SUBREQ_BUDGET = 45;    // bezplatný Workers plán povoluje 50 podpožadavků na jedno spuštění

// ---------- pomocné ----------
function km(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
const decode = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, " ").trim();
const toInt = (s) => { const n = parseInt(String(s || "").replace(/[^\d]/g, ""), 10); return Number.isFinite(n) ? n : null; };
// "2+kk", "1+1", "garsoniéra" → jednotný tvar
function dispFrom(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/(\d)\s*\+\s*(kk|1)/);
  if (m) return m[1] + "+" + m[2];
  if (/garson/.test(t)) return "1+kk";
  return "";
}
const areaFrom = (text) => { const m = String(text || "").match(/(\d{2,3})\s*m(?:²|2|\b)/i); return m ? parseInt(m[1], 10) : 0; };

// počítadlo podpožadavků, ať nepřekročíme limit Cloudflare
function makeFetcher() {
  const f = async (url, init) => { f.count++; return fetch(url, init); };
  f.count = 0;
  f.left = () => SUBREQ_BUDGET - f.count;
  return f;
}

// ---------- ZDROJ: Sreality (API v1) ----------
async function srcSreality(F) {
  const out = [];
  for (const district of [72, 73]) { // 72 Brno-město, 73 Brno-venkov (Modřice)
    for (let offset = 0; offset < 1500; offset += 100) {
      const res = await F("https://www.sreality.cz/api/v1/estates/search?category_main_cb=1&category_type_cb=2" +
        "&locality_district_id=" + district + "&limit=100&offset=" + offset, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error("Sreality HTTP " + res.status);
      const data = await res.json();
      const results = data?.results || [];
      for (const e of results) {
        const name = (e.advert_name || "").replace(/ /g, " ");
        const disp = (e.category_sub_cb?.name || dispFrom(name)).toLowerCase();
        const loc = e.locality || {};
        const price = e.price_summary_czk || e.price_czk || null;
        const slug = [loc.city_seo_name, loc.citypart_seo_name, loc.street_seo_name].filter(Boolean).join("-") || "brno";
        const img = e.advert_images?.[0] || "";
        out.push({
          id: "sreality-" + e.hash_id, source: "Sreality", title: name,
          price: price ? Math.round(price) : null, disposition: disp, area: areaFrom(name),
          locality: [loc.street, loc.citypart, loc.city].filter(Boolean).join(", "),
          lat: loc.gps_lat, lon: loc.gps_lon,
          url: `https://www.sreality.cz/detail/pronajem/byt/${encodeURIComponent(disp)}/${slug}/${e.hash_id}`,
          image: img ? (img.startsWith("//") ? "https:" + img : img) + "?fl=res,400,300,3|shr,,20|jpg,90" : "",
        });
      }
      const total = data?.pagination?.total ?? 0;
      if (results.length < 100 || offset + 100 >= total) break;
    }
  }
  return out;
}

// ---------- ZDROJ: Bezrealitky (GraphQL) ----------
const BZ_DISP = { GARSONIERA: "1+kk", DISP_1_KK: "1+kk", DISP_1_1: "1+1", DISP_2_KK: "2+kk", DISP_2_1: "2+1", DISP_3_KK: "3+kk", DISP_3_1: "3+1", DISP_4_KK: "4+kk", DISP_4_1: "4+1" };
async function srcBezrealitky(F) {
  const q = "query ListAdverts($offerType:[OfferType],$estateType:[EstateType],$regionOsmIds:[ID],$limit:Int,$offset:Int,$locale:Locale!){listAdverts(offerType:$offerType,estateType:$estateType,regionOsmIds:$regionOsmIds,limit:$limit,offset:$offset){totalCount list{id uri disposition price charges surface address(locale:$locale) gps{lat lng} mainImage{url(filter:RECORD_THUMB)}}}}";
  const out = [];
  for (let offset = 0; offset < 600; offset += 100) {
    const res = await F("https://api.bezrealitky.cz/graphql/", {
      method: "POST", headers: { ...BROWSER, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ operationName: "ListAdverts", query: q, variables: { offerType: ["PRONAJEM"], estateType: ["BYT"], regionOsmIds: ["R438171"], limit: 100, offset, locale: "CS" } }),
    });
    if (!res.ok) throw new Error("Bezrealitky HTTP " + res.status);
    const j = await res.json();
    const d = j?.data?.listAdverts;
    if (!d) throw new Error("Bezrealitky: " + (j?.errors?.[0]?.message || "prázdná odpověď"));
    for (const a of d.list || []) {
      out.push({
        id: "bezrealitky-" + a.id, source: "Bezrealitky",
        title: `Pronájem bytu ${BZ_DISP[a.disposition] || ""} ${a.surface || ""} m²`.trim(),
        price: a.price || null, disposition: BZ_DISP[a.disposition] || "", area: a.surface || 0,
        locality: String(a.address || "").replace(/, Jihomoravský kraj$/, ""),
        lat: a.gps?.lat, lon: a.gps?.lng,
        url: "https://www.bezrealitky.cz/nemovitosti-byty-domy/" + a.uri,
        image: a.mainImage?.url || "",
      });
    }
    if ((d.list || []).length < 100 || offset + 100 >= (d.totalCount || 0)) break;
  }
  return out;
}

// ---------- ZDROJ: UlovDomov (API) ----------
const UD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
function udDisp(s) {
  const m = String(s || "").match(/^(one|two|three|four|five)Plus(Kk|One)$/);
  if (m) return UD_NUM[m[1]] + "+" + (m[2] === "Kk" ? "kk" : "1");
  if (/studio|garson/i.test(s || "")) return "1+kk";
  return "";
}
async function srcUlovDomov(F) {
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const res = await F(`https://ud.api.ulovdomov.cz/v1/offer/find?page=${page}&perPage=100&sorting=latest`, {
      method: "POST", headers: { ...BROWSER, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ offerType: "rent", propertyType: "flat", bounds: { northEast: { lat: 49.235, lng: 16.68 }, southWest: { lat: 49.11, lng: 16.48 } } }),
    });
    if (!res.ok) throw new Error("UlovDomov HTTP " + res.status);
    const j = await res.json();
    const offers = j?.data?.offers || [];
    for (const o of offers) {
      const disp = udDisp(o.disposition) || dispFrom(o.title);
      const street = o.street?.title || "";
      const pub = o.published ? Date.parse(o.published + (/[zZ+]/.test(o.published.slice(10)) ? "" : "+02:00")) : null;
      out.push({
        id: "ulovdomov-" + o.id, source: "UlovDomov", title: o.title || "",
        price: o.rentalPrice?.value || null, disposition: disp, area: o.area || areaFrom(o.title),
        locality: [street, o.address?.villagePart ? "Brno" : ""].filter(Boolean).join(", ") || "Brno",
        lat: o.geoCoordinates?.lat, lon: o.geoCoordinates?.lng,
        url: o.absoluteUrl || `https://www.ulovdomov.cz/inzerat/x/${o.id}`,
        image: o.photos?.[0]?.path || "",
        posted_at: Number.isFinite(pub) ? pub : null, posted_kind: "published",
      });
    }
    const pages = j?.data?.paginator?.totalPages || j?.extraData?.totalPages || 0;
    if (offers.length < 100 || (pages && page >= pages)) break;
  }
  return out;
}

// ---------- ZDROJ: iDNES Reality (HTML, polohu dohledáváme podle adresy) ----------
async function srcIdnes(F) {
  const out = [];
  for (let page = 0; page < 10; page++) {
    const res = await F("https://reality.idnes.cz/s/pronajem/byty/brno-mesto/" + (page ? "?page=" + page : ""), { headers: { ...BROWSER, Accept: "text/html" } });
    if (!res.ok) throw new Error("iDNES HTTP " + res.status);
    const html = await res.text();
    const items = html.split('class="c-products__item').slice(1);
    for (const it of items) {
      const href = (it.match(/<a[^>]+href="(https:\/\/reality\.idnes\.cz\/detail\/[^"]+)"[^>]*class="c-products__link|class="c-products__link"[^>]*href="(https:\/\/reality\.idnes\.cz\/detail\/[^"]+)"/) || []);
      const url = href[1] || href[2] || (it.match(/href="(https:\/\/reality\.idnes\.cz\/detail\/[^"]+)"/) || [])[1];
      if (!url) continue; // reklama apod.
      const idm = url.match(/\/([0-9a-f]{20,})\/?$/);
      const title = decode((it.match(/<h2[^>]*c-products__title[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
      const loc = decode((it.match(/<p[^>]*c-products__info[^>]*>([\s\S]*?)<\/p>/) || [])[1]);
      const priceTxt = decode((it.match(/c-products__price[^>]*>([\s\S]*?)<\/p>/) || [])[1]);
      const img = (it.match(/data-src="([^"]+)"/) || [])[1] || "";
      out.push({
        id: "idnes-" + (idm ? idm[1] : url), source: "iDNES Reality", title: title.replace(/^pronájem\s*/i, "Pronájem "),
        price: /měs/i.test(priceTxt) || /Kč/.test(priceTxt) ? toInt(priceTxt) : null,
        disposition: dispFrom(title), area: areaFrom(title), locality: loc,
        lat: null, lon: null, url, image: img,
        // nejdřív ulice, jinak střed čtvrti ("Brno - Komín" → "Komín, Brno")
        geoq: loc + (/Brno\s*-\s*(.+)$/.test(loc) ? "|" + loc.replace(/^.*Brno\s*-\s*(.+)$/, "$1, Brno") : ""),
      });
    }
    if (!html.includes(`?page=${page + 1}"`)) break;
  }
  return out;
}

// ---------- ZDROJ: Bazoš (HTML, poloha podle ulice/PSČ) ----------
const stats_bazos = {};
async function srcBazos(F) {
  stats_bazos.items = 0;
  const out = [];
  for (let page = 0; page < 4; page++) {
    const res = await F(`https://reality.bazos.cz/pronajmu/byt/${page ? page * 20 + "/" : ""}?hlokalita=62500&humkreis=6&cenado=${MAX_PRICE_STORE}`, { headers: { ...BROWSER, Accept: "text/html" } });
    if (!res.ok) throw new Error("Bazoš HTTP " + res.status);
    const html = await res.text();
    const items = html.split(/class=["']?inzeraty inzeratyflex/).slice(1);
    if (!page && !items.length) throw new Error("Bazoš: nenalezeny inzeráty (délka " + html.length + ", ukázka: " + html.slice(Math.max(0, html.indexOf("inzerat")), Math.max(0, html.indexOf("inzerat")) + 160).replace(/\s+/g, " ") + ")");
    for (const it of items) {
      const a = it.match(/<h2[^>]*nadpis[^>]*>\s*<a[^>]*href=["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const path = a[1];
      const idm = path.match(/\/inzerat\/(\d+)\//);
      const title = decode(a[2]);
      const desc = decode((it.match(/<div[^>]*popis[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
      const price = toInt(decode((it.match(/<div[^>]*inzeratycena[^>]*>([\s\S]*?)<\/div>/) || [])[1]));
      const lok = (it.match(/<div[^>]*inzeratylok[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
      const [city, psc] = lok.split(/<br\s*\/?>/i).map(decode);
      const dm = it.match(/\[(\d{1,2})\.(\d{1,2})\.\s*(\d{4})\]/);
      const img = (it.match(/<img[^>]+src="([^"]+)"[^>]*obrazek|obrazek[^>]*src="([^"]+)"/) || []);
      const disp = dispFrom(title) || dispFrom(desc);
      if (!disp) continue; // pokoje, podnájmy spolubydlení apod.
      out.push({
        id: "bazos-" + (idm ? idm[1] : path), source: "Bazoš", title,
        price: price && price >= 3000 ? price : null, disposition: disp, area: areaFrom(title) || areaFrom(desc),
        locality: [city, psc].filter(Boolean).join(", "),
        lat: null, lon: null,
        // ulice z nadpisu ("…, Bratislavská"), jinak střed PSČ
        geoq: [((title.match(/,\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^\d,]{2,30}?)\s*(?:\d|$|,)/) || [])[1] || "").trim(), city]
          .filter((x, i) => i ? x : x && !/brno|byt|pronáj/i.test(x)).join(", ").replace(/^([^,]+)$/, "") + "|PSC:" + String(psc || "").replace(/\s/g, ""),
        url: path.startsWith("http") ? path : "https://reality.bazos.cz" + path,
        image: img[1] || img[2] || "",
        posted_at: dm ? Date.UTC(+dm[3], +dm[2] - 1, +dm[1], 10) : null, posted_kind: "published",
      });
    }
    stats_bazos.items = (stats_bazos.items || 0) + items.length;
    if (items.length < 20) break;
  }
  return out;
}

const SOURCES = [
  ["Sreality", srcSreality],
  ["Bezrealitky", srcBezrealitky],
  ["UlovDomov", srcUlovDomov],
  ["iDNES Reality", srcIdnes],
  ["Bazoš", srcBazos],
];

// ---------- dohledání polohy (Nominatim, výsledky se ukládají) ----------
async function geocode(env, F, q) {
  if (q.includes("|")) {
    const parts = q.split("|").filter(Boolean);
    let pending = false;
    for (let i = 0; i < parts.length; i++) {
      const g = await geocode(env, F, parts[i]);
      if (g === undefined) { pending = true; continue; } // nedohledáno kvůli rozpočtu, zkus hrubší úroveň
      if (g) return { ...g, level: i, pending };
    }
    return pending ? undefined : null;
  }
  const hit = await env.DB.prepare("SELECT lat, lon, ok FROM geo WHERE q=?").bind(q).first();
  if (hit) return hit.ok ? hit : null;
  if (F.left() <= 6) return undefined; // došel rozpočet, zkusíme příště
  let url;
  if (q.startsWith("PSC:")) {
    const psc = q.slice(4);
    if (!/^\d{5}$/.test(psc)) { await env.DB.prepare("INSERT OR REPLACE INTO geo (q,lat,lon,ok) VALUES (?,?,?,0)").bind(q, null, null).run(); return null; }
    url = `https://nominatim.openstreetmap.org/search?postalcode=${psc}&country=cz&format=json&limit=1`;
  } else {
    // "Řezáčova, Brno - Komín" → "Řezáčova, Brno"
    const clean = q.replace(/\s*-\s*[^,]+$/, "").replace(/Brno\s*-\s*[^,]+/, "Brno");
    url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(clean)}&countrycodes=cz&format=json&limit=1`;
  }
  const res = await F(url, { headers: { "User-Agent": "byty-liskovec/1.0 (osobni hlidac pronajmu; byty-liskovec.vojtechs.workers.dev)" } });
  if (!res.ok) return undefined;
  const r = (await res.json())[0];
  const ok = r ? 1 : 0;
  await env.DB.prepare("INSERT OR REPLACE INTO geo (q,lat,lon,ok) VALUES (?,?,?,?)").bind(q, r ? +r.lat : null, r ? +r.lon : null, ok).run();
  await new Promise((s) => setTimeout(s, 1100)); // Nominatim: max 1 dotaz za sekundu
  return r ? { lat: +r.lat, lon: +r.lon } : null;
}

// ---------- sběr ----------
async function collect(env) {
  const now = Date.now();
  const F = makeFetcher();
  const hLat = parseFloat(env.HOME_LAT), hLon = parseFloat(env.HOME_LON);
  const metaRows = (await env.DB.prepare("SELECT k, v FROM meta").all()).results;
  const meta = Object.fromEntries(metaRows.map((r) => [r.k, r.v]));
  const { results: ex } = await env.DB.prepare("SELECT id, lat, lon, approx FROM listings").all();
  const known = new Map(ex.map((r) => [r.id, r]));
  const stats = {}, errors = [], fresh = [], all = [], metaSet = [];

  // 1) stáhnout seznamy ze všech zdrojů (poloha se dohledává až potom, ať na seznamy vždy zbyde rozpočet)
  const got = [];
  for (const [name, fn] of SOURCES) {
    const t0 = Date.now();
    try {
      got.push([name, await fn(F)]);
      stats[name] = { found: got[got.length - 1][1].length, ms: Date.now() - t0 };
      if (name === "Bazoš") stats[name].items = stats_bazos.items;
      metaSet.push(["ok_" + name, String(now)]);
      if (!meta["first_" + name]) metaSet.push(["first_" + name, String(now)]);
    } catch (e) {
      errors.push(name + ": " + String(e.message || e));
      stats[name] = { error: String(e.message || e), ms: Date.now() - t0 };
    }
  }
  // 2) poloha a vzdálenost
  for (const [name, items] of got) {
    let kept = 0;
    for (const l of items) {
      if (!l.price || l.price > MAX_PRICE_STORE || !l.disposition) continue;
      if (l.lat == null || l.lon == null) {
        const prev = known.get(l.id);
        l.approx = 1;
        if (prev && prev.lat != null && prev.approx !== 2) { l.lat = prev.lat; l.lon = prev.lon; }
        else if (l.geoq) {
          const g = await geocode(env, F, l.geoq);
          if (g) { l.lat = g.lat; l.lon = g.lon; l.approx = g.level > 0 && g.pending ? 2 : 1; /* 2 = jen střed čtvrti, ulice se dohledá příště */ }
          else if (prev && prev.lat != null) { l.lat = prev.lat; l.lon = prev.lon; l.approx = prev.approx; }
        }
      }
      if (l.lat != null) {
        l.km = Math.round(km(hLat, hLon, l.lat, l.lon) * 100) / 100;
        if (l.km > MAX_KM_STORE) continue;
      } else l.km = null; // poloha se dohledá při dalším běhu
      all.push(l); kept++;
    }
    stats[name].kept = kept;
  }

  const stmt = env.DB.prepare(`INSERT INTO listings (id,source,title,price,disposition,area,locality,lat,lon,km,url,image,first_seen,last_seen,posted_at,posted_kind,approx,geoq)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, price=excluded.price, url=excluded.url, image=excluded.image,
      locality=excluded.locality, title=excluded.title, area=excluded.area,
      lat=COALESCE(excluded.lat, listings.lat), lon=COALESCE(excluded.lon, listings.lon), km=COALESCE(excluded.km, listings.km), approx=excluded.approx,
      posted_at=COALESCE(excluded.posted_at, listings.posted_at), posted_kind=COALESCE(excluded.posted_kind, listings.posted_kind)`);
  const stmts = all.map((l) => {
    if (!known.has(l.id)) fresh.push(l);
    return stmt.bind(l.id, l.source, l.title, l.price, l.disposition, l.area || 0, l.locality, l.lat ?? null, l.lon ?? null, l.km ?? null,
      l.url, l.image, now, now, l.posted_at ?? null, l.posted_at ? l.posted_kind : null, l.approx ? 1 : 0, l.geoq ?? null);
  });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  // Sreality: datum poslední úpravy z detailu, postupně v rámci zbylého rozpočtu
  try {
    const n = Math.max(0, F.left() - 6);
    if (n) {
      const { results: todo } = await env.DB.prepare("SELECT id FROM listings WHERE source='Sreality' AND posted_at IS NULL AND km IS NOT NULL AND last_seen=? ORDER BY km LIMIT ?").bind(now, n).all();
      const upd = [];
      for (const r of todo) {
        const res = await F("https://www.sreality.cz/api/v1/estates/" + r.id.replace("sreality-", ""), { headers: { "User-Agent": UA, Accept: "application/json" } });
        if (!res.ok) continue;
        const ed = (await res.json())?.result?.edited;
        const t = ed ? Date.parse(ed + "T12:00:00+02:00") : NaN;
        upd.push(env.DB.prepare("UPDATE listings SET posted_at=?, posted_kind='edited' WHERE id=?").bind(Number.isFinite(t) ? t : 0, r.id));
      }
      if (upd.length) await env.DB.batch(upd);
      stats.srealityDates = upd.length;
    }
  } catch (e) { errors.push("Sreality datum: " + e.message); }

  metaSet.push(["last_run", String(now)], ["last_errors", JSON.stringify(errors)], ["last_stats", JSON.stringify({ ...stats, subrequests: F.count })]);
  await env.DB.batch(metaSet.map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)").bind(k, v)));

  // upozornění jen na opravdu nové inzeráty (ne první načtení nového zdroje)
  const notifiable = fresh.filter((l) => meta["first_" + l.source] && l.km != null);
  await notify(env, F, notifiable);
  return { new: notifiable.length, errors, stats };
}

async function notify(env, F, fresh) {
  if (!env.NTFY_TOPIC) return;
  const maxP = parseInt(env.NOTIFY_MAX_PRICE, 10), maxK = parseFloat(env.NOTIFY_MAX_KM);
  const hits = fresh.filter((l) => l.price && l.price <= maxP && l.km <= maxK);
  for (const l of hits.slice(0, Math.max(0, Math.min(5, F.left() + 5)))) {
    await fetch("https://ntfy.sh/" + env.NTFY_TOPIC, {
      method: "POST",
      headers: { Title: `Nový byt ${l.disposition} · ${l.price.toLocaleString("cs-CZ")} Kč`, Click: l.url, Tags: "house" },
      body: `${l.locality} · ${l.km} km od práce${l.area ? " · " + l.area + " m²" : ""} · ${l.source}`,
    });
  }
}

// ---------- HTTP ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/listings") {
      const metaRows = (await env.DB.prepare("SELECT k, v FROM meta").all()).results;
      const meta = Object.fromEntries(metaRows.map((r) => [r.k, r.v]));
      const since = Date.now() - 14 * 24 * 3600 * 1000;
      const { results } = await env.DB.prepare(
        "SELECT id,source,title,price,disposition,area,locality,lat,lon,km,url,image,first_seen,last_seen,posted_at,posted_kind,approx FROM listings WHERE last_seen > ? AND lat IS NOT NULL ORDER BY first_seen DESC"
      ).bind(since).all();
      const firstRun = {};
      for (const l of results) {
        // aktivní = byl vidět při posledním úspěšném stažení svého zdroje
        const ok = Number(meta["ok_" + l.source] || 0);
        l.active = !ok || l.last_seen >= ok - 90 * 60 * 1000;
        if (!l.posted_at) delete l.posted_at;
        firstRun[l.source] = Number(meta["first_" + l.source] || 0);
      }
      return Response.json({ listings: results, lastRun: meta.last_run ? Number(meta.last_run) : null, firstRun });
    }
    if (url.pathname === "/api/refresh" && req.method === "POST") {
      const last = await env.DB.prepare("SELECT v FROM meta WHERE k='last_run'").first();
      if (last && Date.now() - Number(last.v) < 3 * 60 * 1000) return Response.json({ skipped: true });
      return Response.json(await collect(env));
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(collect(env)); },
};
