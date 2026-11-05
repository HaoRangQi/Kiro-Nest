/**
 * Connection facts shared by the core client, discovery, usage, and the
 * gateway. Kept free of transport imports so every layer uses the same values.
 */

import type { ModelModality } from './chat.ts'

/** Location of Kiro's native effort field in `additionalModelRequestFields`. */
export type KiroEffortSchemaPath = 'output_config' | 'reasoning'

/** One model entry advertised for the Kiro route. */
export interface KiroCatalogModel {
  /** Wire model id, sent as `modelId` on every turn. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Known provider output limit. */
  maxTokens?: number
  /** Whether this model honors thinking controls. */
  thinking?: boolean
  /**
   * Request modalities this model accepts, from the catalog's own
   * `supportedInputTypes`. Absent means text only.
   */
  inputModalities?: ModelModality[]
  /** Exact effort ids advertised by this account's live model schema. */
  reasoningEfforts?: string[]
  /** Provider-selected effort for this model. */
  defaultReasoningEffort?: string
  /** Native request-object branch that receives the selected effort. */
  effortSchemaPath?: KiroEffortSchemaPath
  /** Inclusive bounds of the `max_tokens` property this model advertised. */
  maxTokensBounds?: { minimum: number; maximum: number }
}

/** Adapter-level request defaults resolved from configuration. */
export interface RequestDefaults {
  /** Deployment thinking policy; `disabled` refuses every request-level enable. */
  thinking?: 'enabled' | 'disabled' | undefined
  /** Default thinking effort when a request names none. */
  reasoningEffort?: string | undefined
}

/**
 * Validated connection facts for one operation. The caller's configuration
 * resolver is the one explicit step producing this value; the core re-reads it
 * per operation, which is what makes a configuration change reach the next
 * request without re-registration.
 */
export interface KiroConnectionOptions {
  /** Region selecting the `q.<region>.amazonaws.com` endpoint. */
  region?: string
  /** Proxy egress for every Kiro request, or `undefined` for a direct connection. */
  proxyUrl?: string
  /** CodeWhisperer profile the account bills against; omitted uses the account default. */
  profileArn?: string
  /** Request defaults applied to every call. */
  defaults: RequestDefaults
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Ceiling on any model's reported context capacity. */
  maxContextWindow?: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly KiroCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Refresh the access token this long before its expiry. */
  tokenExpiryBufferMs: number
}
