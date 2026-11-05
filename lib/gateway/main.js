import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { request as request$1 } from "node:https";
import { connect } from "node:tls";

//#region lib/types/gateway/config.js
/** 配置文件名。 */
const CONFIG_FILE = "config.json";
/** 默认监听端口。 */
const DEFAULT_PORT = 8787;
/** 默认监听地址。 */
const DEFAULT_HOST = "0.0.0.0";
/** 默认上下文容量。 */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** 默认流空闲超时。 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** 默认令牌提前刷新窗口。 */
const DEFAULT_TOKEN_EXPIRY_BUFFER_MS = 3e5;
/**
* 解析数据目录。
* @param value - 显式传入的目录，或环境变量。
* @returns 绝对路径。
*/
function resolveDataDir(value) {
	return resolve(value ?? process.env["KIRO_NEST_DATA_DIR"] ?? process.env["DATA_DIR"] ?? join(process.cwd(), "data"));
}
/** 读取一个可选的正整数环境变量。 */
function envInteger(name) {
	const raw = process.env[name];
	if (raw === void 0 || raw.trim().length === 0) return void 0;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}
/** 读取一个可选的字符串环境变量。 */
function envString(name) {
	const raw = process.env[name];
	return raw === void 0 ? void 0 : raw.trim();
}
/** 默认配置。 */
function defaults(dataDir$1) {
	return {
		port: envInteger("KIRO_NEST_PORT") ?? envInteger("PORT") ?? DEFAULT_PORT,
		host: envString("KIRO_NEST_HOST") ?? DEFAULT_HOST,
		apiKey: envString("KIRO_NEST_API_KEY") ?? "",
		adminToken: envString("KIRO_NEST_ADMIN_TOKEN") ?? "",
		proxyUrl: envString("KIRO_NEST_PROXY_URL") ?? envString("KIRO_PROXY_URL") ?? "",
		region: envString("KIRO_NEST_REGION") ?? envString("KIRO_REGION") ?? "",
		profileArn: envString("KIRO_NEST_PROFILE_ARN") ?? "",
		defaultModel: envString("KIRO_NEST_DEFAULT_MODEL") ?? "",
		reasoningEffort: envString("KIRO_NEST_REASONING_EFFORT") ?? "",
		thinking: envString("KIRO_NEST_THINKING") === "disabled" ? "disabled" : "enabled",
		maxContextWindow: envInteger("KIRO_NEST_MAX_CONTEXT_WINDOW") ?? null,
		defaultContextWindow: envInteger("KIRO_NEST_DEFAULT_CONTEXT_WINDOW") ?? DEFAULT_CONTEXT_WINDOW,
		streamIdleTimeoutMs: envInteger("KIRO_NEST_STREAM_IDLE_TIMEOUT_MS") ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		tokenExpiryBufferMs: envInteger("KIRO_NEST_TOKEN_EXPIRY_BUFFER_MS") ?? DEFAULT_TOKEN_EXPIRY_BUFFER_MS,
		dataDir: dataDir$1
	};
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value, name, max = 4096) {
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	if (value.length > max) throw new Error(`${name} is too long`);
	return value.trim();
}
function boundedInteger(value, name, minimum, maximum) {
	if (value === void 0) return void 0;
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	return value;
}
/**
* 校验并合并一个配置补丁。
* @param current - 当前配置。
* @param patch - 页面提交的补丁。
* @returns 合并后的配置。
* @throws 当字段类型或范围不合法时。
*/
function mergeConfig(current, patch) {
	const port = boundedInteger(patch.port, "port", 1, 65535) ?? current.port;
	const host = boundedString(patch.host, "host", 255) ?? current.host;
	if (host.length === 0) throw new Error("host is required");
	const apiKey = boundedString(patch.apiKey, "apiKey", 512) ?? current.apiKey;
	const adminToken = boundedString(patch.adminToken, "adminToken", 512) ?? current.adminToken;
	const proxyUrl = boundedString(patch.proxyUrl, "proxyUrl") ?? current.proxyUrl;
	const region = boundedString(patch.region, "region", 64) ?? current.region;
	const profileArn = boundedString(patch.profileArn, "profileArn", 2048) ?? current.profileArn;
	const defaultModel = boundedString(patch.defaultModel, "defaultModel", 256) ?? current.defaultModel;
	const reasoningEffort = boundedString(patch.reasoningEffort, "reasoningEffort", 32) ?? current.reasoningEffort;
	const thinking = patch.thinking ?? current.thinking;
	if (thinking !== "enabled" && thinking !== "disabled") throw new Error("thinking must be enabled or disabled");
	let maxContextWindow = current.maxContextWindow;
	if (patch.maxContextWindow !== void 0) maxContextWindow = patch.maxContextWindow === null ? null : boundedInteger(patch.maxContextWindow, "maxContextWindow", 1, 1e7) ?? null;
	const defaultContextWindow = boundedInteger(patch.defaultContextWindow, "defaultContextWindow", 1, 1e7) ?? current.defaultContextWindow;
	const streamIdleTimeoutMs = boundedInteger(patch.streamIdleTimeoutMs, "streamIdleTimeoutMs", 1e3, 36e5) ?? current.streamIdleTimeoutMs;
	const tokenExpiryBufferMs = boundedInteger(patch.tokenExpiryBufferMs, "tokenExpiryBufferMs", 0, 36e5) ?? current.tokenExpiryBufferMs;
	return {
		port,
		host,
		apiKey,
		adminToken,
		proxyUrl,
		region,
		profileArn,
		defaultModel,
		reasoningEffort,
		thinking,
		maxContextWindow,
		defaultContextWindow,
		streamIdleTimeoutMs,
		tokenExpiryBufferMs,
		dataDir: current.dataDir
	};
}
/** 配置文件的绝对路径。 */
function configPath(dataDir$1) {
	return join(dataDir$1, CONFIG_FILE);
}
/**
* 读取配置：文件中的值覆盖默认值，环境变量优先于文件。
* @param dataDir - 数据目录。
* @returns 校验后的配置。
*/
async function loadConfig(dataDir$1) {
	const base = defaults(dataDir$1);
	let raw;
	try {
		raw = JSON.parse(await readFile(configPath(dataDir$1), "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw new Error(`Cannot read gateway config at ${configPath(dataDir$1)}`, { cause: error });
		return base;
	}
	if (!isRecord$1(raw)) throw new Error("Gateway config must be a JSON object");
	const merged = mergeConfig(base, raw);
	return {
		...merged,
		port: envInteger("KIRO_NEST_PORT") ?? envInteger("PORT") ?? merged.port,
		host: envString("KIRO_NEST_HOST") ?? merged.host,
		apiKey: envString("KIRO_NEST_API_KEY") ?? merged.apiKey,
		adminToken: envString("KIRO_NEST_ADMIN_TOKEN") ?? merged.adminToken,
		proxyUrl: envString("KIRO_NEST_PROXY_URL") ?? merged.proxyUrl,
		region: envString("KIRO_NEST_REGION") ?? merged.region,
		profileArn: envString("KIRO_NEST_PROFILE_ARN") ?? merged.profileArn,
		defaultModel: envString("KIRO_NEST_DEFAULT_MODEL") ?? merged.defaultModel,
		reasoningEffort: envString("KIRO_NEST_REASONING_EFFORT") ?? merged.reasoningEffort,
		thinking: envString("KIRO_NEST_THINKING") === "disabled" ? "disabled" : merged.thinking,
		maxContextWindow: envInteger("KIRO_NEST_MAX_CONTEXT_WINDOW") ?? merged.maxContextWindow,
		defaultContextWindow: envInteger("KIRO_NEST_DEFAULT_CONTEXT_WINDOW") ?? merged.defaultContextWindow,
		streamIdleTimeoutMs: envInteger("KIRO_NEST_STREAM_IDLE_TIMEOUT_MS") ?? merged.streamIdleTimeoutMs,
		tokenExpiryBufferMs: envInteger("KIRO_NEST_TOKEN_EXPIRY_BUFFER_MS") ?? merged.tokenExpiryBufferMs
	};
}
/**
* 原子写入配置，权限仅所有者可读写。
* @param config - 完整配置。
*/
async function saveConfig(config$1) {
	const path = configPath(config$1.dataDir);
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = `${path}.${String(process.pid)}.tmp`;
	const { dataDir: _dataDir,...persisted } = config$1;
	await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 384 });
	await chmod(temporary, 384);
	await rename(temporary, path);
}
/**
* 转成页面可读的视图。
* @param config - 完整配置。
* @returns 密钥脱敏后的配置。
*/
function publicConfig(config$1) {
	return {
		port: config$1.port,
		host: config$1.host,
		apiKeyConfigured: config$1.apiKey.length > 0,
		adminTokenConfigured: config$1.adminToken.length > 0,
		dataDir: config$1.dataDir,
		proxyUrl: config$1.proxyUrl,
		region: config$1.region,
		profileArn: config$1.profileArn,
		defaultModel: config$1.defaultModel,
		reasoningEffort: config$1.reasoningEffort,
		thinking: config$1.thinking,
		maxContextWindow: config$1.maxContextWindow,
		defaultContextWindow: config$1.defaultContextWindow,
		streamIdleTimeoutMs: config$1.streamIdleTimeoutMs,
		tokenExpiryBufferMs: config$1.tokenExpiryBufferMs
	};
}

//#endregion
//#region lib/types/errors.js
/**
* Kiro provider errors that carry a stable machine-routable code.
*
* This module deliberately has no dependency on an HTTP framework: the gateway
* maps these errors to OpenAI/Anthropic protocol vocabulary at its boundary.
*/
/** Typed error for every Kiro credential, transport, and protocol failure. */
var KiroError = class extends Error {
	/** Stable machine-routable failure class (e.g. `AUTH`, `RATE_LIMIT`). */
	code;
	/** HTTP status observed at the provider boundary, when any. */
	status;
	/** Opaque provider request identifier, when any. */
	requestId;
	/** Provider-requested retry delay in milliseconds, when any. */
	providerRetryAfterMs;
	constructor(message, code, options = {}) {
		super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
		this.name = "KiroError";
		this.code = code;
		this.status = options.status;
		this.requestId = options.requestId;
		this.providerRetryAfterMs = options.providerRetryAfterMs;
	}
};
/** Narrow an unknown thrown value to a {@link KiroError}. */
function isKiroError(value) {
	return value instanceof KiroError;
}
/** Canonical code for a request rejected because its context window was exceeded. */
const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
/** Canonical code for a response that completed without any content. */
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";

//#endregion
//#region lib/types/gateway/http.js
/** 请求体过大时抛出的 HTTP 错误。 */
var HttpError = class extends Error {
	/** 返回给客户端的 HTTP 状态码。 */
	status;
	/** 机器可读的错误类型，例如 `invalid_request_error`。 */
	type;
	constructor(status, message, type = "invalid_request_error") {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.type = type;
	}
};
/** 默认请求体上限：足够容纳多张 base64 图片。 */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
/**
* 读取并解析 JSON 请求体。
* @param request - 传入请求。
* @param maximumBytes - 允许的最大字节数。
* @returns 解析后的 JSON 对象。
* @throws `HttpError(400|413)` 当请求体不合法或过大时。
*/
async function readJson(request$2, maximumBytes = DEFAULT_MAX_BODY_BYTES) {
	const chunks = [];
	let bytes = 0;
	for await (const raw of request$2) {
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		bytes += chunk.byteLength;
		if (bytes > maximumBytes) throw new HttpError(413, "Request body is too large", "request_too_large");
		chunks.push(chunk);
	}
	if (bytes === 0) return {};
	let value;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		throw new HttpError(400, "Request body is not valid JSON", "invalid_request_error");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "Request body must be a JSON object", "invalid_request_error");
	return value;
}
/**
* 发送 JSON 响应。
* @param response - 响应对象。
* @param status - HTTP 状态码。
* @param body - 可序列化的响应体。
*/
function sendJson(response, status, body) {
	if (response.headersSent) return;
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	response.end(JSON.stringify(body));
}
/** 发送纯文本响应。 */
function sendText(response, status, body) {
	if (response.headersSent) return;
	response.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(body);
}
/** 写入 SSE 需要的响应头。 */
function writeSseHead(response) {
	if (response.headersSent) return;
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no"
	});
}
/** 把对象编码成一条 SSE `data:` 帧。 */
function sseData(value) {
	return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}
