import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

describe("REGRESSION: non-Plugin exports crash OpenCode host", () => {
    test("plugin source must NOT export isStreamingFailure as a top-level export", () => {
        expect(
            SOURCE,
            "isStreamingFailure must not be a top-level export — OpenCode's plugin loader calls every export as a Plugin entrypoint, and non-Plugin functions return non-Hooks values that crash Provider.list with 'null is not an object (evaluating N.config)'",
        ).not.toMatch(/^export\s+(function|const)\s+isStreamingFailure/m)
    })

    test("plugin source must NOT export getLastAssistantError as a top-level export", () => {
        expect(
            SOURCE,
            "getLastAssistantError must not be a top-level export — it returns null when called with (ctx, options) instead of (messages), and null.config throws",
        ).not.toMatch(/^export\s+(function|const)\s+getLastAssistantError/m)
    })

    test("plugin source must NOT export backoffMs as a top-level export", () => {
        expect(
            SOURCE,
            "backoffMs must not be a top-level export — it returns a number when called as a Plugin, not a Hooks object",
        ).not.toMatch(/^export\s+(function|const)\s+backoffMs/m)
    })

    test("plugin source must NOT export buildOpenTodosReminder as a top-level export", () => {
        expect(
            SOURCE,
            "buildOpenTodosReminder must not be a top-level export — it returns a string when called as a Plugin, not a Hooks object",
        ).not.toMatch(/^export\s+(function|const)\s+buildOpenTodosReminder/m)
    })

    test("plugin source must export AutoResumePlugin (the real Plugin)", () => {
        expect(SOURCE).toMatch(/^export\s+const\s+AutoResumePlugin/m)
    })

    test("plugin source must have a default export", () => {
        expect(SOURCE).toMatch(/^export\s+default\s+AutoResumePlugin/m)
    })
})

describe("REGRESSION: bundled dist must only export Plugin-shaped values (no null/string/number returns)", () => {
    test("every export from the built dist returns an object (Hooks) when called, never null/string/number", async () => {
        const mod = await import("./index")
        const fakeCtx: any = {
            client: {
                app: { log: async () => {} },
                session: {
                    list: async () => ({ data: [] }),
                    status: async () => ({ data: {} }),
                    messages: async () => [],
                    prompt: async () => ({}),
                    abort: async () => ({}),
                },
            },
            ui: { toast: async () => {} },
        }

        for (const [name, fn] of Object.entries(mod)) {
            if (typeof fn !== "function") {
                throw new Error(`Export "${name}" is not a function (got ${typeof fn})`)
            }
            const result = await (fn as Function)(fakeCtx, {})
            if (result === null) {
                throw new Error(
                    `REGRESSION BROKEN: export "${name}" returned null when called as Plugin. ` +
                    `OpenCode's loader would push this null into the plugin array, then crash at null.config?.(U) ` +
                    `with "null is not an object (evaluating 'N.config')".`,
                )
            }
            if (typeof result !== "object") {
                throw new Error(
                    `Export "${name}" returned ${typeof result} (not an object). ` +
                    `OpenCode's loader expects every export to be a Plugin returning a Hooks object.`,
                )
            }
        }
    })
})
