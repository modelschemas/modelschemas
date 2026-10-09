import { recordedSources } from '#/lib/provenance.ts'
import { CopyButton } from '#/components/site.tsx'

/** Per-field evidence, including explicit source silence for unknown values. */
export function Provenance({
  facts,
  compact = false,
  omitLinks = false,
  omitFieldLinks = [],
  fields = [],
}: {
  facts: unknown
  compact?: boolean
  omitLinks?: boolean
  omitFieldLinks?: Array<string>
  fields?: Array<string>
}) {
  const recorded = recordedSources(facts)
  const sources = [
    ...recorded,
    ...fields
      .filter(
        (field) =>
          !recorded.some(
            (source) =>
              source.field === field || source.field.startsWith(`${field}.`),
          ),
      )
      .map((field) => ({
        field,
        sourceUrl: null,
        sourceHash: null,
        derivation: null,
        path: null,
        checkedAt: null,
        trace: {},
      })),
  ]
  const links = new Set(
    sources.flatMap((source) => (source.sourceUrl ? [source.sourceUrl] : [])),
  )
  const body =
    sources.length === 0 ? (
      <p className="font-mono text-xs text-ink-faint">
        Source unknown — no provenance recorded.
      </p>
    ) : (
      <div className="figure overflow-x-auto">
        <table className="dtable">
          <thead>
            <tr>
              <th>field</th>
              <th>recorded source</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.field}>
                <td className="font-mono text-xs">{source.field}</td>
                <td className="text-xs">
                  {source.sourceUrl ? (
                    omitLinks || omitFieldLinks.includes(source.field) ? (
                      <span className="text-ink-faint">
                        Source linked above.
                      </span>
                    ) : (
                      <a
                        className="press-link break-all"
                        href={source.sourceUrl}
                      >
                        {source.sourceUrl}
                      </a>
                    )
                  ) : (
                    <span className="text-ink-faint">
                      Source unknown — no source URL recorded.
                    </span>
                  )}
                  {source.derivation === 'source-silent' ? (
                    <p className="text-ink-faint">
                      Value unknown (null); not published in the checked source
                      {source.checkedAt ? ` · checked ${source.checkedAt}` : ''}
                      .
                    </p>
                  ) : source.derivation ? (
                    <p className="text-ink-faint">{source.derivation}</p>
                  ) : null}
                  {source.path ? (
                    <p className="font-mono text-ink-soft">{source.path}</p>
                  ) : null}
                  {source.sourceHash || Object.keys(source.trace).length > 0 ? (
                    <details className="mt-1 text-ink-faint">
                      <summary className="cursor-pointer">Source trace</summary>
                      <div className="mt-1 flex items-center gap-2">
                        <code className="break-all">{source.sourceHash}</code>
                        {source.sourceHash ? (
                          <CopyButton text={source.sourceHash} />
                        ) : null}
                      </div>
                      {Object.keys(source.trace).length > 0 ? (
                        <pre className="mt-2 whitespace-pre-wrap break-all">
                          {JSON.stringify(source.trace, null, 2)}
                        </pre>
                      ) : null}
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  return compact ? (
    <details className="max-w-md">
      <summary className="press-link cursor-pointer">
        sources{links.size ? ` (${links.size})` : ''}
      </summary>
      <div className="mt-2">{body}</div>
    </details>
  ) : (
    body
  )
}