/** 把对象编码成一条带事件名的 SSE 帧。 */
function sseEvent(event, value) {
	return `event: ${event}\ndata: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}
/** 生成带前缀的随机 id。 */
function newId(prefix) {
	return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
/**
* 把错误映射成客户端可用的 HTTP 状态码。
* @param error - 捕获的错误。
* @returns 建议的状态码。
*/
function statusForError(error) {
	if (error instanceof HttpError) return error.status;
	if (!isKiroError(error)) return 500;
	switch (error.code) {
		case "AUTH":
		case "FORBIDDEN":
		case "INVALID_CREDENTIAL":
		case "MISSING_CREDENTIAL": return 502;
		case "QUOTA": return 402;
		case "RATE_LIMIT": return 429;
		case "INVALID_MODEL": return 404;
		case "INVALID_REQUEST":
		case "UNSUPPORTED_CONTENT":
		case "UNSUPPORTED_REASONING_EFFORT":
		case "UNSUPPORTED_TOOL_NAME":
		case "CONTEXT_WINDOW_EXCEEDED": return 400;
		case "TIMEOUT": return 504;
		case "ABORTED": return 499;
		default: return 502;
	}
}
/**
* 构造 OpenAI 风格的错误体。
* @param error - 捕获的错误。
* @param type - 错误类型。
*/
function openAIErrorBody(error, type = "api_error") {
	const status = statusForError(error);
	const message = error instanceof Error ? error.message : String(error);
	const code = isKiroError(error) ? error.code : error instanceof HttpError ? error.type : void 0;
	return { error: {
		message,
		type: status === 400 ? "invalid_request_error" : type,
		...code === void 0 ? {} : { code }
	} };
}
/**
* 构造 Anthropic 风格的错误体。
* @param error - 捕获的错误。
*/
function anthropicErrorBody(error) {
	const status = statusForError(error);
	const message = error instanceof Error ? error.message : String(error);
	return {
		type: "error",
		error: {
			type: status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : status === 413 ? "request_too_large" : "api_error",
			message
		}
	};
}
/** Kiro 支持的图片媒体类型。 */
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([\s\S]+)$/u;
/**
* 解析 `data:` 形式的图片 URL。
* @param url - OpenAI `image_url.url` 的值。
* @returns 媒体类型与 base64 数据。
* @throws `HttpError(400)` 当 URL 不是受支持的 data URL 时。
*/
function parseImageDataUrl(url) {
	const match = IMAGE_DATA_URL.exec(url.trim());
	if (match === null || match[1] === void 0 || match[2] === void 0) throw new HttpError(400, "image_url must be a base64 data URL (data:image/png;base64,...); remote URLs are not fetched by the gateway", "invalid_request_error");
	const declared = match[1].toLowerCase();
	return {
		mediaType: declared === "image/jpg" ? "image/jpeg" : declared,
		data: match[2]
	};
}
/**
* 把 `stop` 字段规范成字符串数组。
* @param value - OpenAI 的 `stop` 字段。
*/
function stopSequences(value) {
	if (typeof value === "string" && value.length > 0) return [value];
	if (Array.isArray(value)) {
		const items = value.filter((item) => typeof item === "string" && item.length > 0);
		return items.length === 0 ? void 0 : items;
	}
}
/**
* 聚合一次流式响应，供非流式端点使用。
* @param chunks - 核心流。
* @returns 组装完成的块、结束原因与用量。
*/
async function collectResponse(chunks) {
	const blocks = /* @__PURE__ */ new Map();
	let finish = { kind: "stop" };
	let usage;
	for await (const chunk of chunks) switch (chunk.type) {
		case "block-end":
			blocks.set(chunk.index, chunk.block);
			break;
		case "usage":
			usage = chunk.usage;
			break;
		case "finish":
			finish = chunk.reason;
			break;
		default: break;
	}
	return {
		blocks: [...blocks.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]),
		finish,
		...usage === void 0 ? {} : { usage }
	};
}
/**
* 判断结束原因是否需要作为错误上报。
* @param reason - 核心结束原因。
*/
function finishFailure(reason) {
	return reason.kind === "error" || reason.kind === "aborted" ? reason.failure : void 0;
}

//#endregion
//#region lib/types/gateway/anthropic.js
/** 解析 Anthropic 的 content 字段。 */
function systemText$1(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	if (!Array.isArray(value)) return void 0;
	const text$3 = value.filter((part) => typeof part === "object" && part !== null && part["type"] === "text" && typeof part["text"] === "string").map((part) => part.text).join("\n");
	return text$3.length === 0 ? void 0 : text$3;
}
/** 把 Anthropic 的 thinking 预算映射成 Kiro 的推理强度。 */
function effortFromThinking(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const thinking = value;
	if (thinking["type"] === "disabled") return "off";
	const budget = thinking["budget_tokens"];
	if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return void 0;
	if (budget <= 4e3) return "low";
	if (budget <= 12e3) return "medium";
	return "high";
}
/** 解析 Anthropic 的图片块。 */
function imageBlock(block) {
	const source = typeof block["source"] === "object" && block["source"] !== null ? block["source"] : void 0;
	if (source === void 0 || source.type !== "base64" || typeof source.media_type !== "string" || typeof source.data !== "string") throw new HttpError(400, "Anthropic image blocks must use base64 sources");
	const mediaType = source.media_type.toLowerCase() === "image/jpg" ? "image/jpeg" : source.media_type.toLowerCase();
	if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/gif" && mediaType !== "image/webp") throw new HttpError(400, `Unsupported image media type ${source.media_type}`);
	return {
		type: "image",
		image: {
			mediaType,
			data: source.data
		}
	};
}
/** 解析工具结果的内容为文本。 */
function toolResultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part !== "object" || part === null) return "";
		const value = part;
		return value["type"] === "text" && typeof value["text"] === "string" ? value["text"] : "";
	}).join("\n");
}
/** 解析 Anthropic 的工具声明。 */
function toolSchemas$1(value) {
	if (!Array.isArray(value)) return void 0;
	const tools = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const tool = raw;
		const name = typeof tool["name"] === "string" ? tool["name"].trim() : "";
		if (name.length === 0) continue;
		tools.push({
			name,
			description: typeof tool["description"] === "string" ? tool["description"] : "",
			parameters: typeof tool["input_schema"] === "object" && tool["input_schema"] !== null ? tool["input_schema"] : {
				type: "object",
				properties: {}
			}
		});
	}
	return tools.length === 0 ? void 0 : tools;
}
/**
* 选择实际使用的模型。
* @param body - Anthropic 请求体。
* @param options - 网关上下文。
*/
function selectAnthropicModel(body, options) {
	const requested = typeof body["model"] === "string" ? body["model"].trim() : "";
	return requested.length > 0 ? requested : options.defaultModel.length > 0 ? options.defaultModel : options.models[0]?.id ?? "auto";
}
/**
* 把 Anthropic Messages 请求翻译成核心请求。
* @param body - 已解析的请求体。
* @param options - 网关上下文。
* @returns 核心请求。
* @throws `HttpError(400)` 当字段结构不合法时。
*/
function toAnthropicChatRequest(body, options) {
	const rawMessages = body["messages"];
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw new HttpError(400, "messages must be a non-empty array");
	const messages = [];
	for (const raw of rawMessages) {
		if (typeof raw !== "object" || raw === null) throw new HttpError(400, "each message must be an object");
		const message = raw;
		const role = message["role"];
		const content = message["content"];
		if (role === "assistant") {
			const blocks = [];
			if (typeof content === "string") {
				if (content.length > 0) blocks.push({
					type: "text",
					text: content
				});
			} else if (Array.isArray(content)) for (const part of content) {
				if (typeof part !== "object" || part === null) continue;
				const block = part;
				if (block["type"] === "text" && typeof block["text"] === "string") blocks.push({
					type: "text",
					text: block["text"]
				});
				else if (block["type"] === "thinking" && typeof block["thinking"] === "string") blocks.push({
					type: "reasoning",
					text: block["thinking"]
				});
				else if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") blocks.push({
					type: "tool-call",
					id: block["id"],
					name: block["name"],
					arguments: JSON.stringify(block["input"] ?? {})
				});
			}
			else if (content !== null && content !== void 0) throw new HttpError(400, "assistant content must be a string or array");
			messages.push({
				role: "assistant",
				content: blocks
			});
			continue;
		}
		if (role !== "user") throw new HttpError(400, `Unsupported message role ${String(role)}`);
		if (typeof content === "string") {
			messages.push({
				role: "user",
				content: content.length === 0 ? [] : [{
					type: "text",
					text: content
				}]
			});
			continue;
		}
		if (!Array.isArray(content)) throw new HttpError(400, "user content must be a string or array");
		const userBlocks = [];
		const toolMessages = [];
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const block = part;
			if (block["type"] === "text" && typeof block["text"] === "string") userBlocks.push({
				type: "text",
				text: block["text"]
			});
			else if (block["type"] === "image") userBlocks.push(imageBlock(block));
			else if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") toolMessages.push({
				role: "tool",
				toolCallId: block["tool_use_id"],
				content: [{
					type: "text",
					text: toolResultText(block["content"])
				}],
				...block["is_error"] === true ? { isError: true } : {}
			});
		}
		messages.push(...toolMessages);
		if (userBlocks.length > 0) messages.push({
			role: "user",
			content: userBlocks
		});
	}
	const maxTokens = typeof body["max_tokens"] === "number" ? body["max_tokens"] : void 0;
	const thinkingEffort = effortFromThinking(body["thinking"]);
	const reasoningEffort = options.reasoningEffort ?? thinkingEffort ?? (typeof body["reasoning_effort"] === "string" && body["reasoning_effort"].length > 0 ? body["reasoning_effort"] : void 0);
	const tools = toolSchemas$1(body["tools"]);
	const stop = Array.isArray(body["stop_sequences"]) ? body["stop_sequences"].filter((item) => typeof item === "string" && item.length > 0) : void 0;
	const sessionId = options.sessionId ?? (typeof body["metadata"] === "object" && body["metadata"] !== null ? body["metadata"]["user_id"] : void 0);
	return {
		model: selectAnthropicModel(body, options),
		messages,
		...systemText$1(body["system"]) === void 0 ? {} : { system: systemText$1(body["system"]) },
		...tools === void 0 ? {} : { tools },
		...maxTokens === void 0 ? {} : { maxTokens },
		...reasoningEffort === void 0 ? {} : { reasoningEffort },
		...stop === void 0 || stop.length === 0 ? {} : { stop },
		...typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}
	};
}
/** Anthropic stop_reason 词汇。 */
function anthropicStopReason(reason) {
	switch (reason.kind) {
		case "tool-calls": return "tool_use";
		case "max-tokens": return "max_tokens";
		default: return "end_turn";
	}
}
/** Anthropic usage 对象。 */
function anthropicUsage(usage) {
	if (usage === void 0) return void 0;
	return {
		input_tokens: usage.inputTokens,
		output_tokens: usage.outputTokens
	};
}
/** 把工具参数 JSON 解析成 Anthropic 需要的对象。 */
function toolInput(argumentsText) {
	try {
		const parsed = JSON.parse(argumentsText);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
/** 把聚合结果转换成 Anthropic content 块。 */
function anthropicContent(blocks) {
	const content = [];
	for (const block of blocks) {
		if (block.type === "reasoning") {
			if (block.text.length > 0) content.push({
				type: "thinking",
				thinking: block.text
			});
			continue;
		}
		if (block.type === "text") {
			if (block.text.length > 0) content.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		content.push({
			type: "tool_use",
			id: block.id,
			name: block.name,
			input: toolInput(block.arguments)
		});
	}
	return content.length === 0 ? [{
		type: "text",
		text: ""
	}] : content;
}
/**
* 构造非流式 Anthropic 响应。
* @param model - 实际使用的模型。
* @param response - 聚合后的核心响应。
*/
function anthropicMessage(model, response) {
	const usage = anthropicUsage(response.usage);
	return {
		id: newId("msg_"),
		type: "message",
		role: "assistant",
		model,
		content: anthropicContent(response.blocks),
		stop_reason: anthropicStopReason(response.finish),
		stop_sequence: null,
		...usage === void 0 ? {} : { usage }
	};
}
/**
* Anthropic 流式事件编码器。
*
* 维护核心 block index 到 Anthropic content block index 的映射，并保证每个块
* 都有配对的 start/stop 事件。
*/
var AnthropicStreamEncoder = class {
	/** 消息 id。 */
	id = newId("msg_");
	model;
	started = false;
	finished = false;
	blockIndexes = /* @__PURE__ */ new Map();
	/** 已发送 start 的工具块。 */
	startedTools = /* @__PURE__ */ new Set();
	/** 已通过 block-end 关闭的块。 */
	closedBlocks = /* @__PURE__ */ new Set();
	/** 工具块在收到 name 之前不发送 start。 */
	pendingTools = /* @__PURE__ */ new Map();
	usage;
	constructor(model) {
		this.model = model;
	}
	/** 分配下一个 Anthropic content block index。 */
	nextIndex(blockIndex) {
		const existing = this.blockIndexes.get(blockIndex);
		if (existing !== void 0) return existing;
		const next = this.blockIndexes.size;
		this.blockIndexes.set(blockIndex, next);
		return next;
	}
	/** 消息开始事件。 */
	start() {
		if (this.started) return [];
		this.started = true;
		return [sseEvent("message_start", {
			type: "message_start",
			message: {
				id: this.id,
				type: "message",
				role: "assistant",
				model: this.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: 0,
					output_tokens: 0
				}
			}
		})];
	}
	/**
	* 编码一个核心块。
	* @param chunk - 核心流式块。
	* @returns Anthropic SSE 事件。
	*/
	push(chunk) {
		const events = [];
		switch (chunk.type) {
			case "block-start": {
				if (chunk.blockType === "tool-call") {
					this.pendingTools.set(chunk.index, { id: "" });
					return [];
				}
				const index = this.nextIndex(chunk.index);
				events.push(sseEvent("content_block_start", {
					type: "content_block_start",
					index,
					content_block: chunk.blockType === "reasoning" ? {
						type: "thinking",
						thinking: ""
					} : {
						type: "text",
						text: ""
					}
				}));
				return events;
			}
			case "text-delta": {
				if (chunk.text.length === 0) return [];
				const index = this.nextIndex(chunk.index);
				events.push(sseEvent("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: {
						type: "text_delta",
						text: chunk.text
					}
				}));
				return events;
			}
			case "reasoning-delta": {
				if (chunk.text.length === 0) return [];
				const index = this.nextIndex(chunk.index);
				events.push(sseEvent("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: {
						type: "thinking_delta",
						thinking: chunk.text
					}
				}));
				return events;
			}
			case "tool-call-delta": {
				let pending = this.pendingTools.get(chunk.index);
				if (pending === void 0) {
					pending = { id: chunk.id };
					this.pendingTools.set(chunk.index, pending);
				}
				if (pending.id.length === 0) pending.id = chunk.id;
				if (chunk.name !== void 0) pending.name = chunk.name;
				const index = this.nextIndex(chunk.index);
				if (!this.startedTools.has(chunk.index)) {
					this.startedTools.add(chunk.index);
					events.push(sseEvent("content_block_start", {
						type: "content_block_start",
						index,
						content_block: {
							type: "tool_use",
							id: pending.id,
							name: pending.name ?? "unknown",
							input: {}
						}
					}));
				}
				if (chunk.argumentsDelta.length > 0) events.push(sseEvent("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: {
						type: "input_json_delta",
						partial_json: chunk.argumentsDelta
					}
				}));
				return events;
			}
			case "block-end": {
				const index = this.blockIndexes.get(chunk.index);
				if (index === void 0) return [];
				this.closedBlocks.add(chunk.index);
				events.push(sseEvent("content_block_stop", {
					type: "content_block_stop",
					index
				}));
				return events;
			}
			case "usage":
				this.usage = chunk.usage;
				return [];
			case "finish": {
				const failure = finishFailure(chunk.reason);
				if (failure !== void 0) {
					events.push(sseEvent("error", {
						type: "error",
						error: {
							type: "api_error",
							message: failure.message
						}
					}));
					return events;
				}
				events.push(sseEvent("message_delta", {
					type: "message_delta",
					delta: {
						stop_reason: anthropicStopReason(chunk.reason),
						stop_sequence: null
					},
					usage: {
						input_tokens: this.usage?.inputTokens ?? 0,
						output_tokens: this.usage?.outputTokens ?? 0
					}
				}));
				events.push(sseEvent("message_stop", { type: "message_stop" }));
				this.finished = true;
				return events;
			}
			default: return [];
		}
	}
	/** 某个块是否已经打开。 */
	isOpen(blockIndex) {
		return this.blockIndexes.has(blockIndex);
	}
	/**
	* 结束流：补齐未关闭的块，并在上游没有发 finish 时补一个正常结束。
	* @returns 剩余的 Anthropic SSE 事件。
	*/
	end() {
		const events = [];
		for (const [blockIndex, index] of this.blockIndexes) {
			if (this.closedBlocks.has(blockIndex)) continue;
			this.closedBlocks.add(blockIndex);
			events.push(sseEvent("content_block_stop", {
				type: "content_block_stop",
				index
			}));
		}
		if (!this.finished) {
			this.finished = true;
			events.push(sseEvent("message_delta", {
				type: "message_delta",
				delta: {
					stop_reason: "end_turn",
					stop_sequence: null
				},
				usage: {
					input_tokens: this.usage?.inputTokens ?? 0,
					output_tokens: this.usage?.outputTokens ?? 0
				}
			}));
			events.push(sseEvent("message_stop", { type: "message_stop" }));
		}
		return events;
	}
};
/**
* Anthropic 模型列表响应。
* @param models - 当前可用模型。
*/
function anthropicModelList(models) {
	const data = models.map((model) => ({
		type: "model",
		id: model.id,
		display_name: model.name ?? model.id,
		created_at: (/* @__PURE__ */ new Date(0)).toISOString()
	}));
	return {
		data,
		has_more: false,
		first_id: data[0]?.id ?? null,
		last_id: data.at(-1)?.id ?? null
	};
}

//#endregion
//#region lib/types/gateway/openai.js
/** 把 OpenAI content 字段解析成核心内容块。 */
function contentBlocks(content) {
	if (content === null || content === void 0) return [];
	if (typeof content === "string") return content.length === 0 ? [] : [{
		type: "text",
		text: content
	}];
	if (!Array.isArray(content)) throw new HttpError(400, "message.content must be a string or an array of content parts");
	const blocks = [];
	for (const raw of content) {
		if (typeof raw !== "object" || raw === null) continue;
		const part = raw;
		if (part["type"] === "text" || part["type"] === "input_text") {
			if (typeof part["text"] === "string" && part["text"].length > 0) blocks.push({
				type: "text",
				text: part["text"]
			});
			continue;
		}
		if (part["type"] === "image_url" || part["type"] === "input_image") {
			const imageValue = part["image_url"] ?? part["image"];
			const url = typeof imageValue === "string" ? imageValue : typeof imageValue === "object" && imageValue !== null ? imageValue["url"] : void 0;
			if (typeof url !== "string") throw new HttpError(400, "image_url content part requires a url");
			blocks.push({
				type: "image",
				image: parseImageDataUrl(url)
			});
			continue;
		}
		throw new HttpError(400, `Unsupported content part type ${String(part["type"])}`);
	}
	return blocks;
}
/** 把 OpenAI `tool_calls` 解析成核心工具调用块。 */
function toolCallBlocks(value) {
	if (!Array.isArray(value)) return [];
	const blocks = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const call = raw;
		const fn = typeof call["function"] === "object" && call["function"] !== null ? call["function"] : void 0;
		const name = typeof fn?.["name"] === "string" ? fn["name"] : "";
		if (name.length === 0) continue;
		const args = typeof fn?.["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn?.["arguments"] ?? {});
		blocks.push({
			type: "tool-call",
			id: typeof call["id"] === "string" && call["id"].length > 0 ? call["id"] : newId("call_"),
			name,
			arguments: args
		});
	}
	return blocks;
}
/** 把 OpenAI 工具声明解析成核心工具声明。 */
function toolSchemas(value) {
	if (!Array.isArray(value)) return void 0;
	const tools = [];
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) continue;
		const tool = raw;
		if (tool["type"] !== "function") continue;
		const fn = typeof tool["function"] === "object" && tool["function"] !== null ? tool["function"] : void 0;
		const name = typeof fn?.["name"] === "string" ? fn["name"].trim() : "";
		if (name.length === 0) continue;
		tools.push({
			name,
			description: typeof fn?.["description"] === "string" ? fn["description"] : "",
			parameters: typeof fn?.["parameters"] === "object" && fn["parameters"] !== null ? fn["parameters"] : {
				type: "object",
				properties: {}
			}
		});
	}
	return tools.length === 0 ? void 0 : tools;
}
/**
* 选择本次请求实际发往 Kiro 的模型。
* @param body - OpenAI 请求体。
* @param options - 网关上下文。
*/
function selectModel(body, options) {
	const requested = typeof body["model"] === "string" ? body["model"].trim() : "";
	return requested.length > 0 ? requested : options.defaultModel.length > 0 ? options.defaultModel : options.models[0]?.id ?? "auto";
}
/**
* 把 OpenAI 请求翻译成核心请求。
* @param body - 已解析的请求体。
* @param options - 网关上下文。
* @returns 核心请求。
* @throws `HttpError(400)` 当字段结构不合法时。
*/
function toChatRequest(body, options) {
	const rawMessages = body["messages"];
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw new HttpError(400, "messages must be a non-empty array");
	const messages = [];
	const systemParts = [];
	for (const raw of rawMessages) {
		if (typeof raw !== "object" || raw === null) throw new HttpError(400, "each message must be an object");
		const message = raw;
		const role = message["role"];
		if (role === "system" || role === "developer") {
			const blocks = contentBlocks(message["content"]);
			if (blocks.some((block) => block.type === "image")) throw new HttpError(400, "system messages cannot contain images");
			const text$3 = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			if (text$3.length > 0) systemParts.push(text$3);
			continue;
		}
		if (role === "user") {
			messages.push({
				role: "user",
				content: contentBlocks(message["content"])
			});
			continue;
		}
		if (role === "assistant") {
			messages.push({
				role: "assistant",
				content: [...contentBlocks(message["content"]), ...toolCallBlocks(message["tool_calls"])]
			});
			continue;
		}
		if (role === "tool") {
			if (typeof message["tool_call_id"] !== "string" || message["tool_call_id"].length === 0) throw new HttpError(400, "tool messages require tool_call_id");
			messages.push({
				role: "tool",
				toolCallId: message["tool_call_id"],
				content: contentBlocks(message["content"])
			});
			continue;
		}
		throw new HttpError(400, `Unsupported message role ${String(role)}`);
	}
	if (messages.length === 0) throw new HttpError(400, "messages must contain at least one user, assistant, or tool message");
	const maxTokens = typeof body["max_completion_tokens"] === "number" ? body["max_completion_tokens"] : typeof body["max_tokens"] === "number" ? body["max_tokens"] : void 0;
	const reasoningEffort = typeof body["reasoning_effort"] === "string" && body["reasoning_effort"].length > 0 ? body["reasoning_effort"] : void 0;
	const tools = toolSchemas(body["tools"]);
	const stop = stopSequences(body["stop"]);
	const sessionId = options.sessionId ?? (typeof body["user"] === "string" && body["user"].length > 0 ? body["user"] : void 0);
	const system = [...typeof body["system"] === "string" && body["system"].length > 0 ? [body["system"]] : [], ...systemParts].join("\n\n");
	return {
		model: selectModel(body, options),
		messages,
		...system.length === 0 ? {} : { system },
		...tools === void 0 ? {} : { tools },
		...maxTokens === void 0 ? {} : { maxTokens },
		...reasoningEffort === void 0 ? {} : { reasoningEffort },
		...stop === void 0 ? {} : { stop },
		...sessionId === void 0 ? {} : { sessionId }
	};
}
/** OpenAI finish_reason 词汇。 */
function openAIFinishReason(reason) {
	switch (reason.kind) {
		case "tool-calls": return "tool_calls";
		case "max-tokens": return "length";
		default: return "stop";
	}
}
/** OpenAI usage 对象。 */
function openAIUsage(usage) {
	if (usage === void 0) return void 0;
	return {
		prompt_tokens: usage.inputTokens,
		completion_tokens: usage.outputTokens,
		total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
		...usage.cacheReadTokens === void 0 ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
	};
}
/** 流式编码器的状态。 */
var OpenAIStreamEncoder = class {
	/** 本次补全 id。 */
	id = newId("chatcmpl-");
	/** 创建时间（秒）。 */
	created = Math.floor(Date.now() / 1e3);
	model;
	roleSent = false;
	usage;
	toolIndexes = /* @__PURE__ */ new Map();
	constructor(model) {
		this.model = model;
	}
	/** 构造一个 chunk 外壳。 */
	chunk(delta, finishReason) {
		return {
			id: this.id,
			object: "chat.completion.chunk",
			created: this.created,
			model: this.model,
			choices: [{
				index: 0,
				delta,
				finish_reason: finishReason
			}]
		};
	}
	/**
	* 编码一个核心块。
	* @param chunk - 核心流式块。
	* @returns 需要写出的 SSE 帧；不需要输出时为空数组。
	*/
	push(chunk) {
		switch (chunk.type) {
			case "block-start":
				if (this.roleSent) return [];
				this.roleSent = true;
				return [sseData(this.chunk({
					role: "assistant",
					content: ""
				}, null))];
			case "text-delta":
				if (chunk.text.length === 0) return [];
				return [sseData(this.chunk({ content: chunk.text }, null))];
			case "reasoning-delta":
				if (chunk.text.length === 0) return [];
				return [sseData(this.chunk({ reasoning_content: chunk.text }, null))];
			case "tool-call-delta": {
				let toolIndex = this.toolIndexes.get(chunk.id);
				const first = toolIndex === void 0;
				if (toolIndex === void 0) {
					toolIndex = this.toolIndexes.size;
					this.toolIndexes.set(chunk.id, toolIndex);
				}
				return [sseData(this.chunk({ tool_calls: [{
					index: toolIndex,
					...first ? {
						id: chunk.id,
						type: "function"
					} : {},
					function: {
						...first && chunk.name !== void 0 ? { name: chunk.name } : {},
						...chunk.argumentsDelta.length === 0 ? {} : { arguments: chunk.argumentsDelta }
					}
				}] }, null))];
			}
			case "usage":
				this.usage = chunk.usage;
				return [];
			case "finish": {
				const failure = finishFailure(chunk.reason);
				if (failure !== void 0) return [sseData({ error: {
					message: failure.message,
					type: "api_error",
					code: failure.code
				} }), sseData("[DONE]")];
				return [sseData(this.chunk({}, openAIFinishReason(chunk.reason)))];
			}
			default: return [];
		}
	}
	/**
	* 结束流：按需补 finish 帧、usage 帧与 `[DONE]`。
	* @param includeUsage - 是否输出 usage（`stream_options.include_usage`）。
	*/
	end(includeUsage, finished) {
		const frames = [];
		if (!finished) frames.push(sseData(this.chunk({}, "stop")));
		const usage = openAIUsage(this.usage);
		if (includeUsage && usage !== void 0) frames.push(sseData({
			id: this.id,
			object: "chat.completion.chunk",
			created: this.created,
			model: this.model,
			choices: [],
			usage
		}));
		frames.push(sseData("[DONE]"));
		return frames;
	}
};
/**
* 构造非流式 OpenAI 响应。
* @param model - 实际使用的模型。
* @param response - 聚合后的核心响应。
*/
function openAICompletion(model, response) {
	const text$3 = response.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
	const reasoning = response.blocks.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
	const toolCalls = response.blocks.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	const usage = openAIUsage(response.usage);
	return {
		id: newId("chatcmpl-"),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1e3),
		model,
		choices: [{
			index: 0,
			message: {
				role: "assistant",
				content: text$3.length > 0 ? text$3 : null,
				...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
				...toolCalls.length === 0 ? {} : { tool_calls: toolCalls }
			},
			finish_reason: openAIFinishReason(response.finish)
		}],
		...usage === void 0 ? {} : { usage }
	};
}

//#endregion
//#region lib/types/gateway/server.js
/** 管理 API 成功响应。 */
function ok(value) {
	return {
		ok: true,
		value
	};
}
/** 从请求头或查询参数读取令牌。 */
function presentedToken(request$2, url) {
	const authorization = request$2.headers.authorization;
	if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
	const apiKey = request$2.headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey.trim().length > 0) return apiKey.trim();
	const admin = request$2.headers["x-admin-token"];
	if (typeof admin === "string" && admin.trim().length > 0) return admin.trim();
	const query = url.searchParams.get("token");
	return query === null || query.length === 0 ? void 0 : query;
}
/** 恒定时间比较，避免通过响应时间猜测令牌。 */
function secureEqual(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}
/** 判断模型端点是否通过鉴权。 */
function modelAuthorized(request$2, url, expected) {
	if (expected.length === 0) return true;
	const token = presentedToken(request$2, url);
	return token !== void 0 && secureEqual(token, expected);
}
/** 判断管理端点是否通过鉴权；`/api/health` 永远公开。 */
function adminAuthorized(request$2, url, expected) {
	if (expected.length === 0) return true;
	const token = presentedToken(request$2, url);
	return token !== void 0 && secureEqual(token, expected);
}
/** 发送管理 API 错误。 */
function sendAdminError(response, error) {
	sendJson(response, statusForError(error), {
		ok: false,
		error: error instanceof Error ? error.message : String(error)
	});
}
/** 默认静态目录：源码运行时是 `src/gateway`，构建后是 `lib/gateway`。 */
function defaultWebDir() {
	return resolve(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "web"));
}
/** 静态资源的 Content-Type。 */
const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon"
};
/**
* 返回静态文件，拒绝越出 web 目录的路径。
* @param response - 响应对象。
* @param webDir - 静态目录。
* @param pathname - 请求路径。
*/
async function serveStatic(response, webDir, pathname) {
	const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/u, "");
	if (relative.length === 0 || relative.startsWith("..") || relative.includes(`..${sep}`)) {
		sendText(response, 400, "Bad path");
		return;
	}
	const root = resolve(webDir);
	const file = resolve(root, relative);
	if (file !== root && !file.startsWith(root + sep)) {
		sendText(response, 400, "Bad path");
		return;
	}
	let body;
	try {
		body = await readFile(file);
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || code === "EISDIR") {
			if (extname(relative).length === 0) {
				await serveStatic(response, root, "/");
				return;
			}
			sendText(response, 404, "Not found");
			return;
		}
		throw error;
	}
	response.writeHead(200, {
		"content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff"
	});
	response.end(body);
}
/** 读取的模型列表，失败时退回家目录。 */
async function listModels(service$1) {
	try {
		return await service$1.client.listModels(AbortSignal.timeout(15e3));
	} catch {
		return service$1.connection().models;
	}
}
/** 向 SSE 响应写一帧；连接已断开时返回 false。 */
function writeFrame(response, frame) {
	if (response.writableEnded || response.destroyed) return false;
	return response.write(frame);
}
/**
* 处理 OpenAI 流式补全。
* @param service - 网关服务。
* @param request - 核心请求。
* @param includeUsage - 是否输出 usage。
* @param response - HTTP 响应。
* @param signal - 客户端断开信号。
*/
async function streamOpenAI(service$1, request$2, includeUsage, response, signal) {
	const iterator = service$1.client.stream({
		...request$2,
		signal
	})[Symbol.asyncIterator]();
	let first;
	try {
		first = await iterator.next();
	} catch (error) {
		sendJson(response, statusForError(error), openAIErrorBody(error));
		return;
	}
	writeSseHead(response);
	const encoder = new OpenAIStreamEncoder(request$2.model);
	let finished = false;
	let failed = false;
	try {
		if (!first.done) {
			if (first.value.type === "finish") finished = true;
			for (const frame of encoder.push(first.value)) if (!writeFrame(response, frame)) return;
		}
		while (true) {
			const next = await iterator.next();
			if (next.done) break;
			if (next.value.type === "finish") finished = true;
			for (const frame of encoder.push(next.value)) if (!writeFrame(response, frame)) return;
		}
	} catch (error) {
		failed = true;
		if (writeFrame(response, sseData(openAIErrorBody(error)))) writeFrame(response, sseData("[DONE]"));
	} finally {
		if (!failed && !response.destroyed) for (const frame of encoder.end(includeUsage, finished)) writeFrame(response, frame);
		if (!response.destroyed) response.end();
	}
}
/**
* 处理 Anthropic 流式消息。
* @param service - 网关服务。
* @param request - 核心请求。
* @param response - HTTP 响应。
* @param signal - 客户端断开信号。
*/
async function streamAnthropic(service$1, request$2, response, signal) {
	const iterator = service$1.client.stream({
		...request$2,
		signal
	})[Symbol.asyncIterator]();
	let first;
	try {
		first = await iterator.next();
	} catch (error) {
		sendJson(response, statusForError(error), anthropicErrorBody(error));
		return;
	}
	writeSseHead(response);
	const encoder = new AnthropicStreamEncoder(request$2.model);
	for (const frame of encoder.start()) if (!writeFrame(response, frame)) return;
	let failed = false;
	try {
		if (!first.done) {
			for (const frame of encoder.push(first.value)) if (!writeFrame(response, frame)) return;
		}
		while (true) {
			const next = await iterator.next();
			if (next.done) break;
			for (const frame of encoder.push(next.value)) if (!writeFrame(response, frame)) return;
		}
	} catch (error) {
		failed = true;
		const body = anthropicErrorBody(error);
		writeFrame(response, `event: error\ndata: ${JSON.stringify(body)}\n\n`);
	} finally {
		if (!failed && !response.destroyed) for (const frame of encoder.end()) writeFrame(response, frame);
		if (!response.destroyed) response.end();
	}
}
/**
* 创建网关 HTTP 服务器。
* @param service - 网关服务。
* @param options - 静态目录与重启回调。
* @returns 未监听的 Node HTTP server。
*/
function createGatewayServer(service$1, options = {}) {
	const webDir = options.webDir ?? defaultWebDir();
	return createServer((request$2, response) => {
		handle(request$2, response).catch((error) => {
			if (response.headersSent) {
				response.end();
				return;
			}
			const status = statusForError(error);
			const path = (request$2.url ?? "/").split("?")[0] ?? "/";
			if (path === "/v1/messages" || path.startsWith("/anthropic")) sendJson(response, status, anthropicErrorBody(error));
			else if (path.startsWith("/v1/")) sendJson(response, status, openAIErrorBody(error));
			else sendJson(response, status, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		});
	});
	async function handle(request$2, response) {
		response.on("error", () => {});
		const url = new URL(request$2.url ?? "/", "http://gateway.local");
		const path = url.pathname;
		const method = request$2.method ?? "GET";
		const config$1 = service$1.currentConfig;
		if (method === "OPTIONS") {
			response.writeHead(204, {
				"access-control-allow-origin": "*",
				"access-control-allow-headers": "authorization, content-type, x-api-key, x-admin-token, x-session-id, anthropic-version, anthropic-beta",
				"access-control-allow-methods": "GET, POST, OPTIONS"
			});
			response.end();
			return;
		}
		response.setHeader("access-control-allow-origin", "*");
		if (path === "/api/health" && method === "GET") {
			sendJson(response, 200, ok({
				status: "ok",
				version: 1,
				authenticated: (await service$1.status()).authenticated
			}));
			return;
		}
		if (path.startsWith("/api/")) {
			if (!adminAuthorized(request$2, url, config$1.adminToken)) {
				sendJson(response, 401, {
					ok: false,
					error: "Unauthorized"
				});
				return;
			}
			await handleAdmin(request$2, response, url);
			return;
		}
		if (path === "/v1/models" && method === "GET") {
			if (!modelAuthorized(request$2, url, config$1.apiKey)) {
				sendJson(response, 401, openAIErrorBody(new HttpError(401, "Unauthorized", "authentication_error")));
				return;
			}
			sendJson(response, 200, {
				object: "list",
				data: (await listModels(service$1)).map((model) => ({
					id: model.id,
					object: "model",
					created: 0,
					owned_by: "kiro",
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { context_window: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { max_tokens: model.maxTokens },
					...model.inputModalities === void 0 ? {} : { input_modalities: model.inputModalities },
					...model.reasoningEfforts === void 0 ? {} : { reasoning_efforts: model.reasoningEfforts }
				}))
			});
			return;
		}
		if (path === "/v1/chat/completions" && method === "POST") {
			if (!modelAuthorized(request$2, url, config$1.apiKey)) {
				sendJson(response, 401, openAIErrorBody(new HttpError(401, "Unauthorized", "authentication_error")));
				return;
			}
			const body = await readJson(request$2);
			const models = await listModels(service$1);
			const sessionId = typeof request$2.headers["x-session-id"] === "string" ? request$2.headers["x-session-id"] : void 0;
			const chatRequest = toChatRequest(body, {
				defaultModel: config$1.defaultModel,
				models,
				...sessionId === void 0 ? {} : { sessionId }
			});
			const controller = new AbortController();
			response.on("close", () => {
				if (!response.writableEnded) controller.abort("client disconnected");
			});
			chatRequest.signal = controller.signal;
			if (body["stream"] === true) {
				await streamOpenAI(service$1, chatRequest, (typeof body["stream_options"] === "object" && body["stream_options"] !== null ? body["stream_options"] : void 0)?.["include_usage"] === true, response, controller.signal);
				return;
			}
			const collected = await collectResponse(await service$1.client.stream(chatRequest));
			const failure = finishFailure(collected.finish);
			if (failure !== void 0) throw new HttpError(failure.status ?? 502, failure.message, failure.code);
			sendJson(response, 200, openAICompletion(chatRequest.model, collected));
			return;
		}
		if ((path === "/anthropic/v1/models" || path === "/v1/models/anthropic") && method === "GET") {
			if (!modelAuthorized(request$2, url, config$1.apiKey)) {
				sendJson(response, 401, anthropicErrorBody(new HttpError(401, "Unauthorized")));
				return;
			}
			sendJson(response, 200, anthropicModelList(await listModels(service$1)));
			return;
		}
		if ((path === "/anthropic/v1/messages" || path === "/v1/messages") && method === "POST") {
			if (!modelAuthorized(request$2, url, config$1.apiKey)) {
				sendJson(response, 401, anthropicErrorBody(new HttpError(401, "Unauthorized")));
				return;
			}
			const body = await readJson(request$2);
			const models = await listModels(service$1);
			const effort = typeof request$2.headers["x-kiro-reasoning-effort"] === "string" ? request$2.headers["x-kiro-reasoning-effort"] : void 0;
			const chatRequest = toAnthropicChatRequest(body, {
				defaultModel: config$1.defaultModel,
				models,
				...effort === void 0 ? {} : { reasoningEffort: effort }
			});
			const controller = new AbortController();
			response.on("close", () => {
				if (!response.writableEnded) controller.abort("client disconnected");
			});
			chatRequest.signal = controller.signal;
			if (body["stream"] === true) {
				await streamAnthropic(service$1, chatRequest, response, controller.signal);
				return;
			}
			const collected = await collectResponse(service$1.client.stream(chatRequest));
			const failure = finishFailure(collected.finish);
			if (failure !== void 0) throw new HttpError(failure.status ?? 502, failure.message, failure.code);
			sendJson(response, 200, anthropicMessage(chatRequest.model, collected));
			return;
		}
		if (path.startsWith("/api/")) {
			sendJson(response, 404, {
				ok: false,
				error: "not-found"
			});
			return;
		}
		if (method === "GET" || method === "HEAD") {
			await serveStatic(response, webDir, path);
			return;
		}
		sendText(response, 405, "Method not allowed");
	}
	/** 管理 API 路由。 */
	async function handleAdmin(request$2, response, url) {
		const path = url.pathname.replace(/^\/api\/?/u, "");
		const method = request$2.method ?? "GET";
		try {
			if (path === "status" && method === "GET") {
				sendJson(response, 200, ok(await service$1.status()));
				return;
			}
			if (path === "config" && method === "GET") {
				sendJson(response, 200, ok(service$1.currentPublicConfig()));
				return;
			}
			if (path === "config" && (method === "POST" || method === "PUT")) {
				const before = service$1.currentConfig;
				const body = await readJson(request$2);
				const next = await service$1.updateConfig(body);
				sendJson(response, 200, ok({
					config: next,
					restartRequired: next.port !== before.port || next.host !== before.host
				}));
				return;
			}
			if (path === "restart" && method === "POST") {
				if (options.restart === void 0) {
					sendJson(response, 400, {
						ok: false,
						error: "This process cannot restart itself"
					});
					return;
				}
				sendJson(response, 200, ok({ restarting: true }));
				setTimeout(() => {
					options.restart?.();
				}, 100);
				return;
			}
			if (path === "context" && method === "POST") {
				const raw = (await readJson(request$2))["maxContextWindow"];
				if (raw !== null && raw !== void 0 && (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)) throw new HttpError(400, "maxContextWindow must be a positive integer or null");
				await service$1.updateConfig({ maxContextWindow: typeof raw === "number" ? raw : null });
				sendJson(response, 200, ok(await service$1.status()));
				return;
			}
			if (path === "login" && method === "POST") {
				sendJson(response, 200, ok(await service$1.startLogin(await readJson(request$2))));
				return;
			}
			if (path === "login/cancel" && method === "POST") {
				service$1.cancelLogin();
				sendJson(response, 200, ok(await service$1.status()));
				return;
			}
			if (path === "credentials/import" && method === "POST") {
				sendJson(response, 200, ok(await service$1.importCredential(await readJson(request$2))));
				return;
			}
			if (path === "logout" && method === "POST") {
				sendJson(response, 200, ok(await service$1.logout()));
				return;
			}
			if (path === "accounts" && method === "GET") {
				sendJson(response, 200, ok((await service$1.status()).accounts));
				return;
			}
			if (path === "accounts/activate" && method === "POST") {
				const body = await readJson(request$2);
				const accountId = typeof body["accountId"] === "string" ? body["accountId"] : "";
				if (accountId.length === 0) throw new HttpError(400, "accountId is required");
				const revision = typeof body["revision"] === "number" ? body["revision"] : void 0;
				sendJson(response, 200, ok(await service$1.activateAccount(accountId, revision)));
				return;
			}
			if (path === "accounts/remove" && method === "POST") {
				const body = await readJson(request$2);
				const accountId = typeof body["accountId"] === "string" ? body["accountId"] : "";
				if (accountId.length === 0) throw new HttpError(400, "accountId is required");
				sendJson(response, 200, ok(await service$1.removeAccount(accountId, {
					...typeof body["replacementId"] === "string" ? { replacementId: body["replacementId"] } : {},
					...typeof body["revision"] === "number" ? { revision: body["revision"] } : {}
				})));
				return;
			}
			if (path === "models" && method === "GET") {
				sendJson(response, 200, ok(await service$1.modelPayload()));
				return;
			}
			if (path === "models" && method === "POST") {
				const ids = (await readJson(request$2))["enabledModelIds"];
				if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new HttpError(400, "enabledModelIds must be an array of strings");
				sendJson(response, 200, ok(await service$1.setEnabledModels(ids)));
				return;
			}
			if (path === "models/refresh" && method === "POST") {
				sendJson(response, 200, ok(await service$1.refreshModels()));
				return;
			}
			if (path === "usage" && (method === "GET" || method === "POST")) {
				sendJson(response, 200, ok(await service$1.getUsage(method === "POST")));
				return;
			}
			sendJson(response, 404, {
				ok: false,
				error: "not-found"
			});
		} catch (error) {
			sendAdminError(response, error);
		}
	}
}

//#endregion
//#region lib/types/accounts.js
/** Document holding every account this plugin owns, inside the credential directory. */
const KIRO_ACCOUNTS_FILE = "accounts.json";
/** Single-credential file earlier versions wrote, and the CLI still writes. */
const KIRO_LEGACY_TOKEN_FILE = "kiro-auth-token.json";
/** Most accounts one installation may store. */
const MAX_KIRO_ACCOUNTS = 16;
/** Largest accepted account document. */
const KIRO_ACCOUNT_DOCUMENT_LIMIT = 512 * 1024;
/** Longest accepted raw credential record. */
const CREDENTIAL_LIMIT = 64 * 1024;
/** How long a mutation waits for another process to release the document lock. */
const LOCK_TIMEOUT_MS = 15e3;
/** Age at which an ownerless lock directory is treated as abandoned. */
const LOCK_ORPHAN_MS = 3e4;
/** Shape of a locally generated account identifier. */
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
/** Labels for the methods Kiro and this plugin write. */
const METHOD_LABELS = {
	"builder-id": "AWS Builder ID",
	idc: "AWS IAM Identity Center",
	google: "Google",
	github: "GitHub",
	social: "Kiro social sign-in",
	imported: "Imported refresh token",
	api_key: "API key",
	external_idp: "External IdP"
};
/**
* Human label for an account that was not given one.
* @param authMethod - the account recorded method.
* @param region - the account region, when known.
* @returns a label naming the method and region.
*/
function defaultAccountLabel(authMethod, region) {
	const name = METHOD_LABELS[authMethod] ?? authMethod;
	return region === void 0 || region.length === 0 ? name : name + " · " + region;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(value, max) {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : void 0;
}
function safeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function fail(message, code) {
	const error = new Error(message);
	error.code = code;
	throw error;
}
/** Reject a credential file one other user could read or write. */
function assertPrivateFile(stat$1, what) {
	if (!stat$1.isFile()) fail("Kiro " + what + " is not a regular file", "UNSAFE_ACCOUNT_STORE");
	/* v8 ignore next 2 -- Windows cannot express POSIX ownership or mode */
	if (process.platform === "win32") return;
	if (typeof process.getuid === "function" && stat$1.uid !== process.getuid()) fail("Kiro " + what + " is owned by another user", "UNSAFE_ACCOUNT_STORE");
	if ((stat$1.mode & 63) !== 0) fail("Kiro " + what + " is readable beyond its owner; run chmod 600 on it before starting again", "UNSAFE_ACCOUNT_STORE");
}
/** Reject a credential directory one other user could write. */
function assertPrivateDirectory(stat$1, what) {
	if (!stat$1.isDirectory()) fail("Kiro " + what + " is not a directory", "UNSAFE_ACCOUNT_STORE");
	/* v8 ignore next 2 -- Windows cannot express POSIX ownership or mode */
	if (process.platform === "win32") return;
	if (typeof process.getuid === "function" && stat$1.uid !== process.getuid()) fail("Kiro " + what + " is owned by another user", "UNSAFE_ACCOUNT_STORE");
	if ((stat$1.mode & 18) !== 0) fail("Kiro " + what + " is writable beyond its owner", "UNSAFE_ACCOUNT_STORE");
}
/** Read one bounded, owner-only file, or null when it is absent. */
async function readPrivateFile(path, what, limit) {
	let handle;
	try {
		const before = await lstat(path);
		assertPrivateFile(before, what);
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		assertPrivateFile(opened, what);
		if (before.ino !== opened.ino || before.dev !== opened.dev) fail("Kiro " + what + " changed while it was being opened", "UNSAFE_ACCOUNT_STORE");
		if (opened.size > limit) fail("Kiro " + what + " exceeds " + String(limit) + " bytes", "INVALID_ACCOUNT_STORE");
		const buffer = Buffer.alloc(limit + 1);
		let used = 0;
		while (used < buffer.length) {
			const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		if (used > limit) fail("Kiro " + what + " exceeds " + String(limit) + " bytes", "INVALID_ACCOUNT_STORE");
		return buffer.subarray(0, used).toString("utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	} finally {
		await handle?.close();
	}
}
/** Normalize and bound one raw credential record without interpreting its tokens. */
function parseCredential(value, what) {
	if (!isRecord(value)) fail("Kiro " + what + " must be a JSON object", "INVALID_ACCOUNT_STORE");
	let serialized;
	try {
		serialized = JSON.stringify(value);
	} catch {
		fail("Kiro " + what + " is not serializable", "INVALID_ACCOUNT_STORE");
	}
	if (Buffer.byteLength(serialized) > CREDENTIAL_LIMIT) fail("Kiro " + what + " exceeds " + String(CREDENTIAL_LIMIT) + " bytes", "INVALID_ACCOUNT_STORE");
	const access = boundedText(value["accessToken"] ?? value["access_token"], 65536);
	const refresh$1 = boundedText(value["refreshToken"] ?? value["refresh_token"], 65536);
	const region = boundedText(value["region"], 64);
	const profileArn = boundedText(value["profileArn"] ?? value["profile_arn"], 2048);
	const method = boundedText(value["authMethod"] ?? value["auth_method"], 64);
	const rawExpiry = value["expiresAt"] ?? value["expires_at"] ?? value["expired"];
	const parsedExpiry = typeof rawExpiry === "string" ? Date.parse(rawExpiry) : NaN;
	const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : void 0;
	return {
		credential: structuredClone(value),
		...method === void 0 ? {} : { authMethod: method },
		...region === void 0 ? {} : { region },
		...profileArn === void 0 ? {} : { profileArn },
		...expiresAt === void 0 ? {} : { expiresAt },
		refreshable: refresh$1 !== void 0 || method === "api_key",
		authenticated: access !== void 0 || refresh$1 !== void 0
	};
}
/** Validate one stored account record. */
function parseAccount(value, index) {
	const what = "account record " + String(index);
	if (!isRecord(value)) fail("Kiro " + what + " must be a JSON object", "INVALID_ACCOUNT_STORE");
	const id = boundedText(value["id"], 128);
	if (id === void 0 || !idPattern.test(id)) fail("Kiro " + what + " has an invalid id", "INVALID_ACCOUNT_STORE");
	const label = boundedText(value["label"], 320);
	if (label === void 0) fail("Kiro " + what + " has an invalid label", "INVALID_ACCOUNT_STORE");
	const createdAt = safeInteger(value["createdAt"]);
	const updatedAt = safeInteger(value["updatedAt"]);
	const credentialRevision = safeInteger(value["credentialRevision"]);
	if (createdAt === void 0 || updatedAt === void 0 || updatedAt < createdAt || credentialRevision === void 0) fail("Kiro " + what + " has invalid timestamps or revision", "INVALID_ACCOUNT_STORE");
	const parsed = parseCredential(value["credential"], what + " credential");
	const region = boundedText(value["region"], 64);
	const profileArn = boundedText(value["profileArn"], 2048);
	const authMethod = boundedText(value["authMethod"], 64) ?? parsed.authMethod;
	if (authMethod === void 0) fail("Kiro " + what + " names no authentication method", "INVALID_ACCOUNT_STORE");
	return {
		id,
		label,
		authMethod,
		...region === void 0 ? {} : { region },
		...profileArn === void 0 ? {} : { profileArn },
		createdAt,
		updatedAt,
		credentialRevision,
		credential: parsed.credential
	};
}
/** Validate a whole document, returning it unchanged. */
function parseDocument(value) {
	if (!isRecord(value) || value["version"] !== 1) fail("Kiro account document has an unsupported format version", "INVALID_ACCOUNT_STORE");
	const revision = safeInteger(value["revision"]);
	const accounts = value["accounts"];
	if (revision === void 0 || !Array.isArray(accounts)) fail("Kiro account document is malformed", "INVALID_ACCOUNT_STORE");
	if (accounts.length > MAX_KIRO_ACCOUNTS) fail("Kiro account document holds more than " + String(MAX_KIRO_ACCOUNTS) + " accounts", "INVALID_ACCOUNT_STORE");
	const parsed = accounts.map(parseAccount);
	const ids = new Set(parsed.map((account) => account.id));
	if (ids.size !== parsed.length) fail("Kiro account document repeats an account id", "INVALID_ACCOUNT_STORE");
	const active = value["activeAccountId"];
	if (active !== null && (typeof active !== "string" || !ids.has(active))) fail("Kiro account document names an active account it does not hold", "INVALID_ACCOUNT_STORE");
	if (parsed.length === 0 && active !== null) fail("Kiro account document names an active account while holding none", "INVALID_ACCOUNT_STORE");
	return {
		version: 1,
		revision,
		activeAccountId: active,
		accounts: parsed
	};
}
/** Summarize one stored account for the settings page. */
function summarize(account, activeAccountId, now) {
	const parsed = parseCredential(account.credential, "account " + account.id + " credential");
	const state = account.authMethod === "api_key" ? parsed.authenticated ? "ready" : "unusable" : parsed.expiresAt !== void 0 && parsed.expiresAt > now ? "ready" : parsed.refreshable ? "refresh-required" : "unusable";
	return {
		id: account.id,
		label: account.label,
		authMethod: account.authMethod,
		...account.region === void 0 ? {} : { region: account.region },
		...account.profileArn === void 0 ? {} : { profileArn: account.profileArn },
		...parsed.expiresAt === void 0 ? {} : { expiresAt: parsed.expiresAt },
		active: account.id === activeAccountId,
		createdAt: account.createdAt,
		updatedAt: account.updatedAt,
		credentialRevision: account.credentialRevision,
		state
	};
}
/** The document representing an installation that holds no account yet. */
function emptyDocument() {
	return {
		version: 1,
		revision: 0,
		activeAccountId: null,
		accounts: []
	};
}
/** Stable identifier for the credential a legacy single-file install holds. */
function legacyAccountId(path) {
	return "legacy-" + createHash("sha256").update(path).digest("hex").slice(0, 24);
}
/** Credential-derived facts recorded beside a stored credential. */
function factsOf(parsed) {
	return {
		...parsed.authMethod === void 0 ? {} : { authMethod: parsed.authMethod },
		...parsed.region === void 0 ? {} : { region: parsed.region },
		...parsed.profileArn === void 0 ? {} : { profileArn: parsed.profileArn }
	};
}
/**
* Owner-only persistent store for every Kiro credential this plugin owns.
*
* Reads are lock-free because writes replace the document atomically; every
* mutation takes a cross-process lock first, so the Web settings page and the
* `kiro-login` CLI can both write without losing each other work.
*/
var KiroAccountStore = class {
	/** Absolute credential directory this store owns. */
	directory;
	constructor(directory) {
		if (typeof directory !== "string" || directory.length === 0) fail("Kiro account store requires a directory", "INVALID_ACCOUNT_STORE");
		this.directory = resolve(directory);
	}
	/** Absolute path of the account document. */
	get documentPath() {
		return join(this.directory, KIRO_ACCOUNTS_FILE);
	}
	/** Absolute path of the single-credential file earlier versions wrote. */
	get legacyPath() {
		return join(this.directory, KIRO_LEGACY_TOKEN_FILE);
	}
	/** Absolute path of one account device-registration file. */
	registrationPath(clientIdHash) {
		return join(this.directory, clientIdHash + ".json");
	}
	/** Whether the multi-account document exists, written or empty. */
	async exists() {
		return await readPrivateFile(this.documentPath, "account document", KIRO_ACCOUNT_DOCUMENT_LIMIT) !== null;
	}
	/**
	* Create the credential directory, make it owner-only, and verify no
	* component of its path is shared.
	*/
	async ensureDirectory() {
		await mkdir(this.directory, {
			recursive: true,
			mode: 448
		});
		await this.ownDirectory();
		let part = dirname(this.directory);
		while (true) {
			if (!(await stat(part)).isDirectory()) fail("Kiro credential path contains a non-directory component", "UNSAFE_ACCOUNT_STORE");
			const next = dirname(part);
			if (next === part) break;
			part = next;
		}
	}
	/**
	* Require the credential directory to be this user's and owner-only.
	*
	* A wider mode is a leftover rather than an intent: `mkdir` never corrects a
	* directory that already exists, and an earlier release let the model-settings
	* writer create this one with the process umask (`umask 002` leaves it
	* group-writable). Refusing every write over that would leave the installation
	* unable to sign in or sign out at all, so a directory this user owns is
	* tightened instead of rejected.
	*/
	async ownDirectory() {
		let stat$1 = await lstat(this.directory);
		if (!stat$1.isDirectory()) fail("Kiro credential directory is not a directory", "UNSAFE_ACCOUNT_STORE");
		/* v8 ignore next 1 -- Windows cannot express POSIX ownership or mode */
		if (process.platform === "win32") return;
		if (typeof process.getuid === "function" && stat$1.uid !== process.getuid()) fail("Kiro credential directory is owned by another user", "UNSAFE_ACCOUNT_STORE");
		if ((stat$1.mode & 18) !== 0) {
			await chmod(this.directory, 448);
			stat$1 = await lstat(this.directory);
		}
		assertPrivateDirectory(stat$1, "credential directory");
	}
	/**
	* Run one mutation under the document lock, taking over a lock whose owner
	* died on this host and leaving one another host holds alone until it ages out.
	* @param suffix - lock namespace, so account-scoped writes do not serialize with whole-document ones.
	* @param action - the mutation to run while the lock is held.
	* @returns the action result.
	*/
	async withLock(suffix, action) {
		await this.ensureDirectory();
		const folder = `${this.documentPath}.${suffix}.lock`;
		const owner = join(folder, `${String(process.pid)}-${randomUUID()}`);
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) try {
			await mkdir(folder, { mode: 448 });
			const created = await lstat(folder);
			assertPrivateDirectory(created, "account lock");
			const handle = await open(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 384);
			try {
				await handle.writeFile(hostname());
			} finally {
				await handle.close();
			}
			const current = await lstat(folder);
			if (current.ino !== created.ino || current.dev !== created.dev) {
				await unlink(owner).catch(() => void 0);
				continue;
			}
			break;
		} catch (error) {
			const code = error.code;
			if (code !== "EEXIST" && code !== "ENOENT") throw error;
			await this.reapLock(folder).catch(() => void 0);
			if (Date.now() >= deadline) fail("Timed out waiting for the Kiro account lock", "ACCOUNT_LOCK_TIMEOUT");
			await setTimeout$1(15 + Math.floor(Math.random() * 20));
		}
		try {
			return await action();
		} finally {
			await unlink(owner).catch(() => void 0);
			await rmdir(folder).catch(() => void 0);
		}
	}
	/**
	* Remove a lock directory whose owner is gone, or which nobody claimed.
	* @param folder - the lock directory to inspect.
	*/
	async reapLock(folder) {
		const stat$1 = await lstat(folder);
		assertPrivateDirectory(stat$1, "account lock");
		const entries = await readdir(folder);
		if (entries.length === 0) {
			if (Date.now() - stat$1.mtimeMs > LOCK_ORPHAN_MS) await rmdir(folder);
			return;
		}
		if (entries.length !== 1) return;
		const entry = entries[0] ?? "";
		if (!/^\d+-[a-f0-9-]+$/u.test(entry)) return;
		const host = await readPrivateFile(join(folder, entry), "account lock", 1024);
		if (host === null || host !== hostname()) return;
		const pid = Number(entry.split("-")[0]);
		let dead = false;
		try {
			process.kill(pid, 0);
		} catch (error) {
			dead = error.code === "ESRCH";
		}
		if (dead) {
			await unlink(join(folder, entry));
			await rmdir(folder);
		}
	}
	/** Read the document, synthesizing one from the legacy file when needed. */
	async load() {
		const raw = await readPrivateFile(this.documentPath, "account document", KIRO_ACCOUNT_DOCUMENT_LIMIT);
		if (raw !== null) {
			let value;
			try {
				value = JSON.parse(raw);
			} catch {
				fail("Kiro account document is not valid JSON", "INVALID_ACCOUNT_STORE");
			}
			return {
				document: parseDocument(value),
				legacy: false
			};
		}
		const legacyRaw = await readPrivateFile(this.legacyPath, "token file", CREDENTIAL_LIMIT);
		if (legacyRaw === null) return {
			document: emptyDocument(),
			legacy: false
		};
		let legacyValue;
		try {
			legacyValue = JSON.parse(legacyRaw);
		} catch {
			return {
				document: emptyDocument(),
				legacy: false
			};
		}
		if (!isRecord(legacyValue)) return {
			document: emptyDocument(),
			legacy: false
		};
		const parsed = parseCredential(legacyValue, "token file");
		if (!parsed.authenticated) return {
			document: emptyDocument(),
			legacy: false
		};
		const id = legacyAccountId(this.legacyPath);
		const facts = factsOf(parsed);
		const method = facts.authMethod ?? "builder-id";
		return {
			legacy: true,
			document: {
				version: 1,
				revision: 0,
				activeAccountId: id,
				accounts: [{
					id,
					label: defaultAccountLabel(method, facts.region),
					authMethod: method,
					...facts.region === void 0 ? {} : { region: facts.region },
					...facts.profileArn === void 0 ? {} : { profileArn: facts.profileArn },
					createdAt: 0,
					updatedAt: 0,
					credentialRevision: 0,
					credential: parsed.credential
				}]
			}
		};
	}
	/**
	* Replace the document atomically, leaving the legacy file untouched.
	* @param document - the complete document to persist.
	*/
	async save(document) {
		parseDocument(document);
		const serialized = `${JSON.stringify(document, null, 2)}\n`;
		if (Buffer.byteLength(serialized) > KIRO_ACCOUNT_DOCUMENT_LIMIT) fail("Kiro account document exceeds " + String(KIRO_ACCOUNT_DOCUMENT_LIMIT) + " bytes", "INVALID_ACCOUNT_STORE");
		await this.ensureDirectory();
		const temporary = `${this.documentPath}.${String(process.pid)}-${randomUUID()}.tmp`;
		let handle;
		try {
			handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
			await handle.writeFile(serialized);
			await handle.sync();
			await handle.close();
			handle = void 0;
			await rename(temporary, this.documentPath);
			/* v8 ignore next 8 -- the Windows branch cannot run on a POSIX test host */
			if (process.platform !== "win32") {
				const directory = await open(this.directory, constants.O_RDONLY);
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} finally {
			await handle?.close();
			await unlink(temporary).catch(() => void 0);
		}
	}
	/**
	* Run one mutation and persist its result under a new revision.
	* @param action - the mutation, which edits the document in place.
	* @param options - optional revision guard and lock namespace.
	* @returns the action result.
	*/
	async mutate(action, options = {}) {
		return this.withLock(options.suffix ?? "document", async () => {
			const { document } = await this.load();
			if (options.expectedRevision !== void 0 && options.expectedRevision !== document.revision) fail("Kiro accounts changed since they were read; reload before retrying", "REVISION_CONFLICT");
			const result = action(document);
			document.revision += 1;
			await this.save(document);
			return result;
		});
	}
	/**
	* Locate one stored account or fail.
	* @param document - the document to search.
	* @param accountId - the account to find.
	* @returns the stored account.
	*/
	account(document, accountId) {
		const found = document.accounts.find((account) => account.id === accountId);
		if (found === void 0) fail("Kiro account \"" + accountId + "\" is not stored", "ACCOUNT_NOT_FOUND");
		return found;
	}
	/**
	* List every stored account, credential-free.
	* @returns the snapshot the settings page renders.
	*/
	async snapshot() {
		const { document, legacy } = await this.load();
		const now = Date.now();
		return {
			revision: document.revision,
			activeAccountId: document.activeAccountId,
			accounts: document.accounts.map((account) => summarize(account, document.activeAccountId, now)),
			migrated: legacy
		};
	}
	/**
	* Pin one account for a request or a refresh.
	* @param accountId - the account to pin; the active one when omitted.
	* @returns the pinned account, or null when the store holds none.
	*/
	async capture(accountId) {
		const document = (await this.load()).document;
		const target = accountId ?? document.activeAccountId;
		if (target === null) return null;
		const account = this.account(document, target);
		let revision = account.credentialRevision;
		let pending = null;
		return {
			accountId: account.id,
			credentialRevision: revision,
			read: async () => {
				return (await this.load()).document.accounts.find((candidate) => candidate.id === account.id)?.credential;
			},
			modify: (change) => {
				if (pending !== null) return pending;
				pending = this.withLock(`account-${account.id}`, async () => {
					const current = (await this.load()).document.accounts.find((candidate) => candidate.id === account.id);
					if (current === void 0) fail("Kiro account \"" + account.id + "\" was removed", "ACCOUNT_NOT_FOUND");
					if (current.credentialRevision !== revision) {
						revision = current.credentialRevision;
						return structuredClone(current.credential);
					}
					const next = change(structuredClone(current.credential));
					if (next === void 0) return structuredClone(current.credential);
					const parsed = parseCredential(next, "account " + account.id + " credential");
					const facts = factsOf(parsed);
					const written = await this.mutate((document$1) => {
						const stored = this.account(document$1, account.id);
						if (stored.credentialRevision !== current.credentialRevision) fail("Kiro account credentials changed while they were being refreshed", "ACCOUNT_CHANGED");
						stored.credential = parsed.credential;
						stored.credentialRevision += 1;
						stored.updatedAt = Date.now();
						if (facts.authMethod !== void 0) stored.authMethod = facts.authMethod;
						if (facts.region !== void 0) stored.region = facts.region;
						if (facts.profileArn !== void 0) stored.profileArn = facts.profileArn;
						return structuredClone(stored.credential);
					});
					revision = current.credentialRevision + 1;
					return written;
				}).finally(() => {
					pending = null;
				});
				return pending;
			}
		};
	}
	/**
	* Store a credential, updating an existing account or adding one.
	* @param input - the credential and the metadata that names it.
	* @returns the identifier of the account that now holds the credential.
	*/
	async upsert(input) {
		const parsed = parseCredential(input.credential, "credential");
		if (!parsed.authenticated) fail("Kiro credential carries neither an access nor a refresh token", "INVALID_CREDENTIAL");
		const label = input.label === void 0 ? void 0 : boundedText(input.label, 320);
		if (input.label !== void 0 && label === void 0) fail("Kiro account label is unusable", "INVALID_ACCOUNT_STORE");
		return this.mutate((document) => {
			const existing = input.accountId === void 0 ? void 0 : this.account(document, input.accountId);
			const now = Date.now();
			const facts = factsOf(parsed);
			const authMethod = input.authMethod ?? facts.authMethod ?? existing?.authMethod;
			if (authMethod === void 0) fail("Kiro login did not name an authentication method", "INVALID_CREDENTIAL");
			const region = input.region ?? facts.region ?? existing?.region;
			const profileArn = input.profileArn ?? facts.profileArn ?? existing?.profileArn;
			if (existing !== void 0) {
				existing.credential = parsed.credential;
				existing.credentialRevision += 1;
				existing.updatedAt = now;
				existing.authMethod = authMethod;
				if (region !== void 0) existing.region = region;
				if (profileArn !== void 0) existing.profileArn = profileArn;
				if (label !== void 0) existing.label = label;
				if (document.activeAccountId === null || input.activate === true) document.activeAccountId = existing.id;
				return { accountId: existing.id };
			}
			if (document.accounts.length >= MAX_KIRO_ACCOUNTS) fail("Kiro stores at most " + String(MAX_KIRO_ACCOUNTS) + " accounts; remove one first", "ACCOUNT_LIMIT");
			const account = {
				id: randomUUID(),
				label: label ?? defaultAccountLabel(authMethod, region),
				authMethod,
				...region === void 0 ? {} : { region },
				...profileArn === void 0 ? {} : { profileArn },
				createdAt: now,
				updatedAt: now,
				credentialRevision: 0,
				credential: parsed.credential
			};
			document.accounts.push(account);
			if (document.activeAccountId === null || input.activate === true) document.activeAccountId = account.id;
			return { accountId: account.id };
		}, { ...input.expectedRevision === void 0 ? {} : { expectedRevision: input.expectedRevision } });
	}
	/**
	* Select the account later requests use.
	* @param accountId - the account to activate.
	* @param expectedRevision - document revision the caller read, when it wants conflict detection.
	* @returns the activated account identifier.
	*/
	async activate(accountId, expectedRevision) {
		return this.mutate((document) => {
			this.account(document, accountId);
			document.activeAccountId = accountId;
			return { accountId };
		}, { ...expectedRevision === void 0 ? {} : { expectedRevision } });
	}
	/**
	* Remove one account, requiring a replacement when it is the active one and
	* others remain.
	* @param accountId - the account to remove.
	* @param options - replacement choice and optional revision guard.
	* @returns the removed account identifier and its credential, so the caller
	*   can also delete that account device registration.
	*/
	async remove(accountId, options = {}) {
		return this.mutate((document) => {
			const account = this.account(document, accountId);
			const replacement = options.replacementId;
			if (replacement !== void 0) {
				if (replacement === accountId) fail("An account cannot replace itself", "INVALID_REPLACEMENT");
				this.account(document, replacement);
			}
			if (document.activeAccountId === accountId && document.accounts.length > 1 && replacement === void 0) fail("Removing the active Kiro account needs a replacement account", "REPLACEMENT_REQUIRED");
			document.accounts = document.accounts.filter((candidate) => candidate.id !== accountId);
			if (document.activeAccountId === accountId) document.activeAccountId = replacement ?? null;
			return {
				accountId,
				credential: account.credential
			};
		}, { ...options.expectedRevision === void 0 ? {} : { expectedRevision: options.expectedRevision } });
	}
	/**
	* Whether any stored account still needs one device registration.
	*
	* A registration file belongs to the OIDC client, not to the account that
	* happened to arrive with it, so removing one account must not delete a file a
	* remaining account still refreshes through.
	* @param clientIdHash - the registration file stem to look for.
	* @returns true when at least one stored account names that hash.
	*/
	async usesRegistration(clientIdHash) {
		const { document } = await this.load();
		return document.accounts.some((account) => account.credential["clientIdHash"] === clientIdHash);
	}
	/**
	* Sign out every account, keeping an empty document so the installation stays
	* explicitly signed out instead of falling back to the legacy file.
	* @returns every removed credential, so the caller can clean up registrations.
	*/
	async removeAll() {
		return this.withLock("document", async () => {
			const { document } = await this.load();
			const removed = document.accounts.map((account) => ({
				accountId: account.id,
				credential: account.credential
			}));
			const next = {
				version: 1,
				revision: document.revision + 1,
				activeAccountId: null,
				accounts: []
			};
			await this.save(next);
			return removed;
		});
	}
};

//#endregion
//#region lib/types/profile.js
/** Validation and region extraction for Kiro CodeWhisperer profile ARNs. */
const PROFILE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-[0-9]+):[0-9]{12}:profile\/[A-Za-z0-9+=,.@_-]+$/u;
/** Validate a Kiro profile ARN before it reaches a request URL or body. */
function assertKiroProfileArn(value) {
	const profileArn = value.trim();
	if (!PROFILE_ARN.test(profileArn)) throw new Error("kiro-nest: invalid CodeWhisperer profile ARN");
	return profileArn;
}
/** Return the AWS region embedded in a validated profile ARN. */
function profileRegion(value) {
	const profileArn = assertKiroProfileArn(value);
	const match = PROFILE_ARN.exec(profileArn);
	if (match?.[1] === void 0) throw new Error("kiro-nest: profile ARN contains no region");
	return match[1];
}

//#endregion
//#region lib/types/region.js
/** Validation for AWS region values used to construct Kiro hostnames. */
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u;
/**
* Normalize an AWS region before using it in an outbound hostname.
* @param value - configured or credential-derived region.
* @returns validated lowercase region.
*/
function assertKiroRegion(value) {
	const region = value.trim().toLowerCase();
	if (!REGION.test(region)) throw new Error(`kiro-nest: invalid AWS region "${value}"`);
	return region;
}

//#endregion
//#region lib/types/external-idp.js
const MICROSOFT_TOKEN_HOSTS = new Set([
	"login.microsoftonline.com",
	"login.microsoft.com",
	"login.windows.net"
]);
function record$4(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text$2(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function scopes(value) {
	if (Array.isArray(value)) {
		const result = value.map(text$2).filter((item) => item !== void 0).join(" ");
		return result.length > 0 ? result : void 0;
	}
	return text$2(value);
}
/** Restrict imported token endpoints to Microsoft's real login hosts. */
function assertMicrosoftTokenEndpoint(value) {
	let url;
	try {
		url = new URL(value.trim());
	} catch (error) {
		throw new Error("kiro-nest: external IdP token endpoint is not a valid URL", { cause: error });
	}
	if (url.protocol !== "https:" || !MICROSOFT_TOKEN_HOSTS.has(url.hostname.toLowerCase())) throw new Error("kiro-nest: external IdP token endpoint must use an approved Microsoft login host");
	return url.toString();
}
function jwtExpiry(accessToken) {
	try {
		const part = accessToken.split(".")[1];
		if (part === void 0) return void 0;
		const expiry = record$4(JSON.parse(Buffer.from(part, "base64url").toString("utf8")))?.exp;
		return typeof expiry === "number" && Number.isFinite(expiry) ? (/* @__PURE__ */ new Date(expiry * 1e3)).toISOString() : void 0;
	} catch {
		return;
	}
}
/** Parse snake_case or camelCase CLIProxyAPI Kiro auth JSON. */
function normalizeExternalIdpCredentials(raw) {
	let parsed = raw;
	if (typeof raw === "string") try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error("kiro-nest: external IdP credential JSON is invalid", { cause: error });
	}
	const value = record$4(parsed);
	if (value === void 0) throw new Error("kiro-nest: external IdP credential JSON is required");
	const method = text$2(value.authMethod ?? value.auth_method);
	if (method !== void 0 && method !== "external_idp") throw new Error("kiro-nest: imported credential is not external_idp auth");
	const accessToken = text$2(value.accessToken ?? value.access_token);
	const refreshToken = text$2(value.refreshToken ?? value.refresh_token);
	const clientId = text$2(value.clientId ?? value.client_id);
	const tokenEndpoint = text$2(value.tokenEndpoint ?? value.token_endpoint);
	const profileArn = text$2(value.profileArn ?? value.profile_arn);
	const scope = scopes(value.scope ?? value.scopes);
	if (accessToken === void 0) throw new Error("kiro-nest: external IdP access_token is required");
	if (refreshToken === void 0) throw new Error("kiro-nest: external IdP refresh_token is required");
	if (clientId === void 0) throw new Error("kiro-nest: external IdP client_id is required");
	if (tokenEndpoint === void 0) throw new Error("kiro-nest: external IdP token_endpoint is required");
	if (profileArn === void 0) throw new Error("kiro-nest: external IdP profile_arn is required");
	if (scope === void 0) throw new Error("kiro-nest: external IdP scopes are required");
	const explicitExpiry = text$2(value.expiresAt ?? value.expires_at ?? value.expired);
	const expiresIn = Number(value.expiresIn ?? value.expires_in);
	return {
		accessToken,
		refreshToken,
		expiresAt: explicitExpiry !== void 0 && Number.isFinite(Date.parse(explicitExpiry)) ? new Date(explicitExpiry).toISOString() : Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1e3).toISOString() : jwtExpiry(accessToken) ?? new Date(Date.now() + 36e5).toISOString(),
		region: assertKiroRegion(text$2(value.region) ?? "us-east-1"),
		profileArn: assertKiroProfileArn(profileArn),
		clientId,
		tokenEndpoint: assertMicrosoftTokenEndpoint(tokenEndpoint),
		scope,
		authMethod: "external_idp"
	};
}

//#endregion
//#region lib/types/auth.js
const SSO_CACHE_DIR = [
	".aws",
	"sso",
	"cache"
];
const TOKEN_FILE$1 = "kiro-auth-token.json";
const SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const NON_EXPIRING = Number.MAX_SAFE_INTEGER;
const DEFAULT_REGION = "us-east-1";
/**
* Methods whose refresh needs nothing but the refresh token, because Kiro's own
* desktop auth service issues them. Kiro refreshes its `social` tokens exactly
* this way, with no client registration involved.
*/
const KIRO_SERVICE_METHODS = new Set([
	"imported",
	"google",
	"github",
	"social"
]);
/** Directory holding Kiro IDE/CLI's shared SSO cache. */
function kiroCredentialDirectory() {
	return join(homedir(), ...SSO_CACHE_DIR);
}
function record$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function numeric$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* Classify one credential file's authentication method.
*
* Two vocabularies land here: this plugin's own, and Kiro IDE/CLI's, which is
* what a fresh install reads from the shared SSO cache. Kiro writes `social`,
* `IdC`, and `external_idp` — the same three its own refresher switches on — so
* those are recognized rather than guessed at, because the guess decides both
* the refresh endpoint and the upstream request surface.
* @param value - the file's recorded method, if any.
* @param source - the whole credential record, for provenance fallbacks.
* @returns the normalized method.
*/
function inferAuthMethod(value, source) {
	if (value === "builder-id" || value === "idc" || value === "google" || value === "github" || value === "social" || value === "imported" || value === "api_key" || value === "external_idp") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "idc") return "idc";
		if (normalized === "social") return "social";
		if (normalized === "builderid" || normalized === "builder_id") return "builder-id";
		if (normalized === "apikey" || normalized === "api-key") return "api_key";
		if (normalized === "externalidp" || normalized === "external-idp") return "external_idp";
	}
	if (source.tokenEndpoint !== void 0 || source.token_endpoint !== void 0) return "external_idp";
	if (source.tokenType === "API_KEY" || source.token_type === "API_KEY") return "api_key";
	const configuredStartUrl = text$1(source.startUrl ?? source.start_url);
	if (source.clientIdHash !== void 0 || source.client_id_hash !== void 0) return configuredStartUrl === void 0 || configuredStartUrl === "https://view.awsapps.com/start" ? "builder-id" : "idc";
	if (configuredStartUrl !== void 0 && configuredStartUrl !== "https://view.awsapps.com/start") return "idc";
	return "builder-id";
}
/**
* Normalize any credential record's recorded method into the vocabulary this
* adapter acts on. Exported so surfaces report the method that actually decides
* refresh and endpoint selection, instead of the raw string on disk.
* @param value - the file's recorded method, if any.
* @param source - the whole credential record, for provenance fallbacks.
* @returns the normalized method.
*/
function kiroAuthMethod(value, source = {}) {
	return inferAuthMethod(value, source);
}
function normalizeTokenFile(value) {
	const source = record$3(value);
	if (source === void 0) throw new KiroError("Kiro token file is not a JSON object", "INVALID_CREDENTIAL");
	const accessToken = text$1(source.accessToken ?? source.access_token);
	const refreshToken = text$1(source.refreshToken ?? source.refresh_token);
	const expiresAt = text$1(source.expiresAt ?? source.expires_at ?? source.expired);
	const clientIdHash = text$1(source.clientIdHash ?? source.client_id_hash);
	const clientId = text$1(source.clientId ?? source.client_id);
	const tokenEndpoint = text$1(source.tokenEndpoint ?? source.token_endpoint);
	const scope = Array.isArray(source.scopes) ? source.scopes.map(text$1).filter((item) => item !== void 0).join(" ") : text$1(source.scope ?? source.scopes);
	const region = text$1(source.region);
	const profileArn = text$1(source.profileArn ?? source.profile_arn);
	const startUrl$1 = text$1(source.startUrl ?? source.start_url);
	return {
		...accessToken === void 0 ? {} : { accessToken },
		...refreshToken === void 0 ? {} : { refreshToken },
		...expiresAt === void 0 ? {} : { expiresAt },
		...clientIdHash === void 0 ? {} : { clientIdHash },
		...clientId === void 0 ? {} : { clientId },
		...tokenEndpoint === void 0 ? {} : { tokenEndpoint },
		...scope === void 0 || scope.length === 0 ? {} : { scope },
		...region === void 0 ? {} : { region },
		...profileArn === void 0 ? {} : { profileArn },
		authMethod: inferAuthMethod(source.authMethod ?? source.auth_method, source),
		...startUrl$1 === void 0 ? {} : { startUrl: startUrl$1 },
		raw: source
	};
}
async function readJsonFile(path, what) {
	let value;
	try {
		value = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") throw new KiroError(`Kiro ${what} not found at ${path}`, "MISSING_CREDENTIAL", { cause: error });
		throw new KiroError(`Kiro ${what} at ${path} could not be read`, "INVALID_CREDENTIAL", { cause: error });
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new KiroError(`Kiro ${what} at ${path} is not valid JSON`, "INVALID_CREDENTIAL", { cause: error });
	}
}
const cached = /* @__PURE__ */ new Map();
function clearTokenCache() {
	cached.clear();
}
function refreshDetail(body, status) {
	const value = record$3(body);
	return text$1(value?.error_description ?? value?.errorDescription ?? value?.message ?? value?.error) ?? `HTTP ${status}`;
}
function parseRefresh(body, fallbackRefreshToken) {
	const value = record$3(body);
	const accessToken = text$1(value?.accessToken ?? value?.access_token);
	if (accessToken === void 0) throw new KiroError("Kiro token refresh returned no access token", "AUTH");
	const lifetime = Math.max(1, numeric$1(value?.expiresIn ?? value?.expires_in) ?? 3600);
	const rawProfile = text$1(value?.profileArn ?? value?.profile_arn);
	return {
		accessToken,
		refreshToken: text$1(value?.refreshToken ?? value?.refresh_token) ?? fallbackRefreshToken,
		expiresAt: Date.now() + lifetime * 1e3,
		...rawProfile === void 0 ? {} : { profileArn: assertKiroProfileArn(rawProfile) }
	};
}
async function registration(directory, hash) {
	const value = record$3(await readJsonFile(join(directory, `${hash}.json`), "device registration"));
	const clientId = text$1(value?.clientId ?? value?.client_id);
	const clientSecret = text$1(value?.clientSecret ?? value?.client_secret);
	if (clientId === void 0 || clientSecret === void 0) throw new KiroError("Kiro device registration is missing its client id or secret", "INVALID_CREDENTIAL");
	return {
		clientId,
		clientSecret
	};
}
async function refresh(token, directory, region, options) {
	const refreshToken = token.refreshToken;
	if (refreshToken === void 0) throw new KiroError("Kiro credential has expired and carries no refresh token", "INVALID_CREDENTIAL");
	let response;
	if (token.authMethod === "external_idp") {
		if (token.clientId === void 0 || token.tokenEndpoint === void 0 || token.scope === void 0) throw new KiroError("Kiro external IdP credential is missing client, endpoint, or scopes", "INVALID_CREDENTIAL");
		if (options.fetchForm === void 0) throw new KiroError("Kiro external IdP refresh transport is unavailable", "INVALID_CREDENTIAL");
		response = await options.fetchForm(assertMicrosoftTokenEndpoint(token.tokenEndpoint), new URLSearchParams({
			grant_type: "refresh_token",
			client_id: token.clientId,
			refresh_token: refreshToken,
			scope: token.scope
		}));
	} else if (token.clientIdHash !== void 0) {
		const client = await registration(directory, token.clientIdHash);
		response = await options.fetchJson(`https://oidc.${region}.amazonaws.com/token`, {
			refreshToken,
			clientId: client.clientId,
			clientSecret: client.clientSecret,
			grantType: "refresh_token"
		});
	} else if (KIRO_SERVICE_METHODS.has(token.authMethod)) response = await options.fetchJson(SOCIAL_REFRESH_URL, { refreshToken });
	else throw new KiroError(`Kiro ${token.authMethod} credential cannot be refreshed without its client registration; sign in through the Kiro settings page to store a refreshable credential`, "INVALID_CREDENTIAL");
	if (response.status !== 200) throw new KiroError(`Kiro token refresh failed: ${refreshDetail(response.body, response.status)}`, "AUTH", { status: response.status });
	const parsed = parseRefresh(response.body, refreshToken);
	const existingProfile = token.profileArn === void 0 ? void 0 : assertKiroProfileArn(token.profileArn);
	const refreshedProfile = parsed.profileArn ?? existingProfile;
	return {
		refreshToken: parsed.refreshToken,
		token: {
			accessToken: parsed.accessToken,
			region,
			expiresAt: parsed.expiresAt,
			authMethod: token.authMethod,
			...refreshedProfile === void 0 ? {} : { profileArn: refreshedProfile }
		}
	};
}
async function atomicTokenFile(directory, value) {
	const path = join(directory, TOKEN_FILE$1);
	const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, path);
}
/**
* The record a refreshed token writes back, preserving every other field the
* credential arrived with.
*/
function credentialRecord(file, token, refreshToken) {
	return {
		...file.raw,
		accessToken: token.accessToken,
		...refreshToken === void 0 ? {} : { refreshToken },
		expiresAt: new Date(token.expiresAt).toISOString(),
		region: token.region,
		authMethod: token.authMethod,
		...token.profileArn === void 0 ? {} : { profileArn: token.profileArn }
	};
}
async function withProfile(result, file, source, options, refreshToken) {
	if (result.profileArn !== void 0 || result.authMethod === "api_key" || options.resolveProfileArn === void 0) return result;
	let profileArn;
	try {
		profileArn = await options.resolveProfileArn(result.accessToken, result.region, result.authMethod);
	} catch {
		return result;
	}
	if (profileArn === void 0) return result;
	const enriched = {
		...result,
		profileArn: assertKiroProfileArn(profileArn)
	};
	cached.set(source.key, enriched);
	if (source.write !== void 0) await source.write(credentialRecord(file, enriched, refreshToken ?? file.refreshToken));
	return enriched;
}
/** Resolve a usable token from one credential source, refreshing and persisting as needed. */
async function resolveFromSource(source, options) {
	const now = Date.now();
	const cachedToken = cached.get(source.key);
	if (cachedToken !== void 0 && now < cachedToken.expiresAt - options.expiryBufferMs) return cachedToken;
	const file = normalizeTokenFile(await source.read());
	let region;
	try {
		region = assertKiroRegion(file.region ?? DEFAULT_REGION);
	} catch (error) {
		throw new KiroError("Kiro token file contains an invalid AWS region", "INVALID_CREDENTIAL", { cause: error });
	}
	let profileArn;
	try {
		profileArn = file.profileArn === void 0 ? void 0 : assertKiroProfileArn(file.profileArn);
	} catch (error) {
		throw new KiroError("Kiro token file contains an invalid profile ARN", "INVALID_CREDENTIAL", { cause: error });
	}
	const fileExpiry = file.authMethod === "api_key" ? NON_EXPIRING : file.expiresAt === void 0 ? 0 : Date.parse(file.expiresAt);
	if (file.accessToken !== void 0 && Number.isFinite(fileExpiry) && now < fileExpiry - options.expiryBufferMs) {
		const result$1 = await withProfile({
			accessToken: file.accessToken,
			region,
			expiresAt: fileExpiry,
			authMethod: file.authMethod,
			...profileArn === void 0 ? {} : { profileArn }
		}, file, source, options);
		cached.set(source.key, result$1);
		return result$1;
	}
	const refreshed = await refresh(file, source.directory, region, options);
	let result = refreshed.token;
	if (source.write !== void 0) await source.write(credentialRecord(file, result, refreshed.refreshToken));
	result = await withProfile(result, file, source, options, refreshed.refreshToken);
	cached.set(source.key, result);
	return result;
}
/** Resolve a currently usable token from one credential directory. */
async function resolveToken(options) {
	const directory = options.cacheDir ?? kiroCredentialDirectory();
	return resolveFromSource({
		key: directory,
		directory,
		read: async () => {
			return await readJsonFile(join(directory, TOKEN_FILE$1), "token file");
		},
		...options.persistRefresh === true ? { write: async (next) => {
			await atomicTokenFile(directory, next);
		} } : {}
	}, options);
}
/** Resolve the first present source, preferring gateway-managed credentials over Kiro's cache. */
async function resolveTokenFromDirectories(directories, options) {
	const unique = [...new Set(directories)];
	const writable = new Set(options.writableDirectories ?? []);
	const { writableDirectories: _writableDirectories,...resolveOptions } = options;
	let lastMissing;
	for (const cacheDir of unique) {
		const store = new KiroAccountStore(cacheDir);
		if (await store.exists()) try {
			return await resolveStoredAccount(store, resolveOptions, void 0, writable.has(cacheDir));
		} catch (error) {
			if (error.code !== "MISSING_CREDENTIAL") throw error;
			lastMissing = error;
			continue;
		}
		try {
			return await resolveToken({
				...resolveOptions,
				cacheDir,
				persistRefresh: writable.has(cacheDir)
			});
		} catch (error) {
			if (error.code !== "MISSING_CREDENTIAL") throw error;
			lastMissing = error;
		}
	}
	if (lastMissing !== void 0) throw lastMissing;
	throw new KiroError("No Kiro credential sources were configured", "MISSING_CREDENTIAL");
}
/**
* Resolve one stored account, writing a rotated credential back only when the
* directory belongs to this plugin.
* @param store - the multi-account store to read.
* @param options - refresh transports and the profile expiry buffer.
* @param accountId - the account to use; the active one when omitted.
* @param persist - whether a rotated credential may be written to disk.
* @returns the token requests and discovery authenticate with.
* @throws KiroError('MISSING_CREDENTIAL') when the store holds no such account.
*/
async function resolveStoredAccount(store, options, accountId, persist) {
	const captured = await store.capture(accountId);
	if (captured === null) throw new KiroError("Kiro has no signed-in account; add one in Settings, Kiro", "MISSING_CREDENTIAL");
	return resolveFromSource({
		key: store.directory + "\0" + captured.accountId,
		directory: store.directory,
		read: async () => {
			const credential = await captured.read();
			if (credential === void 0) throw new KiroError("Kiro account " + captured.accountId + " is no longer stored", "MISSING_CREDENTIAL");
			return credential;
		},
		...persist ? { write: async (next) => {
			const written = await captured.modify(() => next);
			if (written !== void 0 && (await store.snapshot()).activeAccountId === captured.accountId) await atomicTokenFile(store.directory, written);
		} } : {}
	}, options);
}

