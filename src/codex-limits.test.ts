import { describe, test, expect } from "bun:test"
import {
    CODEX_DEFAULT_GRACE_MS,
    evaluateCodexLimits,
    formatDuration,
    matchesUsageLimitMessage,
    parseCodexAuth,
    parseCodexUsage,
    pickDecidingWindow,
    planResume,
    toEpochMs,
} from "./codex-limits"

const NOW = 1_793_260_000_000

function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        plan_type: "plus",
        rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: {
                used_percent: 100,
                limit_window_seconds: 18000,
                reset_after_seconds: 1872,
                reset_at: 1_793_263_935,
            },
            secondary_window: {
                used_percent: 76,
                limit_window_seconds: 604800,
                reset_after_seconds: 512131,
                reset_at: 1_793_774_195,
            },
        },
        rate_limit_reset_credits: { available_count: 2, applicable_available_count: 2 },
        ...overrides,
    }
}

describe("codex-limits: payload parsing", () => {
    test("parses the documented payload shape", () => {
        const snapshot = parseCodexUsage(usagePayload(), NOW)
        expect(snapshot).not.toBeNull()
        expect(snapshot!.planType).toBe("plus")
        expect(snapshot!.limitReached).toBe(true)
        expect(snapshot!.windows.map((w) => w.name)).toEqual(["primary", "secondary"])
        expect(snapshot!.windows[0].usedPercent).toBe(100)
        expect(snapshot!.windows[0].resetAtMs).toBe(1_793_263_935_000)
        expect(snapshot!.resetCredits).toBe(2)
    })

    test("derives reset time from reset_after_seconds when reset_at is missing", () => {
        const payload = usagePayload()
        const primary = (payload.rate_limit as any).primary_window
        delete primary.reset_at
        primary.reset_after_seconds = 600

        const snapshot = parseCodexUsage(payload, NOW)!
        expect(snapshot.windows[0].resetAtMs).toBeNull()
        expect(snapshot.windows[0].effectiveResetMs).toBe(NOW + 600_000)
    })

    test("returns null when rate_limit is absent", () => {
        expect(parseCodexUsage({ plan_type: "plus" }, NOW)).toBeNull()
        expect(parseCodexUsage("nope", NOW)).toBeNull()
    })
})

describe("codex-limits: window selection", () => {
    test("chooses the exhausted window, not the merely-used one", () => {
        const snapshot = parseCodexUsage(usagePayload(), NOW)!
        expect(pickDecidingWindow(snapshot)?.name).toBe("primary")
    })

    test("takes the latest reset when several windows are exhausted", () => {
        const payload = usagePayload()
        ;(payload.rate_limit as any).secondary_window.used_percent = 100
        const snapshot = parseCodexUsage(payload, NOW)!
        expect(pickDecidingWindow(snapshot)?.name).toBe("secondary")
    })

    test("no wait when the limit is not reached", () => {
        const payload = usagePayload()
        const rateLimit = payload.rate_limit as any
        rateLimit.allowed = true
        rateLimit.limit_reached = false
        rateLimit.primary_window.used_percent = 12
        const snapshot = parseCodexUsage(payload, NOW)!
        const plan = planResume(snapshot, NOW)
        expect(plan.resumeAtMs).toBeNull()
        expect(plan.resetAtMs).toBeNull()
    })
})

describe("codex-limits: resume planning", () => {
    test("resumes one grace period after the reset", () => {
        const snapshot = parseCodexUsage(usagePayload(), NOW)!
        const plan = planResume(snapshot, NOW, CODEX_DEFAULT_GRACE_MS)
        expect(plan.resetAtMs).toBe(1_793_263_935_000)
        expect(plan.resumeAtMs).toBe(1_793_263_935_000 + 60_000)
        expect(plan.decidingWindow).toBe("primary")
    })

    test("honours a custom grace period", () => {
        const snapshot = parseCodexUsage(usagePayload(), NOW)!
        const plan = planResume(snapshot, NOW, 5_000)
        expect(plan.resumeAtMs).toBe(1_793_263_935_000 + 5_000)
    })

    test("model availability later than the window reset wins", () => {
        const payload = usagePayload({
            model_usage: { "gpt-6-astra": { available_at: 1_793_300_000 } },
        })
        const snapshot = parseCodexUsage(payload, NOW)!
        const plan = planResume(snapshot, NOW, 60_000, "gpt-6-astra")
        expect(plan.resetAtMs).toBe(1_793_300_000_000)
        expect(plan.resumeAtMs).toBe(1_793_300_000_000 + 60_000)
    })

    test("never schedules in the past when the reset already happened", () => {
        const snapshot = parseCodexUsage(usagePayload(), NOW)!
        snapshot.windows[0].effectiveResetMs = NOW - 10 * 60_000
        const plan = planResume(snapshot, NOW, 60_000)
        expect(plan.resumeAtMs).toBe(NOW + 1_000)
    })

    test("returns no resume moment when the reset is unknown", () => {
        const snapshot = parseCodexUsage(usagePayload(), NOW)!
        snapshot.windows[0].effectiveResetMs = null
        snapshot.windows = [snapshot.windows[0]]
        const plan = planResume(snapshot, NOW, 60_000)
        expect(plan.resumeAtMs).toBeNull()
    })
})

