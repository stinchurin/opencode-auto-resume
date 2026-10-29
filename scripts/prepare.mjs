#!/usr/bin/env node
/**
 * Build `dist/` during `npm install` of this package from git.
 *
 * npm runs `prepare` for git dependencies, so without this the installed
 * package has no `dist/index.js` (it is generated, not committed) and the
 * opencode plugin loader fails with "cannot find module". When `bun` is not
 * on PATH the build is skipped and the committed `dist/` is used instead, so
 * installation never hard-fails on a missing build tool.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const bun = spawnSync("bun", ["--version"], { stdio: "ignore", shell: process.platform === "win32" })

if (bun.status !== 0) {
    const fallback = join(root, "dist", "index.js")
    if (existsSync(fallback)) {
        console.warn("[opencode-auto-resume] bun not found: using committed dist/")
    } else {
        console.warn("[opencode-auto-resume] bun not found and dist/ is missing: plugin will not load")
    }
    process.exit(0)
}

const build = spawnSync("bun", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
})
process.exit(build.status ?? 1)
