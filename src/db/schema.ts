import { relations } from 'drizzle-orm'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .$onUpdate(() => new Date())
    .notNull(),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

export const agentHost = sqliteTable(
  'agent_host',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    defaultCapabilities: text('default_capabilities'),
    publicKey: text('public_key'),
    kid: text('kid'),
    jwksUrl: text('jwks_url'),
    enrollmentTokenHash: text('enrollment_token_hash'),
    enrollmentTokenExpiresAt: integer('enrollment_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    status: text('status').default('active').notNull(),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('agentHost_userId_idx').on(table.userId),
    index('agentHost_kid_idx').on(table.kid),
    index('agentHost_enrollmentTokenHash_idx').on(table.enrollmentTokenHash),
    index('agentHost_status_idx').on(table.status),
  ],
)

export const agent = sqliteTable(
  'agent',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    hostId: text('host_id')
      .notNull()
      .references(() => agentHost.id, { onDelete: 'cascade' }),
    status: text('status').default('active').notNull(),
    mode: text('mode').default('delegated').notNull(),
    publicKey: text('public_key').notNull(),
    kid: text('kid'),
    jwksUrl: text('jwks_url'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    metadata: text('metadata'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('agent_userId_idx').on(table.userId),
    index('agent_hostId_idx').on(table.hostId),
    index('agent_status_idx').on(table.status),
    index('agent_kid_idx').on(table.kid),
  ],
)

export const agentCapabilityGrant = sqliteTable(
  'agent_capability_grant',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    deniedBy: text('denied_by').references(() => user.id, {
      onDelete: 'cascade',
    }),
    grantedBy: text('granted_by').references(() => user.id, {
      onDelete: 'cascade',
    }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').default('active').notNull(),
    reason: text('reason'),
    constraints: text('constraints'),
  },
  (table) => [
    index('agentCapabilityGrant_agentId_idx').on(table.agentId),
    index('agentCapabilityGrant_capability_idx').on(table.capability),
    index('agentCapabilityGrant_grantedBy_idx').on(table.grantedBy),
    index('agentCapabilityGrant_status_idx').on(table.status),
  ],
)

export const approvalRequest = sqliteTable(
  'approval_request',
  {
    id: text('id').primaryKey(),
    method: text('method').notNull(),
    agentId: text('agent_id').references(() => agent.id, {
      onDelete: 'cascade',
    }),
    hostId: text('host_id').references(() => agentHost.id, {
      onDelete: 'cascade',
    }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    capabilities: text('capabilities'),
    status: text('status').default('pending').notNull(),
    userCodeHash: text('user_code_hash'),
    loginHint: text('login_hint'),
    bindingMessage: text('binding_message'),
    clientNotificationToken: text('client_notification_token'),
    clientNotificationEndpoint: text('client_notification_endpoint'),
    deliveryMode: text('delivery_mode'),
    interval: integer('interval').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('approvalRequest_agentId_idx').on(table.agentId),
    index('approvalRequest_hostId_idx').on(table.hostId),
    index('approvalRequest_userId_idx').on(table.userId),
    index('approvalRequest_status_idx').on(table.status),
  ],
)

export const apikey = sqliteTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: integer('last_refill_at', { mode: 'timestamp_ms' }),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),
    rateLimitEnabled: integer('rate_limit_enabled', {
      mode: 'boolean',
    }).default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: integer('last_request', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('apikey_configId_idx').on(table.configId),
    index('apikey_referenceId_idx').on(table.referenceId),
    index('apikey_key_idx').on(table.key),
  ],
)

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  agentHosts: many(agentHost),
  agents: many(agent),
  agentCapabilityGrants: many(agentCapabilityGrant),
  approvalRequests: many(approvalRequest),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}))

export const agentHostRelations = relations(agentHost, ({ one, many }) => ({
  user: one(user, {
    fields: [agentHost.userId],
    references: [user.id],
  }),
  agents: many(agent),
  approvalRequests: many(approvalRequest),
}))

export const agentRelations = relations(agent, ({ one, many }) => ({
  user: one(user, {
    fields: [agent.userId],
    references: [user.id],
  }),
  agentHost: one(agentHost, {
    fields: [agent.hostId],
    references: [agentHost.id],
  }),
  agentCapabilityGrants: many(agentCapabilityGrant),
  approvalRequests: many(approvalRequest),
}))

export const agentCapabilityGrantDeniedByRelations = relations(
  agentCapabilityGrant,
  ({ one }) => ({
    user: one(user, {
      fields: [agentCapabilityGrant.deniedBy],
      references: [user.id],
    }),
  }),
)

export const agentCapabilityGrantGrantedByRelations = relations(
  agentCapabilityGrant,
  ({ one }) => ({
    user: one(user, {
      fields: [agentCapabilityGrant.grantedBy],
      references: [user.id],
    }),
  }),
)

export const agentCapabilityGrantRelations = relations(
  agentCapabilityGrant,
  ({ one }) => ({
    agent: one(agent, {
      fields: [agentCapabilityGrant.agentId],
      references: [agent.id],
    }),
  }),
)

export const approvalRequestRelations = relations(
  approvalRequest,
  ({ one }) => ({
    agent: one(agent, {
      fields: [approvalRequest.agentId],
      references: [agent.id],
    }),
    agentHost: one(agentHost, {
      fields: [approvalRequest.hostId],
      references: [agentHost.id],
    }),
    user: one(user, {
      fields: [approvalRequest.userId],
      references: [user.id],
    }),
  }),
)

