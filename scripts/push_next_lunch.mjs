import { chromium } from "playwright";

const MENU_URL =
  process.env.MENU_URL ??
  "https://www.sagedining.com/sites/st.marksschooloftexas/menu";

const TRMNL_WEBHOOK_URL = process.env.TRMNL_WEBHOOK_URL;
const TIMEZONE = process.env.TIMEZONE ?? "America/Chicago";
const START_DATE_ISO = process.env.START_DATE_ISO ?? "";
const MEAL_REGEX = new RegExp(process.env.MEAL_REGEX ?? "\\blunch\\b", "i");
const DRY_RUN = (process.env.DRY_RUN ?? "").toLowerCase() === "true";

const MAX_PAYLOAD_BYTES = 1900;
const DEFAULT_ERROR_MAX_CHARS = 200;

if (!TRMNL_WEBHOOK_URL && !DRY_RUN) {
  console.error("Missing env TRMNL_WEBHOOK_URL (add it as a GitHub Secret or local env var).");
  process.exit(2);
}

const DATE_RE_ISO = /\b20\d{2}-\d{2}-\d{2}\b/;
const DATE_RE_US = /\b([01]?\d)\/([0-3]?\d)\/(20\d{2})\b/;

const NAME_KEYS = [
  "name",
  "item_name",
  "itemName",
  "menuItemName",
  "displayName",
  "title",
];

// Favor food/course grouping labels over branded station labels.
const SECTION_KEYS = ["displayCategory", "category", "course", "dailyCategory"];