//#endregion
//#region lib/types/chat.js
/**
* Provider-neutral chat vocabulary used by the gateway and the Kiro client.
*
* The shapes mirror the OpenAI/Anthropic-facing gateway protocol closely
* enough that request and stream translation stays a field-by-field mapping,
* while nothing here imports an HTTP or framework package.
*/
/** Whether any block in one message carries an image. */
function contentHasImage(content) {
	return content.some((block) => block.type === "image");
}

//#endregion
//#region lib/types/eventstream.js
/** Bytes before the headers: total length, header length, prelude CRC. */
const PRELUDE_BYTES = 12;
/** Bytes after the payload holding the message CRC. */
const MESSAGE_CRC_BYTES = 4;
/** Header value type tag for a UTF-8 string, the only type Kiro sends. */
const HEADER_TYPE_STRING = 7;
/**
* Largest frame this decoder will buffer. AWS caps event-stream messages at
* 16 MiB, so a larger declared length is a desynchronized stream rather than
* a big message, and refusing it bounds memory instead of buffering forever.
*/
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/**
* Decode one frame's headers.
* @param buffer - the whole buffered stream.
* @param start - offset of the first header byte.
* @param end - offset one past the last header byte.
* @returns the header name/value pairs.
* @throws `KiroError('MALFORMED_RESPONSE')` on a non-string header value type.
*/
function decodeHeaders(buffer, start, end) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const decoder = new TextDecoder();
	const headers$1 = {};
	let offset = start;
	while (offset < end) {
		const nameLength = view.getUint8(offset);
		offset += 1;
		const name = decoder.decode(buffer.subarray(offset, offset + nameLength));
		offset += nameLength;
		const type = view.getUint8(offset);
		offset += 1;
		if (type !== HEADER_TYPE_STRING) throw new KiroError(`Kiro event-stream header "${name}" has unsupported value type ${type}`, "MALFORMED_RESPONSE");
		const valueLength = view.getUint16(offset);
		offset += 2;
		headers$1[name] = decoder.decode(buffer.subarray(offset, offset + valueLength));
		offset += valueLength;
	}
	return headers$1;
}
/**
* Decode a byte stream into whole event-stream frames.
*
* A stream that ends mid-frame is truncation, not a flushable tail: the
* response cannot be trusted, so it raises rather than yielding a partial
* frame.
* @param stream - raw response bytes; reads may split anywhere, including
*   inside a prelude, header, or payload. Any async iterable of byte chunks
*   works, so the same decoder serves a `fetch` body and a Node response.
* @param onActivity - optional transport-activity callback invoked for each
*   read, so an idle watchdog can distinguish a slow model from a dead socket.
* @returns each complete frame in arrival order.
* @throws `KiroError('STREAM_CLOSED')` when the stream ends mid-frame, or
*   `KiroError('MALFORMED_RESPONSE')` on an implausible declared frame length.
*/
async function* decodeFrames(stream, onActivity) {
	let buffered = new Uint8Array(0);
	for await (const chunk of stream) {
		onActivity?.();
		const next = new Uint8Array(buffered.length + chunk.length);
		next.set(buffered);
		next.set(chunk, buffered.length);
		buffered = next;
		while (buffered.length >= PRELUDE_BYTES) {
			const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
			const totalLength = view.getUint32(0);
			const headerLength = view.getUint32(4);
			if (totalLength > MAX_FRAME_BYTES || totalLength < PRELUDE_BYTES + headerLength + MESSAGE_CRC_BYTES) throw new KiroError(`Kiro event-stream frame declares an implausible length of ${totalLength} bytes`, "MALFORMED_RESPONSE");
			if (buffered.length < totalLength) break;
			const headerEnd = PRELUDE_BYTES + headerLength;
			yield {
				headers: decodeHeaders(buffered, PRELUDE_BYTES, headerEnd),
				payload: buffered.subarray(headerEnd, totalLength - MESSAGE_CRC_BYTES)
			};
			buffered = buffered.subarray(totalLength);
		}
	}
	if (buffered.length > 0) throw new KiroError(`Kiro event stream ended with ${buffered.length} bytes of an incomplete frame`, "STREAM_CLOSED");
}

