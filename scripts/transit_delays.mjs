import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_SECONDS = 120;
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.FETCH_TIMEOUT_MS ?? "15000", 10);
const MTA_ALERTS_URL =
  process.env.MTA_ALERTS_URL ??
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts.json";
const TFL_STATUS_URL =
  process.env.TFL_STATUS_URL ?? "https://api.tfl.gov.uk/Line/Mode/tube/Status?detail=true";

const DELAY_KEYWORD_RE =
  /\b(delay|delays|delayed|suspend|suspended|suspension|no service|reduced service|service change|detour|slow|congestion|signal|switch|track|disabled train|police|investigation)\b/i;
const TUBE_DISRUPTION_RE =
  /\b(delay|delays|minor|severe|suspend|suspended|closure|closed|reduced|part)\b/i;

const HTML_TAG_RE = /<[^>]*>/g;
const MULTISPACE_RE = /\s+/g;
const execFileAsync = promisify(execFile);

function printHelp() {
  console.log(`
Transit delays CLI (NYC Subway + London Tube)

Usage:
  node scripts/transit_delays.mjs [options]

Options:
  --watch                Keep refreshing output.
  --interval <seconds>   Refresh interval in watch mode. Default: ${DEFAULT_INTERVAL_SECONDS}
  --json                 Emit JSON output.
  --include-planned      Include planned-work alerts from MTA output.
  --help                 Show this message.

Env vars:
  MTA_ALERTS_URL         Override MTA alerts endpoint.
  TFL_STATUS_URL         Override TfL tube status endpoint.
  FETCH_TIMEOUT_MS       HTTP timeout per request in milliseconds.
`.trim());
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    watch: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    json: false,
    includePlanned: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--watch") {
      options.watch = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--include-planned") {
      options.includePlanned = true;
      continue;
    }

    if (arg === "--interval") {
      const value = argv[i + 1];
      if (!value) throw new Error("--interval requires a numeric value.");
      const seconds = parseInteger(value, NaN);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`Invalid --interval value: ${value}`);
      }
      options.intervalSeconds = seconds;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value, maxChars) {
  if (typeof value !== "string") return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function sanitizeText(value) {
  if (typeof value !== "string") return "";
  return decodeHtmlEntities(value).replace(HTML_TAG_RE, " ").replace(MULTISPACE_RE, " ").trim();
}

function humanizeEnum(value) {
  const input = sanitizeText(String(value ?? ""));
  if (!input) return "";

  return input
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function firstSentence(value, maxChars = 240) {
  const cleaned = sanitizeText(value);
  if (!cleaned) return "";

  const match = cleaned.match(/.+?[.?!](?=\s|$)/);
  return truncateText((match ? match[0] : cleaned).trim(), maxChars);
}

function translationText(translatable) {
  if (!translatable || !Array.isArray(translatable.translation)) return "";

  const seen = new Set();
  const parts = [];

  for (const row of translatable.translation) {
    const text = sanitizeText(row?.text ?? "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }

  return parts.join(" ").trim();
}

function routeSortKey(routeId) {
  const value = String(routeId ?? "").trim().toUpperCase();
  const match = value.match(/^(\d+)([A-Z]*)$/);
  if (!match) {
    return { type: 1, number: Number.MAX_SAFE_INTEGER, suffix: "", raw: value };
  }
  return {
    type: 0,
    number: Number.parseInt(match[1], 10),
    suffix: match[2] ?? "",
    raw: value,
  };
}

function compareRouteIds(a, b) {
  const left = routeSortKey(a);
  const right = routeSortKey(b);
  if (left.type !== right.type) return left.type - right.type;
  if (left.number !== right.number) return left.number - right.number;
  if (left.suffix !== right.suffix) return left.suffix.localeCompare(right.suffix);
  return left.raw.localeCompare(right.raw);
}

function formatEpochSeconds(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return null;
  return new Date(epochSeconds * 1000).toLocaleString();
}

function pickReason({ header, description, cause, effect }) {
  const combined = `${header}\n${description}`.trim();
  const dueToMatch = combined.match(/\bdue to\b[^.?!\n]*/i);
  if (dueToMatch) {
    const reason = sanitizeText(dueToMatch[0]);
    if (reason) return truncateText(reason, 220);
  }

  const details = firstSentence(description, 220);
  const summary = firstSentence(header, 220);
  if (details && details.toLowerCase() !== summary.toLowerCase()) {
    return details;
  }

  const causeText = humanizeEnum(cause);
  if (causeText && !/unknown|other/i.test(causeText)) return causeText;

  const effectText = humanizeEnum(effect);
  if (effectText && !/unknown|other/i.test(effectText)) return effectText;

  return "";
}

function parseMtaDelays(feed, includePlanned = false) {
  const entities = Array.isArray(feed?.entity) ? feed.entity : [];
  const results = [];

  for (const entity of entities) {
    const alert = entity?.alert;
    if (!alert || typeof alert !== "object") continue;

    const informedEntity = Array.isArray(alert.informed_entity) ? alert.informed_entity : [];
    const subwayRefs = informedEntity.filter((entry) => entry?.agency_id === "MTASBWY");
    if (!subwayRefs.length) continue;

    const header = translationText(alert.header_text);
    const description = translationText(alert.description_text);
    const effect = String(alert.effect ?? "");
    const cause = String(alert.cause ?? "");
    const id = String(entity.id ?? "");
    const category = id.split(":")[1] ?? "";
    const isPlanned = category === "planned_work";

    const keywordMatch = DELAY_KEYWORD_RE.test(`${header} ${description} ${effect} ${cause}`);
    const isExplicitAlert = id.includes(":alert:");
    const hasDisruptionEffect = /delay|suspend|service|detour|closure|no_service/i.test(effect);

    if (!includePlanned && isPlanned && !keywordMatch) continue;
    if (!(keywordMatch || isExplicitAlert || hasDisruptionEffect)) continue;

    const routes = [...new Set(subwayRefs.map((entry) => sanitizeText(entry?.route_id ?? "")).filter(Boolean))]
      .sort(compareRouteIds);
    const summary = firstSentence(header || description || "Service disruption reported.", 260);
    const reason = pickReason({ header, description, cause, effect });

    const activePeriods = Array.isArray(alert.active_period) ? alert.active_period : [];
    const starts = activePeriods.map((period) => Number(period?.start)).filter(Number.isFinite);
    const ends = activePeriods.map((period) => Number(period?.end)).filter(Number.isFinite);

    results.push({
      id,
      category,
      routes,
      summary,
      reason,
      effect: humanizeEnum(effect),
      cause: humanizeEnum(cause),
      starts_at: starts.length ? Math.min(...starts) : null,
      ends_at: ends.length ? Math.min(...ends) : null,
    });
  }

  results.sort((a, b) => {
    const aRoute = a.routes.join(",");
    const bRoute = b.routes.join(",");
    if (aRoute !== bRoute) return aRoute.localeCompare(bRoute);
    return a.summary.localeCompare(b.summary);
  });

  return results;
}

function parseTubeDelays(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const seen = new Set();
  const delays = [];

  for (const line of rows) {
    const lineName = sanitizeText(line?.name ?? "");
    const statuses = Array.isArray(line?.lineStatuses) ? line.lineStatuses : [];
    if (!lineName || !statuses.length) continue;

    for (const status of statuses) {
      const statusDescription = sanitizeText(status?.statusSeverityDescription ?? "");
      if (!statusDescription || /^good service$/i.test(statusDescription)) continue;

      const reason = sanitizeText(status?.reason ?? "");
      const disruptionText = `${statusDescription} ${reason}`.trim();
      if (!TUBE_DISRUPTION_RE.test(disruptionText)) continue;

      const key = `${lineName}@@${statusDescription}@@${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);

      delays.push({
        line: lineName,
        status: statusDescription,
        reason: truncateText(firstSentence(reason || statusDescription, 260), 260),
      });
    }
  }

  delays.sort((a, b) => {
    if (a.line !== b.line) return a.line.localeCompare(b.line);
    return a.status.localeCompare(b.status);
  });

  return delays;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (fetchError) {
      // Fallback for restricted runtime environments where Node fetch DNS is blocked.
      try {
        const { stdout } = await execFileAsync("curl", [
          "-sS",
          "--fail",
          url,
        ]);
        return JSON.parse(stdout);
      } catch (curlError) {
        const fetchMessage = fetchError instanceof Error
          ? fetchError.message
          : String(fetchError);
        const curlMessage = curlError instanceof Error ? curlError.message : String(curlError);
        throw new Error(
          `Request failed via fetch and curl at ${url}. fetch: ${truncateText(fetchMessage, 120)}; curl: ${truncateText(curlMessage, 120)}`
        );
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function getNycSubwayDelays(options) {
  const feed = await fetchJson(MTA_ALERTS_URL, options.timeoutMs);
  const timestamp = Number(feed?.header?.timestamp);

  return {
    source: "MTA GTFS-RT alerts",
    feed_timestamp: Number.isFinite(timestamp) ? timestamp : null,
    delays: parseMtaDelays(feed, options.includePlanned),
  };
}

async function getLondonTubeDelays(options) {
  const lines = await fetchJson(TFL_STATUS_URL, options.timeoutMs);
  return {
    source: "TfL line status",
    delays: parseTubeDelays(lines),
  };
}

function toResultState(sourceName, settledResult) {
  if (settledResult.status === "fulfilled") {
    return {
      status: "ok",
      ...settledResult.value,
    };
  }

  const message = settledResult.reason instanceof Error
    ? settledResult.reason.message
    : String(settledResult.reason);

  return {
    status: "error",
    source: sourceName,
    error: truncateText(sanitizeText(message), 280),
  };
}

export async function collectSnapshot(options) {
  const [nyc, london] = await Promise.allSettled([
    getNycSubwayDelays(options),
    getLondonTubeDelays(options),
  ]);

  return {
    generated_at: new Date().toISOString(),
    nyc_subway: toResultState("MTA GTFS-RT alerts", nyc),
    london_tube: toResultState("TfL line status", london),
  };
}

function renderNycSection(state) {
  const lines = [];
  lines.push("NYC Subway (MTA)");

  if (state.status === "error") {
    lines.push(`  Error: ${state.error}`);
    return lines.join("\n");
  }

  if (Number.isFinite(state.feed_timestamp)) {
    lines.push(`  Feed timestamp: ${formatEpochSeconds(state.feed_timestamp)}`);
  }

  if (!state.delays.length) {
    lines.push("  No active subway delays found.");
    return lines.join("\n");
  }

  lines.push(`  Active delays: ${state.delays.length}`);
  for (let index = 0; index < state.delays.length; index += 1) {
    const row = state.delays[index];
    const routeLabel = row.routes.length ? row.routes.join(", ") : "Unknown route";
    lines.push(`  ${index + 1}. [${routeLabel}] ${row.summary}`);
    if (row.reason) lines.push(`     Reason: ${row.reason}`);
    if (row.effect) lines.push(`     Effect: ${row.effect}`);
    if (Number.isFinite(row.starts_at)) lines.push(`     Started: ${formatEpochSeconds(row.starts_at)}`);
    if (Number.isFinite(row.ends_at)) lines.push(`     Ends: ${formatEpochSeconds(row.ends_at)}`);
  }

  return lines.join("\n");
}

function renderTubeSection(state) {
  const lines = [];
  lines.push("London Tube (TfL)");

  if (state.status === "error") {
    lines.push(`  Error: ${state.error}`);
    return lines.join("\n");
  }

  if (!state.delays.length) {
    lines.push("  No active tube delays found.");
    return lines.join("\n");
  }

  lines.push(`  Active delays: ${state.delays.length}`);
  for (let index = 0; index < state.delays.length; index += 1) {
    const row = state.delays[index];
    lines.push(`  ${index + 1}. ${row.line} - ${row.status}`);
    if (row.reason) lines.push(`     Reason: ${row.reason}`);
  }

  return lines.join("\n");
}

function renderText(snapshot, options) {
  const lines = [];
  lines.push(`Transit Delay Board (${new Date(snapshot.generated_at).toLocaleString()})`);
  lines.push("");
  lines.push(renderNycSection(snapshot.nyc_subway));
  lines.push("");
  lines.push(renderTubeSection(snapshot.london_tube));

  if (options.watch) {
    lines.push("");
    lines.push(`Refreshes every ${options.intervalSeconds} seconds. Press Ctrl+C to stop.`);
  }

  return lines.join("\n");
}

async function run(options) {
  if (options.watch) {
    while (true) {
      const snapshot = await collectSnapshot(options);

      if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        process.stdout.write("\x1Bc");
        console.log(renderText(snapshot, options));
      }

      await sleep(options.intervalSeconds * 1000);
    }
  }

  const snapshot = await collectSnapshot(options);

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(renderText(snapshot, options));
  }

  if (snapshot.nyc_subway.status === "error" || snapshot.london_tube.status === "error") {
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run with --help for usage.");
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    return;
  }

  options.timeoutMs = parseInteger(process.env.FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  await run(options);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isMainModule()) {
  await main();
}
