// Byty Brno – Cloudflare Worker: stahuje inzeráty, ukládá do D1, posílá notifikace, servíruje API.

const UA = "Mozilla/5.0 (byty-brno osobni hlidac)";
const MAX_KM_STORE = 8; // ukládáme vše do 8 km, filtruje se až v aplikaci

function km(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// ---------- ZDROJ: Sreality ----------
// category_sub_cb: 2=1+kk 3=1+1 4=2+kk 5=2+1 6=3+kk 7=3+1
async function fetchSreality() {
  const out = [];
  for (const district of [72, 73]) { // 72 Brno-město, 73 Brno-venkov (Modřice)
    for (let offset = 0; offset < 1500; offset += 100) {
      const url = "https://www.sreality.cz/api/v1/estates/search?category_main_cb=1&category_type_cb=2" +
        "&locality_district_id=" + district + "&limit=100&offset=" + offset;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error("Sreality HTTP " + res.status);
      const data = await res.json();
      const results = data?.results || [];
      for (const e of results) {
        const name = (e.advert_name || "").replace(/ /g, " ");
        const disp = (e.category_sub_cb?.name || (name.match(/(\d\+(?:kk|\d))/i) || [])[1] || "").toLowerCase();
        const area = parseInt((name.match(/(\d+)\s*m²/) || [])[1] || "0", 10);
        const loc = e.locality || {};
        const price = e.price_summary_czk || e.price_czk || null;
        if (price && price > 30000) continue;
        const slug = [loc.city_seo_name, loc.citypart_seo_name, loc.street_seo_name].filter(Boolean).join("-") || "brno";
        const img = e.advert_images?.[0] || "";
        out.push({
          id: "sreality-" + e.hash_id,
          source: "Sreality",
          title: name,
          price: price ? Math.round(price) : null,
          disposition: disp,
          area,
          locality: [loc.street, loc.citypart, loc.city].filter(Boolean).join(", "),
          lat: loc.gps_lat, lon: loc.gps_lon,
          url: `https://www.sreality.cz/detail/pronajem/byt/${encodeURIComponent(disp)}/${slug}/${e.hash_id}`,
          image: img ? (img.startsWith("//") ? "https:" + img : img) + "?fl=res,400,300,3" : "",
        });
      }
      const total = data?.pagination?.total ?? 0;
      if (results.length < 100 || offset + 100 >= total) break;
    }
  }
  return out;
}

const SOURCES = [fetchSreality]; // další zdroje se přidají sem

// ---------- sběr ----------
async function collect(env) {
  const now = Date.now();
  const hLat = parseFloat(env.HOME_LAT), hLon = parseFloat(env.HOME_LON);
  const fresh = [];
  const errors = [];
  const all = [];
  for (const src of SOURCES) {
    try {
      for (const l of await src()) {
        if (l.lat == null || l.lon == null) continue;
        l.km = Math.round(km(hLat, hLon, l.lat, l.lon) * 100) / 100;
        if (l.km <= MAX_KM_STORE) all.push(l);
      }
    } catch (e) { errors.push(String(e)); }
  }
  const { results: ex } = await env.DB.prepare("SELECT id FROM listings").all();
  const known = new Set(ex.map((r) => r.id));
  const stmt = env.DB.prepare(`INSERT INTO listings (id,source,title,price,disposition,area,locality,lat,lon,km,url,image,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, price=excluded.price, url=excluded.url, image=excluded.image, locality=excluded.locality`);
  const stmts = all.map((l) => {
    if (!known.has(l.id)) fresh.push(l);
    return stmt.bind(l.id, l.source, l.title, l.price, l.disposition, l.area, l.locality, l.lat, l.lon, l.km, l.url, l.image, now, now);
  });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('last_run',?),('last_errors',?)")
    .bind(String(now), JSON.stringify(errors)).run();
  await notify(env, fresh);
  return { new: fresh.length, errors };
}

async function notify(env, fresh) {
  if (!env.NTFY_TOPIC) return;
  const maxP = parseInt(env.NOTIFY_MAX_PRICE, 10), maxK = parseFloat(env.NOTIFY_MAX_KM);
  const hits = fresh.filter((l) => l.price && l.price <= maxP && l.km <= maxK);
  for (const l of hits.slice(0, 10)) {
    await fetch("https://ntfy.sh/" + env.NTFY_TOPIC, {
      method: "POST",
      headers: { Title: `Nový byt ${l.disposition} · ${l.price.toLocaleString("cs-CZ")} Kč`, Click: l.url, Tags: "house" },
      body: `${l.locality} · ${l.km} km od práce${l.area ? " · " + l.area + " m²" : ""}`,
    });
  }
}

// ---------- HTTP ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/listings") {
      const since = Date.now() - 2 * 24 * 3600 * 1000; // ukaž jen inzeráty viděné za poslední 2 dny
      const { results } = await env.DB.prepare("SELECT * FROM listings WHERE last_seen > ? ORDER BY first_seen DESC").bind(since).all();
      const meta = await env.DB.prepare("SELECT v FROM meta WHERE k='last_run'").first();
      return Response.json({ listings: results, lastRun: meta ? Number(meta.v) : null, home: [env.HOME_LAT, env.HOME_LON] });
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