//#endregion
//#region lib/types/serialize.js
/** Request origin Kiro attributes IDE traffic to. */
const ORIGIN = "AI_EDITOR";
/**
* Neutral user text standing in for an absent turn. Matches the installed Kiro
* client's own `CONTINUE_MESSAGE_CONTENT`: ordinary conversational filler the
* model has no reason to imitate as output.
*/
const CONTINUE_PADDING = "Continue";
/**
* Neutral assistant text standing in for a turn with no prose of its own —
* the installed Kiro client's `UNDERSTOOD_MESSAGE` content.
*/
const ACKNOWLEDGE_PADDING = "understood";
/**
* The distinctive placeholder earlier versions used for structural padding.
* It looked like an injected system message, so the model imitated it and gateway
* persisted the imitation as visible assistant output. Sessions recorded before
* the fix still contain it, so replayed history is scrubbed of exact matches
* rather than replaying them into the model's context again.
*/
const LEGACY_CONTINUATION$1 = "[system: conversation continues]";
/** Content for a user turn that carries only tool results. */
const TOOL_RESULTS_ONLY = "Tool results provided.";
/**
* Most history entries the service accepts. Verified live: 198 passes and 200
* fails with `Input is too long.` at any token count, for text and tool turns.
*/
const MAX_HISTORY_ENTRIES = 198;
/**
* Entries folded at a time: one fold, then about 74 append-only steps before
* the next, so the provider's prefix cache misses once per block rather than
* every turn. Each fold keeps the latest ~50 entries as structured turns.
*/
const FOLD_BLOCK = 150;
/** Tool names CodeWhisperer accepts verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
* Tool-use ids CodeWhisperer accepts verbatim (verified live). Anything else,
* such as another provider's `call_…|fc_…` ids replayed after a model switch,
* fails the whole request with HTTP 400 `Invalid tool use format.`
*/
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
* Map a gateway tool-call id onto one Kiro accepts. Deterministic, so a call
* and its result still pair and the replayed prefix stays cache-stable.
*/
function wireToolUseId(id) {
	if (TOOL_USE_ID_PATTERN.test(id)) return id;
	return `tooluse_${createHash("sha256").update(id).digest("base64url").slice(0, 32)}`;
}
/** Maximum thinking length published for each effort, in tokens. */
const THINKING_BUDGETS = {
	low: 4e3,
	medium: 12e3,
	high: 24e3
};
/**
* Validate the adapter-owned effort.
* @param effort - the request's opaque effort identifier.
* @returns the same value, narrowed.
* @throws `KiroError('UNSUPPORTED_REASONING_EFFORT')` for any other value.
*/
function narrowLegacyEffort(effort) {
	if (effort === "off" || effort === "low" || effort === "medium" || effort === "high") return effort;
	throw new KiroError(`Kiro does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
* Resolve the effort governing one request.
* @param options - the gateway request.
* @param defaults - adapter-level defaults.
* @returns the effort, or `off` when thinking is not in play.
* @throws `KiroError('UNSUPPORTED_REASONING_EFFORT')` when a deployment that
*   disabled thinking is asked to enable it.
*/
function resolveEffort(options, defaults$1, native) {
	if (options.purpose === "session-title") return void 0;
	const requested = options.reasoningEffort === void 0 ? defaults$1.reasoningEffort ?? native?.defaultLevel : String(options.reasoningEffort);
	if (defaults$1.thinking === "disabled" && requested !== void 0 && requested !== "off" && requested !== "none") throw new KiroError(`Kiro deployment does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
	if (defaults$1.thinking === "disabled") return void 0;
	if (native !== void 0) {
		if (requested === void 0) return void 0;
		if (!native.levels.includes(requested)) throw new KiroError(`Kiro model does not advertise reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
		return requested;
	}
	return requested === void 0 ? "off" : narrowLegacyEffort(requested);
}
/**
* Build the system text Kiro sees, including thinking markers.
* @param options - the gateway request.
* @param effort - the resolved effort.
* @returns the system text, empty when there is nothing to say.
*/
function systemText(options, effort, native) {
	const persona = options.system ?? "";
	if (effort === void 0 || effort === "off" || effort === "none" || native !== void 0) return persona;
	const legacyEffort = narrowLegacyEffort(effort);
	if (legacyEffort === "off") return persona;
	const markers = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGETS[legacyEffort]}</max_thinking_length>`;
	return persona.length === 0 ? markers : `${markers}\n${persona}`;
}
/** Build Kiro's model-specific native effort object. */
function buildEffortRequestFields(effort, native) {
	if (effort === void 0 || native === void 0) return void 0;
	return native.schemaPath === "output_config" ? { output_config: { effort } } : { reasoning: { effort } };
}
/**
* Build `additionalModelRequestFields` for one request.
*
* This is the only place `generateAssistantResponse` accepts generation
* controls: its request shape declares `conversationState`, `profileArn`,
* `agentMode`, `additionalModelRequestFields`, and `systemPrompt` and nothing
* else, so a top-level `inferenceConfig` is silently dropped by the service.
* The object is validated against each model's advertised schema, which is
* `additionalProperties: false`, and a model that advertises no schema rejects
* the member outright — so nothing may be sent speculatively:
*
* - unadvertised property → HTTP 400 `property 'x' is not defined in the schema`
* - model with no schema → HTTP 400 `additionalModelRequestFields is not supported for this model`
*
* @param effort - the resolved reasoning effort, when the model takes one.
* @param native - the model's live effort contract, absent when it has no schema.
* @param maxTokens - the caller's requested output cap, if any.
* @param limits - the model's advertised field bounds.
* @returns the object to send, or `undefined` when there is nothing valid to send.
* @throws `KiroError('INVALID_REQUEST')` for an unusable caller value.
*/
function buildModelRequestFields(effort, native, maxTokens, limits) {
	if (native === void 0) return void 0;
	const fields = { ...buildEffortRequestFields(effort, native) };
	if (maxTokens !== void 0) {
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new KiroError(`Kiro requires a positive integer maxTokens; received ${String(maxTokens)}`, "INVALID_REQUEST");
		const bounds = limits?.maxTokensBounds;
		if (bounds !== void 0) fields.max_tokens = Math.min(Math.max(maxTokens, bounds.minimum), bounds.maximum);
	}
	return Object.keys(fields).length === 0 ? void 0 : fields;
}
/**
* Join the text blocks of one message, dropping blocks that are nothing but an
* exact legacy continuation marker.
*
* Sessions recorded before the padding fix persisted the marker as whole
* assistant text blocks; replaying them teaches the model the phrase again and
* multiplies it through history. Only a block whose entire text is the marker is
* dropped, so a message discussing the phrase in prose keeps it verbatim.
*/
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").filter((block) => block.text.trim() !== LEGACY_CONTINUATION$1).map((block) => block.text).join("");
}
/** Media types Kiro's `ImageFormat` enum accepts, mapped to its own spelling. */
const IMAGE_FORMATS = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/gif": "gif",
	"image/webp": "webp"
};
/**
* Reject images in a role whose wire message has nowhere to put them.
* @param blocks - blocks from one message.
* @param role - the role being serialized, named in the error.
* @throws `KiroError('UNSUPPORTED_CONTENT')` when the role carries an image.
*/
function assertNoImages(blocks, role) {
	if (contentHasImage(blocks)) throw new KiroError(`Kiro accepts images only on user turns; this request has one on a ${role} turn.`, "UNSUPPORTED_CONTENT");
}
/**
* Collect the wire images for one user message, in content order.
*
* Tool-role content is passed through the same image collection as user
* content; the service has no separate image seat for a tool result.
* @param blocks - blocks from one user message.
* @returns wire image blocks in the order they appear.
* @throws `KiroError('UNSUPPORTED_CONTENT')` for a media type Kiro cannot accept.
*/
function imagesOf(blocks) {
	const images = [];
	for (const block of blocks) {
		if (block.type !== "image") continue;
		const format = IMAGE_FORMATS[block.image.mediaType];
		if (format === void 0) throw new KiroError(`Kiro accepts png, jpeg, gif and webp images; ${String(block.image.mediaType)} is not one of them.`, "UNSUPPORTED_CONTENT");
		images.push({
			format,
			source: { bytes: block.image.data }
		});
	}
	return images;
}
/**
* Validate one tool name against the wire pattern.
* @param name - the gateway tool name.
* @returns the same name.
* @throws `KiroError('UNSUPPORTED_TOOL_NAME')` when Kiro would reject it.
*/
function assertToolName(name) {
	if (!TOOL_NAME_PATTERN.test(name)) throw new KiroError(`Kiro rejects tool name "${name}"; names must match ${String(TOOL_NAME_PATTERN)}`, "UNSUPPORTED_TOOL_NAME");
	return name;
}
/** Serialize the tool-result blocks of one message. */
function toolResultsOf(message) {
	if (message.toolCallId === void 0) throw new KiroError("Kiro tool result is missing its tool call id", "INVALID_REQUEST");
	return [{
		toolUseId: wireToolUseId(message.toolCallId),
		content: [{ text: flattenText(message.content) || "(no output)" }],
		status: message.isError === true ? "error" : "success"
	}];
}
/** Serialize the tool-call blocks of one assistant message. */
function toolUsesOf(message) {
	return message.content.filter((block) => block.type === "tool-call").map((block) => ({
		toolUseId: wireToolUseId(block.id),
		name: assertToolName(block.name),
		input: parseArguments(block.arguments)
	}));
}
/**
* Parse tool-call arguments into the object Kiro expects.
* @param raw - the model's raw JSON argument string.
* @returns the parsed value, or an empty object when the model emitted
*   nothing or invalid JSON — replaying history must not fail a live request
*   over a malformed past call.
*/
function parseArguments(raw) {
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
/**
* Fold the gateway conversation into alternating user and assistant turns.
* Consecutive same-role messages merge, because Kiro accepts only strict
* alternation.
* @param messages - the gateway conversation, in order.
* @returns the folded turns, each tagged with its role.
*/
function foldTurns(messages) {
	const turns = [];
	for (const message of messages) {
		const text$3 = flattenText(message.content);
		if (message.role === "assistant") {
			assertNoImages(message.content, "assistant");
			const toolUses = toolUsesOf(message);
			const last$1 = turns.at(-1);
			if (last$1?.role === "assistant") {
				last$1.text = [last$1.text, text$3].filter((part) => part.length > 0).join("\n\n");
				last$1.toolUses = [...last$1.toolUses, ...toolUses];
				continue;
			}
			turns.push({
				role: "assistant",
				text: text$3,
				toolUses
			});
			continue;
		}
		const toolResults = message.role === "tool" ? toolResultsOf(message) : [];
		const messageText = message.role === "tool" ? "" : text$3;
		const turnImages = imagesOf(message.content);
		const last = turns.at(-1);
		if (last?.role === "user") {
			last.turn.text = [last.turn.text, messageText].filter((part) => part.length > 0).join("\n\n");
			last.turn.toolResults = [...last.turn.toolResults, ...toolResults];
			last.turn.images = [...last.turn.images, ...turnImages];
			continue;
		}
		turns.push({
			role: "user",
			turn: {
				text: messageText,
				toolResults,
				images: turnImages
			}
		});
	}
	return turns;
}
/**
* Build one wire user message.
* @param turn - the folded user turn.
* @param model - the wire model id, repeated on every user turn.
* @param context - optional per-turn context (tools, tool results).
* @returns the wire message.
*/
function userMessage(turn, model, context) {
	return {
		content: turn.text.length > 0 ? turn.text : turn.toolResults.length > 0 ? TOOL_RESULTS_ONLY : CONTINUE_PADDING,
		modelId: model,
		origin: ORIGIN,
		...context === void 0 ? {} : { userInputMessageContext: context },
		...turn.images.length === 0 ? {} : { images: turn.images }
	};
}
/** A tool result as text, for a result whose call is no longer on the wire. */
function resultText(result) {
	return `[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ""}`;
}
/**
* Fold the oldest history entries into one text turn once history passes the
* service cap. Content is kept, not dropped: only its structure changes, and
* deciding what the conversation holds stays with the gateway's compaction.
* @param history - alternating history starting on a user entry and ending on an assistant one; edited in place.
* @param model - the wire model id for the folded user turn.
*/
function foldOverflow(history, model) {
	if (history.length <= MAX_HISTORY_ENTRIES) return;
	const count = Math.ceil((history.length - (MAX_HISTORY_ENTRIES - 2)) / FOLD_BLOCK) * FOLD_BLOCK;
	const lines = ["Earlier in this conversation:"];
	const images = [];
	for (const entry of history.slice(0, count)) {
		if ("userInputMessage" in entry) {
			const message$1 = entry.userInputMessage;
			lines.push(`User: ${message$1.content}`, ...(message$1.userInputMessageContext?.toolResults ?? []).map(resultText));
			images.push(...message$1.images ?? []);
			continue;
		}
		const message = entry.assistantResponseMessage;
		lines.push(`Assistant: ${message.content}`, ...(message.toolUses ?? []).map((use) => `[Tool call ${use.toolUseId}: ${use.name} ${JSON.stringify(use.input)}]`));
	}
	history.splice(0, count, { userInputMessage: userMessage({
		text: lines.join("\n\n"),
		toolResults: [],
		images
	}, model) }, { assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } });
	const head = history[2];
	const results = head !== void 0 && "userInputMessage" in head ? head.userInputMessage.userInputMessageContext?.toolResults ?? [] : [];
	if (head !== void 0 && "userInputMessage" in head && results.length > 0) {
		head.userInputMessage.content = [head.userInputMessage.content, ...results.map(resultText)].join("\n\n");
		delete head.userInputMessage.userInputMessageContext;
	}
}
/**
* Build the complete wire request.
*
* The final user turn becomes `currentMessage` and carries the tool schemas;
* everything before it becomes alternating history. A conversation whose last
* turn is the assistant's (a resumed session, a compaction boundary) gets a
* neutral continuation user turn so there is something to answer.
* @param options - the gateway request.
* @param defaults - adapter-level thinking defaults.
* @param conversationId - identifier for this request's conversation.
* @param profileArn - CodeWhisperer profile the account bills against.
* @param nativeEffort - live effort levels and their provider request path.
* @param limits - live per-model generation bounds, when discovery supplied them.
* @returns the request body.
* @throws `KiroError` when an image cannot be placed, a tool name is unusable,
*   an effort is unsupported, a generation option is unusable, or there are no
*   messages at all.
*/
function serializeRequest(options, defaults$1, conversationId, profileArn, nativeEffort, limits) {
	if (options.messages.length === 0) throw new KiroError("Kiro requires at least one message", "INVALID_REQUEST");
	const effort = resolveEffort(options, defaults$1, nativeEffort);
	const turns = foldTurns(options.messages);
	if (turns.at(-1)?.role === "assistant") turns.push({
		role: "user",
		turn: {
			text: CONTINUE_PADDING,
			toolResults: [],
			images: []
		}
	});
	const current = turns.pop();
	/* v8 ignore next -- a non-empty conversation always folds to at least one turn */
	if (current === void 0 || current.role !== "user") throw new KiroError("Kiro request has no user turn to answer", "INVALID_REQUEST");
	const history = [];
	for (const entry of turns) {
		const expected = history.length % 2 === 0 ? "user" : "assistant";
		if (entry.role !== expected) history.push(expected === "user" ? { userInputMessage: userMessage({
			text: CONTINUE_PADDING,
			toolResults: [],
			images: []
		}, options.model) } : { assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } });
		if (entry.role === "user") {
			history.push({ userInputMessage: userMessage(entry.turn, options.model, entry.turn.toolResults.length > 0 ? { toolResults: entry.turn.toolResults } : void 0) });
			continue;
		}
		history.push({ assistantResponseMessage: {
			content: entry.text.length > 0 ? entry.text : ACKNOWLEDGE_PADDING,
			...entry.toolUses.length > 0 ? { toolUses: entry.toolUses } : {}
		} });
	}
	if (history.length % 2 !== 0) history.push({ assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } });
	foldOverflow(history, options.model);
	const issued = new Set(history.flatMap((entry) => "assistantResponseMessage" in entry ? (entry.assistantResponseMessage.toolUses ?? []).map((use) => use.toolUseId) : []));
	const matched = current.turn.toolResults.filter((result) => issued.has(result.toolUseId));
	const text$3 = current.turn.toolResults.filter((result) => !issued.has(result.toolUseId)).reduce((accumulated, result) => `${accumulated}\n\n${resultText(result)}`, current.turn.text);
	const tools = (options.tools ?? []).map((tool) => ({ toolSpecification: {
		name: assertToolName(tool.name),
		description: tool.description,
		inputSchema: { json: tool.parameters }
	} }));
	const system = systemText(options, effort, nativeEffort);
	const currentMessage = userMessage({
		text: text$3,
		toolResults: matched,
		images: current.turn.images
	}, options.model, tools.length > 0 || matched.length > 0 ? {
		...tools.length > 0 ? { tools } : {},
		...matched.length > 0 ? { toolResults: matched } : {}
	} : void 0);
	if (system.length > 0) {
		const first = history.find((entry) => "userInputMessage" in entry);
		if (first === void 0) currentMessage.content = `${system}\n\n${currentMessage.content}`;
		else first.userInputMessage.content = `${system}\n\n${first.userInputMessage.content}`;
	}
	const additionalModelRequestFields = buildModelRequestFields(effort, nativeEffort, options.maxTokens, limits);
	return {
		...profileArn === void 0 ? {} : { profileArn },
		...additionalModelRequestFields === void 0 ? {} : { additionalModelRequestFields },
		conversationState: {
			chatTriggerType: "MANUAL",
			conversationId,
			currentMessage: { userInputMessage: currentMessage },
			...history.length > 0 ? { history } : {}
		}
	};
}

