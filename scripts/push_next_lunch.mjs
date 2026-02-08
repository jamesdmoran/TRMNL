import { chromium } from "playwright";

const MENU_URL =
  process.env.MENU_URL ??
  "https://www.sagedining.com/sites/st.marksschooloftexas/menu";

const TRMNL_WEBHOOK_URL = process.env.TRMNL_WEBHOOK_URL; // store in GitHub Secrets
const TIMEZONE = process.env.TIMEZONE ?? "America/Chicago";
const MEAL_REGEX = new RegExp(process.env.MEAL_REGEX ?? "\\blunch\\b", "i");
const DRY_RUN = (process.env.DRY_RUN ?? "").toLowerCase() === "true";

if (!TRMNL_WEBHOOK_URL && !DRY_RUN) {
  console.error("Missing env TRMNL_WEBHOOK_URL (add it as a GitHub Secret).");
  process.exit(2);
}

const DATE_RE_ISO = /\b20\d{2}-\d{2}-\d{2}\b/;
const DATE_RE_US = /\b([01]?\d)\/([0-3]?\d)\/(20\d{2})\b/;

function todayIso(tz) {
  // YYYY-MM-DD in the requested timezone
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function formatDate(isoDate, tz) {
  // Use noon UTC to avoid date-shift surprises when formatting in tz
  const dt = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dt);
}

function formatDateTimeNow(tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function isoToUsDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}

function addDaysIso(isoDate, days) {
  const dt = new Date(`${isoDate}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function usDateToIso(v) {
  if (typeof v !== "string") return null;
  const m = v.match(DATE_RE_US);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function coerceIsoDate(v) {
  if (typeof v !== "string") return null;

  const iso = v.match(DATE_RE_ISO);
  if (iso) return iso[0];

  return usDateToIso(v);
}

function extractDateFromObject(obj) {
  if (!isPlainObject(obj)) return null;

  // Common date-ish keys seen across menu APIs
  const keys = [
    "date",
    "menuDate",
    "menu_date",
    "serviceDate",
    "serveDate",
    "day",
    "dayDate",
    "startDate",
  ];

  for (const k of keys) {
    if (k in obj) {
      const d = coerceIsoDate(obj[k]);
      if (d) return d;
    }
  }

  // Fallback: scan immediate values
  for (const v of Object.values(obj)) {
    const d = coerceIsoDate(v);
    if (d) return d;
  }

  return null;
}

function findCandidateDayArrays(root) {
  const candidates = [];
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();

    if (Array.isArray(node)) {
      // Candidate: array of objects, some of which have dates
      const lenOk = node.length >= 2 && node.length <= 45;
      const objsOk = node.every((e) => e && typeof e === "object");
      const hasDate = node.some((e) => extractDateFromObject(e));

      if (lenOk && objsOk && hasDate) candidates.push(node);

      for (const child of node) stack.push(child);
      continue;
    }

    if (isPlainObject(node)) {
      for (const child of Object.values(node)) stack.push(child);
    }
  }

  return candidates;
}

function hasStringValueMatching(obj, re) {
  return Object.values(obj).some((v) => typeof v === "string" && re.test(v));
}

function hasNonEmptyArrayValue(obj) {
  return Object.values(obj).some((v) => Array.isArray(v) && v.length > 0);
}

function findMealCandidates(dayObj, mealRe) {
  const meals = [];
  const stack = [dayObj];

  while (stack.length) {
    const node = stack.pop();

    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }

    if (!isPlainObject(node)) continue;

    // Heuristic: meal objects usually contain the word Lunch AND have child arrays
    if (hasStringValueMatching(node, mealRe) && hasNonEmptyArrayValue(node)) {
      meals.push(node);
    }

    for (const child of Object.values(node)) stack.push(child);
  }

  return meals;
}

const NAME_KEYS = ["name", "item_name", "itemName", "menuItemName", "displayName", "title"];
const STATION_KEYS = ["station", "stationName", "concept", "category", "course", "line", "area"];

function getFirstString(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === "string") {
      const s = obj[k].trim();
      if (s) return s;
    }
  }
  return null;
}

function looksLikeFoodName(name) {
  if (!name) return false;
  const s = name.trim();
  if (s.length < 2 || s.length > 80) return false;
  if (DATE_RE_ISO.test(s)) return false;
  if (DATE_RE_US.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (/^(lunch|breakfast|dinner|menu)$/i.test(s)) return false;
  return true;
}

function extractItemPairs(mealObj) {
  const pairs = [];
  const seen = new Set();
  const stack = [mealObj];

  while (stack.length) {
    const node = stack.pop();

    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }

    if (!isPlainObject(node)) continue;

    // Avoid treating containers as items if they obviously contain items arrays
    const looksContainer =
      Object.values(node).some(
        (v) => Array.isArray(v) && v.length && typeof v[0] === "object"
      );

    const name = getFirstString(node, NAME_KEYS) ?? null;
    const station = getFirstString(node, STATION_KEYS) ?? null;

    if (!looksContainer && looksLikeFoodName(name)) {
      const key = `${name}@@${station ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ name, station });
      }
    }

    for (const child of Object.values(node)) stack.push(child);
  }

  return pairs;
}

