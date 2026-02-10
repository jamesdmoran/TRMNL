import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRMNL_WEBHOOK_URL = process.env.TRMNL_WEBHOOK_URL_ARBORISM;
const TIMEZONE = process.env.TIMEZONE ?? "America/Chicago";
const FACTS_FILE = process.env.FACTS_FILE ?? "../data/arborism_facts.json";
const FACT_OFFSET = Number.parseInt(process.env.FACT_OFFSET ?? "0", 10);
const DRY_RUN = (process.env.DRY_RUN ?? "").toLowerCase() === "true";

if (!TRMNL_WEBHOOK_URL && !DRY_RUN) {
  console.error(
    "Missing webhook env TRMNL_WEBHOOK_URL_ARBORISM."
  );
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function truncateText(value, maxChars) {
  if (typeof value !== "string") return value;
  if (maxChars <= 1) return value.slice(0, 1);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}...`;
}

function toInt(value, fallback = 0) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function todayIso(timeZone) {
  return new Date().toLocaleDateString("en-CA", { timeZone });
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

function isoToEpochDay(isoDate) {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Could not parse date key: ${isoDate}`);
  }
  return Math.floor(dt.getTime() / 86_400_000);
}

function ensureString(value, fieldName, index) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Fact ${index + 1} is missing required field '${fieldName}'.`);
  }
  return value.trim();
}

function normalizeFact(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Fact ${index + 1} must be an object.`);
  }

  return {
    topic: truncateText(ensureString(raw.topic, "topic", index), 44),
    fact: truncateText(ensureString(raw.fact, "fact", index), 320),
    exam_tip: truncateText(ensureString(raw.exam_tip, "exam_tip", index), 220),
    memory_hook: truncateText(ensureString(raw.memory_hook, "memory_hook", index), 140),
  };
}

async function loadFacts(factsFile) {
  const resolvedPath = path.isAbsolute(factsFile)
    ? factsFile
    : path.resolve(scriptDir, factsFile);

  const rawText = await readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(rawText);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Facts file must contain a non-empty array: ${resolvedPath}`);
  }

  const facts = parsed.map(normalizeFact);
  return { facts, resolvedPath };
}

function pickFactForToday(facts, timeZone, offset) {
  const dateKey = todayIso(timeZone);
  const day = isoToEpochDay(dateKey);
  const offsetValue = toInt(offset, 0);
  const index = mod(day + offsetValue, facts.length);

  return {
    dateKey,
    index,
    fact: facts[index],
  };
}

async function postToTrmnl(mergeVariables) {
  if (DRY_RUN) {
    console.log("DRY_RUN=true. Would POST merge variables to TRMNL:");
    console.log(JSON.stringify(mergeVariables, null, 2));
    return;
  }

  const response = await fetch(TRMNL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge_variables: mergeVariables }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `TRMNL webhook POST failed: HTTP ${response.status} ${response.statusText} :: ${truncateText(body, 200)}`
    );
  }

  console.log("Posted to TRMNL successfully.");
}

async function main() {
  const updatedAtLocal = formatDateTimeNow(TIMEZONE);

  let mergeVariables;
  try {
    const { facts, resolvedPath } = await loadFacts(FACTS_FILE);
    const selection = pickFactForToday(facts, TIMEZONE, FACT_OFFSET);

    mergeVariables = {
      status: "ok",
      app_title: "Arborism Exam Fact",
      updated_at_local: updatedAtLocal,
      date_key: selection.dateKey,
      fact: {
        index: selection.index + 1,
        total: facts.length,
        topic: selection.fact.topic,
        fact: selection.fact.fact,
        exam_tip: selection.fact.exam_tip,
        memory_hook: selection.fact.memory_hook,
      },
      source: {
        mode: "local_fact_bank",
        path: resolvedPath,
        offset: toInt(FACT_OFFSET, 0),
      },
    };
  } catch (error) {
    mergeVariables = {
      status: "error",
      app_title: "Arborism Exam Fact",
      updated_at_local: updatedAtLocal,
      error: truncateText(error instanceof Error ? error.message : String(error), 220),
      fact: {
        index: 0,
        total: 0,
        topic: "Unavailable",
        fact: "Could not load a study fact.",
        exam_tip: "Check script logs and the facts file.",
        memory_hook: "Fix data source and retry.",
      },
      source: {
        mode: "local_fact_bank",
        path: FACTS_FILE,
        offset: toInt(FACT_OFFSET, 0),
      },
    };

    console.error("ERROR:", mergeVariables.error);
  }

  await postToTrmnl(mergeVariables);

  if (mergeVariables.status !== "ok") {
    process.exitCode = 1;
  }
}

await main();