//#endregion
//#region lib/types/transport.js
/** Default port for each supported proxy scheme. */
const PROXY_PORTS = {
	"http:": 80,
	"https:": 443
};
/**
* Validate a proxy URL at its configuration boundary.
* @param raw - the configured proxy URL.
* @returns the parsed URL.
* @throws when the value is not a URL, or names a scheme this transport cannot open.
*/
function parseProxyUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch (error) {
		throw new Error(`llm-kiro: proxyUrl "${raw}" is not a valid URL`, { cause: error });
	}
	if (!(url.protocol in PROXY_PORTS)) throw new Error(`llm-kiro: proxyUrl scheme "${url.protocol}" is not supported; use http:// or https://`);
	if (url.hostname.length === 0) throw new Error(`llm-kiro: proxyUrl "${raw}" names no host`);
	return url;
}
/**
* Open a `CONNECT` tunnel to `host:port` through an HTTP proxy.
* @param proxy - the validated proxy URL.
* @param host - target hostname.
* @param port - target port.
* @param signal - caller cancellation.
* @returns the tunneled socket, ready for TLS.
* @throws `KiroError('TRANSPORT')` when the proxy refuses or the connection fails.
*/
function openTunnel(proxy, host, port, signal) {
	return new Promise((resolve$1, reject) => {
		const request$2 = (proxy.protocol === "https:" ? request$1 : request)({
			host: proxy.hostname,
			port: proxy.port.length > 0 ? Number(proxy.port) : PROXY_PORTS[proxy.protocol],
			method: "CONNECT",
			path: `${host}:${port}`,
			signal,
			headers: {
				host: `${host}:${port}`,
				...proxy.username.length > 0 ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}
			}
		});
		request$2.once("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new KiroError(`Kiro proxy ${proxy.host} refused CONNECT with HTTP ${String(response.statusCode)}`, "TRANSPORT"));
				return;
			}
			resolve$1(socket);
		});
		request$2.once("error", (error) => {
			reject(new KiroError(`Kiro proxy ${proxy.host} connection failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end();
	});
}
/**
* POST one request and resolve as soon as response headers arrive, so the
* caller streams the body itself.
* @param options - target, headers, body, cancellation, and optional proxy.
* @returns status, headers, and the body byte stream.
* @throws `KiroError('TRANSPORT')` on a pre-response transport failure, or
*   `KiroError('ABORTED')` when the caller cancelled first.
*/
async function send(options) {
	const target = new URL(options.url);
	const port = target.port.length > 0 ? Number(target.port) : 443;
	const tunnel = options.proxyUrl === void 0 ? void 0 : await openTunnel(parseProxyUrl(options.proxyUrl), target.hostname, port, options.signal);
	return new Promise((resolve$1, reject) => {
		const request$2 = request$1({
			host: target.hostname,
			port,
			path: `${target.pathname}${target.search}`,
			method: options.method,
			signal: options.signal,
			...tunnel === void 0 ? {} : { createConnection: () => connect({
				socket: tunnel,
				servername: target.hostname
			}) },
			headers: {
				...options.headers,
				...options.body === void 0 ? {} : { "content-length": String(Buffer.byteLength(options.body)) }
			}
		}, (response) => {
			resolve$1({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: response
			});
		});
		request$2.once("error", (error) => {
			tunnel?.destroy();
			if (options.signal.aborted) {
				reject(new KiroError("Kiro request aborted by caller", "ABORTED", { cause: error }));
				return;
			}
			reject(new KiroError(`Kiro request to ${target.host} failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end(options.body);
	});
}
function post(options) {
	return send({
		...options,
		method: "POST"
	});
}
async function responseJson(response) {
	const chunks = [];
	for await (const chunk of response.body) chunks.push(chunk);
	const text$3 = Buffer.concat(chunks).toString("utf8");
	try {
		return {
			status: response.status,
			body: JSON.parse(text$3)
		};
	} catch {
		return {
			status: response.status,
			body: void 0
		};
	}
}
/**
* POST JSON and read the whole response, for the small non-streaming calls
* (token refresh) that share this transport's egress.
* @param url - absolute `https:` URL.
* @param body - value serialized as the JSON request body.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns the status and parsed JSON body; an unparsable body resolves as `undefined`.
*/
async function postJson(url, body, proxyUrl, signal) {
	return postJsonWithHeaders(url, body, {}, proxyUrl, signal);
}
/**
* POST and parse JSON while supplying operation-specific headers.
* @param url - absolute HTTPS URL.
* @param body - JSON request value.
* @param headers - extra request headers such as Kiro authorization.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns status and parsed response body.
*/
async function postJsonWithHeaders(url, body, headers$1, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			...headers$1
		},
		body: JSON.stringify(body),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}
/** POST an OAuth form and parse its small JSON response. */
async function postForm(url, body, proxyUrl, signal) {
	return responseJson(await post({
		url,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json"
		},
		body: body.toString(),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}
/**
* GET and parse a small JSON response through the same optional proxy.
* @param url - absolute HTTPS URL.
* @param headers - request headers.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns status and parsed response body.
*/
async function getJson(url, headers$1, proxyUrl, signal) {
	return responseJson(await send({
		url,
		method: "GET",
		headers: {
			accept: "application/json",
			...headers$1
		},
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	}));
}

//#endregion
//#region lib/types/translate.js
/** Opens Kiro's in-band thinking channel. */
const THINKING_OPEN = "<thinking>";
/** Closes Kiro's in-band thinking channel. */
const THINKING_CLOSE = "</thinking>";
/**
* Tool-call preamble the open-weight routes leak into the text channel. It is
* an artifact of their prompt format, never content the user should read, and
* the real call always follows as a `toolUseEvent`.
*/
const DSML_MARKER = "<｜DSML｜";
/**
* The structural padding earlier versions sent as history. Enough of it reached
* the model that it learned to answer with the phrase verbatim; sessions still
* replay those answers. Serialization no longer produces it, and a response
* that is nothing but the marker is suppressed here so the last contaminated
* turns cannot surface as visible assistant output.
*/
const LEGACY_CONTINUATION = "[system: conversation continues]";
/**
* Withhold a visible response that may turn out to be nothing but the legacy
* continuation marker.
*
* Only an exact standalone marker is suppressed. Text is held back only while
* everything seen so far is still a prefix of the marker, so ordinary prose —
* including prose that discusses the phrase — is released as soon as it
* diverges and is never altered.
*/
var LegacyMarkerGuard = class {
	pending = "";
	settled = false;
	/**
	* Filter one visible run.
	* @param text - the run exactly as the router produced it.
	* @returns the text that can be emitted now, empty while undecided.
	*/
	push(text$3) {
		if (this.settled) return text$3;
		this.pending += text$3;
		const trimmed = this.pending.trim();
		if (trimmed.length === 0 || LEGACY_CONTINUATION.startsWith(trimmed)) return "";
		this.settled = true;
		const released = this.pending;
		this.pending = "";
		return released;
	}
	/**
	* Resolve the withheld text when the stream ends.
	* @returns the withheld text, or nothing when it was exactly the marker.
	*/
	flush() {
		if (this.settled) return "";
		const pending = this.pending;
		this.pending = "";
		this.settled = true;
		return pending.trim() === LEGACY_CONTINUATION ? "" : pending;
	}
};
/**
* Length of the longest suffix of `buffer` that is a proper prefix of any
* watched token. That tail must be held back: it may complete into a marker
* on the next frame.
* @param buffer - the unrouted text.
* @param tokens - markers being watched in the current channel.
* @returns the number of trailing characters to withhold.
*/
function heldSuffixLength(buffer, tokens) {
	const longest = Math.max(...tokens.map((token) => token.length));
	for (let length = Math.min(longest - 1, buffer.length); length > 0; length -= 1) {
		const suffix = buffer.slice(buffer.length - length);
		if (tokens.some((token) => token.startsWith(suffix))) return length;
	}
	return 0;
}
/**
* Routes Kiro's single text channel into gateway text and reasoning runs.
*
* Marker recognition is stateful across frames, which is the point: a delta
* boundary inside `</thinking>` must not surface the tag as visible output.
*/
var TextRouter = class {
	channel = "text";
	buffer = "";
	/** Markers that end the current channel's run. */
	get watched() {
		switch (this.channel) {
			case "text": return [THINKING_OPEN, DSML_MARKER];
			case "reasoning": return [THINKING_CLOSE];
			case "suppressed": return [];
		}
	}
	/**
	* Route one text delta.
	* @param delta - text exactly as the frame carried it.
	* @returns the runs that can be emitted now, in order; a delta ending
	*   mid-marker contributes nothing until the marker resolves.
	*/
	push(delta) {
		if (this.channel === "suppressed") return [];
		this.buffer += delta;
		const routed = [];
		while (true) {
			const watched = this.watched;
			if (watched.length === 0) {
				this.buffer = "";
				return routed;
			}
			const hit = watched.map((token) => ({
				token,
				at: this.buffer.indexOf(token)
			})).filter((candidate) => candidate.at >= 0).sort((left, right) => left.at - right.at)[0];
			if (hit === void 0) break;
			const before = this.buffer.slice(0, hit.at);
			if (before.length > 0 && this.channel !== "suppressed") routed.push({
				channel: this.channel,
				text: before
			});
			this.buffer = this.buffer.slice(hit.at + hit.token.length);
			this.channel = hit.token === THINKING_OPEN ? "reasoning" : hit.token === THINKING_CLOSE ? "text" : "suppressed";
		}
		if (this.channel === "suppressed") return routed;
		const held = heldSuffixLength(this.buffer, this.watched);
		const emit = this.buffer.slice(0, this.buffer.length - held);
		this.buffer = this.buffer.slice(this.buffer.length - held);
		if (emit.length > 0) routed.push({
			channel: this.channel,
			text: emit
		});
		return routed;
	}
	/**
	* Release text withheld as a possible partial marker.
	* @returns the final run, or nothing when the buffer is empty or suppressed.
	*/
	flush() {
		if (this.channel === "suppressed" || this.buffer.length === 0) return [];
		const text$3 = this.buffer;
		this.buffer = "";
		return [{
			channel: this.channel,
			text: text$3
		}];
	}
};
/** Assemble the final ChatContentBlockResult for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: block.callId ?? "",
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Parse one frame payload as JSON.
* @param frame - the decoded frame.
* @returns the parsed event.
* @throws `KiroError('MALFORMED_RESPONSE')` when the payload is not JSON.
*/
function parsePayload(frame) {
	const text$3 = new TextDecoder().decode(frame.payload);
	try {
		return JSON.parse(text$3);
	} catch {
		throw new KiroError(`malformed Kiro event payload: ${text$3.slice(0, 120)}`, "MALFORMED_RESPONSE");
	}
}
/** Accept one provider counter only when it is safe for gateway's usage schema. */
function tokenCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
/**
* Convert Kiro's disjoint token buckets to gateway's native usage vocabulary.
*
* Missing counters are zero, matching Kiro CLI's own stream parser, and a
* present malformed counter rejects the event instead of publishing misleading
* data. `totalTokens` is used only to recover the uncached input when the
* provider reports the total without that bucket. An event with no non-zero
* counter publishes nothing at all: usage gateway never received must read as
* unavailable, not as zero.
*/
function tokenUsageOf(value) {
	if (value === void 0 || typeof value !== "object" || value === null) return void 0;
	if ([
		value.uncachedInputTokens,
		value.outputTokens,
		value.totalTokens,
		value.cacheReadInputTokens,
		value.cacheWriteInputTokens
	].some((field) => field !== void 0 && tokenCount(field) === void 0)) return void 0;
	const outputTokens = tokenCount(value.outputTokens) ?? 0;
	const cacheReadTokens = tokenCount(value.cacheReadInputTokens) ?? 0;
	const cacheWriteTokens = tokenCount(value.cacheWriteInputTokens) ?? 0;
	const total = tokenCount(value.totalTokens);
	const inputTokens = tokenCount(value.uncachedInputTokens) ?? (total === void 0 ? 0 : Math.max(0, total - outputTokens - cacheReadTokens - cacheWriteTokens));
	if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return;
	return {
		inputTokens,
		outputTokens,
		...cacheReadTokens > 0 ? { cacheReadTokens } : {},
		...cacheWriteTokens > 0 ? { cacheWriteTokens } : {}
	};
}
/**
* Price one call from the provider's own context measurement.
*
* Kiro does not send `metadataEvent.tokenUsage` on every route — this account's
* traffic never received one — but it does send `contextUsageEvent` on every
* request, and the wire schema treats `contextUsagePercentage` as part of token
* accounting. Scaling it by the model's advertised window recovers the absolute
* input size, which is what the gateway needs to know how full the window is:
* without any usage the token meter has no provider anchor and prices the whole
* conversation from a local heuristic, so its compaction thresholds drift.
*
* Both local reference implementations do exactly this, for the same stated
* reason (`Kiro-Go/proxy/kiro.go:766`, `9router/open-sse/executors/kiro.js:1086`).
* The result is the provider's own measurement at the precision the provider
* reported it, not an exact per-request count: the output side has no such
* signal and is priced from the characters this stream actually emitted.
* @param percentage - the last `contextUsagePercentage` the stream reported.
* @param contextWindow - the selected model's advertised input capacity.
* @param outputCharacters - characters emitted as visible text and reasoning.
* @returns derived usage, or `undefined` when either input is unusable.
*/
function contextUsageTokens(percentage$1, contextWindow, outputCharacters) {
	if (percentage$1 === void 0 || contextWindow === void 0) return void 0;
	if (!Number.isFinite(percentage$1) || percentage$1 <= 0 || percentage$1 > 100) return void 0;
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) return void 0;
	const inputTokens = Math.round(percentage$1 / 100 * contextWindow);
	if (inputTokens <= 0) return void 0;
	return {
		inputTokens,
		outputTokens: outputCharacters > 0 ? Math.max(1, Math.round(outputCharacters / 4)) : 0
	};
}
/**
* Normalize a provider stop reason for comparison.
*
* Kiro's `StopReason` enum is upper snake case, while its lifecycle and proxy
* vocabularies use lower snake or camel case for the same outcomes. One
* normalized form keeps the mapping table small and case-independent.
* @param reason - the raw provider value.
* @returns the upper snake-case form.
*/
function normalizeStopReason(reason) {
	return reason.trim().replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[\s-]+/gu, "_").toUpperCase();
}
/** Render the refusal detail Kiro attaches to a filtered or declined turn. */
function refusalDetail(details) {
	const refusal = details?.refusal;
	if (refusal === void 0) return "";
	const parts = [
		refusal.category,
		refusal.explanation,
		refusal.recommendedModel
	].filter((part) => typeof part === "string" && part.length > 0);
	return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}
