import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TRMNL_WEBHOOK_URL = process.env.TRMNL_WEBHOOK_URL_WTA_SCORES;
const TIMEZONE = process.env.TIMEZONE ?? "America/Chicago";
const WTA_TENNIS_API_BASE =
  process.env.WTA_TENNIS_API_BASE ?? "https://api.wtatennis.com/tennis";
const DRY_RUN = (process.env.DRY_RUN ?? "").toLowerCase() === "true";
const execFileAsync = promisify(execFile);

const LOOKBACK_DAYS = toPositiveInt(process.env.WTA_LOOKBACK_DAYS, 1);
const LOOKAHEAD_DAYS = toPositiveInt(process.env.WTA_LOOKAHEAD_DAYS, 6);
const MAX_SCORE_MATCHES = toPositiveInt(process.env.WTA_MAX_SCORE_MATCHES, 4);
const MAX_NEXT_MATCHES = toPositiveInt(process.env.WTA_MAX_NEXT_MATCHES, 6);

if (!TRMNL_WEBHOOK_URL && !DRY_RUN) {
  console.error("Missing webhook env TRMNL_WEBHOOK_URL_WTA_SCORES.");
  process.exit(2);
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function todayIso(timeZone) {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

function addDaysIso(isoDate, days) {
  const dt = new Date(`${isoDate}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
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

function formatLocalDateTime(value, timeZone) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "TBD";

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

function formatLocalTime(value, timeZone) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "TBD";

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

function getTimeZoneAbbrev(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date());

  const part = parts.find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function matchTimeMs(value) {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? Number.POSITIVE_INFINITY : dt.getTime();
}

function isPlaceholderTime(value) {
  return typeof value === "string" && /T23:59(?::\d{2})?/.test(value);
}

function levelPriority(levelRaw) {
  const level = cleanString(levelRaw).toUpperCase();

  if (level.includes("GRAND SLAM")) return 100;
  if (level.includes("WTA FINALS")) return 95;
  if (level.includes("WTA 1000")) return 90;
  if (level.includes("WTA 500")) return 80;
  if (level.includes("WTA 250")) return 70;
  if (level.includes("WTA 125")) return 60;
  if (level.includes("OLYMPIC")) return 60;

  return 20;
}

function tournamentStatusPriority(statusRaw) {
  const status = cleanString(statusRaw).toLowerCase();

  if (status === "live") return 3;
  if (status === "inprogress") return 2;
  if (status === "upcoming" || status === "future") return 1;
  return 0;
}

function normalizeTournamentStatus(statusRaw) {
  const status = cleanString(statusRaw).toLowerCase();
  if (status === "live") return "Live";
  if (status === "inprogress") return "In Progress";
  if (status === "future" || status === "upcoming") return "Upcoming";
  if (status === "past") return "Finished";
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
}

function buildPlayerName(first, last) {
  const full = [cleanString(first), cleanString(last)].filter(Boolean).join(" ");
  return full || "TBD";
}

function buildMatchup(match) {
  const sideA = buildPlayerName(match.PlayerNameFirstA, match.PlayerNameLastA);
  const sideB = buildPlayerName(match.PlayerNameFirstB, match.PlayerNameLastB);
  return truncateText(`${sideA} vs ${sideB}`, 66);
}

function coerceScorePart(value) {
  const text = cleanString(value);
  return text || null;
}

function buildSetScoreLine(match) {
  const sets = [];

  for (let i = 1; i <= 5; i += 1) {
    const a = coerceScorePart(match[`ScoreSet${i}A`]);
    const b = coerceScorePart(match[`ScoreSet${i}B`]);

    if (!a || !b) continue;

    const tb = coerceScorePart(match[`ScoreTbSet${i}`]);
    if (tb) {
      sets.push(`${a}-${b}(${tb})`);
    } else {
      sets.push(`${a}-${b}`);
    }
  }

  if (sets.length) {
    return sets.join(" ");
  }

  const scoreString = cleanString(match.ScoreString);
  if (scoreString) return scoreString;

  return "";
}

function buildPointLine(match) {
  const pointA = cleanString(match.PointA);
  const pointB = cleanString(match.PointB);
  if (!pointA || !pointB) return "";
  if (pointA === "0" && pointB === "0") return "";
  return `${pointA}-${pointB}`;
}

function formatRound(match) {
  const roundName = cleanString(match.RoundName);
  if (roundName) return truncateText(roundName, 18);

  const roundId = cleanString(String(match.RoundID ?? ""));
  if (roundId) return `Round ${roundId}`;

  return "";
}

function isInProgressMatch(match) {
  return cleanString(match.MatchState).toUpperCase() === "P";
}

function isFinalMatch(match) {
  return cleanString(match.MatchState).toUpperCase() === "F";
}

function isUpcomingMatch(match) {
  return cleanString(match.MatchState).toUpperCase() === "U";
}

function stateLabel(match) {
  if (isInProgressMatch(match)) return "Live";
  if (isFinalMatch(match)) return "Final";
  if (isUpcomingMatch(match)) return "Upcoming";
  return "Match";
}

function dedupeByMatchId(matches) {
  const seen = new Set();
  const result = [];

  for (const match of matches) {
    const id = cleanString(match.MatchID);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(match);
  }

  return result;
}

async function fetchJson(path, params = {}) {
  const normalizedPath = String(path ?? "").replace(/^\/+/, "");
  const endpoint = new URL(normalizedPath, `${WTA_TENNIS_API_BASE.replace(/\/$/, "")}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    endpoint.searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `WTA API request failed (${response.status} ${response.statusText}) at ${endpoint} :: ${truncateText(body, 220)}`
      );
    }

    return response.json();
  } catch (fetchError) {
    // Fallback for restricted runtime environments where Node fetch DNS is blocked.
    try {
      const { stdout } = await execFileAsync("curl", [
        "-sS",
        "--fail",
        endpoint.toString(),
      ]);
      return JSON.parse(stdout);
    } catch (curlError) {
      const fetchMessage =
        fetchError instanceof Error ? fetchError.message : String(fetchError);
      const curlMessage = curlError instanceof Error ? curlError.message : String(curlError);
      throw new Error(
        `WTA API request failed via fetch and curl at ${endpoint}. fetch: ${truncateText(fetchMessage, 120)}; curl: ${truncateText(curlMessage, 120)}`
      );
    }
  }
}

