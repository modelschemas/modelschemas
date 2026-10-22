import { DurableObject } from 'cloudflare:workers'

type EgressHandler = NonNullable<InstanceType<typeof DurableObject>['fetch']>

/**
 * Forwards a request from where this object lives (eastern North America;
 * see `usEgressFetch` in `providers/us-egress.ts`). It stores nothing; its
 * location only decides where the outbound fetch runs.
 */
export class UsEgress extends DurableObject {
  // The casts bridge workers-types' Request/Response and the DOM ones the
  // global fetch is typed with here; they are the same runtime classes.
  override fetch(
    request: Parameters<EgressHandler>[0],
  ): ReturnType<EgressHandler> {
    return fetch(
      request as unknown as Request,
    ) as unknown as ReturnType<EgressHandler>
  }
}
