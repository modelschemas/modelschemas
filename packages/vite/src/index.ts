/**
 * Vite plugin (PLAN.md task 12.4). Dev server (`serve`): pull whatever is
 * missing, then *report* upstream schema drift — never rewrite existing
 * files (a teammate booting dev must not mutate the build; `modelschemas
 * update` is the explicit refresh, and the git diff is the review).
 * Production (`build`): zero network — verify the committed files match the
 * manifest and fail with remediation otherwise.
 */
import { isAbsolute, resolve } from 'node:path'
import { checkUpdates, pull, verify } from '@modelschemas/codegen'
import type { PullConfig } from '@modelschemas/codegen'
import type { Plugin, ResolvedConfig } from 'vite'

export interface ModelschemasOptions extends Omit<
  PullConfig,
  'outDir' | 'log'
> {
  /** Where generated files live, relative to the vite root (committed).
   * Default `src/modelschemas`. */
  outDir?: string
}

export function modelschemas(options: ModelschemasOptions): Plugin {
  let command: ResolvedConfig['command'] = 'build'
  let root = process.cwd()
  let logger: ResolvedConfig['logger'] | undefined

  const pullConfig = (): PullConfig => {
    const outDir = options.outDir ?? 'src/modelschemas'
    return {
      ...options,
      outDir: isAbsolute(outDir) ? outDir : resolve(root, outDir),
      log: (message) => logger?.info(`[modelschemas] ${message}`),
    }
  }

  return {
    name: 'modelschemas',

    configResolved(config) {
      command = config.command
      root = config.root
      logger = config.logger
    },

    async buildStart() {
      const config = pullConfig()

      if (command === 'serve') {
        const summary = await pull(config, { missingOnly: true })
        if (summary.written.length > 0) {
          logger?.info(
            `[modelschemas] pulled ${String(summary.written.length)} schema module(s) into ${String(options.outDir ?? 'src/modelschemas')} — commit them.`,
          )
        }
        for (const failure of summary.failed) {
          logger?.warn(`[modelschemas] ${failure.key}: ${failure.reason}`)
        }
        const updates = await checkUpdates(config).catch((error: unknown) => {
          logger?.warn(
            `[modelschemas] update check failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          return []
        })
        if (updates.length > 0) {
          logger?.info(
            `[modelschemas] ${String(updates.length)} upstream schema update(s) available — run \`modelschemas update\`:\n` +
              updates.map((u) => `  ${u.key} — ${u.summary}`).join('\n'),
          )
        }
        return
      }

      // build: offline verification only.
      const result = await verify(config)
      if (!result.ok) {
        throw new Error(
          `[modelschemas] generated schema files are not ready:\n${result.problems.map((p) => `  - ${p}`).join('\n')}`,
        )
      }
    },
  }
}

export default modelschemas