/**
* Map one provider stop reason to the gateway finish reason.
*
* Terminal protocol semantics are the provider's to state: a turn cut off by an
* output cap, an exhausted context, or a refusal must not be reported as a
* normal completion. An unrecognized reason stays a diagnosable failure rather
* than becoming a silent success, because a new terminal reason is exactly the
* case where guessing `stop` loses information.
* @param reason - the raw `metadataEvent.stopReason`.
* @param details - the accompanying `stopDetails`, when present.
* @param sawToolCalls - whether the stream opened any tool call.
* @returns the finish reason, or `undefined` when the provider named none.
*/
function finishReasonOf(reason, details, sawToolCalls) {
	if (reason === void 0 || reason.trim().length === 0) return void 0;
	switch (normalizeStopReason(reason)) {
		case "END_TURN":
		case "STOP":
		case "STOP_SEQUENCE": return sawToolCalls ? { kind: "tool-calls" } : { kind: "stop" };
		case "TOOL_USE":
		case "TOOL_CALLS": return { kind: "tool-calls" };
		case "MAX_TOKENS":
		case "MAX_OUTPUT_TOKENS":
		case "LENGTH": return { kind: "max-tokens" };
		case "MODEL_CONTEXT_WINDOW_EXCEEDED":
		case "CONTEXT_WINDOW_EXCEEDED": return {
			kind: "error",
			failure: {
				message: "Kiro stopped the turn because the model context window was exceeded",
				code: CONTEXT_WINDOW_EXCEEDED_CODE
			}
		};
		case "CONTENT_FILTERED":
		case "REFUSAL": return {
			kind: "error",
			failure: {
				message: `Kiro stopped the turn with a content refusal${refusalDetail(details)}`,
				code: "CONTENT_FILTERED"
			}
		};
		case "PAUSE_TURN": return {
			kind: "error",
			failure: {
				message: "Kiro paused the turn before it completed",
				code: "PAUSE_TURN"
			}
		};
		default: return {
			kind: "error",
			failure: {
				message: `Kiro stopped the turn with an unrecognized reason "${reason}"`,
				code: "UNKNOWN_STOP_REASON"
			}
		};
	}
}
/**
* Translate decoded frames into gateway chunks.
* @param frames - decoded event-stream frames in arrival order.
* @returns deltas as they arrive, every `block-end`, exact terminal `usage`
*   when supplied by Kiro, then one `finish`.
* @throws `KiroError` for an in-band service exception frame or a malformed payload.
*/
async function* translate(frames, contextWindow) {
	const router = new TextRouter();
	const guard = new LegacyMarkerGuard();
	const order = [];
	const toolBlocks = /* @__PURE__ */ new Map();
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	let usage;
	let stopReason;
	let stopDetails;
	let contextPercentage;
	let outputCharacters = 0;
	function open$1(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	function* emitText(text$3) {
		outputCharacters += text$3.length;
		if (textBlock === void 0) {
			textBlock = open$1("text");
			yield {
				type: "block-start",
				index: textBlock.index,
				blockType: "text"
			};
		}
		textBlock.text += text$3;
		yield {
			type: "text-delta",
			index: textBlock.index,
			text: text$3
		};
	}
	function* emitReasoning(text$3) {
		outputCharacters += text$3.length;
		if (reasoningBlock === void 0) {
			reasoningBlock = open$1("reasoning");
			yield {
				type: "block-start",
				index: reasoningBlock.index,
				blockType: "reasoning"
			};
		}
		reasoningBlock.text += text$3;
		yield {
			type: "reasoning-delta",
			index: reasoningBlock.index,
			text: text$3
		};
	}
	function* route(runs) {
		for (const run of runs) {
			if (run.channel === "reasoning") {
				yield* emitReasoning(run.text);
				continue;
			}
			const visible = guard.push(run.text);
			if (visible.length > 0) yield* emitText(visible);
		}
	}
	for await (const frame of frames) {
		const exception = frame.headers[":exception-type"];
		if (exception !== void 0) throw new KiroError(`Kiro service exception ${exception}: ${new TextDecoder().decode(frame.payload).slice(0, 300)}`, exception);
		switch (frame.headers[":event-type"]) {
			case "assistantResponseEvent": {
				const event = parsePayload(frame);
				if (typeof event.content === "string" && event.content.length > 0) yield* route(router.push(event.content));
				break;
			}
			case "reasoningContentEvent": {
				const event = parsePayload(frame);
				if (typeof event.text === "string" && event.text.length > 0) yield* emitReasoning(event.text);
				break;
			}
			case "toolUseEvent": {
				const event = parsePayload(frame);
				let block = toolBlocks.get(event.toolUseId);
				if (block === void 0) {
					block = open$1("tool-call");
					block.callId = event.toolUseId;
					toolBlocks.set(event.toolUseId, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (event.name !== void 0) block.name = event.name;
				const fragment = event.input ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: event.toolUseId,
					...block.name === void 0 ? {} : { name: block.name },
					argumentsDelta: fragment
				};
				break;
			}
			case "metadataEvent": {
				const event = parsePayload(frame);
				usage = tokenUsageOf(event.tokenUsage) ?? usage;
				const percentage$1 = event.tokenUsage?.contextUsagePercentage;
				if (typeof percentage$1 === "number" && Number.isFinite(percentage$1)) contextPercentage = percentage$1;
				if (typeof event.stopReason === "string" && event.stopReason.length > 0) {
					stopReason = event.stopReason;
					stopDetails = event.stopDetails;
				}
				break;
			}
			case "contextUsageEvent": {
				const event = parsePayload(frame);
				if (typeof event.contextUsagePercentage === "number" && Number.isFinite(event.contextUsagePercentage)) contextPercentage = event.contextUsagePercentage;
				break;
			}
			default: break;
		}
	}
	yield* route(router.flush());
	const withheld = guard.flush();
	if (withheld.length > 0) yield* emitText(withheld);
	for (const block of order) yield {
		type: "block-end",
		index: block.index,
		block: closeBlock(block)
	};
	const reason = finishReasonOf(stopReason, stopDetails, toolBlocks.size > 0) ?? (toolBlocks.size > 0 ? { kind: "tool-calls" } : order.length > 0 ? { kind: "stop" } : {
		kind: "error",
		failure: {
			message: "Kiro returned a completed response with no content",
			code: EMPTY_RESPONSE_CODE
		}
	});
	const settled = order.length === 0 && (reason.kind === "stop" || reason.kind === "tool-calls") ? {
		kind: "error",
		failure: {
			message: "Kiro returned a completed response with no content",
			code: EMPTY_RESPONSE_CODE
		}
	} : reason;
	const priced = usage ?? contextUsageTokens(contextPercentage, contextWindow, outputCharacters);
	if (priced !== void 0) yield {
		type: "usage",
		usage: priced
	};
	yield {
		type: "finish",
		reason: settled
	};
}

//#endregion
//#region lib/types/client.js
/** User agent Kiro's own IDE sends; the service gates model access on it. */
const KIRO_USER_AGENT$2 = "aws-sdk-js/3.738.0 KiroIDE";
const CODEWHISPERER_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
/**
* Kiro's `ValidationException` reason for a request whose serialized content
* exceeded the service bound. Kiro's own client maps exactly this reason to a
* context-window-exceeded failure.
*/
const CONTEXT_OVERFLOW_REASON = "CONTENT_LENGTH_EXCEEDS_THRESHOLD";
/**
* Message wording Kiro's own client treats as context overflow, kept byte-for-byte
* with the installed Kiro agent so the same recovery triggers here.
*/
const CONTEXT_OVERFLOW_MESSAGES = ["input is too long", "prompt is too long"];
/**
* Reasons that mean an allowance is spent rather than momentarily throttled,
* taken from the service model's own enums rather than guessed.
*/
const QUOTA_REASONS = [
	"MONTHLY_REQUEST_COUNT",
	"DAILY_REQUEST_COUNT",
	"OVERAGE_REQUEST_LIMIT_EXCEEDED"
];
/**
* A conversation the service will not extend further. The only lever is to make
* the conversation smaller, so it is reported as overflow.
*/
const CONVERSATION_LIMIT_REASON = "CONVERSATION_LIMIT_EXCEEDED";
/**
* Models the verified account tier reaches, used when live discovery is
* unavailable. Unlisted ids still pass through, so a tier that serves more
* needs no code change.
*/
const VISION = ["text", "image"];
/** Fallback catalog for a fresh installation or a failed discovery. */
const DEFAULT_MODELS = [{
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	contextWindow: 1e6,
	thinking: true,
	inputModalities: [...VISION]
}, {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	contextWindow: 1e6,
	thinking: true,
	inputModalities: [...VISION]
}];
/** Human-readable name for one reasoning effort id. */
function effortName(effort) {
	if (effort === "xhigh") return "xHigh";
	return effort.length === 0 ? effort : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;
}
/**
* The context capacity a model is reported with.
*
* `maxContextWindow` is a ceiling rather than a default: it lowers whatever the
* model claims and never raises it.
*/
function contextCapacity(declared, connection) {
	const cap = connection.maxContextWindow;
	return cap === void 0 ? declared : Math.min(declared, cap);
}
/**
* Recognize a Kiro HTTP 400 body that reports a context-window overflow rather
* than an ordinary validation failure. Deliberately narrow.
*/
function isKiroContextOverflow(body) {
	if (body === void 0 || body.length === 0) return false;
	if (body.includes(CONTEXT_OVERFLOW_REASON) || body.includes(CONVERSATION_LIMIT_REASON)) return true;
	const normalized = body.toLowerCase();
	return CONTEXT_OVERFLOW_MESSAGES.some((phrase) => normalized.includes(phrase));
}
/**
* Recognize a body that reports an exhausted account allowance rather than a
* transient throttle.
*/
function isKiroQuotaExhausted(body) {
	if (body === void 0 || body.length === 0) return false;
	if (body.includes(CONVERSATION_LIMIT_REASON)) return false;
	return QUOTA_REASONS.some((reason) => body.includes(reason));
}
/**
* Map a Kiro HTTP status and error body to a stable code.
* @param status - status of a non-2xx response.
* @param body - the response body text, when available.
* @returns the normalized error code.
*/
function httpErrorCode(status, body) {
	if (status === 401) return "AUTH";
	if (status === 403) {
		if (body !== void 0 && body.includes("bearer token")) return "AUTH";
		return isKiroQuotaExhausted(body) ? "QUOTA" : "FORBIDDEN";
	}
	if (isKiroContextOverflow(body)) return "CONTEXT_WINDOW_EXCEEDED";
	if (status === 402) return "QUOTA";
	if (status === 429) return isKiroQuotaExhausted(body) ? "QUOTA" : "RATE_LIMIT";
	if (status === 400) {
		if (body !== void 0 && body.includes("INVALID_MODEL_ID")) return "INVALID_MODEL";
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/** Select the auth-specific upstream surface Kiro accepts. */
function kiroRequestEndpoint(token, region) {
	return token.authMethod === "idc" || token.authMethod === "external_idp" ? `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse` : `https://q.${region}.amazonaws.com/generateAssistantResponse`;
}
/** Add the token discriminator required by API-key and external-IdP auth. */
function kiroTokenTypeHeaders(token) {
	if (token.authMethod === "api_key") return { TokenType: "API_KEY" };
	if (token.authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
/**
* Derive a stable provider conversation id from a caller session id.
*
* Kiro correlates caching and diagnostics by `conversationId`, so a new random
* id per turn presents one durable session as unrelated conversations. Hashed
* rather than forwarded, so no caller identifier leaks upstream.
*/
function conversationIdFor(sessionId) {
	if (sessionId === void 0 || sessionId.length === 0) return randomUUID();
	const digest = createHash("sha256").update(`kiro-nest:conversation:${sessionId}`).digest();
	const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
	bytes[6] = (bytes[6] ?? 0) & 15 | 128;
	bytes[8] = (bytes[8] ?? 0) & 63 | 128;
	const hex = Buffer.from(bytes).toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32)
	].join("-");
}
/**
* The Kiro `generateAssistantResponse` operation without an HTTP framework.
*
* One instance serves every route: the caller's model name is the wire
* `modelId`, so adding a Kiro model is configuration rather than registration.
*/
var KiroClient = class {
	config;
	constructor(config$1) {
		this.config = config$1;
	}
	/** List the models this account may reach. */
	async listModels(signal) {
		const connection = this.config.options();
		const discovered = this.config.discoverModels === void 0 ? connection.models : await this.config.discoverModels(connection, signal ?? AbortSignal.timeout(1e4));
		return this.config.selectModels === void 0 ? discovered : await this.config.selectModels(discovered);
	}
	/** Resolve one model's metadata for routing and selectors. */
	resolveModel(model) {
		const connection = this.config.options();
		const configured = (this.config.currentModels?.(connection) ?? connection.models).find((entry) => entry.id === model);
		const thinking = connection.defaults.thinking !== "disabled" && (configured?.thinking ?? true);
		const efforts = configured?.reasoningEfforts ?? (thinking ? [
			"off",
			"low",
			"medium",
			"high"
		] : ["off"]);
		const requestedDefault = connection.defaults.reasoningEffort;
		const defaultEffort = requestedDefault !== void 0 && efforts.includes(requestedDefault) ? requestedDefault : configured?.defaultReasoningEffort !== void 0 && efforts.includes(configured.defaultReasoningEffort) ? configured.defaultReasoningEffort : efforts.includes("high") ? "high" : efforts[0] ?? "off";
		return {
			id: configured?.id ?? model,
			name: configured?.name ?? model,
			...configured?.description === void 0 ? {} : { description: configured.description },
			inputModalities: configured?.inputModalities ?? ["text"],
			contextWindow: contextCapacity(configured?.contextWindow ?? connection.defaultContextWindow, connection),
			...configured?.maxTokens === void 0 ? {} : { defaultMaxTokens: configured.maxTokens },
			reasoningEfforts: efforts.map((effort) => ({
				id: effort,
				name: effortName(effort)
			})),
			defaultReasoningEffort: defaultEffort
		};
	}
	/**
	* Stream one request.
	*
	* One resolution per call: connection facts and the token freeze here and
	* hold for the whole request, so an in-flight stream never observes a
	* configuration change and the next call re-resolves.
	*/
	async *stream(request$2) {
		const connection = this.config.options();
		const consumer = new AbortController();
		const upstream = request$2.signal === void 0 ? consumer.signal : AbortSignal.any([request$2.signal, consumer.signal]);
		let idleExpired = false;
		const idle = () => {
			idleExpired = true;
			consumer.abort(new KiroError(`Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT"));
		};
		let timer = setTimeout(idle, connection.streamIdleTimeoutMs);
		const onActivity = () => {
			clearTimeout(timer);
			timer = setTimeout(idle, connection.streamIdleTimeoutMs);
		};
		const iterator = this.request(request$2, upstream, connection, onActivity)[Symbol.asyncIterator]();
		let exhausted = false;
		try {
			while (true) {
				const result = await iterator.next();
				if (result.done) {
					exhausted = true;
					return;
				}
				yield result.value;
			}
		} catch (error) {
			if (idleExpired) throw new KiroError(`Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
			if (request$2.signal?.aborted) throw new KiroError("Kiro request aborted by caller", "ABORTED", { cause: error });
			if (error instanceof KiroError) throw error;
			throw new KiroError("Kiro API stream failed", "TRANSPORT", { cause: error });
		} finally {
			clearTimeout(timer);
			consumer.abort("Kiro stream consumer stopped");
			if (!exhausted && iterator.return !== void 0) try {
				await iterator.return(void 0);
			} catch (_abortedTransportTeardown) {}
		}
	}
	async *request(request$2, signal, connection, onActivity) {
		const token = await this.config.resolveToken(connection, signal);
		const profileArn = connection.profileArn ?? token.profileArn;
		const url = kiroRequestEndpoint(token, profileArn === void 0 ? connection.region ?? token.region : profileRegion(profileArn));
		const selected = (this.config.currentModels?.(connection) ?? connection.models).find((model) => model.id === request$2.model);
		const nativeEffort = selected?.effortSchemaPath === void 0 || selected.reasoningEfforts === void 0 ? void 0 : {
			schemaPath: selected.effortSchemaPath,
			levels: selected.reasoningEfforts,
			...selected.defaultReasoningEffort === void 0 ? {} : { defaultLevel: selected.defaultReasoningEffort }
		};
		if (request$2.messages.some((message) => contentHasImage(message.content)) && selected?.inputModalities?.includes("image") !== true) throw new KiroError(`Kiro model "${request$2.model}" does not accept images.`, "UNSUPPORTED_CONTENT");
		const body = JSON.stringify(serializeRequest(request$2, connection.defaults, conversationIdFor(request$2.sessionId), profileArn, nativeEffort, selected?.maxTokensBounds === void 0 ? void 0 : { maxTokensBounds: selected.maxTokensBounds }));
		const attribution = this.config.userAgent === void 0 ? "" : ` ${this.config.userAgent}`;
		const response = await post({
			url,
			headers: {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
				authorization: `Bearer ${token.accessToken}`,
				...url.includes("://codewhisperer.") ? { "x-amz-target": CODEWHISPERER_TARGET } : {},
				...kiroTokenTypeHeaders(token),
				"x-amzn-kiro-agent-mode": "vibe",
				"user-agent": KIRO_USER_AGENT$2,
				"x-amz-user-agent": `${KIRO_USER_AGENT$2}${attribution}`
			},
			body,
			signal,
			...connection.proxyUrl === void 0 ? {} : { proxyUrl: connection.proxyUrl }
		});
		if (response.status !== 200) {
			const chunks = [];
			for await (const chunk of response.body) chunks.push(chunk);
			const text$3 = Buffer.concat(chunks).toString("utf8");
			let message = `Kiro API error (HTTP ${response.status})`;
			try {
				const parsed = JSON.parse(text$3);
				if (parsed.message !== void 0) message = parsed.message;
			} catch {}
			const id = response.headers["x-amzn-requestid"];
			throw new KiroError(message, httpErrorCode(response.status, text$3), {
				status: response.status,
				...typeof id === "string" && id.length > 0 ? { requestId: id } : {}
			});
		}
		yield* translate(decodeFrames(response.body, onActivity), contextCapacity(selected?.contextWindow ?? connection.defaultContextWindow, connection));
	}
};

//#endregion
//#region lib/types/discovery.js
const DEFAULT_CACHE_TTL_MS$1 = 300 * 1e3;
const KIRO_USER_AGENT$1 = "aws-sdk-js/3.738.0 KiroIDE";
/** Models requested per page; the service caps a page at its own maximum. */
const PAGE_SIZE = 50;
/**
* Pages followed before giving up on a continuation token. `ListAvailableModels`
* declares `nextToken` on both its request and its response, so a truncated
* catalog is a real possibility; a bounded walk keeps a misbehaving or looping
* token from turning discovery into an unbounded request sequence.
*/
const MAX_PAGES = 10;
/**
* Modalities in the order selectors should show them. Fixed rather than taken
* from the wire so one account's ordering cannot become a UI difference.
*/
const MODALITY_ORDER = ["text", "image"];
/**
* Read the input modalities a catalog entry declares.
*
* The service states this per model as `supportedInputTypes: ["TEXT","IMAGE"]`,
* so the capability is read rather than inferred from the model id: on this
* account 17 of 19 models accept images while `glm-5` and `minimax-m2.5` accept
* only text, and an id-based guess would send images to a model that refuses
* them. An unreadable value yields absence, which leaves the configured default
* in force instead of silently narrowing the model to text.
* @param value - the raw `supportedInputTypes` member.
* @returns declared modalities in display order, or undefined when unreadable.
*/
function parseInputModalities(value) {
	if (!Array.isArray(value)) return void 0;
	const declared = new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim().toLowerCase()));
	const modalities = MODALITY_ORDER.filter((modality) => declared.has(modality));
	return modalities.length === 0 ? void 0 : [...modalities];
}
function record$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function tokenTypeHeaders$1(authMethod) {
	if (authMethod === "api_key") return { TokenType: "API_KEY" };
	if (authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
function authHeaders(token) {
	return {
		authorization: `Bearer ${token.accessToken}`,
		"user-agent": KIRO_USER_AGENT$1,
		"x-amz-user-agent": KIRO_USER_AGENT$1,
		"x-amzn-codewhisperer-optout": "true",
		...tokenTypeHeaders$1(token.authMethod)
	};
}
/** Resolve the best CodeWhisperer profile ARN for one OAuth credential. */
async function discoverKiroProfileArn(connection, token, signal, request$2 = postJsonWithHeaders) {
	if (token.authMethod === "api_key") return void 0;
	const candidates = [...new Set([
		connection.region,
		token.region,
		"us-east-1",
		"eu-central-1"
	].filter((candidate) => candidate !== void 0))];
	for (const candidate of candidates) {
		const endpoint = candidate === "us-east-1" ? "https://codewhisperer.us-east-1.amazonaws.com" : `https://q.${candidate}.amazonaws.com`;
		const attempts = [{
			url: `${endpoint}/ListAvailableProfiles`,
			headers: authHeaders(token)
		}, {
			url: endpoint,
			headers: {
				...authHeaders(token),
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles"
			}
		}];
		for (const attempt of attempts) {
			let response;
			try {
				response = await request$2(attempt.url, { maxResults: 50 }, attempt.headers, connection.proxyUrl, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				continue;
			}
			if (response.status !== 200) continue;
			const profiles = record$2(response.body)?.profiles;
			if (!Array.isArray(profiles)) continue;
			const valid = [];
			for (const raw of profiles) {
				const value = record$2(raw);
				const candidateArn = value?.arn ?? value?.profileArn;
				if (typeof candidateArn !== "string") continue;
				try {
					valid.push(assertKiroProfileArn(candidateArn));
				} catch {}
			}
			const regional = valid.find((arn) => arn.split(":")[3] === token.region);
			if (regional !== void 0) return regional;
			if (valid[0] !== void 0) return valid[0];
		}
	}
}
/** Infer whether a discovered route should expose Kiro's thinking controls. */
function modelSupportsThinking(modelId) {
	return !/^(?:auto$|claude-sonnet-4$|claude-haiku-|qwen3-coder-next$)/iu.test(modelId);
}
/** Parse the same two effort-schema branches used by the installed Kiro client. */
function parseEffortSchema(schema) {
	const properties = record$2(record$2(schema)?.properties);
	for (const schemaPath of ["output_config", "reasoning"]) {
		const effort = record$2(record$2(record$2(properties?.[schemaPath])?.properties)?.effort);
		const rawLevels = effort?.enum;
		if (!Array.isArray(rawLevels)) continue;
		const levels = [...new Set(rawLevels.filter((level) => typeof level === "string" && level.length > 0))];
		if (levels.length === 0) continue;
		const defaultLevel = typeof effort?.default === "string" && levels.includes(effort.default) ? effort.default : void 0;
		return {
			levels,
			schemaPath,
			...defaultLevel === void 0 ? {} : { defaultLevel }
		};
	}
}
/**
* Read the bounds of the model's advertised `max_tokens` request field.
*
* The field is the only output cap `generateAssistantResponse` honors, and the
* advertised schema is `additionalProperties: false`, so a value outside the
* declared range — or the field itself on a model that does not declare it —
* fails validation. Sending it therefore requires reading these bounds first.
* @param schema - the model's `additionalModelRequestFieldsSchema`.
* @returns the inclusive bounds, or `undefined` when the model declares none.
*/
function parseMaxTokensBounds(schema) {
	const field = record$2(record$2(record$2(schema)?.properties)?.max_tokens);
	if (field === void 0 || field.type !== "integer") return void 0;
	const maximum = positiveInteger(field.maximum);
	if (maximum === void 0) return void 0;
	const minimum = positiveInteger(field.minimum) ?? 1;
	return minimum > maximum ? void 0 : {
		minimum,
		maximum
	};
}
/**
* Parse Kiro's ListAvailableModels response into catalog entries.
* @param body - decoded JSON response.
* @returns unique models in provider order.
*/
function parseAvailableModels(body) {
	const models = parseModelPage(body);
	if (models.length === 0) throw new Error("Kiro ListAvailableModels returned no usable model ids");
	return models;
}
/**
* Read the continuation token of one ListAvailableModels page.
* @param body - decoded JSON response.
* @returns the token, or `undefined` when this page is the last.
*/
function modelPageToken(body) {
	const token = record$2(body)?.nextToken;
	return typeof token === "string" && token.length > 0 ? token : void 0;
}
/**
* Parse one page of the model catalog without requiring it to be non-empty:
* a continuation page may legitimately add nothing new.
* @param body - decoded JSON response.
* @returns the page's models in provider order.
*/
function parseModelPage(body) {
	const rawModels = record$2(body)?.models;
	if (!Array.isArray(rawModels)) throw new Error("Kiro ListAvailableModels returned no models array");
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const raw of rawModels) {
		const rawModel = record$2(raw);
		const model = rawModel;
		if (model === void 0 || typeof model.modelId !== "string" || model.modelId.length === 0) continue;
		if (seen.has(model.modelId)) continue;
		seen.add(model.modelId);
		const limits = record$2(model.tokenLimits);
		const contextWindow = positiveInteger(limits?.maxInputTokens);
		const maxTokens = positiveInteger(limits?.maxOutputTokens);
		const inputModalities = parseInputModalities(model.supportedInputTypes);
		const effort = parseEffortSchema(model.additionalModelRequestFieldsSchema);
		const maxTokensBounds = parseMaxTokensBounds(model.additionalModelRequestFieldsSchema);
		const hasEffortSchema = rawModel !== void 0 && Object.hasOwn(rawModel, "additionalModelRequestFieldsSchema");
		models.push({
			id: model.modelId,
			...typeof model.modelName === "string" && model.modelName.length > 0 ? { name: model.modelName } : {},
			...typeof model.description === "string" && model.description.length > 0 ? { description: model.description } : {},
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...inputModalities === void 0 ? {} : { inputModalities },
			thinking: hasEffortSchema ? effort !== void 0 : modelSupportsThinking(model.modelId),
			...effort === void 0 ? {} : {
				reasoningEfforts: effort.levels,
				defaultReasoningEffort: effort.defaultLevel,
				effortSchemaPath: effort.schemaPath
			},
			...maxTokensBounds === void 0 ? {} : { maxTokensBounds }
		});
	}
	return models;
}
function discoveryError(status, body) {
	const value = record$2(body);
	return new KiroError(typeof value?.message === "string" ? value.message : `Kiro model discovery failed (HTTP ${status})`, status === 401 ? "AUTH" : status === 403 ? "FORBIDDEN" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "INVALID_REQUEST", { status });
}
/** Cached account-specific model discovery used by the adapter and web UI. */
var KiroModelDiscovery = class {
	options;
	requestJson;
	profileRequestJson;
	cacheTtlMs;
	cache = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		this.requestJson = options.requestJson ?? getJson;
		this.profileRequestJson = options.profileRequestJson ?? postJsonWithHeaders;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS$1;
	}
	key(connection, region) {
		return `${region}\u0000${connection.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`;
	}
	/** Drop all cached discovery results after login or logout. */
	clear() {
		this.cache.clear();
	}
	endpoint(region) {
		return region === "us-east-1" ? "https://codewhisperer.us-east-1.amazonaws.com" : `https://q.${region}.amazonaws.com`;
	}
	headers(token) {
		return authHeaders(token);
	}
	async discoverProfile(connection, token, region, signal) {
		return discoverKiroProfileArn({
			...connection,
			region
		}, token, signal, this.profileRequestJson);
	}
	/**
	* Return the last discovered catalog for this connection without I/O.
	* @param connection - current connection facts.
	* @returns cached models, if a matching discovery has completed.
	*/
	current(connection) {
		const region = connection.region;
		if (region !== void 0) return this.cache.get(this.key(connection, region))?.models;
		for (const [key, value] of this.cache) if (key.endsWith(`\u0000${connection.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`)) return value.models;
	}
	/**
	* Discover models offered to the signed-in account.
	* @param connection - frozen request facts.
	* @param signal - caller cancellation.
	* @param force - bypass a still-valid cache entry.
	* @returns live Kiro model metadata.
	*/
	async list(connection, signal, force = false) {
		const token = await this.options.resolveToken(connection, signal);
		const authRegion = connection.region ?? token.region;
		const key = this.key(connection, authRegion);
		const cached$1 = this.cache.get(key);
		if (!force && cached$1 !== void 0 && cached$1.expiresAt > Date.now()) return cached$1.models;
		const profileArn = connection.profileArn ?? token.profileArn ?? await this.discoverProfile(connection, token, authRegion, signal);
		const profileRegion$1 = profileArn?.split(":")[3];
		const region = profileRegion$1 !== void 0 && /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(profileRegion$1) ? profileRegion$1 : authRegion;
		const url = new URL(`${this.endpoint(region)}/ListAvailableModels`);
		url.searchParams.set("origin", "AI_EDITOR");
		url.searchParams.set("maxResults", String(PAGE_SIZE));
		if (profileArn !== void 0) url.searchParams.set("profileArn", profileArn);
		const models = [];
		const seen = /* @__PURE__ */ new Set();
		const usedTokens = /* @__PURE__ */ new Set();
		let nextToken;
		for (let page = 0; page < MAX_PAGES; page += 1) {
			let added = 0;
			if (nextToken === void 0) url.searchParams.delete("nextToken");
			else url.searchParams.set("nextToken", nextToken);
			const response = await this.requestJson(url.toString(), this.headers(token), connection.proxyUrl, signal);
			if (response.status !== 200) {
				if (models.length === 0) throw discoveryError(response.status, response.body);
				break;
			}
			for (const model of page === 0 ? parseAvailableModels(response.body) : parseModelPage(response.body)) {
				if (seen.has(model.id)) continue;
				seen.add(model.id);
				models.push(model);
				added += 1;
			}
			nextToken = modelPageToken(response.body);
			if (nextToken === void 0 || usedTokens.has(nextToken) || page > 0 && added === 0) break;
			usedTokens.add(nextToken);
		}
		this.cache.set(key, {
			expiresAt: Date.now() + this.cacheTtlMs,
			models
		});
		return models;
	}
};

//#endregion
//#region lib/types/login.js
const TOKEN_FILE = "kiro-auth-token.json";
const BUILDER_START_URL = "https://view.awsapps.com/start";
const KIRO_ISSUER_URL = "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6";
const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
const SOCIAL_CLIENT_ID = "kiro-cli";
const SOCIAL_DEVICE_AUTHORIZE_URL = `${KIRO_AUTH_SERVICE}/oauth/device/authorization`;
const SOCIAL_DEVICE_POLL_URL = `${KIRO_AUTH_SERVICE}/oauth/device/poll`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations"
];
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function stringField(value, camel, snake) {
	const candidate = value[camel] ?? (snake === void 0 ? void 0 : value[snake]);
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : void 0;
}
function numberField(value, camel, snake) {
	const candidate = value[camel] ?? (snake === void 0 ? void 0 : value[snake]);
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : void 0;
}
function providerError(body, fallback) {
	const value = record$1(body);
	if (value === void 0) return fallback;
	return stringField(value, "error_description") ?? stringField(value, "errorDescription") ?? stringField(value, "message") ?? stringField(value, "error") ?? fallback;
}
function startUrl(value) {
	let parsed;
	try {
		parsed = new URL(value.trim());
	} catch (error) {
		throw new Error("Kiro IAM Identity Center start URL is invalid", { cause: error });
	}
	if (parsed.protocol !== "https:" || !(parsed.hostname === "view.awsapps.com" || parsed.hostname.endsWith(".awsapps.com")) || parsed.pathname !== "/start" && parsed.pathname !== "/start/") throw new Error("Kiro IAM Identity Center start URL must be an https://*.awsapps.com/start URL");
	return parsed.toString().replace(/\/$/u, "");
}
/**
* Begin Kiro's coded device authorization for a free or IAM Identity Center account.
*/
async function startDeviceLogin(region, requestJson, signal, options = {}) {
	const selectedRegion = assertKiroRegion(region.trim() || "us-east-1");
	const authMethod = options.authMethod === "idc" ? "idc" : "builder-id";
	const selectedStartUrl = startUrl(authMethod === "idc" ? options.startUrl ?? "" : BUILDER_START_URL);
	const oidcBase = `https://oidc.${selectedRegion}.amazonaws.com`;
	const registration$1 = await requestJson(`${oidcBase}/client/register`, {
		clientName: "kiro-oauth-client",
		clientType: "public",
		scopes: SCOPES,
		grantTypes: [DEVICE_GRANT, "refresh_token"],
		issuerUrl: KIRO_ISSUER_URL
	}, signal);
	if (registration$1.status !== 200) throw new Error(`Kiro client registration failed: ${providerError(registration$1.body, `HTTP ${registration$1.status}`)}`);
	const registered = record$1(registration$1.body);
	const clientId = registered === void 0 ? void 0 : stringField(registered, "clientId", "client_id");
	const clientSecret = registered === void 0 ? void 0 : stringField(registered, "clientSecret", "client_secret");
	if (clientId === void 0 || clientSecret === void 0) throw new Error("Kiro client registration returned no client id or secret");
	const authorization = await requestJson(`${oidcBase}/device_authorization`, {
		clientId,
		clientSecret,
		startUrl: selectedStartUrl
	}, signal);
	if (authorization.status !== 200) throw new Error(`Kiro device authorization failed: ${providerError(authorization.body, `HTTP ${authorization.status}`)}`);
	const authorized = record$1(authorization.body);
	if (authorized === void 0) throw new Error("Kiro device authorization returned an invalid response");
	const deviceCode = stringField(authorized, "deviceCode", "device_code");
	const userCode = stringField(authorized, "userCode", "user_code");
	const verificationUri = stringField(authorized, "verificationUriComplete", "verification_uri_complete") ?? stringField(authorized, "verificationUri", "verification_uri");
	if (deviceCode === void 0 || userCode === void 0 || verificationUri === void 0) throw new Error("Kiro device authorization returned incomplete login details");
	const verificationUrl = new URL(verificationUri);
	if (verificationUrl.protocol !== "https:" || !(verificationUrl.hostname.endsWith(".amazonaws.com") || verificationUrl.hostname.endsWith(".awsapps.com") || verificationUrl.hostname.endsWith(".signin.aws"))) throw new Error(`Kiro returned an unsafe verification URL host: ${verificationUrl.hostname}`);
	const intervalSeconds = Math.max(1, numberField(authorized, "interval") ?? 5);
	const expiresIn = Math.max(1, numberField(authorized, "expiresIn", "expires_in") ?? 600);
	return {
		clientId,
		clientSecret,
		deviceCode,
		userCode,
		verificationUri: verificationUrl.toString(),
		intervalSeconds,
		expiresAt: Date.now() + expiresIn * 1e3,
		region: selectedRegion,
		authMethod,
		startUrl: selectedStartUrl
	};
}
/** Poll one device authorization once. */
async function pollDeviceLogin(session, requestJson, signal) {
	if (Date.now() >= session.expiresAt) throw new Error("Kiro device authorization expired; start login again");
	const response = await requestJson(`https://oidc.${session.region}.amazonaws.com/token`, {
		clientId: session.clientId,
		clientSecret: session.clientSecret,
		grantType: DEVICE_GRANT,
		deviceCode: session.deviceCode
	}, signal);
	const body = record$1(response.body);
	if (response.status === 400) {
		const code = body === void 0 ? void 0 : stringField(body, "error");
		if (code === "authorization_pending") return {
			status: "pending",
			intervalSeconds: session.intervalSeconds
		};
		if (code === "slow_down") return {
			status: "pending",
			intervalSeconds: session.intervalSeconds + 5
		};
		if (code === "access_denied") throw new Error("Kiro device authorization was denied");
		if (code === "expired_token") throw new Error("Kiro device authorization expired; start login again");
	}
	if (response.status !== 200 || body === void 0) throw new Error(`Kiro token request failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const accessToken = stringField(body, "accessToken", "access_token");
	const refreshToken = stringField(body, "refreshToken", "refresh_token");
	if (accessToken === void 0 || refreshToken === void 0) throw new Error("Kiro token response returned incomplete credentials");
	const expiresIn = Math.max(1, numberField(body, "expiresIn", "expires_in") ?? 3600);
	const profileArn = stringField(body, "profileArn", "profile_arn");
	return {
		status: "completed",
		credentials: {
			accessToken,
			refreshToken,
			expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
			clientId: session.clientId,
			clientSecret: session.clientSecret,
			region: session.region,
			authMethod: session.authMethod,
			startUrl: session.startUrl,
			...profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(profileArn) }
		}
	};
}
/** Begin Kiro's headless Google or GitHub device authorization. */
async function startSocialDeviceLogin(provider, requestJson, signal) {
	const loginProvider = provider === "google" ? "Google" : "Github";
	const response = await requestJson(SOCIAL_DEVICE_AUTHORIZE_URL, {
		clientId: SOCIAL_CLIENT_ID,
		loginProvider
	}, signal);
	if (response.status !== 200) throw new Error(`Kiro social device authorization failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const body = record$1(response.body);
	const deviceCode = body === void 0 ? void 0 : stringField(body, "deviceCode", "device_code");
	const userCode = body === void 0 ? void 0 : stringField(body, "userCode", "user_code");
	const verificationUri = body === void 0 ? void 0 : stringField(body, "verificationUriComplete", "verification_uri_complete");
	if (deviceCode === void 0 || userCode === void 0 || verificationUri === void 0) throw new Error("Kiro social device authorization returned incomplete login details");
	const verificationUrl = new URL(verificationUri);
	if (verificationUrl.protocol !== "https:" || verificationUrl.hostname !== "app.kiro.dev" || verificationUrl.pathname !== "/account/device" || verificationUrl.searchParams.get("user_code") !== userCode || verificationUrl.searchParams.get("login_provider") !== loginProvider) throw new Error("Kiro returned an unexpected social verification URL");
	const intervalMilliseconds = Math.max(1, body === void 0 ? 5e3 : numberField(body, "intervalInMilliseconds", "interval_in_milliseconds") ?? 5e3);
	const expiresInMilliseconds = Math.max(1, body === void 0 ? 3e5 : numberField(body, "expiresInMilliseconds", "expires_in_milliseconds") ?? 3e5);
	return {
		provider,
		deviceCode,
		userCode,
		verificationUri: verificationUrl.toString(),
		intervalSeconds: Math.max(1, Math.ceil(intervalMilliseconds / 1e3)),
		expiresAt: Date.now() + expiresInMilliseconds
	};
}
/** Poll one Kiro Google/GitHub device authorization once. */
async function pollSocialDeviceLogin(session, requestJson, signal) {
	if (Date.now() >= session.expiresAt) throw new Error("Kiro social device authorization expired; start login again");
	const response = await requestJson(SOCIAL_DEVICE_POLL_URL, {
		clientId: SOCIAL_CLIENT_ID,
		deviceCode: session.deviceCode
	}, signal);
	const body = record$1(response.body);
	const progress = body === void 0 ? void 0 : stringField(body, "error") ?? stringField(body, "status");
	if (progress === "authorization_pending") return {
		status: "pending",
		intervalSeconds: session.intervalSeconds
	};
	if (progress === "slow_down") return {
		status: "pending",
		intervalSeconds: session.intervalSeconds + 5
	};
	if (response.status !== 200 || body === void 0) throw new Error(`Kiro social device token request failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const accessToken = stringField(body, "accessToken", "access_token");
	const refreshToken = stringField(body, "refreshToken", "refresh_token");
	if (accessToken === void 0 || refreshToken === void 0) throw new Error(`Kiro social device token request failed: ${progress ?? "incomplete token response"}`);
	const expiresIn = Math.max(1, numberField(body, "expiresIn", "expires_in") ?? 3600);
	const profileArn = stringField(body, "profileArn", "profile_arn");
	return {
		status: "completed",
		credentials: {
			accessToken,
			refreshToken,
			expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
			region: "us-east-1",
			authMethod: session.provider,
			...profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(profileArn) }
		}
	};
}
/**
* Resolve the credential origin for one refresh-token import.
* @param requested - the explicit origin the caller named, if any.
* @param hasClientCredentials - whether an OIDC client id and secret were supplied.
* @param resolvedStartUrl - the normalized start URL, if any.
* @returns the origin to record.
* @throws when the named origin contradicts the supplied credentials.
*/
function resolveRefreshTokenOrigin(requested, hasClientCredentials, resolvedStartUrl) {
	if (requested === "imported" && hasClientCredentials) throw new Error("Kiro refresh-token import: an imported Kiro token refreshes against Kiro's own service and takes no OIDC client id or secret");
	if ((requested === "builder-id" || requested === "idc") && !hasClientCredentials) throw new Error(`Kiro refresh-token import: ${requested} credentials refresh through AWS OIDC and require their client id and client secret`);
	if (requested === "idc" && resolvedStartUrl === void 0) throw new Error("Kiro refresh-token import: IAM Identity Center credentials require their start URL");
	if (requested !== void 0) return requested;
	if (!hasClientCredentials) return "imported";
	return resolvedStartUrl !== void 0 && resolvedStartUrl !== BUILDER_START_URL ? "idc" : "builder-id";
}
/** Validate and refresh an imported Kiro refresh token. */
async function importRefreshToken(input, requestJson, signal) {
	const refreshToken = input.refreshToken.trim();
	if (refreshToken.length === 0) throw new Error("Kiro refresh token is required");
	if (input.clientId === void 0 !== (input.clientSecret === void 0)) throw new Error("Kiro client id and client secret must be provided together");
	const region = assertKiroRegion(input.region?.trim() || "us-east-1");
	const hasClientCredentials = input.clientId !== void 0 && input.clientSecret !== void 0;
	const resolvedStartUrl = input.startUrl === void 0 || input.startUrl.trim().length === 0 ? void 0 : startUrl(input.startUrl);
	const origin = resolveRefreshTokenOrigin(input.authMethod, hasClientCredentials, resolvedStartUrl);
	const viaAwsOidc = origin === "builder-id" || origin === "idc";
	const response = await requestJson(viaAwsOidc ? `https://oidc.${region}.amazonaws.com/token` : `${KIRO_AUTH_SERVICE}/refreshToken`, viaAwsOidc ? {
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		refreshToken,
		grantType: "refresh_token"
	} : { refreshToken }, signal);
	if (response.status !== 200) throw new Error(`Kiro refresh-token import failed: ${providerError(response.body, `HTTP ${response.status}`)}`);
	const body = record$1(response.body);
	const accessToken = body === void 0 ? void 0 : stringField(body, "accessToken", "access_token");
	if (accessToken === void 0) throw new Error("Kiro refresh-token import returned no access token");
	const rotated = body === void 0 ? void 0 : stringField(body, "refreshToken", "refresh_token");
	const expiresIn = Math.max(1, body === void 0 ? 3600 : numberField(body, "expiresIn", "expires_in") ?? 3600);
	const responseProfile = body === void 0 ? void 0 : stringField(body, "profileArn", "profile_arn");
	const selectedProfile = input.profileArn?.trim() || responseProfile;
	return {
		accessToken,
		refreshToken: rotated ?? refreshToken,
		expiresAt: new Date(Date.now() + expiresIn * 1e3).toISOString(),
		region,
		authMethod: origin,
		...viaAwsOidc ? {
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			startUrl: resolvedStartUrl ?? BUILDER_START_URL
		} : {},
		...selectedProfile === void 0 ? {} : { profileArn: assertKiroProfileArn(selectedProfile) }
	};
}
/** Validate a long-lived Kiro API key against its actual model catalog. */
async function importApiKey(apiKey, regionValue, requestGet, signal) {
	const accessToken = apiKey.trim();
	if (accessToken.length === 0) throw new Error("Kiro API key is required");
	const region = assertKiroRegion(regionValue?.trim() || "us-east-1");
	const url = new URL(`https://q.${region}.amazonaws.com/ListAvailableModels`);
	url.searchParams.set("origin", "AI_EDITOR");
	const response = await requestGet(url.toString(), {
		authorization: `Bearer ${accessToken}`,
		TokenType: "API_KEY",
		"user-agent": "aws-sdk-js/3.738.0 KiroIDE",
		"x-amz-user-agent": "aws-sdk-js/3.738.0 KiroIDE"
	}, signal);
	const models = record$1(response.body)?.models;
	if (response.status !== 200 || !Array.isArray(models) || models.length === 0) throw new Error("Kiro API key validation failed");
	return {
		credentials: {
			accessToken,
			expiresAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1e3).toISOString(),
			region,
			authMethod: "api_key"
		},
		models: models.length
	};
}
/** Convert CLIProxyAPI-compatible Microsoft external-IdP JSON into managed credentials. */
function importExternalIdp(raw) {
	return normalizeExternalIdpCredentials(raw);
}
async function atomicJson(path, value) {
	const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, path);
}
/** The stored record one login writes, in the shape every resolver reads. */
function credentialRecordOf(credentials, clientIdHash) {
	return {
		accessToken: credentials.accessToken,
		...credentials.refreshToken === void 0 ? {} : { refreshToken: credentials.refreshToken },
		expiresAt: credentials.expiresAt,
		region: credentials.region,
		authMethod: credentials.authMethod,
		...credentials.profileArn === void 0 ? {} : { profileArn: assertKiroProfileArn(credentials.profileArn) },
		...clientIdHash === void 0 ? {} : { clientIdHash },
		...credentials.clientId === void 0 || credentials.clientSecret !== void 0 ? {} : { clientId: credentials.clientId },
		...credentials.startUrl === void 0 ? {} : { startUrl: credentials.startUrl },
		...credentials.tokenEndpoint === void 0 ? {} : { tokenEndpoint: credentials.tokenEndpoint },
		...credentials.scope === void 0 ? {} : { scope: credentials.scope }
	};
}
/**
* Save any normalized credential beneath the gateway data directory with private permissions.
*
* The account store is the authority; the single-credential file is kept in
* step because the `kiro-login` CLI and external tooling read it.
* @param directory - the credential directory this plugin owns.
* @param credentials - the credential a login or import produced.
* @param options - account targeting for a re-login, or a label for a new account.
* @returns the identifier of the account that now holds the credential.
*/
async function saveManagedCredentials(directory, credentials, options = {}) {
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	let clientIdHash;
	if (credentials.clientId !== void 0 && credentials.clientSecret !== void 0) {
		clientIdHash = createHash("sha256").update(credentials.clientId).digest("hex");
		await atomicJson(join(directory, clientIdHash + ".json"), {
			clientId: credentials.clientId,
			clientSecret: credentials.clientSecret
		});
	}
	const record$5 = credentialRecordOf(credentials, clientIdHash);
	const saved = await new KiroAccountStore(directory).upsert({
		credential: record$5,
		authMethod: credentials.authMethod,
		region: credentials.region,
		...credentials.profileArn === void 0 ? {} : { profileArn: credentials.profileArn },
		...options.label === void 0 ? {} : { label: options.label },
		...options.accountId === void 0 ? {} : { accountId: options.accountId },
		activate: options.activate ?? options.accountId === void 0
	});
	await syncManagedCredentialFile(directory);
	return saved;
}
/**
* Read only non-secret managed credential metadata for the status API.
*
* The account store wins over the single-credential file once it exists, so
* an installation that signed every account out reads as signed out instead of
* as still holding the credential it migrated from.
* @param directory - the credential directory this plugin owns.
* @returns credential metadata safe for the browser.
*/
async function credentialSummary(directory) {
	const store = new KiroAccountStore(directory);
	if (await store.exists()) {
		const active = (await store.snapshot()).accounts.find((account) => account.active);
		if (active === void 0) return { authenticated: false };
		return {
			authenticated: active.state !== "unusable",
			...active.expiresAt === void 0 ? {} : { expiresAt: new Date(active.expiresAt).toISOString() },
			...active.region === void 0 ? {} : { region: active.region },
			authMethod: kiroAuthMethod(active.authMethod, {}),
			...active.profileArn === void 0 ? {} : { profileArn: active.profileArn }
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(await readFile(join(directory, TOKEN_FILE), "utf8"));
	} catch {
		return { authenticated: false };
	}
	const value = record$1(parsed);
	if (value === void 0) return { authenticated: false };
	const accessToken = stringField(value, "accessToken", "access_token");
	const refreshToken = stringField(value, "refreshToken", "refresh_token");
	const expiresAt = stringField(value, "expiresAt", "expires_at");
	const region = stringField(value, "region");
	const recorded = stringField(value, "authMethod", "auth_method");
	const method = recorded === void 0 ? void 0 : kiroAuthMethod(recorded, value);
	const profileArn = stringField(value, "profileArn", "profile_arn");
	return {
		authenticated: accessToken !== void 0 || refreshToken !== void 0,
		...expiresAt === void 0 ? {} : { expiresAt },
		...region === void 0 ? {} : { region },
		...method === void 0 ? {} : { authMethod: method },
		...profileArn === void 0 ? {} : { profileArn }
	};
}
async function unlinkIfPresent(path) {
	try {
		await unlink(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
/**
* Delete only credentials owned by this plugin, leaving Kiro IDE files intact.
*
* Every stored account is removed, which is the historical meaning of signing
* out here; each account device registration goes with its credential.
* @param directory - the credential directory this plugin owns.
*/
async function deleteDeviceCredentials(directory) {
	const store = new KiroAccountStore(directory);
	let legacyHash;
	try {
		const parsed = record$1(JSON.parse(await readFile(join(directory, TOKEN_FILE), "utf8")));
		const candidate = parsed === void 0 ? void 0 : stringField(parsed, "clientIdHash");
		if (candidate !== void 0 && /^[a-f0-9]{64}$/u.test(candidate)) legacyHash = candidate;
	} catch (error) {
		if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
	}
	const removed = await store.removeAll();
	await unlinkIfPresent(join(directory, TOKEN_FILE));
	const hashes = /* @__PURE__ */ new Set();
	if (legacyHash !== void 0) hashes.add(legacyHash);
	for (const entry of removed) {
		const hash = stringField(record$1(entry.credential) ?? {}, "clientIdHash");
		if (hash !== void 0 && /^[a-f0-9]{64}$/u.test(hash)) hashes.add(hash);
	}
	for (const hash of hashes) await unlinkIfPresent(join(directory, hash + ".json"));
	clearTokenCache();
}
/**
* Make the single-credential file mirror the active account.
*
* The account store is what the adapter resolves from, but the CLI and
* external tooling read the older file, so every account switch or removal
* leaves it describing the account that is actually in use.
* @param directory - the credential directory this plugin owns.
*/
async function syncManagedCredentialFile(directory) {
	const captured = await new KiroAccountStore(directory).capture();
	const credential = captured === null ? void 0 : await captured.read();
	if (credential === void 0) {
		await unlinkIfPresent(join(directory, TOKEN_FILE));
		clearTokenCache();
		return;
	}
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	await atomicJson(join(directory, TOKEN_FILE), credential);
	clearTokenCache();
}

//#endregion
//#region lib/types/model-settings.js
const MODEL_SETTINGS_FILE = "model-settings.json";
/** Default file used when a caller does not name one. */
function defaultSettingsFile() {
	const dataDir$1 = process.env.KIRO_NEST_DATA_DIR;
	return join(dataDir$1 !== void 0 && dataDir$1.trim().length > 0 ? join(dataDir$1, "storages", "kiro-auth") : join(process.cwd(), "data", "storages", "kiro-auth"), MODEL_SETTINGS_FILE);
}
function validIds(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id) => typeof id === "string" && id.length > 0 && !/\s/u.test(id)))];
}
function normalize$1(value) {
	const record$5 = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	return {
		enabledModelIds: validIds(record$5.enabledModelIds),
		knownModelIds: validIds(record$5.knownModelIds),
		updatedAt: typeof record$5.updatedAt === "number" && Number.isFinite(record$5.updatedAt) ? record$5.updatedAt : 0
	};
}
/** Default storage path inside the credential directory. */
function modelSettingsPath(directory) {
	return join(directory, MODEL_SETTINGS_FILE);
}
/** Sort models by family, newest numeric version, then preferred variant. */
function compareKiroModels(a, b) {
	const family = (model) => {
		const text$3 = `${model.id} ${model.name ?? ""}`.toLowerCase();
		if (text$3.includes("claude")) return 1;
		if (text$3.includes("gpt")) return 2;
		if (text$3.includes("glm")) return 3;
		if (text$3.includes("deepseek")) return 4;
		if (text$3.includes("minimax")) return 5;
		if (text$3.includes("qwen")) return 6;
		if (model.id === "auto") return 8;
		return 7;
	};
	const familyDifference = family(a) - family(b);
	if (familyDifference !== 0) return familyDifference;
	const version = (model) => {
		return (`${model.id} ${model.name ?? ""}`.match(/\b(?:claude|gpt|glm|deepseek|qwen)?[-_ ]*v?(\d+(?:\.\d+)*)/iu)?.[1] ?? "0").split(".").map((part) => Number(part) || 0);
	};
	const left = version(a);
	const right = version(b);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (right[index] ?? 0) - (left[index] ?? 0);
		if (difference !== 0) return difference;
	}
	const variant = (model) => {
		const text$3 = `${model.id} ${model.name ?? ""}`.toLowerCase();
		if (text$3.includes("opus")) return 1;
		if (text$3.includes("sonnet")) return 2;
		if (text$3.includes("haiku")) return 3;
		if (text$3.includes("sol")) return 4;
		if (text$3.includes("terra")) return 5;
		if (text$3.includes("luna")) return 6;
		return 10;
	};
	const variantDifference = variant(a) - variant(b);
	if (variantDifference !== 0) return variantDifference;
	return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
}
/** Serialize model-settings writes so concurrent checkbox changes cannot race. */
var FileModelSettingsStore = class {
	chain = Promise.resolve();
	file;
	constructor(file = defaultSettingsFile()) {
		this.file = file;
	}
	async read() {
		try {
			return normalize$1(JSON.parse(await readFile(this.file, "utf8")));
		} catch (error) {
			if (error.code === "ENOENT") return normalize$1(void 0);
			throw error;
		}
	}
	async write(settings) {
		const next = {
			...normalize$1(settings),
			updatedAt: Date.now()
		};
		await mkdir(dirname(this.file), {
			recursive: true,
			mode: 448
		});
		const temporary = `${this.file}.tmp`;
		await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 384 });
		await rename(temporary, this.file);
		return next;
	}
	modify(update) {
		const next = (async () => {
			await this.chain.catch(() => {});
			const current = await this.read();
			const updated = update(current);
			return updated === void 0 ? current : this.write(updated);
		})();
		this.chain = next.catch(() => {});
		return next;
	}
	/** Merge a fresh catalog, enabling first-run and newly discovered model ids. */
	mergeCatalog(models) {
		const catalogIds = [...new Set(models.map((model) => model.id))];
		const catalog = new Set(catalogIds);
		return this.modify((current) => {
			const known = new Set(current.knownModelIds);
			const enabled = current.knownModelIds.length === 0 ? catalogIds : [...current.enabledModelIds.filter((id) => catalog.has(id)), ...catalogIds.filter((id) => !known.has(id))];
			const enabledModelIds = [...new Set(enabled)];
			if (enabledModelIds.length === current.enabledModelIds.length && enabledModelIds.every((id, index) => id === current.enabledModelIds[index]) && catalogIds.length === current.knownModelIds.length && catalogIds.every((id, index) => id === current.knownModelIds[index])) return void 0;
			return {
				enabledModelIds,
				knownModelIds: catalogIds,
				updatedAt: current.updatedAt
			};
		});
	}
	/** Persist an exact checkbox selection, constrained to the current catalog. */
	setEnabledModelIds(enabledModelIds, models) {
		const catalogIds = [...new Set(models.map((model) => model.id))];
		const requested = new Set(validIds(enabledModelIds));
		return this.modify((current) => ({
			enabledModelIds: catalogIds.filter((id) => requested.has(id)),
			knownModelIds: catalogIds,
			updatedAt: current.updatedAt
		}));
	}
	/** Resolve enabled models; a missing settings file means all are enabled. */
	async enabledModels(models) {
		const settings = await this.read();
		const enabled = settings.knownModelIds.length === 0 ? new Set(models.map((model) => model.id)) : new Set(settings.enabledModelIds);
		return models.filter((model) => enabled.has(model.id)).sort(compareKiroModels);
	}
};
/** Project a full catalog into the compact checkbox API shape. */
async function modelSelection(store, models) {
	const settings = await store.read();
	const enabled = settings.knownModelIds.length === 0 ? new Set(models.map((model) => model.id)) : new Set(settings.enabledModelIds);
	const projected = models.map((model) => ({
		...model,
		enabled: enabled.has(model.id)
	}));
	projected.sort((a, b) => Number(b.enabled) - Number(a.enabled) || compareKiroModels(a, b));
	return {
		enabledModelIds: projected.filter((model) => model.enabled).map((model) => model.id),
		models: projected
	};
}

