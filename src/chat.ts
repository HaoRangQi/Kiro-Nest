/**
 * Provider-neutral chat vocabulary used by the gateway and the Kiro client.
 *
 * The shapes mirror the OpenAI/Anthropic-facing gateway protocol closely
 * enough that request and stream translation stays a field-by-field mapping,
 * while nothing here imports an HTTP or framework package.
 */

/** Image media types Kiro accepts on the wire. */
export type ChatImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Input modalities a model may accept. */
export type ModelModality = 'text' | 'image'

/** One inline image, already decoded and bounded for the request. */
export interface ChatImage {
  mediaType: ChatImageMediaType
  /** Base64 payload without a `data:` prefix. */
  data: string
}

/** Visible text produced by the model or supplied by the caller. */
export interface ChatTextBlock {
  type: 'text'
  text: string
}

/** Reasoning content, kept out of the visible text channel. */
export interface ChatReasoningBlock {
  type: 'reasoning'
  text: string
}

/** One model-issued tool call. */
export interface ChatToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  /** Raw JSON argument string as produced by the model. */
  arguments: string
}

/** One inline image carried by a user turn. */
export interface ChatImageBlock {
  type: 'image'
  image: ChatImage
}

/** Any content block the core understands. */
export type ChatContentBlock =
  | ChatTextBlock
  | ChatReasoningBlock
  | ChatToolCallBlock
  | ChatImageBlock

/** One conversation message. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool'
  content: ChatContentBlock[]
  /** Correlation id on a tool-result message. */
  toolCallId?: string
  /** Whether a tool result represents a failure. */
  isError?: boolean
}

/** JSON-schema description of one tool. */
export interface ChatToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** One fully assembled model request. */
export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  /** System prompt text; mapped onto Kiro's earliest user turn. */
  system?: string
  tools?: ChatToolSchema[]
  maxTokens?: number
  reasoningEffort?: string
  /** Stable per-conversation routing identity. */
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
  /** Caller cancellation. */
  signal?: AbortSignal
}

/** One failure attached to a terminal finish reason. */
export interface ChatFailure {
  message: string
  code: string
  status?: number
  requestId?: string
}

/** Why a model response stopped. */
export type ChatFinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: ChatFailure }
  | { kind: 'error'; failure: ChatFailure }

/** Token accounting for one call; counters are disjoint. */
export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** A block that has been assembled to completion. */
export type ChatContentBlockResult =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

/** Raw streaming chunk emitted by the core. */
export type ChatChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
    type: 'tool-call-delta'
    index: number
    id: string
    name?: string
    argumentsDelta: string
  }
  | { type: 'block-end'; index: number; block: ChatContentBlockResult }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'finish'; reason: ChatFinishReason }

/** Whether any block in one message carries an image. */
export function contentHasImage(content: readonly ChatContentBlock[]): boolean {
  return content.some(block => block.type === 'image')
}