function selectTournament(tournaments) {
  if (!Array.isArray(tournaments) || tournaments.length === 0) return null;

  const active = tournaments.filter((t) => {
    const status = cleanString(t?.status).toLowerCase();
    return status === "live" || status === "inprogress";
  });

  const notPast = tournaments.filter((t) => {
    const status = cleanString(t?.status).toLowerCase();
    return status !== "past" && status !== "completed";
  });

  const pool = active.length ? active : notPast.length ? notPast : tournaments;

  return [...pool].sort((a, b) => {
    const levelA = levelPriority(a?.tournamentGroup?.level ?? a?.level);
    const levelB = levelPriority(b?.tournamentGroup?.level ?? b?.level);
    if (levelA !== levelB) return levelB - levelA;

    const statusA = tournamentStatusPriority(a?.status);
    const statusB = tournamentStatusPriority(b?.status);
    if (statusA !== statusB) return statusB - statusA;

    const prizeA = Number(a?.prizeMoney ?? 0);
    const prizeB = Number(b?.prizeMoney ?? 0);
    if (prizeA !== prizeB) return prizeB - prizeA;

    const startA = Date.parse(`${cleanString(a?.startDate)}T00:00:00Z`) || 0;
    const startB = Date.parse(`${cleanString(b?.startDate)}T00:00:00Z`) || 0;
    return startB - startA;
  })[0];
}

function formatScoreMatches(matches, timeZone) {
  const singles = matches.filter((match) => cleanString(match.DrawMatchType).toUpperCase() === "S");
  const pool = singles.length ? singles : matches;

  const live = pool
    .filter(isInProgressMatch)
    .sort((a, b) => matchTimeMs(a.MatchTimeStamp) - matchTimeMs(b.MatchTimeStamp));

  const finals = pool
    .filter(isFinalMatch)
    .sort((a, b) => {
      const aTs = matchTimeMs(a.LastUpdated ?? a.MatchTimeStamp);
      const bTs = matchTimeMs(b.LastUpdated ?? b.MatchTimeStamp);
      return bTs - aTs;
    });

  const fallbackUpcoming = pool
    .filter(isUpcomingMatch)
    .sort((a, b) => matchTimeMs(a.MatchTimeStamp) - matchTimeMs(b.MatchTimeStamp));

  const picked = dedupeByMatchId([...live, ...finals, ...fallbackUpcoming]).slice(0, MAX_SCORE_MATCHES);

  return picked.map((match) => {
    const scoreLine = buildSetScoreLine(match);
    const points = buildPointLine(match);

    return {
      match_id: cleanString(match.MatchID),
      state: stateLabel(match),
      round: formatRound(match),
      players: buildMatchup(match),
      score: truncateText(scoreLine || (isUpcomingMatch(match) ? "Not started" : "In progress"), 38),
      points: truncateText(points, 12),
      updated_local: truncateText(formatLocalDateTime(match.LastUpdated ?? match.MatchTimeStamp, timeZone), 30),
    };
  });
}

