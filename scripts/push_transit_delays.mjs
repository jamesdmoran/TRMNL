import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { collectSnapshot } from "./transit_delays.mjs";

const TRMNL_WEBHOOK_URL = process.env.TRMNL_WEBHOOK_URL_TRANSIT;
const TIMEZONE = process.env.TIMEZONE ?? "America/Chicago";
const DRY_RUN = (process.env.DRY_RUN ?? "").toLowerCase() === "true";
const TRANSIT_INCLUDE_PLANNED =
  (process.env.TRANSIT_INCLUDE_PLANNED ?? "").toLowerCase() === "true";
const FETCH_TIMEOUT_MS = toPositiveInt(process.env.FETCH_TIMEOUT_MS, 15_000);
const MAX_NYC_ITEMS = toPositiveInt(process.env.TRANSIT_MAX_NYC_ITEMS, 3);
const MAX_LONDON_ITEMS = toPositiveInt(process.env.TRANSIT_MAX_LONDON_ITEMS, 4);
const MAX_PAYLOAD_BYTES = 1900;

const execFileAsync = promisify(execFile);

if (!TRMNL_WEBHOOK_URL && !DRY_RUN) {
  console.error("Missing webhook env TRMNL_WEBHOOK_URL_TRANSIT.");
  process.exit(2);
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncateText(value, maxChars) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  if (maxChars <= 3) return cleaned.slice(0, maxChars);
  return `${cleaned.slice(0, maxChars - 3)}...`;
}

function formatDateTimeNow(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function formatEpochSeconds(epochSeconds, timeZone) {
  if (!Number.isFinite(epochSeconds)) return null;

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function getTimeZoneAbbrev(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date());

  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

function payloadBytes(mergeVariables) {
  return Buffer.byteLength(JSON.stringify({ merge_variables: mergeVariables }), "utf8");
}

function routeLabel(routes, maxChars = 22) {
  const value = Array.isArray(routes) && routes.length > 0 ? routes.join(", ") : "Unknown route";
  return truncateText(value, maxChars);
}

function normalizeNycItems(state, limits) {
  if (state.status !== "ok") return [];

  return (state.delays ?? [])
    .slice(0, limits.nycMax)
    .map((row) => ({
      line: routeLabel(row.routes, 20),
      summary: truncateText(row.summary || "Service disruption reported.", limits.summaryMax),
      reason: truncateText(row.reason || row.effect || row.cause || "", limits.reasonMax),
    }));
}

function normalizeLondonItems(state, limits) {
  if (state.status !== "ok") return [];

  return (state.delays ?? [])
    .slice(0, limits.londonMax)
    .map((row) => ({
      line: truncateText(row.line || "Unknown line", 18),
      status: truncateText(row.status || "Disruption", 24),
      reason: truncateText(row.reason || "", limits.reasonMax),
    }));
}

function deriveStatus(nycStatus, londonStatus) {
  if (nycStatus === "ok" && londonStatus === "ok") return "ok";
  if (nycStatus === "error" && londonStatus === "error") return "error";
  return "partial";
}

function buildMergeVariables(snapshot, limits) {
  const nyc = snapshot.nyc_subway;
  const london = snapshot.london_tube;

  const nycItems = normalizeNycItems(nyc, limits);
  const londonItems = normalizeLondonItems(london, limits);

  const nycDelayCount = nyc.status === "ok" ? (nyc.delays?.length ?? 0) : 0;
  const londonDelayCount = london.status === "ok" ? (london.delays?.length ?? 0) : 0;
  const status = deriveStatus(nyc.status, london.status);

  const mergeVariables = {
    status,
    app_title: "Transit Delay Board",
    updated_at_local: formatDateTimeNow(TIMEZONE),
    timezone_abbrev: getTimeZoneAbbrev(TIMEZONE),
    generated_at: snapshot.generated_at,
    nyc: {
      status: nyc.status,
      delay_count: nycDelayCount,
      feed_timestamp_local: formatEpochSeconds(nyc.feed_timestamp, TIMEZONE),
      source: nyc.source ?? "MTA GTFS-RT alerts",
      error: nyc.status === "error" ? truncateText(nyc.error ?? "Unknown MTA error.", 180) : "",
      items: nycItems,
    },
    london: {
      status: london.status,
      delay_count: londonDelayCount,
      source: london.source ?? "TfL line status",
      error:
        london.status === "error" ? truncateText(london.error ?? "Unknown TfL error.", 180) : "",
      items: londonItems,
    },
  };

  if (status !== "ok") {
    const errors = [];
    if (mergeVariables.nyc.error) errors.push(`NYC: ${mergeVariables.nyc.error}`);
    if (mergeVariables.london.error) errors.push(`London: ${mergeVariables.london.error}`);
    mergeVariables.error = truncateText(errors.join(" | "), 220);
  }

  return mergeVariables;
}

function compactMergeVariables(snapshot) {
  const plans = [
    {
      nycMax: MAX_NYC_ITEMS,
      londonMax: MAX_LONDON_ITEMS,
      summaryMax: 120,
      reasonMax: 120,
    },
    {
      nycMax: Math.min(MAX_NYC_ITEMS, 3),
      londonMax: Math.min(MAX_LONDON_ITEMS, 4),
      summaryMax: 96,
      reasonMax: 92,
    },
    {
      nycMax: Math.min(MAX_NYC_ITEMS, 2),
      londonMax: Math.min(MAX_LONDON_ITEMS, 3),
      summaryMax: 80,
      reasonMax: 72,
    },
    {
      nycMax: 1,
      londonMax: 2,
      summaryMax: 64,
      reasonMax: 56,
    },
  ];

  let last = null;
  for (const plan of plans) {
    const candidate = buildMergeVariables(snapshot, plan);
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

  const body = JSON.stringify({ merge_variables: mergeVariables });

  try {
    const response = await fetch(TRMNL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `TRMNL webhook POST failed: HTTP ${response.status} ${response.statusText} :: ${truncateText(errorBody, 220)}`
      );
    }
  } catch (fetchError) {
    // Fallback for restricted runtime environments where Node fetch DNS is blocked.
    try {
      await execFileAsync("curl", [
        "-sS",
        "--fail",
        "-X",
        "POST",
        TRMNL_WEBHOOK_URL,
        "-H",
        "Content-Type: application/json",
        "--data",
        body,
      ]);
    } catch (curlError) {
      const fetchMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
      const curlMessage = curlError instanceof Error ? curlError.message : String(curlError);
      throw new Error(
        `TRMNL webhook POST failed via fetch and curl. fetch: ${truncateText(fetchMessage, 120)}; curl: ${truncateText(curlMessage, 120)}`
      );
    }
  }

  console.log("Posted to TRMNL successfully.");
}

async function main() {
  const snapshot = await collectSnapshot({
    includePlanned: TRANSIT_INCLUDE_PLANNED,
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const compacted = compactMergeVariables(snapshot);
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
