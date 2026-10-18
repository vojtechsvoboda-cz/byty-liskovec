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
    for (let page = 1; page <= 5; page++) {
      const url = "https://www.sreality.cz/api/cs/v2/estates?category_main_cb=1&category_type_cb=2" +
        "&category_sub_cb=2|3|4|5|6|7&locality_region_id=14&locality_district_id=" + district +
        "&czk_price_summary_order2=0|26000&per_page=60&page=" + page;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error("Sreality HTTP " + res.status);
      const data = await res.json();
      const estates = data?._embedded?.estates || [];
      for (const e of estates) {
        const name = e.name || "";
        const disp = (name.match(/(\d\+(?:kk|\d))/i) || [])[1] || "";
        const area = parseInt((name.match(/(\d+)\s*m²/) || [])[1] || "0", 10);
        out.push({
          id: "sreality-" + e.hash_id,
          source: "Sreality",
          title: name.replace(/\u00a0/g, " "),
          price: e.price_czk?.value_raw ?? e.price ?? null,
          disposition: disp.toLowerCase(),
          area,
          locality: e.locality || "",
          lat: e.gps?.lat, lon: e.gps?.lon,
          url: "https://www.sreality.cz/detail/pronajem/byt/x/x/" + e.hash_id,
          image: e._links?.images?.[0]?.href || "",
        });
      }
      if (estates.length < 60) break;
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
  for (const src of SOURCES) {
    try {
      for (const l of await src()) {
        if (l.lat == null || l.lon == null) continue;
        l.km = Math.round(km(hLat, hLon, l.lat, l.lon) * 100) / 100;
        if (l.km > MAX_KM_STORE) continue;
        const existing = await env.DB.prepare("SELECT id FROM listings WHERE id=?").bind(l.id).first();
        if (existing) {
          await env.DB.prepare("UPDATE listings SET last_seen=?, price=? WHERE id=?").bind(now, l.price, l.id).run();
        } else {
          await env.DB.prepare(`INSERT INTO listings (id,source,title,price,disposition,area,locality,lat,lon,km,url,image,first_seen,last_seen)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(l.id, l.source, l.title, l.price, l.disposition, l.area, l.locality, l.lat, l.lon, l.km, l.url, l.image, now, now).run();
          fresh.push(l);
        }
      }
    } catch (e) { errors.push(String(e)); }
  }
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