function formatUpcomingMatches(matches, timeZone) {
  const singles = matches.filter((match) => cleanString(match.DrawMatchType).toUpperCase() === "S");
  const pool = singles.length ? singles : matches;

  const upcoming = pool
    .filter(isUpcomingMatch)
    .sort((a, b) => {
      const aPlaceholder = isPlaceholderTime(a.MatchTimeStamp);
      const bPlaceholder = isPlaceholderTime(b.MatchTimeStamp);
      if (aPlaceholder !== bPlaceholder) return aPlaceholder ? 1 : -1;
      return matchTimeMs(a.MatchTimeStamp) - matchTimeMs(b.MatchTimeStamp);
    })
    .slice(0, MAX_NEXT_MATCHES);

  return upcoming.map((match) => {
    const displayTime = isPlaceholderTime(match.MatchTimeStamp)
      ? "TBD"
      : formatLocalTime(match.MatchTimeStamp, timeZone);

    return {
      match_id: cleanString(match.MatchID),
      round: formatRound(match),
      players: buildMatchup(match),
      start_local: truncateText(displayTime, 24),
    };
  });
}

function buildTournamentSummary(tournament) {
  const title = cleanString(tournament?.title);
  const nameOnly = title.split(" - ")[0] || title;

  const city = cleanString(tournament?.city);
  const country = cleanString(tournament?.country);

  return {
    id: cleanString(String(tournament?.tournamentGroup?.id ?? "")),
    year: Number.parseInt(tournament?.year ?? "", 10) || 0,
    title: truncateText(title, 78),
    event_name: truncateText(nameOnly, 48),
    level: truncateText(cleanString(tournament?.tournamentGroup?.level ?? tournament?.level) || "WTA", 16),
    status: normalizeTournamentStatus(tournament?.status),
    location: truncateText([city, country].filter(Boolean).join(", "), 28),
    start_date: cleanString(tournament?.startDate),
    end_date: cleanString(tournament?.endDate),
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
      `TRMNL webhook POST failed: HTTP ${response.status} ${response.statusText} :: ${truncateText(body, 220)}`
    );
  }

  console.log("Posted to TRMNL successfully.");
}

async function main() {
  const nowIso = todayIso(TIMEZONE);
  const fromIso = addDaysIso(nowIso, -LOOKBACK_DAYS);
  const toIso = addDaysIso(nowIso, LOOKAHEAD_DAYS);
  const updatedAtLocal = formatDateTimeNow(TIMEZONE);
  const timezoneAbbrev = getTimeZoneAbbrev(TIMEZONE);

  let mergeVariables;

  try {
    const tournamentsResponse = await fetchJson("/tournaments/", {
      page: 0,
      pageSize: 80,
      excludeLevels: "ITF",
      from: fromIso,
      to: toIso,
    });

    const tournaments = Array.isArray(tournamentsResponse?.content)
      ? tournamentsResponse.content
      : [];

    if (!tournaments.length) {
      throw new Error(`No WTA tournaments returned for date range ${fromIso} to ${toIso}.`);
    }

    const tournament = selectTournament(tournaments);

    if (!tournament?.tournamentGroup?.id || !tournament?.year) {
      throw new Error("Could not determine an active WTA tournament.");
    }

    const tournamentId = tournament.tournamentGroup.id;
    const tournamentYear = tournament.year;

    const matchesResponse = await fetchJson(`/tournaments/${tournamentId}/${tournamentYear}/matches`, {
      from: fromIso,
      to: toIso,
    });

    const matches = Array.isArray(matchesResponse?.matches) ? matchesResponse.matches : [];
    if (!matches.length) {
      throw new Error(`No matches found for tournament ${tournamentId}/${tournamentYear}.`);
    }

    const tournamentSummary = buildTournamentSummary(tournament);
    const scoreMatches = formatScoreMatches(matches, TIMEZONE);
    const nextMatches = formatUpcomingMatches(matches, TIMEZONE);

    mergeVariables = {
      status: "ok",
      app_title: "WTA Tournament Scores",
      updated_at_local: updatedAtLocal,
      timezone: TIMEZONE,
      timezone_abbrev: timezoneAbbrev,
      tournament: tournamentSummary,
      score_matches: scoreMatches,
      next_matches: nextMatches,
      source: {
        provider: "WTA Tennis API",
        api_base: WTA_TENNIS_API_BASE,
        from_date: fromIso,
        to_date: toIso,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    mergeVariables = {
      status: "error",
      app_title: "WTA Tournament Scores",
      updated_at_local: updatedAtLocal,
      timezone: TIMEZONE,
      timezone_abbrev: timezoneAbbrev,
      error: truncateText(errorMessage, 220),
      tournament: {
        id: "",
        year: 0,
        title: "WTA data unavailable",
        event_name: "WTA Scores",
        level: "WTA",
        status: "Unavailable",
        location: "",
        start_date: "",
        end_date: "",
      },
      score_matches: [],
      next_matches: [],
      source: {
        provider: "WTA Tennis API",
        api_base: WTA_TENNIS_API_BASE,
        from_date: fromIso,
        to_date: toIso,
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