function buildStations(pairs, stationLimit = 6, itemsPerStation = 3) {
  const map = new Map(); // station -> [items]
  const noStation = [];

  for (const p of pairs) {
    if (p.station) {
      if (!map.has(p.station)) map.set(p.station, []);
      map.get(p.station).push(p.name);
    } else {
      noStation.push(p.name);
    }
  }

  // Dedup within each station
  const stations = [...map.entries()].map(([name, items]) => {
    const dedup = [...new Set(items)];
    return { name, items: dedup };
  });

  // Sort: stations with most items first
  stations.sort((a, b) => b.items.length - a.items.length);

  // Trim
  const trimmed = stations.slice(0, stationLimit).map((s) => ({
    name: s.name,
    items: s.items.slice(0, itemsPerStation),
    items_joined: s.items.slice(0, itemsPerStation).join(", "),
  }));

  return { stations: trimmed, fallbackItems: [...new Set(noStation)].slice(0, 12) };
}

function extractLunchPairsFromSageDay(dayObj, mealRe) {
  const pairs = [];
  const seen = new Set();

  for (const categoryValue of Object.values(dayObj)) {
    if (!Array.isArray(categoryValue)) continue;

    for (const item of categoryValue) {
      if (!isPlainObject(item)) continue;
      if (!hasStringValueMatching(item, mealRe)) continue;

      const name = getFirstString(item, NAME_KEYS) ?? null;
      if (!looksLikeFoodName(name)) continue;

      let stationNames = [];

      if (Array.isArray(item.stations)) {
        stationNames = item.stations
          .filter((s) => isPlainObject(s))
          .map((s) => getFirstString(s, ["name"]))
          .filter(Boolean);
      }

      if (!stationNames.length) {
        const displayStation = getFirstString(item, ["displayStation"]);
        if (displayStation) {
          stationNames = displayStation
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }

      if (!stationNames.length) stationNames = [null];

      for (const station of stationNames) {
        const key = `${name}@@${station ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ name, station });
      }
    }
  }

  return pairs;
}

function extractNextLunchFromSageDateMap(root, tz, mealRe) {
  if (!isPlainObject(root)) return null;

  const dateEntries = Object.entries(root)
    .map(([k, v]) => ({ key: k, iso: usDateToIso(k), value: v }))
    .filter((e) => e.iso && isPlainObject(e.value))
    .sort((a, b) => a.iso.localeCompare(b.iso));

  if (!dateEntries.length) return null;

  const today = todayIso(tz);
  for (const entry of dateEntries) {
    if (entry.iso < today) continue;

    const pairs = extractLunchPairsFromSageDay(entry.value, mealRe);
    if (!pairs.length) continue;

    const { stations, fallbackItems } = buildStations(pairs);
    return {
      date: entry.iso,
      date_display: formatDate(entry.iso, tz),
      stations,
      items: fallbackItems,
    };
  }

  return null;
}

function tryExtractNextLunchFromRoot(root, tz, mealRe) {
  const today = todayIso(tz);

  // 1) Best case: root contains an array of "days"
  const dayArrays = findCandidateDayArrays(root);

  // Score arrays by number of unique dates + presence of "Lunch"
  const scored = dayArrays
    .map((arr) => {
      const dates = arr
        .map((o) => extractDateFromObject(o))
        .filter(Boolean);
      const uniqDates = new Set(dates);
      const lunchHits = arr.filter((o) => JSON.stringify(o).match(mealRe)).length;
      const score = uniqDates.size * 10 + lunchHits * 5;
      return { arr, uniqDates: [...uniqDates], score };
    })
    .sort((a, b) => b.score - a.score);

  // Helper: given a set of candidate day objects, find the first date >= today that has lunch items
  const extractFromDayObjects = (dayObjects) => {
    const dayList = dayObjects
      .map((o) => ({ date: extractDateFromObject(o), obj: o }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const day of dayList) {
      if (day.date < today) continue;

      const mealCandidates = findMealCandidates(day.obj, mealRe);
      for (const mealObj of mealCandidates) {
        const pairs = extractItemPairs(mealObj);
        if (pairs.length >= 3) {
          const { stations, fallbackItems } = buildStations(pairs);
          return {
            date: day.date,
            date_display: formatDate(day.date, tz),
            stations,
            items: fallbackItems,
          };
        }
      }
    }

    return null;
  };

  // Try best scored day arrays first
  for (const c of scored.slice(0, 5)) {
    const extracted = extractFromDayObjects(c.arr);
    if (extracted) return extracted;
  }

  // 2) Fallback: scan for individual day objects (objects with a date somewhere)
  const dayObjects = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isPlainObject(node)) continue;

    const d = extractDateFromObject(node);
    if (d) dayObjects.push(node);

    for (const child of Object.values(node)) stack.push(child);
  }

  const fallbackExtracted = extractFromDayObjects(dayObjects);
  if (fallbackExtracted) return fallbackExtracted;

  return null;
}

async function fetchMenuJsonViaPlaywright() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });

  const captured = [];

  page.on("response", async (resp) => {
    const ct = resp.headers()["content-type"] ?? "";
    if (!ct.includes("application/json")) return;

    try {
      const json = await resp.json();
      const text = JSON.stringify(json);

      // Skip tiny JSON (analytics, config)
      if (text.length < 1500) return;

      const nextLunch = extractNextLunchFromSageDateMap(json, TIMEZONE, MEAL_REGEX);

      captured.push({
        url: resp.url(),
        json,
        textLength: text.length,
        hasLunch: MEAL_REGEX.test(text),
        hasNextLunch: Boolean(nextLunch),
        nextLunchDate: nextLunch?.date ?? null,
        nextLunch,
      });
    } catch {
      // ignore JSON parse failures
    }
  });

  await page.goto(MENU_URL, { waitUntil: "networkidle", timeout: 90_000 });
  // Give any late XHR a moment
  await page.waitForTimeout(2500);

  await browser.close();

  if (!captured.length) {
    throw new Error("Captured 0 JSON responses. The site may have changed or blocked headless browsers.");
  }

  // Prefer JSON that contains "Lunch" and is large-ish
  captured.sort((a, b) => {
    const scoreA =
      (a.hasNextLunch ? 1_000_000 : 0) +
      (a.hasLunch ? 100_000 : 0) +
      a.textLength;
    const scoreB =
      (b.hasNextLunch ? 1_000_000 : 0) +
      (b.hasLunch ? 100_000 : 0) +
      b.textLength;
    return scoreB - scoreA;
  });

  let best = captured[0];

  if (!best.hasNextLunch) {
    const menuIds = [
      ...new Set(
        captured
          .map((c) => {
            try {
              return new URL(c.url).searchParams.get("menuId");
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];

    const today = todayIso(TIMEZONE);
    for (const menuId of menuIds) {
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidateIso = addDaysIso(today, offset);
        const candidateUs = isoToUsDate(candidateIso);
        const url = `https://www.sagedining.com/microsites/getWeeklyMenuItems?menuId=${menuId}&date=${candidateUs}`;

        try {
          const resp = await fetch(url);
          if (!resp.ok) continue;

          const json = await resp.json();
          const text = JSON.stringify(json);
          const nextLunch = extractNextLunchFromSageDateMap(json, TIMEZONE, MEAL_REGEX);

          if (nextLunch) {
            best = {
              url,
              json,
              textLength: text.length,
              hasLunch: MEAL_REGEX.test(text),
              hasNextLunch: true,
              nextLunchDate: nextLunch.date,
              nextLunch,
              source: "api-fallback",
            };
            break;
          }
        } catch {
          // continue trying additional dates
        }
      }

      if (best.hasNextLunch) break;
    }
  }

  console.log("Best JSON candidate:", {
    url: best.url,
    bytes: best.textLength,
    hasLunch: best.hasLunch,
    hasNextLunch: best.hasNextLunch,
    nextLunchDate: best.nextLunchDate,
    source: best.source ?? "captured-response",
  });

  return best;
}

async function postToTrmnl(mergeVariables) {
  if (DRY_RUN) {
    console.log("DRY_RUN=true. Would POST merge variables to TRMNL:");
    console.log(JSON.stringify(mergeVariables, null, 2));
    return;
  }

  const res = await fetch(TRMNL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge_variables: mergeVariables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TRMNL webhook POST failed: HTTP ${res.status} ${res.statusText} :: ${body}`);
  }

  console.log("Posted to TRMNL successfully.");
}

async function main() {
  const updatedAtLocal = formatDateTimeNow(TIMEZONE);

  let mergeVariables;

  try {
    const best = await fetchMenuJsonViaPlaywright();
    const lunch =
      best.nextLunch ??
      extractNextLunchFromSageDateMap(best.json, TIMEZONE, MEAL_REGEX) ??
      tryExtractNextLunchFromRoot(best.json, TIMEZONE, MEAL_REGEX);

    if (!lunch) {
      throw new Error(
        "Could not locate a next Lunch payload in the captured JSON. The menu data structure may have changed."
      );
    }

    mergeVariables = {
      status: "ok",
      updated_at_local: updatedAtLocal,
      source_url: MENU_URL,
      lunch: {
        date: lunch.date,
        date_display: lunch.date_display,
        note: lunch.date === todayIso(TIMEZONE) ? "Today" : null,
        stations: lunch.stations,
        items: lunch.items
      },
    };
  } catch (err) {
    mergeVariables = {
      status: "error",
      updated_at_local: updatedAtLocal,
      source_url: MENU_URL,
      error: err instanceof Error ? err.message : String(err),
      lunch: {
        date: null,
        date_display: null,
        note: null,
        stations: [],
        items: [],
      },
    };
    console.error("ERROR:", mergeVariables.error);
    // Still try to post the error to TRMNL so you can see it on-device
  }

  await postToTrmnl(mergeVariables);

  // Make the action fail when scraping fails (so you notice)
  if (mergeVariables.status !== "ok") process.exitCode = 1;
}

await main();