// ---------------------------------------------------------------------------
// Core domain tables (PLAN.md task 1.1).
// Conventions: ids are lowercase kebab/slug text; times are unix epoch seconds
// (plain integers — the timestamp_ms columns above are better-auth-generated).
// ---------------------------------------------------------------------------

export const activities = [
  'chat',
  'image',
  'video',
  'audio',
  'embeddings',
  'moderation',
] as const
export type Activity = (typeof activities)[number]

export const changeTypes = [
  'model.added',
  'model.removed',
  'model.updated',
  'schema.added',
  'schema.updated',
  'endpoint.added',
  'endpoint.removed',
] as const
export type ChangeType = (typeof changeTypes)[number]

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  specSourceUrl: text('spec_source_url').notNull(),
  modelsEndpoint: text('models_endpoint'),
  authEnvVar: text('auth_env_var'),
  lastPolledAt: integer('last_polled_at'),
  lastSyncedAt: integer('last_synced_at'),
  status: text('status', {
    enum: ['active', 'degraded', 'disabled'],
  })
    .notNull()
    .default('active'),
})

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    rawId: text('raw_id').notNull(),
    activity: text('activity', { enum: activities }),
    displayName: text('display_name'),
    contextWindow: integer('context_window'),
    maxOutput: integer('max_output'),
    modalities: text('modalities', { mode: 'json' }),
    pricing: text('pricing', { mode: 'json' }),
    capabilities: text('capabilities', { mode: 'json' }),
    // Upstream release date when the provider reports one (backdated by the
    // poller, issue #1); otherwise when our poller first observed the model.
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    deprecatedAt: integer('deprecated_at'),
  },
  (table) => [
    index('models_providerId_idx').on(table.providerId),
    index('models_activity_idx').on(table.activity),
  ],
)

export const endpoints = sqliteTable(
  'endpoints',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    activity: text('activity', { enum: activities }).notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    description: text('description'),
  },
  (table) => [index('endpoints_providerId_idx').on(table.providerId)],
)

export const schemaVersions = sqliteTable(
  'schema_versions',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['input', 'output'] }).notNull(),
    contentHash: text('content_hash').notNull(),
    schema: text('schema').notNull(),
    specRevision: text('spec_revision'),
    // Provenance (nullable on rows synced before it was recorded): the
    // upstream document this version was derived from, and the extractor
    // that derived it. createdAt doubles as the fetched-at timestamp.
    sourceUrl: text('source_url'),
    sourceHash: text('source_hash'),
    extractorVersion: text('extractor_version'),
    createdAt: integer('created_at').notNull(),
    supersededAt: integer('superseded_at'),
  },
  (table) => [
    index('schema_versions_endpointId_kind_idx').on(
      table.endpointId,
      table.kind,
    ),
    index('schema_versions_contentHash_idx').on(table.contentHash),
  ],
)

export const changes = sqliteTable(
  'changes',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: changeTypes }).notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id').notNull(),
    summary: text('summary').notNull(),
    payload: text('payload', { mode: 'json' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('changes_createdAt_idx').on(table.createdAt),
    index('changes_providerId_idx').on(table.providerId),
  ],
)

export const providersRelations = relations(providers, ({ many }) => ({
  models: many(models),
  endpoints: many(endpoints),
  changes: many(changes),
}))

export const modelsRelations = relations(models, ({ one }) => ({
  provider: one(providers, {
    fields: [models.providerId],
    references: [providers.id],
  }),
}))

export const endpointsRelations = relations(endpoints, ({ one, many }) => ({
  provider: one(providers, {
    fields: [endpoints.providerId],
    references: [providers.id],
  }),
  schemaVersions: many(schemaVersions),
}))

export const schemaVersionsRelations = relations(schemaVersions, ({ one }) => ({
  endpoint: one(endpoints, {
    fields: [schemaVersions.endpointId],
    references: [endpoints.id],
  }),
}))

export const changesRelations = relations(changes, ({ one }) => ({
  provider: one(providers, {
    fields: [changes.providerId],
    references: [providers.id],
  }),
}))

// ---------------------------------------------------------------------------
// Cache + delivery tables (PLAN.md task 1.2).
// ---------------------------------------------------------------------------

export const cacheMeta = sqliteTable('cache_meta', {
  key: text('key').primaryKey(),
  fetchedAt: integer('fetched_at').notNull(),
  staleTime: integer('stale_time').notNull(),
  lastError: text('last_error'),
  refreshing: integer('refreshing', { mode: 'boolean' })
    .notNull()
    .default(false),
})

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    events: text('events', { mode: 'json' }).notNull(),
    providerFilter: text('provider_filter').references(() => providers.id, {
      onDelete: 'cascade',
    }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('subscriptions_agentId_idx').on(table.agentId)],
)

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    changeId: text('change_id')
      .notNull()
      .references(() => changes.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    status: text('status', { enum: ['pending', 'ok', 'failed'] })
      .notNull()
      .default('pending'),
    lastResponseCode: integer('last_response_code'),
  },
  (table) => [
    index('webhook_deliveries_status_nextAttemptAt_idx').on(
      table.status,
      table.nextAttemptAt,
    ),
    index('webhook_deliveries_subscriptionId_idx').on(table.subscriptionId),
  ],
)

export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    agent: one(user, {
      fields: [subscriptions.agentId],
      references: [user.id],
    }),
    deliveries: many(webhookDeliveries),
  }),
)

export const webhookDeliveriesRelations = relations(
  webhookDeliveries,
  ({ one }) => ({
    subscription: one(subscriptions, {
      fields: [webhookDeliveries.subscriptionId],
      references: [subscriptions.id],
    }),
    change: one(changes, {
      fields: [webhookDeliveries.changeId],
      references: [changes.id],
    }),
  }),
)