describe("codex-limits: HTTP client", () => {
    const auth = { accessToken: "token-1", accountId: "acc-1" }

    function jsonResponse(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        })
    }

    test("returns a parsed evaluation on 200", async () => {
        const result = await evaluateCodexLimits({
            auth,
            now: NOW,
            fetchImpl: (async () => jsonResponse(usagePayload())) as unknown as typeof fetch,
        })
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.limitReached).toBe(true)
        expect(result.resumeAtMs).toBe(1_793_263_935_000 + 60_000)
        expect(result.decidingWindow).toBe("primary")
    })

    test("sends the ChatGPT auth headers", async () => {
        let seen: { url: string; headers: Record<string, string> } | null = null
        await evaluateCodexLimits({
            auth,
            now: NOW,
            fetchImpl: (async (url: string, init: RequestInit) => {
                seen = { url: String(url), headers: init.headers as Record<string, string> }
                return jsonResponse(usagePayload())
            }) as unknown as typeof fetch,
        })
        expect(seen!.url).toContain("/backend-api/wham/usage")
        expect(seen!.headers.Authorization).toBe("Bearer token-1")
        expect(seen!.headers["chatgpt-account-id"]).toBe("acc-1")
    })

    test("maps 401 to auth-invalid", async () => {
        const result = await evaluateCodexLimits({
            auth,
            now: NOW,
            fetchImpl: (async () => new Response("expired", { status: 401 })) as unknown as typeof fetch,
        })
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.reason).toBe("auth-invalid")
    })

    test("maps a non-JSON body to bad-response", async () => {
        const result = await evaluateCodexLimits({
            auth,
            now: NOW,
            fetchImpl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
        })
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.reason).toBe("bad-response")
    })

    test("maps a thrown fetch to network", async () => {
        const result = await evaluateCodexLimits({
            auth,
            now: NOW,
            fetchImpl: (async () => {
                throw new Error("ECONNRESET")
            }) as unknown as typeof fetch,
        })
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.reason).toBe("network")
    })

    test("maps a missing auth payload to auth-missing", async () => {
        const result = await evaluateCodexLimits({ auth: null, now: NOW })
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.reason).toBe("auth-missing")
    })
})

describe("codex-limits: helpers", () => {
    test("parses auth.json tokens", () => {
        expect(parseCodexAuth({ tokens: { access_token: "abc", account_id: "acc" } })).toEqual({
            accessToken: "abc",
            accountId: "acc",
        })
        expect(parseCodexAuth({ tokens: {} })).toBeNull()
        expect(parseCodexAuth(null)).toBeNull()
    })

    test("epoch conversion keeps millisecond values intact", () => {
        expect(toEpochMs(1_793_263_935)).toBe(1_793_263_935_000)
        expect(toEpochMs(1_793_263_935_000)).toBe(1_793_263_935_000)
        expect(toEpochMs(0)).toBeNull()
        expect(toEpochMs("oops")).toBeNull()
    })

    test("matches the ChatGPT limit signature", () => {
        expect(matchesUsageLimitMessage("The usage limit has been reached")).toBe(true)
        expect(matchesUsageLimitMessage("You've hit your usage limit. Try later.")).toBe(true)
        expect(matchesUsageLimitMessage("429 rate limited but under usage limit")).toBe(true)
        expect(matchesUsageLimitMessage("streaming response failed")).toBe(false)
    })

    test("formats durations for logs", () => {
        expect(formatDuration(45_000)).toBe("45s")
        expect(formatDuration(31 * 60_000)).toBe("31m")
        expect(formatDuration(5 * 3_600_000 + 5 * 60_000)).toBe("5h 5m")
        expect(formatDuration(2 * 86_400_000)).toBe("2d")
    })
})
