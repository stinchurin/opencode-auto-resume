#!/usr/bin/env node

// src/codex-limits.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
var CODEX_DEFAULT_AUTH_PATH = join(homedir(), ".codex", "auth.json");
var CODEX_DEFAULT_GRACE_MS = 60000;
var CODEX_DEFAULT_TIMEOUT_MS = 1e4;
var CODEX_DEFAULT_USER_AGENT = "codex-cli/1.0.0";
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return null;
}
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return null;
}
function toEpochMs(value) {
  const raw = asNumber(value);
  if (raw === null || raw <= 0)
    return null;
  return raw > 1000000000000 ? Math.round(raw) : Math.round(raw * 1000);
}
function parseWindow(name, raw) {
  const record = asRecord(raw);
  if (!record)
    return null;
  const resetAtMs = toEpochMs(record.reset_at);
  const resetAfterSeconds = asNumber(record.reset_after_seconds);
  return {
    name,
    usedPercent: asNumber(record.used_percent),
    limitWindowSeconds: asNumber(record.limit_window_seconds),
    resetAtMs,
    resetAfterMs: resetAfterSeconds === null ? null : resetAfterSeconds,
    effectiveResetMs: resetAtMs
  };
}
function parseCodexUsage(raw, now = Date.now()) {
  const root = asRecord(raw);
  if (!root)
    return null;
  const rateLimit = asRecord(root.rate_limit);
  if (!rateLimit)
    return null;
  const windows = [];
  const primary = parseWindow("primary", rateLimit.primary_window);
  if (primary)
    windows.push(primary);
  const secondary = parseWindow("secondary", rateLimit.secondary_window);
  if (secondary)
    windows.push(secondary);
  for (const window of windows) {
    if (window.effectiveResetMs === null && window.resetAfterMs !== null) {
      window.effectiveResetMs = now + Math.round(window.resetAfterMs * 1000);
    }
  }
  const modelUsage = {};
  const rawModelUsage = asRecord(root.model_usage);
  if (rawModelUsage) {
    for (const [model, value] of Object.entries(rawModelUsage)) {
      const record = asRecord(value);
      if (!record)
        continue;
      modelUsage[model] = {
        availableAtMs: toEpochMs(record.available_at ?? record.available_at_ms)
      };
    }
  }
  const limitReached = rateLimit.limit_reached === true || rateLimit.allowed === false;
  const resetCredits = asNumber(asRecord(root.rate_limit_reset_credits)?.available_count);
  return {
    planType: typeof root.plan_type === "string" ? root.plan_type : null,
    allowed: rateLimit.allowed !== false,
    limitReached,
    windows,
    modelUsage,
    resetCredits,
    fetchedAt: now
  };
}
function pickDecidingWindow(snapshot) {
  const withReset = snapshot.windows.filter((w) => w.effectiveResetMs !== null);
  const exhausted = withReset.filter((w) => (w.usedPercent ?? 0) >= 100);
  if (exhausted.length > 0) {
    return exhausted.reduce((a, b) => (b.effectiveResetMs ?? 0) > (a.effectiveResetMs ?? 0) ? b : a);
  }
  if (snapshot.limitReached && withReset.length > 0) {
    return withReset.reduce((a, b) => (b.effectiveResetMs ?? 0) > (a.effectiveResetMs ?? 0) ? b : a);
  }
  return null;
}
function planResume(snapshot, now, graceMs = CODEX_DEFAULT_GRACE_MS, modelId) {
  const deciding = pickDecidingWindow(snapshot);
  let resetAtMs = deciding?.effectiveResetMs ?? null;
  if (modelId) {
    const modelAvailableAt = snapshot.modelUsage[modelId]?.availableAtMs ?? null;
    if (modelAvailableAt !== null && modelAvailableAt > now) {
      resetAtMs = Math.max(resetAtMs ?? 0, modelAvailableAt);
    }
  }
  if (!snapshot.limitReached || resetAtMs === null) {
    return {
      resetAtMs: snapshot.limitReached ? resetAtMs : null,
      resumeAtMs: null,
      decidingWindow: deciding?.name ?? null,
      graceMs
    };
  }
  const resumeAtMs = Math.max(now + 1000, resetAtMs + graceMs);
  return {
    resetAtMs,
    resumeAtMs,
    decidingWindow: deciding?.name ?? null,
    graceMs
  };
}
function parseCodexAuth(raw) {
  const root = asRecord(raw);
  if (!root)
    return null;
  const tokens = asRecord(root.tokens) ?? root;
  const accessToken = tokens.access_token ?? root.access_token ?? null;
  if (typeof accessToken !== "string" || accessToken.trim() === "")
    return null;
  const accountId = tokens.account_id ?? root.account_id ?? null;
  return {
    accessToken: accessToken.trim(),
    accountId: typeof accountId === "string" && accountId.trim() !== "" ? accountId.trim() : null
  };
}
function readCodexAuth(authPath) {
  const path = authPath ?? process.env.CODEX_AUTH_PATH ?? CODEX_DEFAULT_AUTH_PATH;
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "auth-missing",
      message: `cannot read Codex auth file ${path}: ${message}`
    };
  }
  const auth = parseCodexAuth(payload);
  if (!auth) {
    return {
      ok: false,
      reason: "auth-missing",
      message: `no tokens.access_token in ${path}`
    };
  }
  return auth;
}
function isAuthError(value) {
  return typeof value === "object" && value !== null && value.ok === false;
}
async function evaluateCodexLimits(options = {}) {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? CODEX_DEFAULT_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const url = process.env.CODEX_USAGE_URL ?? CODEX_USAGE_URL;
  const rawAuth = options.auth === undefined ? readCodexAuth(options.authPath) : options.auth;
  if (rawAuth === null) {
    return { ok: false, reason: "auth-missing", message: "no Codex credentials available" };
  }
  if (isAuthError(rawAuth))
    return rawAuth;
  const auth = {
    accessToken: rawAuth.accessToken,
    accountId: rawAuth.accountId ?? null
  };
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "User-Agent": process.env.CODEX_CLI_USER_AGENT ?? CODEX_DEFAULT_USER_AGENT
  };
  if (auth.accountId)
    headers["chatgpt-account-id"] = auth.accountId;
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      reason: aborted ? "timeout" : "network",
      message: aborted ? `usage request timed out after ${timeoutMs}ms` : message
    };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const reason = response.status === 401 || response.status === 403 ? "auth-invalid" : "http-error";
    return {
      ok: false,
      reason,
      status: response.status,
      message: `usage endpoint returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "bad-response", message: `usage response is not JSON: ${message}` };
  }
  const snapshot = parseCodexUsage(payload, now);
  if (!snapshot) {
    return {
      ok: false,
      reason: "bad-response",
      message: "usage response has no rate_limit object"
    };
  }
  const plan = planResume(snapshot, now, graceMs, options.modelId ?? null);
  return {
    ok: true,
    snapshot,
    limitReached: snapshot.limitReached,
    resetAtMs: plan.resetAtMs,
    resumeAtMs: plan.resumeAtMs,
    decidingWindow: plan.decidingWindow,
    graceMs
  };
}
function formatDuration(ms) {
  if (!Number.isFinite(ms))
    return "?";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds % 86400 / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0)
    parts.push(`${days}d`);
  if (hours > 0)
    parts.push(`${hours}h`);
  if (minutes > 0 && days === 0)
    parts.push(`${minutes}m`);
  if (parts.length === 0)
    parts.push(`${seconds}s`);
  return parts.join(" ");
}
function formatLocalTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// src/codex-limits-cli.ts
function parseArgs(argv) {
  const args = {
    json: false,
    modelId: null,
    authPath: undefined,
    graceMs: CODEX_DEFAULT_GRACE_MS,
    timeoutMs: CODEX_DEFAULT_TIMEOUT_MS,
    help: false
  };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--model":
        args.modelId = argv[++i] ?? null;
        break;
      case "--auth":
        args.authPath = argv[++i];
        break;
      case "--grace": {
        const seconds = Number(argv[++i]);
        if (Number.isFinite(seconds) && seconds >= 0)
          args.graceMs = seconds * 1000;
        break;
      }
      case "--timeout": {
        const ms = Number(argv[++i]);
        if (Number.isFinite(ms) && ms > 0)
          args.timeoutMs = ms;
        break;
      }
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
    }
  }
  return args;
}
var HELP = `codex-limits — ChatGPT/Codex usage limit checker

Options:
  --json             print machine-readable JSON (used by opencode-auto-resume)
  --model <id>       consult model_usage.<id>.available_at for this model
  --auth <path>      path to Codex auth.json (default: ~/.codex/auth.json)
  --grace <seconds>  extra wait after reset before resuming (default: 60)
  --timeout <ms>     HTTP timeout (default: 10000)
  -h, --help         show this help

Exit codes:
  0 limits available now
  3 limit reached, resume_at known
  4 limit reached, resume_at unknown
  1 failure (auth/network/format)
`;
function describeWindow(used, seconds) {
  if (seconds === null)
    return used === null ? "n/a" : `${used}%`;
  const hours = seconds / 3600;
  const label = hours >= 168 ? "7d" : hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(seconds)}s`;
  return `${label} ${used === null ? "?" : `${used}%`}`;
}
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 1;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const result = await evaluateCodexLimits({
    authPath: args.authPath,
    modelId: args.modelId,
    graceMs: args.graceMs,
    timeoutMs: args.timeoutMs
  });
  if (!result.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, reason: result.reason, message: result.message, status: result.status ?? null }, null, 2));
    } else {
      console.error(`codex-limits: ${result.reason}: ${result.message}`);
    }
    return 1;
  }
  const now = Date.now();
  const snapshot = result.snapshot;
  const waitMs = result.resumeAtMs === null ? null : Math.max(0, result.resumeAtMs - now);
  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      plan_type: snapshot.planType,
      allowed: snapshot.allowed,
      limit_reached: snapshot.limitReached,
      windows: snapshot.windows.map((w) => ({
        name: w.name,
        used_percent: w.usedPercent,
        limit_window_seconds: w.limitWindowSeconds,
        reset_at: w.effectiveResetMs === null ? null : Math.round(w.effectiveResetMs / 1000),
        reset_at_iso: w.effectiveResetMs === null ? null : new Date(w.effectiveResetMs).toISOString()
      })),
      reset_credits: snapshot.resetCredits,
      deciding_window: result.decidingWindow,
      reset_at: result.resetAtMs === null ? null : Math.round(result.resetAtMs / 1000),
      reset_at_local: result.resetAtMs === null ? null : formatLocalTime(result.resetAtMs),
      resume_at: result.resumeAtMs === null ? null : Math.round(result.resumeAtMs / 1000),
      resume_at_local: result.resumeAtMs === null ? null : formatLocalTime(result.resumeAtMs),
      resume_in_seconds: waitMs === null ? null : Math.round(waitMs / 1000),
      grace_seconds: Math.round(result.graceMs / 1000),
      fetched_at: new Date(snapshot.fetchedAt).toISOString()
    }, null, 2));
  } else {
    const status = snapshot.limitReached ? "LIMIT REACHED" : "available";
    const windows = snapshot.windows.map((w) => `${w.name} ${describeWindow(w.usedPercent, w.limitWindowSeconds)}`).join(", ");
    console.log(`plan:    ${snapshot.planType ?? "unknown"}`);
    console.log(`status:  ${status}${windows ? ` (${windows})` : ""}`);
    if (result.resetAtMs !== null) {
      console.log(`reset:   ${formatLocalTime(result.resetAtMs)}${result.decidingWindow ? ` [${result.decidingWindow}]` : ""}`);
    }
    if (result.resumeAtMs !== null && waitMs !== null) {
      console.log(`resume:  ${formatLocalTime(result.resumeAtMs)} (+${Math.round(result.graceMs / 1000)}s, in ${formatDuration(waitMs)})`);
    } else if (snapshot.limitReached) {
      console.log("resume:  unknown — poll again later");
    }
    if (snapshot.resetCredits !== null) {
      console.log(`credits: ${snapshot.resetCredits} manual reset(s) available`);
    }
  }
  if (!snapshot.limitReached)
    return 0;
  return result.resumeAtMs === null ? 4 : 3;
}
main().then((code) => {
  process.exitCode = code;
}, (error) => {
  console.error(`codex-limits: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