function todayIso(tz) {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function resolveStartIso(tz) {
  const override = coerceIsoDate(START_DATE_ISO);
  return override ?? addDaysIso(todayIso(tz), 1);
}

function formatDate(isoDate, tz) {
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

function truncateText(value, maxChars) {
  if (typeof value !== "string") return value;
  if (maxChars <= 1) return value.slice(0, 1);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function stripAnsi(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function cleanLabel(value) {
  if (typeof value !== "string") return null;
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[®™]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSectionName(raw, fallback = null) {
  const base = cleanLabel(raw) ?? cleanLabel(fallback);
  if (!base) return null;

  const lower = base.toLowerCase();
  if (["none", "exclude", "events"].includes(lower)) return null;
  if (lower === "today's menu features" || lower === "todays menu features") return "Features";
  if (lower === "sides and vegetables") return "Sides";
  if (lower === "entrees" || lower === "entree" || lower === "entrees") return "Entrees";

  return truncateText(base, 28);
}

function cleanFoodName(raw) {
  const value = cleanLabel(raw);
  if (!value) return null;
  if (value.length < 2 || value.length > 90) return null;
  if (DATE_RE_ISO.test(value) || DATE_RE_US.test(value)) return null;
  if (/^https?:\/\//i.test(value)) return null;
  if (/^(lunch|breakfast|dinner|menu)$/i.test(value)) return null;
  return value;
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
    if (!(k in obj)) continue;
    const d = coerceIsoDate(obj[k]);
    if (d) return d;
  }

  for (const v of Object.values(obj)) {
    const d = coerceIsoDate(v);
    if (d) return d;
  }

  return null;
}

function hasStringValueMatching(obj, re) {
  return Object.values(obj).some((v) => typeof v === "string" && re.test(v));
}

function getFirstString(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] !== "string") continue;
    const trimmed = obj[k].trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function buildSections(pairs, sectionLimit = 6, itemsPerSection = 3) {
  const map = new Map(); // section -> [items]
  const noSection = [];

  for (const p of pairs) {
    if (p.section) {
      if (!map.has(p.section)) map.set(p.section, []);
      map.get(p.section).push(p.name);
    } else {
      noSection.push(p.name);
    }
  }

  const sections = [...map.entries()].map(([name, items]) => {
    const dedup = [...new Set(items)];
    return { name, items: dedup };
  });

  sections.sort((a, b) => b.items.length - a.items.length);

  const trimmed = sections.slice(0, sectionLimit).map((section) => ({
    name: section.name,
    items: section.items.slice(0, itemsPerSection),
  }));

  return { sections: trimmed, fallbackItems: [...new Set(noSection)].slice(0, 12) };
}

function extractLunchPairsFromSageDay(dayObj, mealRe) {
  const pairs = [];
  const seen = new Set();

  for (const [categoryKey, categoryValue] of Object.entries(dayObj)) {
    if (!Array.isArray(categoryValue)) continue;

    for (const item of categoryValue) {
      if (!isPlainObject(item)) continue;
      if (!hasStringValueMatching(item, mealRe)) continue;

      const name = cleanFoodName(getFirstString(item, NAME_KEYS));
      if (!name) continue;

      const section = normalizeSectionName(
        getFirstString(item, SECTION_KEYS),
        categoryKey
      );

      const key = `${name}@@${section ?? ""}`;
      if (seen.has(key)) continue;

      seen.add(key);
      pairs.push({ name, section });
    }
  }

  return pairs;
}

function extractNextLunchFromSageDateMap(root, tz, mealRe, startIso) {
  if (!isPlainObject(root)) return null;

  const dateEntries = Object.entries(root)
    .map(([k, v]) => ({ iso: usDateToIso(k), value: v }))
    .filter((e) => e.iso && isPlainObject(e.value))
    .sort((a, b) => a.iso.localeCompare(b.iso));

  if (!dateEntries.length) return null;

  for (const entry of dateEntries) {
    if (entry.iso < startIso) continue;

    const pairs = extractLunchPairsFromSageDay(entry.value, mealRe);
    if (!pairs.length) continue;

    const { sections, fallbackItems } = buildSections(pairs);
    return {
      date: entry.iso,
      date_display: formatDate(entry.iso, tz),
      sections,
      items: fallbackItems,
    };
  }

  return null;
}

function findCandidateDayArrays(root) {
  const candidates = [];
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();

    if (Array.isArray(node)) {
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

    const hasArray = Object.values(node).some((v) => Array.isArray(v) && v.length > 0);
    if (hasStringValueMatching(node, mealRe) && hasArray) meals.push(node);

    for (const child of Object.values(node)) stack.push(child);
  }

  return meals;
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

    const looksContainer = Object.values(node).some(
      (v) => Array.isArray(v) && v.length && typeof v[0] === "object"
    );

    const name = cleanFoodName(getFirstString(node, NAME_KEYS));
    const section = normalizeSectionName(getFirstString(node, SECTION_KEYS));

    if (!looksContainer && name) {
      const key = `${name}@@${section ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ name, section });
      }
    }

    for (const child of Object.values(node)) stack.push(child);
  }

  return pairs;
}

function tryExtractNextLunchFromRoot(root, tz, mealRe, startIso) {
  const dayArrays = findCandidateDayArrays(root);

  const scored = dayArrays
    .map((arr) => {
      const dates = arr.map((o) => extractDateFromObject(o)).filter(Boolean);
      const uniqDates = new Set(dates);
      const lunchHits = arr.filter((o) => JSON.stringify(o).match(mealRe)).length;
      return { arr, score: uniqDates.size * 10 + lunchHits * 5 };
    })
    .sort((a, b) => b.score - a.score);

  const extractFromDayObjects = (dayObjects) => {
    const dayList = dayObjects
      .map((o) => ({ date: extractDateFromObject(o), obj: o }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const day of dayList) {
      if (day.date < startIso) continue;

      const mealCandidates = findMealCandidates(day.obj, mealRe);
      for (const mealObj of mealCandidates) {
        const pairs = extractItemPairs(mealObj);
        if (pairs.length < 3) continue;

        const { sections, fallbackItems } = buildSections(pairs);
        return {
          date: day.date,
          date_display: formatDate(day.date, tz),
          sections,
          items: fallbackItems,
        };
      }
    }

    return null;
  };

  for (const candidate of scored.slice(0, 5)) {
    const extracted = extractFromDayObjects(candidate.arr);
    if (extracted) return extracted;
  }

  const dayObjects = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isPlainObject(node)) continue;

    if (extractDateFromObject(node)) dayObjects.push(node);
    for (const child of Object.values(node)) stack.push(child);
  }

  return extractFromDayObjects(dayObjects);
}

function extractNextLunch(root, tz, mealRe, startIso) {
  return (
    extractNextLunchFromSageDateMap(root, tz, mealRe, startIso) ??
    tryExtractNextLunchFromRoot(root, tz, mealRe, startIso)
  );
}

async function fetchMenuJsonViaPlaywright(startIso) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });

  const captured = [];

  try {
    page.on("response", async (resp) => {
      const ct = resp.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;

      try {
        const json = await resp.json();
        const text = JSON.stringify(json);
        if (text.length < 1500) return;

        const nextLunch = extractNextLunch(json, TIMEZONE, MEAL_REGEX, startIso);

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
        // Ignore non-json/parse failures.
      }
    });

    await page.goto(MENU_URL, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(2500);
  } finally {
    await browser.close().catch(() => {});
  }

  if (!captured.length) {
    throw new Error("Captured 0 JSON responses. The site may have changed or blocked headless browsers.");
  }

  captured.sort((a, b) => {
    const scoreA = (a.hasNextLunch ? 1_000_000 : 0) + (a.hasLunch ? 100_000 : 0) + a.textLength;
    const scoreB = (b.hasNextLunch ? 1_000_000 : 0) + (b.hasLunch ? 100_000 : 0) + b.textLength;
    return scoreB - scoreA;
  });

  let best = captured[0];

  // Sunday/midnight edge case: captured response can be a stale week; directly query near-term weeks.
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

    for (const menuId of menuIds) {
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidateIso = addDaysIso(startIso, offset);
        const candidateUs = isoToUsDate(candidateIso);
        const url =
          `https://www.sagedining.com/microsites/getWeeklyMenuItems` +
          `?menuId=${menuId}&date=${candidateUs}`;

        try {
          const resp = await fetch(url);
          if (!resp.ok) continue;

          const json = await resp.json();
          const text = JSON.stringify(json);
          const nextLunch = extractNextLunch(json, TIMEZONE, MEAL_REGEX, startIso);
          if (!nextLunch) continue;

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
        } catch {
          // Keep trying additional dates.
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

function payloadBytes(mergeVariables) {
  return Buffer.byteLength(JSON.stringify({ merge_variables: mergeVariables }), "utf8");
}

function toCompactStations(stations, stationLimit, itemsPerStation, stationNameMax, itemMax) {
  return (stations ?? [])
    .map((section) => ({
      name: truncateText(cleanLabel(section.name) ?? "Menu", stationNameMax),
      items: (section.items ?? [])
        .map((item) => truncateText(cleanFoodName(item) ?? "", itemMax))
        .filter(Boolean)
        .slice(0, itemsPerStation),
    }))
    .filter((section) => section.items.length > 0)
    .slice(0, stationLimit)
    .map((section) => ({
      name: section.name,
      items_joined: section.items.join(", "),
    }));
}

function applyPayloadLimits(mergeVariables, limits) {
  const clone = JSON.parse(JSON.stringify(mergeVariables));

  if (clone.error) clone.error = truncateText(String(clone.error), limits.errorMax);

  if (clone.lunch) {
    const stations = toCompactStations(
      clone.lunch.sections ?? clone.lunch.stations ?? [],
      limits.stationLimit,
      limits.itemsPerStation,
      limits.stationNameMax,
      limits.itemMax
    );

    clone.lunch.stations = stations;
    clone.lunch.items = (clone.lunch.items ?? [])
      .map((item) => truncateText(cleanFoodName(item) ?? "", limits.itemMax))
      .filter(Boolean)
      .slice(0, limits.fallbackLimit);

    // Internal extraction field; not needed in payload.
    delete clone.lunch.sections;
  }

  return clone;
}

function compactMergeVariables(mergeVariables) {
  const plans = [
    {
      stationLimit: 6,
      itemsPerStation: 3,
      fallbackLimit: 12,
      stationNameMax: 28,
      itemMax: 64,
      errorMax: DEFAULT_ERROR_MAX_CHARS,
    },
    {
      stationLimit: 4,
      itemsPerStation: 3,
      fallbackLimit: 10,
      stationNameMax: 24,
      itemMax: 56,
      errorMax: 190,
    },
    {
      stationLimit: 4,
      itemsPerStation: 2,
      fallbackLimit: 8,
      stationNameMax: 20,
      itemMax: 44,
      errorMax: 170,
    },
    {
      stationLimit: 3,
      itemsPerStation: 2,
      fallbackLimit: 6,
      stationNameMax: 18,
      itemMax: 36,
      errorMax: 150,
    },
    {
      stationLimit: 2,
      itemsPerStation: 2,
      fallbackLimit: 5,
      stationNameMax: 16,
      itemMax: 30,
      errorMax: 130,
    },
  ];

  let last = null;
  for (const plan of plans) {
    const candidate = applyPayloadLimits(mergeVariables, plan);
    const bytes = payloadBytes(candidate);
    last = { mergeVariables: candidate, bytes, plan };
    if (bytes <= MAX_PAYLOAD_BYTES) return last;
  }

  return last;
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
    const snippet = truncateText(stripAnsi(body), 240);
    throw new Error(`TRMNL webhook POST failed: HTTP ${res.status} ${res.statusText} :: ${snippet}`);
  }

  console.log("Posted to TRMNL successfully.");
}

async function main() {
  const updatedAtLocal = formatDateTimeNow(TIMEZONE);
  const startIso = resolveStartIso(TIMEZONE);

  let mergeVariables;
  try {
    const best = await fetchMenuJsonViaPlaywright(startIso);
    const lunch =
      best.nextLunch ??
      extractNextLunch(best.json, TIMEZONE, MEAL_REGEX, startIso);

    if (!lunch) {
      throw new Error("Could not locate a next Lunch payload in the captured JSON.");
    }

    mergeVariables = {
      status: "ok",
      updated_at_local: updatedAtLocal,
      source_url: MENU_URL,
      lunch: {
        date: lunch.date,
        date_display: lunch.date_display,
        note: lunch.date === todayIso(TIMEZONE) ? "Today" : null,
        sections: lunch.sections ?? [],
        items: lunch.items ?? [],
      },
    };
  } catch (err) {
    mergeVariables = {
      status: "error",
      updated_at_local: updatedAtLocal,
      source_url: MENU_URL,
      error: truncateText(
        stripAnsi(err instanceof Error ? err.message : String(err)),
        DEFAULT_ERROR_MAX_CHARS
      ),
      lunch: {
        date: null,
        date_display: null,
        note: null,
        sections: [],
        items: [],
      },
    };
    console.error("ERROR:", mergeVariables.error);
  }

  const compacted = compactMergeVariables(mergeVariables);
  console.log(`Webhook payload bytes: ${compacted.bytes}`);

  if (compacted.bytes > MAX_PAYLOAD_BYTES) {
    console.error(
      `ERROR: Payload is still too large (${compacted.bytes} bytes) after compaction.`
    );
  }

  await postToTrmnl(compacted.mergeVariables);

  if (compacted.mergeVariables.status !== "ok" || compacted.bytes > MAX_PAYLOAD_BYTES) {
    process.exitCode = 1;
  }
}

await main();
