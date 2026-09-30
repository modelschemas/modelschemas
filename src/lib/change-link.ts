/**
 * Homepage and /changes rows. Model events use the catalog slug as
 * subjectId, which GET /models/$provider/$modelId accepts.
 */
export function modelChangeHref(change: {
  type: string
  providerId: string
  subjectId: string
}): string | null {
  if (!change.type.startsWith('model.')) return null
  if (change.providerId === '' || change.subjectId === '') return null
  return `/models/${encodeURIComponent(change.providerId)}/${encodeURIComponent(change.subjectId)}`
}