//#endregion
//#region lib/types/usage.js
const DEFAULT_CACHE_TTL_MS = 300 * 1e3;
const KIRO_USER_AGENT = "aws-sdk-js/3.738.0 KiroIDE";
/**
* Limit value Kiro publishes for a plan with no usable bound. The installed
* client treats a limit at or above it as "no limit" rather than a quota, so
* converting it into a percentage would invent a ceiling the account does not have.
*/
const NO_LIMIT_SENTINEL = 999999;
/** Bonus states that still describe real, displayable balance. */
const DISPLAYABLE_BONUS_STATES = new Set(["ACTIVE", "EXHAUSTED"]);
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function numeric(...values) {
	for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
	return 0;
}
function timestamp(value) {
	let milliseconds;
	if (typeof value === "number" && Number.isFinite(value)) milliseconds = value < 1e10 ? value * 1e3 : value;
	else if (typeof value === "string" && value.length > 0) {
		const asNumber = Number(value);
		milliseconds = Number.isFinite(asNumber) ? asNumber < 1e10 ? asNumber * 1e3 : asNumber : Date.parse(value);
	} else return;
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : void 0;
}
function percentage(value) {
	return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
/**
* Build one usage row, treating an absent or sentinel limit as unbounded.
* @param id - stable row identifier.
* @param label - display label.
* @param used - amount consumed.
* @param limit - reported bound, possibly Kiro's no-limit sentinel.
* @param resetAt - when the bound resets or the grant expires.
* @param kind - which balance this row describes.
* @returns the normalized row.
*/
function row(id, label, used, limit, resetAt, kind) {
	const bounded = limit > 0 && limit < NO_LIMIT_SENTINEL;
	const remaining = bounded ? Math.max(0, limit - used) : 0;
	return {
		id,
		label,
		used,
		limit,
		remaining,
		usedPercent: bounded ? percentage(used / limit * 100) : 0,
		remainingPercent: bounded ? percentage(remaining / limit * 100) : 0,
		...resetAt === void 0 ? {} : { resetAt },
		kind,
		...bounded ? {} : { unlimited: true }
	};
}
/** Slug one label into a stable row-id fragment. */
function slug(value, fallback) {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
	return cleaned.length === 0 ? fallback : cleaned;
}
/**
* Normalize the public quota response without retaining account identity fields.
*
* Every structure the installed Kiro client reads is covered: subscription
* breakdowns, the welcome trial (only while the provider calls it `ACTIVE`),
* named bonus grants, and purchased overage credit packs. Unknown or unbounded
* limits are marked, never converted into a percentage.
* @param value - the decoded GetUsageLimits response.
* @param now - current epoch milliseconds, injectable for tests.
* @returns the normalized usage snapshot.
*/
function parseKiroUsage(value, now = Date.now()) {
	const root = record(value);
	const breakdowns = root?.usageBreakdownList;
	if (!Array.isArray(breakdowns)) throw new Error("Kiro GetUsageLimits returned no usage breakdown");
	const resetAt = timestamp(root?.nextDateReset ?? root?.resetDate);
	const rows = [];
	for (const raw of breakdowns) {
		const item = record(raw);
		if (item === void 0) continue;
		const resourceType = text(item.resourceType) ?? `usage-${rows.length + 1}`;
		const prefix = resourceType.toLowerCase();
		const label = text(item.displayNamePlural) ?? text(item.displayName) ?? resourceType;
		rows.push(row(prefix, label, numeric(item.currentUsageWithPrecision, item.currentUsage), numeric(item.usageLimitWithPrecision, item.usageLimit), resetAt, "subscription"));
		const trial = record(item.freeTrialInfo);
		if (trial !== void 0 && text(trial.freeTrialStatus) === "ACTIVE") rows.push(row(`${prefix}-welcome-bonus`, "Welcome bonus", numeric(trial.currentUsageWithPrecision, trial.currentUsage), numeric(trial.usageLimitWithPrecision, trial.usageLimit), timestamp(trial.freeTrialExpiry) ?? resetAt, "bonus"));
		if (Array.isArray(item.bonuses)) for (const [index, rawBonus] of item.bonuses.entries()) {
			const bonus = record(rawBonus);
			if (bonus === void 0) continue;
			const status = text(bonus.status);
			if (status !== void 0 && !DISPLAYABLE_BONUS_STATES.has(status)) continue;
			const name = text(bonus.displayName) ?? "Bonus";
			rows.push(row(`${prefix}-bonus-${slug(name, String(index + 1))}`, name, numeric(bonus.currentUsageWithPrecision, bonus.currentUsage), numeric(bonus.usageLimitWithPrecision, bonus.usageLimit), timestamp(bonus.expiresAt) ?? resetAt, "bonus"));
		}
		if (Array.isArray(item.overageCredits)) for (const [index, rawPack] of item.overageCredits.entries()) {
			const pack = record(rawPack);
			if (pack === void 0) continue;
			const expiresAt = timestamp(pack.expiresAt);
			if (expiresAt !== void 0 && Date.parse(expiresAt) <= now) continue;
			rows.push(row(`${prefix}-addon-${index + 1}`, text(pack.displayName) ?? "Add-on credits", numeric(pack.currentUsageWithPrecision, pack.currentUsage), numeric(pack.usageLimitWithPrecision, pack.usageLimit), expiresAt ?? resetAt, "addon"));
		}
	}
	if (rows.length === 0) throw new Error("Kiro GetUsageLimits returned no usable usage rows");
	return {
		plan: text(record(root?.subscriptionInfo)?.subscriptionTitle) ?? "Kiro",
		fetchedAt: now,
		...resetAt === void 0 ? {} : { resetAt },
		rows
	};
}
function tokenTypeHeaders(authMethod) {
	if (authMethod === "api_key") return { TokenType: "API_KEY" };
	if (authMethod === "external_idp") return { TokenType: "EXTERNAL_IDP" };
	return {};
}
function headers(token) {
	return {
		authorization: `Bearer ${token.accessToken}`,
		"user-agent": KIRO_USER_AGENT,
		"x-amz-user-agent": KIRO_USER_AGENT,
		...tokenTypeHeaders(token.authMethod)
	};
}
/** Account-scoped five-minute usage cache with forced refresh support. */
var KiroUsageService = class {
	options;
	getRequest;
	postRequest;
	cacheTtlMs;
	cache = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		this.getRequest = options.getRequest ?? getJson;
		this.postRequest = options.postRequest ?? postJsonWithHeaders;
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	}
	key(connection, token) {
		return `${connection.region ?? token.region}\u0000${connection.profileArn ?? token.profileArn ?? ""}\u0000${connection.proxyUrl ?? ""}`;
	}
	clear() {
		this.cache.clear();
	}
	current(connection) {
		const suffix = `\u0000${connection.proxyUrl ?? ""}`;
		const prefix = connection.region === void 0 ? void 0 : `${connection.region}\u0000`;
		for (const [key, entry] of this.cache) if (key.endsWith(suffix) && (prefix === void 0 || key.startsWith(prefix))) return entry.usage;
	}
	async get(connection, signal, force = false) {
		const token = await this.options.resolveToken(connection, signal);
		const key = this.key(connection, token);
		const cached$1 = this.cache.get(key);
		if (!force && cached$1 !== void 0 && cached$1.expiresAt > Date.now()) return cached$1.usage;
		const region = connection.region ?? token.region;
		const profileArn = connection.profileArn ?? token.profileArn;
		const codeWhispererQuery = new URLSearchParams({
			isEmailRequired: "true",
			origin: "AI_EDITOR",
			resourceType: "AGENTIC_REQUEST"
		});
		const qQuery = new URLSearchParams({
			origin: "AI_EDITOR",
			resourceType: "AGENTIC_REQUEST",
			...profileArn === void 0 ? {} : { profileArn }
		});
		const commonHeaders = headers(token);
		const attempts = [
			() => this.getRequest(`https://codewhisperer.${region}.amazonaws.com/getUsageLimits?${codeWhispererQuery.toString()}`, commonHeaders, connection.proxyUrl, signal),
			() => this.postRequest(`https://codewhisperer.${region}.amazonaws.com`, {
				origin: "AI_EDITOR",
				resourceType: "AGENTIC_REQUEST",
				...profileArn === void 0 ? {} : { profileArn }
			}, {
				...commonHeaders,
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": "AmazonCodeWhispererService.GetUsageLimits"
			}, connection.proxyUrl, signal),
			() => this.getRequest(`https://q.${region}.amazonaws.com/getUsageLimits?${qQuery.toString()}`, commonHeaders, connection.proxyUrl, signal)
		];
		let lastStatus = 0;
		let lastError;
		for (const attempt of attempts) try {
			const response = await attempt();
			lastStatus = response.status;
			if (response.status !== 200) continue;
			const usage = parseKiroUsage(response.body);
			this.cache.set(key, {
				expiresAt: Date.now() + this.cacheTtlMs,
				usage
			});
			return usage;
		} catch (error) {
			if (signal.aborted) throw error;
			lastError = error;
		}
		const code = lastStatus === 401 ? "AUTH" : lastStatus === 403 ? "FORBIDDEN" : lastStatus === 429 ? "RATE_LIMIT" : lastStatus >= 500 ? "SERVER" : "TRANSPORT";
		throw new KiroError(lastStatus > 0 ? `Kiro usage is temporarily unavailable (HTTP ${lastStatus})` : "Kiro usage is temporarily unavailable", code, {
			...lastStatus > 0 ? { status: lastStatus } : {},
			...lastError === void 0 ? {} : { cause: lastError }
		});
	}
};

//#endregion
//#region lib/types/gateway/paths.js
/** 返回网关管理的凭据目录。 */
function credentialDirectory(dataDir$1) {
	return join(dataDir$1, "storages", "kiro-auth");
}

//#endregion
//#region lib/types/gateway/service.js
/** 安全化错误文本：去掉可能的凭据。 */
function safeError(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/(?:access|refresh|client|api)[_-]?(?:token|secret|key)\s*[:=]\s*\S+/giu, "[redacted credential]").replace(/aorAAAAAG[A-Za-z0-9._~-]+/gu, "[redacted refresh token]");
}
/** 把可选字符串字段规范成 `undefined`。 */
function optionalText(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/** 必填字符串字段。 */
function requiredText(value, name) {
	const result = optionalText(value);
	if (result === void 0) throw new Error(`${name} is required`);
	return result;
}
/** 窄化导入请求声明的凭据来源。 */
function refreshTokenOrigin(value) {
	const named = optionalText(value);
	if (named === void 0) return void 0;
	if (named === "builder-id" || named === "idc" || named === "imported") return named;
	throw new Error(`Unsupported Kiro refresh-token credential source "${named}"`);
}
/** 读出一个登录或导入请求指向的账号。 */
function accountTarget(source) {
	const accountId = optionalText(source.accountId);
	const label = optionalText(source.label);
	return {
		...accountId === void 0 ? {} : { accountId },
		...label === void 0 ? {} : { label }
	};
}
/** 删除一个被移除账号独占的设备注册文件。 */
async function dropRegistration(directory, credential) {
	const hash = credential["clientIdHash"];
	if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) return;
	if (await new KiroAccountStore(directory).usesRegistration(hash)) return;
	try {
		await unlink(join(directory, hash + ".json"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
/** 登录流程的公开视图。 */
function publicLogin(flow) {
	if (flow === void 0) return { status: "idle" };
	return {
		status: flow.status,
		kind: flow.kind,
		method: flow.method,
		startedAt: flow.startedAt,
		...flow.completedAt === void 0 ? {} : { completedAt: flow.completedAt },
		...flow.authUrl === void 0 ? {} : { authUrl: flow.authUrl },
		...flow.userCode === void 0 ? {} : { userCode: flow.userCode },
		...flow.accountId === void 0 ? {} : { accountId: flow.accountId },
		...flow.error === void 0 ? {} : { error: flow.error }
	};
}
/** 网关运行时的核心依赖。 */
var GatewayService = class {
	credentialDirectory;
	modelSettings;
	discovery;
	usage;
	client;
	config;
	login;
	loginController;
	constructor(config$1) {
		this.config = config$1;
		this.credentialDirectory = credentialDirectory(config$1.dataDir);
		this.modelSettings = new FileModelSettingsStore(modelSettingsPath(this.credentialDirectory));
		this.discovery = new KiroModelDiscovery({ resolveToken: (connection, signal) => this.resolveToken(connection, signal) });
		this.usage = new KiroUsageService({ resolveToken: (connection, signal) => this.resolveToken(connection, signal) });
		this.client = new KiroClient({
			options: () => this.connection(),
			resolveToken: (connection, signal) => this.resolveToken(connection, signal),
			discoverModels: async (connection, signal) => {
				try {
					const models = await this.discovery.list(connection, signal);
					await this.modelSettings.mergeCatalog(models);
					return models;
				} catch {
					return connection.models;
				}
			},
			currentModels: (connection) => this.discovery.current(connection),
			selectModels: (models) => this.modelSettings.enabledModels(models),
			userAgent: "kiro-nest"
		});
	}
	/** 当前配置。 */
	get currentConfig() {
		return this.config;
	}
	/** 关停仍在等待的登录。 */
	close() {
		this.loginController?.abort("gateway shutting down");
		this.loginController = void 0;
	}
	/** 当前连接事实。 */
	connection() {
		const config$1 = this.config;
		if (config$1.proxyUrl.length > 0) parseProxyUrl(config$1.proxyUrl);
		const region = config$1.region.length > 0 ? assertKiroRegion(config$1.region) : void 0;
		const profileArn = config$1.profileArn.length > 0 ? assertKiroProfileArn(config$1.profileArn) : void 0;
		return {
			...region === void 0 ? {} : { region },
			...config$1.proxyUrl.length === 0 ? {} : { proxyUrl: config$1.proxyUrl },
			...profileArn === void 0 ? {} : { profileArn },
			defaults: {
				thinking: config$1.thinking,
				...config$1.reasoningEffort.length === 0 ? {} : { reasoningEffort: config$1.reasoningEffort }
			},
			defaultContextWindow: config$1.defaultContextWindow,
			...config$1.maxContextWindow === null ? {} : { maxContextWindow: config$1.maxContextWindow },
			models: DEFAULT_MODELS,
			streamIdleTimeoutMs: config$1.streamIdleTimeoutMs,
			tokenExpiryBufferMs: config$1.tokenExpiryBufferMs
		};
	}
	/** 解析一次请求可用的令牌。 */
	resolveToken(connection, signal) {
		return resolveTokenFromDirectories([this.credentialDirectory, kiroCredentialDirectory()], {
			expiryBufferMs: connection.tokenExpiryBufferMs,
			fetchJson: (url, body) => postJson(url, body, connection.proxyUrl, signal),
			fetchForm: (url, body) => postForm(url, body, connection.proxyUrl, signal),
			...connection.profileArn === void 0 ? { resolveProfileArn: (accessToken, region, authMethod) => discoverKiroProfileArn(connection, {
				accessToken,
				region,
				authMethod,
				expiresAt: Date.now() + 6e4
			}, signal) } : {},
			writableDirectories: [this.credentialDirectory]
		});
	}
	/** 模型目录的公开视图。 */
	async modelPayload() {
		const connection = this.connection();
		const cached$1 = this.discovery.current(connection);
		const models = cached$1 ?? connection.models;
		const selection = await modelSelection(this.modelSettings, models);
		return {
			source: cached$1 === void 0 ? "configured" : "live",
			fetchedAt: Date.now(),
			enabledModelIds: selection.enabledModelIds,
			models: selection.models.map((model) => ({
				id: model.id,
				name: model.name ?? model.id,
				...model.description === void 0 ? {} : { description: model.description },
				...model.contextWindow === void 0 ? {} : { contextWindow: contextCapacity(model.contextWindow, connection) },
				...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
				thinking: model.thinking ?? true,
				reasoningEfforts: model.reasoningEfforts ?? (model.thinking === false ? ["off"] : [
					"off",
					"low",
					"medium",
					"high"
				]),
				...model.defaultReasoningEffort === void 0 ? {} : { defaultReasoningEffort: model.defaultReasoningEffort },
				...model.inputModalities === void 0 ? {} : { inputModalities: model.inputModalities },
				enabled: model.enabled
			}))
		};
	}
	/** 汇总状态，供页面与管理 API 读取。 */
	async status() {
		const managed = await credentialSummary(this.credentialDirectory);
		const external = managed.authenticated ? {
			authenticated: false,
			authMethod: void 0,
			region: void 0,
			expiresAt: void 0,
			profileArn: void 0
		} : await credentialSummary(kiroCredentialDirectory());
		const connection = this.connection();
		const accounts = await new KiroAccountStore(this.credentialDirectory).snapshot();
		const usage = this.usage.current(connection);
		const authMethod = managed.authMethod ?? external.authMethod;
		const region = managed.region ?? external.region ?? connection.region;
		const expiresAt = managed.expiresAt ?? external.expiresAt;
		const profileArn = connection.profileArn ?? managed.profileArn ?? external.profileArn;
		return {
			authenticated: managed.authenticated || external.authenticated,
			credentialSource: managed.authenticated ? "gateway" : external.authenticated ? "kiro" : "none",
			...authMethod === void 0 ? {} : { authMethod },
			...region === void 0 ? {} : { region },
			...expiresAt === void 0 ? {} : { expiresAt },
			...profileArn === void 0 ? {} : { profileArn },
			accounts,
			activeAccountId: accounts.activeAccountId,
			contextWindowCap: connection.maxContextWindow ?? null,
			login: publicLogin(this.login),
			models: await this.modelPayload(),
			...usage === void 0 ? {} : { usage },
			gateway: {
				apiKeyConfigured: this.config.apiKey.length > 0,
				adminTokenConfigured: this.config.adminToken.length > 0,
				endpoints: {
					openai: "/v1",
					anthropic: "/anthropic"
				}
			}
		};
	}
	/** 强制刷新模型目录。 */
	async refreshModels() {
		const connection = this.connection();
		const models = await this.discovery.list(connection, AbortSignal.timeout(2e4), true);
		await this.modelSettings.mergeCatalog(models);
		return this.modelPayload();
	}
	/** 保存启用模型列表。 */
	async setEnabledModels(ids) {
		const connection = this.connection();
		const models = this.discovery.current(connection) ?? connection.models;
		await this.modelSettings.setEnabledModelIds(ids, models);
		return this.modelPayload();
	}
	/** 读取用量；`force` 绕过五分钟缓存。 */
	async getUsage(force) {
		return this.usage.get(this.connection(), AbortSignal.timeout(2e4), force);
	}
	/** 当前配置的脱敏视图。 */
	currentPublicConfig() {
		return publicConfig(this.config);
	}
	/**
	* 保存配置补丁。端口/监听地址的变更由服务器层决定是否重启。
	* @param patch - 页面提交的字段子集。
	* @returns 脱敏后的新配置。
	*/
	async updateConfig(patch) {
		const next = mergeConfig(this.config, patch);
		await saveConfig(next);
		this.config = next;
		this.discovery.clear();
		this.usage.clear();
		return publicConfig(next);
	}
	/**
	* 把一次登录或导入得到的凭据写入账号存储。
	* @param credentials - 登录流程产出的凭据。
	* @param signal - 请求取消信号。
	* @param target - 要更新的账号，或新账号的显示名。
	*/
	async saveCredentials(credentials, signal, target = {}) {
		let complete = credentials;
		if (credentials.profileArn === void 0 && credentials.authMethod !== "api_key") try {
			const profileArn = await discoverKiroProfileArn(this.connection(), {
				accessToken: credentials.accessToken,
				region: credentials.region,
				expiresAt: Date.parse(credentials.expiresAt),
				authMethod: credentials.authMethod
			}, signal);
			if (profileArn !== void 0) complete = {
				...credentials,
				profileArn
			};
		} catch {}
		const saved = await saveManagedCredentials(this.credentialDirectory, complete, target);
		this.discovery.clear();
		this.usage.clear();
		this.refreshModels().catch(() => {});
		return saved;
	}
	/**
	* 轮询设备码登录，直到完成、失败或取消。
	* @param initialIntervalSeconds - 首次轮询间隔。
	* @param flow - 正在发布的登录流程。
	* @param controller - 取消控制器。
	* @param poll - 单次轮询函数。
	*/
	monitorLogin(initialIntervalSeconds, flow, controller, poll) {
		(async () => {
			let intervalSeconds = initialIntervalSeconds;
			try {
				while (!controller.signal.aborted) {
					await new Promise((resolve$1, reject) => {
						const onAbort = () => {
							clearTimeout(timer);
							reject(/* @__PURE__ */ new Error("Kiro login cancelled"));
						};
						const timer = setTimeout(() => {
							controller.signal.removeEventListener("abort", onAbort);
							resolve$1();
						}, intervalSeconds * 1e3);
						controller.signal.addEventListener("abort", onAbort, { once: true });
					});
					const result = await poll();
					if (result.status === "pending") {
						intervalSeconds = result.intervalSeconds;
						continue;
					}
					const saved = await this.saveCredentials(result.credentials, controller.signal, {
						...flow.accountId === void 0 ? {} : { accountId: flow.accountId },
						...flow.label === void 0 ? {} : { label: flow.label }
					});
					this.login = {
						status: "complete",
						kind: flow.kind,
						method: flow.method,
						...flow.authUrl === void 0 ? {} : { authUrl: flow.authUrl },
						...flow.userCode === void 0 ? {} : { userCode: flow.userCode },
						startedAt: flow.startedAt,
						completedAt: Date.now(),
						accountId: saved.accountId
					};
					return;
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				this.login = {
					...flow,
					status: "error",
					completedAt: Date.now(),
					error: safeError(error)
				};
			}
		})();
	}
	/**
	* 启动 Builder ID / IAM Identity Center 设备码登录。
	* @param body - 页面提交的登录参数。
	* @returns 当前的登录流程状态。
	*/
	async startDeviceLogin(body) {
		this.loginController?.abort("starting a new Kiro login");
		const controller = new AbortController();
		this.loginController = controller;
		if (body.method !== "builder-id" && body.method !== "idc") throw new Error("Unsupported Kiro device login method");
		const method = body.method;
		const target = accountTarget(body);
		const connection = this.connection();
		const region = optionalText(body.region) ?? connection.region ?? "us-east-1";
		const requestJson = (url, value, signal) => postJson(url, value, connection.proxyUrl, signal);
		const session = await startDeviceLogin(region, requestJson, controller.signal, {
			authMethod: method,
			...method === "idc" ? { startUrl: requiredText(body.startUrl, "IAM Identity Center start URL") } : {}
		});
		const flow = {
			status: "pending",
			kind: "device",
			method,
			authUrl: session.verificationUri,
			userCode: session.userCode,
			startedAt: Date.now(),
			...target
		};
		this.login = flow;
		this.monitorLogin(session.intervalSeconds, flow, controller, () => pollDeviceLogin(session, requestJson, controller.signal));
		return publicLogin(this.login);
	}
	/**
	* 启动 Google / GitHub 社交设备码登录。
	* @param method - 身份提供商。
	* @param target - 要更新的账号，或新账号的显示名。
	*/
	async startSocialLogin(method, target = {}) {
		this.loginController?.abort("starting a new Kiro login");
		const controller = new AbortController();
		this.loginController = controller;
		const connection = this.connection();
		const requestJson = (url, value, signal) => postJson(url, value, connection.proxyUrl, signal);
		const session = await startSocialDeviceLogin(method, requestJson, controller.signal);
		const flow = {
			status: "pending",
			kind: "social-device",
			method,
			authUrl: session.verificationUri,
			userCode: session.userCode,
			startedAt: Date.now(),
			...target
		};
		this.login = flow;
		this.monitorLogin(session.intervalSeconds, flow, controller, () => pollSocialDeviceLogin(session, requestJson, controller.signal));
		return publicLogin(this.login);
	}
	/**
	* 按 `method` 分派一次登录。
	* @param body - 页面提交的登录参数。
	*/
	async startLogin(body) {
		const method = optionalText(body.method) ?? "builder-id";
		return method === "google" || method === "github" ? this.startSocialLogin(method, accountTarget(body)) : this.startDeviceLogin({
			...body,
			method
		});
	}
	/** 取消正在进行的登录。 */
	cancelLogin() {
		this.loginController?.abort("Kiro login cancelled");
		this.loginController = void 0;
		this.login = void 0;
	}
	/**
	* 导入已有凭据（refresh token / API key / Microsoft external IdP）。
	* @param body - 页面提交的导入参数。
	* @returns 状态快照，附带本次导入实际验证的结果。
	*/
	async importCredential(body) {
		this.loginController?.abort("importing Kiro credentials");
		this.loginController = void 0;
		const connection = this.connection();
		const signal = AbortSignal.timeout(3e4);
		const method = requiredText(body.method, "Kiro import method");
		let credentials;
		let verified;
		if (method === "refresh-token") {
			const region = optionalText(body.region) ?? connection.region;
			const profileArn = optionalText(body.profileArn);
			const clientId = optionalText(body.clientId);
			const clientSecret = optionalText(body.clientSecret);
			const startUrl$1 = optionalText(body.startUrl);
			const origin = refreshTokenOrigin(body.credentialSource ?? body.authMethod);
			credentials = await importRefreshToken({
				refreshToken: requiredText(body.refreshToken, "Kiro refresh token"),
				...region === void 0 ? {} : { region },
				...profileArn === void 0 ? {} : { profileArn },
				...clientId === void 0 ? {} : { clientId },
				...clientSecret === void 0 ? {} : { clientSecret },
				...startUrl$1 === void 0 ? {} : { startUrl: startUrl$1 },
				...origin === void 0 ? {} : { authMethod: origin }
			}, (url, value, requestSignal) => postJson(url, value, connection.proxyUrl, requestSignal), signal);
			verified = { refreshed: true };
		} else if (method === "api-key") {
			const checked = await importApiKey(requiredText(body.apiKey, "Kiro API key"), optionalText(body.region) ?? connection.region, (url, headers$1, requestSignal) => getJson(url, headers$1, connection.proxyUrl, requestSignal), signal);
			credentials = checked.credentials;
			verified = { models: checked.models };
		} else if (method === "external-idp") credentials = importExternalIdp(body.credentials);
		else throw new Error("Unsupported Kiro import method");
		await this.saveCredentials(credentials, signal, accountTarget(body));
		this.login = void 0;
		const current = await this.status();
		return verified === void 0 ? current : {
			...current,
			verified
		};
	}
	/** 退出所有由网关管理的账号。 */
	async logout() {
		this.loginController?.abort("Kiro logout");
		this.login = void 0;
		await deleteDeviceCredentials(this.credentialDirectory);
		this.discovery.clear();
		this.usage.clear();
		return this.status();
	}
	/**
	* 切换请求使用的账号。
	* @param accountId - 目标账号。
	* @param revision - 页面读取到的文档版本，用于冲突检测。
	*/
	async activateAccount(accountId, revision) {
		await new KiroAccountStore(this.credentialDirectory).activate(accountId, revision);
		await syncManagedCredentialFile(this.credentialDirectory);
		this.discovery.clear();
		this.usage.clear();
		return this.status();
	}
	/**
	* 移除一个账号。
	* @param accountId - 目标账号。
	* @param options - 替代账号与版本保护。
	*/
	async removeAccount(accountId, options = {}) {
		const removed = await new KiroAccountStore(this.credentialDirectory).remove(accountId, {
			...options.replacementId === void 0 ? {} : { replacementId: options.replacementId },
			...options.revision === void 0 ? {} : { expectedRevision: options.revision }
		});
		await dropRegistration(this.credentialDirectory, removed.credential);
		await syncManagedCredentialFile(this.credentialDirectory);
		this.discovery.clear();
		this.usage.clear();
		return this.status();
	}
};

//#endregion
//#region lib/types/gateway/main.js
/** 读取 `--name value` 或 `--name=value` 形式的命令行参数。 */
function flagValue(name) {
	const index = process.argv.indexOf(name);
	const next = process.argv[index + 1];
	if (index >= 0 && next !== void 0 && !next.startsWith("--")) return next;
	const prefix = `${name}=`;
	const inline = process.argv.find((argument) => argument.startsWith(prefix));
	return inline === void 0 ? void 0 : inline.slice(prefix.length);
}
/** 打印一条带前缀的日志。 */
function log(message) {
	console.log(`[kiro-nest] ${message}`);
}
/** 错误信息。 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
const dataDir = resolveDataDir(flagValue("--data-dir"));
await mkdir(dataDir, {
	recursive: true,
	mode: 448
});
const config = await loadConfig(dataDir);
const service = new GatewayService(config);
let listening;
let closing = false;
const server = createGatewayServer(service, { restart });
/**
* 在配置指定的地址上开始监听。
* @param target - 端口与地址来源。
*/
async function listen(target) {
	await new Promise((resolve$1, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve$1();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(target.port, target.host);
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : target.port;
	listening = {
		port,
		host: target.host
	};
	const shown = target.host === "0.0.0.0" || target.host === "::" ? "localhost" : target.host;
	log(`listening on http://${shown}:${port}`);
	log(`OpenAI-compatible endpoint:    http://${shown}:${port}/v1`);
	log(`Anthropic-compatible endpoint: http://${shown}:${port}/anthropic`);
	log(`settings page:                 http://${shown}:${port}/`);
}
/** 停止监听；先等现有请求结束，超时后强制断开。 */
async function stopListening() {
	await new Promise((resolve$1) => {
		const forceTimer = setTimeout(() => server.closeAllConnections(), 2e3);
		forceTimer.unref();
		server.close(() => {
			clearTimeout(forceTimer);
			resolve$1();
		});
		server.closeIdleConnections();
	});
}
/** 页面修改端口后原地重启监听；失败时回退到上一个端口。 */
async function restart() {
	if (closing) return;
	const previous = listening;
	const next = service.currentConfig;
	log(`restarting listener on ${next.host}:${next.port} ...`);
	await stopListening();
	try {
		await listen(next);
		return;
	} catch (error) {
		log(`cannot listen on ${next.host}:${next.port}: ${messageOf(error)}`);
	}
	if (previous === void 0) {
		process.exitCode = 1;
		return;
	}
	try {
		await service.updateConfig({
			port: previous.port,
			host: previous.host
		});
	} catch (error) {
		log(`cannot restore previous configuration: ${messageOf(error)}`);
	}
	await listen({
		...next,
		port: previous.port,
		host: previous.host
	});
	log("kept the previous port; update the port setting and restart the container later");
}
/** 优雅退出。 */
async function shutdown(signal) {
	if (closing) return;
	closing = true;
	log(`received ${signal}, shutting down`);
	service.close();
	await stopListening();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
server.on("error", (error) => {
	log(`server error: ${messageOf(error)}`);
});
log(`data directory: ${dataDir}`);
try {
	await listen(config);
} catch (error) {
	log(`cannot start gateway: ${messageOf(error)}`);
	process.exit(1);
}

//#endregion
export {  };