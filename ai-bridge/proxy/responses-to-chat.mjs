/**
 * Responses API ↔ Chat Completions API conversion core.
 *
 * New Codex versions only speak the Responses API (wire_api = "responses"),
 * while most third-party OpenAI-compatible providers (Kimi, GLM, DeepSeek,
 * relays, ...) only offer Chat Completions. This module converts between the
 * two protocols so the built-in local proxy (responses-proxy.mjs) can bridge
 * them, the same role cc-switch's local router plays.
 *
 * Pure functions / classes only — no I/O, fully unit-testable.
 */

let idCounter = 0;

/** Generates a reasonably unique item id (no crypto needed — protocol ids are opaque). */
function genId(prefix) {
    idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
    return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function asJsonString(value, fallback = '{}') {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value ?? JSON.parse(fallback));
    } catch {
        return fallback;
    }
}

/**
 * Canonical JSON with recursively sorted keys — stable across runs so tool
 * definitions embedded in descriptions don't churn the prompt cache.
 * (Same trick as cc-switch's canonical_json_string.)
 */
function canonicalJsonString(value) {
    return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortKeysDeep(value[key]);
        }
        return sorted;
    }
    return value;
}

// ============================================================================
// Custom (freeform) tool emulation — mirrors cc-switch's router strategy
// ============================================================================

/**
 * Custom Responses tools (e.g. apply_patch grammars) cannot be expressed in
 * Chat Completions. cc-switch wraps them in a fixed JSON envelope
 * (`{"input": "<raw freeform text>"}`): the envelope gives chat models a
 * reliable structure while the inner string stays freeform, and the original
 * tool definition (including the grammar) is embedded in the description so
 * the model still sees the expected payload format.
 */
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const CUSTOM_TOOL_INPUT_DESCRIPTION =
    'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.';
const CUSTOM_TOOL_DEFINITION_HEADING = 'Original tool definition:';

/**
 * Extracts the raw freeform input from chat function-call arguments produced
 * against the custom-tool envelope. Falls back to the raw arguments string
 * when the model ignored the envelope. (cc-switch: custom_tool_input_from_chat_arguments)
 */
export function customToolInputFromChatArguments(args) {
    if (typeof args !== 'string' || args.trim() === '') return '';
    try {
        const parsed = JSON.parse(args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const input = parsed[CUSTOM_TOOL_INPUT_FIELD];
            if (typeof input === 'string') return input;
        }
    } catch {
        // Not JSON — treat the whole string as the freeform input.
    }
    return args;
}

/** True for upstreams that honor OpenAI's `reasoning_effort` (cc-switch: supports_reasoning_effort). */
function supportsReasoningEffort(model) {
    if (typeof model !== 'string') return false;
    const m = model.toLowerCase();
    if (/^o\d/.test(m)) return true; // o1 / o3 / o4 …
    const gptRest = m.startsWith('gpt-') ? m.slice(4) : null;
    if (gptRest && gptRest[0] >= '5' && gptRest[0] <= '9') return true; // gpt-5+
    return m === 'grok-4.5' || m.startsWith('grok-4.5-') || m.startsWith('grok-build-');
}

// ============================================================================
// Request: Responses → Chat Completions
// ============================================================================

function convertContentPart(part) {
    if (!part || typeof part !== 'object') return null;
    switch (part.type) {
        case 'input_text':
        case 'output_text':
        case 'text':
            return { type: 'text', text: part.text ?? '' };
        case 'input_image': {
            // Responses: { type: 'input_image', image_url: 'https://...' | { url } , detail? }
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (!url) return null;
            const imageUrl = { url };
            if (part.detail) imageUrl.detail = part.detail;
            return { type: 'image_url', image_url: imageUrl };
        }
        case 'input_file':
            // Chat Completions has no portable file part; drop silently.
            return null;
        default:
            return null;
    }
}

/**
 * Convert a Responses message `content` value into a Chat Completions content
 * value (string, or an array of text/image_url parts).
 */
function convertMessageContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    const parts = content.map(convertContentPart).filter(Boolean);
    const nonText = parts.find((p) => p.type !== 'text');
    if (nonText === undefined) {
        // Pure text — collapse to a single string for maximal provider compatibility.
        return parts.map((p) => p.text).join('');
    }
    return parts;
}

/**
 * Normalize a function tool's `parameters` JSON Schema so `type` is always
 * `"object"` — some Responses tools carry `parameters: null` or `{"type": null}`,
 * which Chat Completions strictly rejects. (cc-switch: normalize_function_parameters)
 */
function normalizeFunctionParameters(params) {
    const obj = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
    if (obj.type !== 'object') {
        obj.type = 'object';
    }
    if (obj.properties == null && !('additionalProperties' in obj)) {
        obj.properties = {};
    }
    return obj;
}

function convertTool(tool) {
    if (!tool || typeof tool !== 'object') return null;
    if (tool.type === 'function') {
        const fn = {
            name: tool.name,
            description: tool.description ?? '',
            parameters: normalizeFunctionParameters(tool.parameters),
        };
        if (tool.strict != null) fn.strict = tool.strict;
        return { type: 'function', function: fn };
    }
    if (tool.type === 'custom') {
        // Freeform custom tools (e.g. apply_patch grammars) use cc-switch's JSON
        // envelope: a single required `input` string, with the original tool
        // definition embedded in the description so the model keeps the format.
        const originalDefinition = canonicalJsonString(tool);
        const baseDescription = typeof tool.description === 'string' && tool.description !== ''
            ? `${tool.description}\n\n`
            : '';
        return {
            type: 'function',
            function: {
                name: tool.name,
                description: `${baseDescription}${CUSTOM_TOOL_DEFINITION_HEADING}\n\`\`\`json\n${originalDefinition}\n\`\`\``,
                parameters: {
                    type: 'object',
                    properties: {
                        [CUSTOM_TOOL_INPUT_FIELD]: {
                            type: 'string',
                            description: CUSTOM_TOOL_INPUT_DESCRIPTION,
                        },
                    },
                    required: [CUSTOM_TOOL_INPUT_FIELD],
                },
            },
        };
    }
    // Built-in hosted tools (web_search etc.) are not supported by chat upstreams.
    return null;
}

function convertToolChoice(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') {
        if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') {
            return toolChoice;
        }
        return undefined;
    }
    if (typeof toolChoice === 'object') {
        if (toolChoice.type === 'function' && toolChoice.name) {
            return { type: 'function', function: { name: toolChoice.name } };
        }
        if (toolChoice.type === 'custom' && toolChoice.name) {
            return { type: 'function', function: { name: toolChoice.name } };
        }
    }
    return undefined;
}

/**
 * Convert a Responses API request body into a Chat Completions request body.
 *
 * @param {object} body parsed Responses API request
 * @returns {{ chat: object, customToolNames: string[] }} the converted request
 *          plus the names of tools declared as `custom` (so the response side
 *          can map their calls back to `custom_tool_call` items).
 */
export function convertResponsesRequestToChat(body) {
    const safeBody = body && typeof body === 'object' ? body : {};
    const messages = [];

    if (typeof safeBody.instructions === 'string' && safeBody.instructions.trim() !== '') {
        messages.push({ role: 'system', content: safeBody.instructions });
    }

    const customToolNames = [];
    for (const tool of Array.isArray(safeBody.tools) ? safeBody.tools : []) {
        if (tool && tool.type === 'custom' && tool.name) {
            customToolNames.push(tool.name);
        }
    }

    let items;
    if (typeof safeBody.input === 'string') {
        items = [{ type: 'message', role: 'user', content: safeBody.input }];
    } else if (Array.isArray(safeBody.input)) {
        items = safeBody.input;
    } else {
        items = [];
    }

    // Consecutive (custom_)tool_call items merge into one assistant message with
    // a tool_calls array, as Chat Completions requires.
    let pendingAssistant = null;
    const flushAssistant = () => {
        if (!pendingAssistant) return;
        const msg = { role: 'assistant' };
        const text = pendingAssistant.textParts.join('');
        msg.content = text !== '' ? text : null;
        if (pendingAssistant.toolCalls.length > 0) {
            msg.tool_calls = pendingAssistant.toolCalls;
        }
        messages.push(msg);
        pendingAssistant = null;
    };
    const ensureAssistant = () => {
        if (!pendingAssistant) {
            pendingAssistant = { textParts: [], toolCalls: [] };
        }
        return pendingAssistant;
    };

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = item.type ?? 'message';

        if (type === 'message') {
            flushAssistant();
            const role = item.role ?? 'user';
            if (role === 'assistant') {
                // Assistant text goes through the merge path so trailing tool calls
                // can attach to the same assistant message.
                const assistant = ensureAssistant();
                assistant.textParts.push(toPlainText(item.content));
            } else {
                messages.push({ role, content: convertMessageContent(item.content) });
            }
        } else if (type === 'function_call') {
            const assistant = ensureAssistant();
            assistant.toolCalls.push({
                id: item.call_id ?? item.id ?? genId('call'),
                type: 'function',
                function: {
                    name: item.name ?? '',
                    arguments: asJsonString(item.arguments),
                },
            });
        } else if (type === 'custom_tool_call') {
            const assistant = ensureAssistant();
            assistant.toolCalls.push({
                id: item.call_id ?? item.id ?? genId('call'),
                type: 'function',
                function: {
                    name: item.name ?? '',
                    // Custom tool history rides the same JSON envelope the model
                    // is asked to produce: {"input": "<raw freeform text>"}.
                    arguments: canonicalJsonString({
                        [CUSTOM_TOOL_INPUT_FIELD]: typeof item.input === 'string'
                            ? item.input
                            : asJsonString(item.input, ''),
                    }),
                },
            });
        } else if (type === 'function_call_output') {
            flushAssistant();
            messages.push({
                role: 'tool',
                tool_call_id: item.call_id ?? '',
                content: typeof item.output === 'string' ? item.output : asJsonString(item.output),
            });
        }
        // reasoning / item_reference / unknown types: chat upstreams cannot consume
        // them — dropped on purpose.
    }
    flushAssistant();

    const chat = { model: safeBody.model, messages };

    if (Array.isArray(safeBody.tools) && safeBody.tools.length > 0) {
        const tools = safeBody.tools.map(convertTool).filter(Boolean);
        if (tools.length > 0) chat.tools = tools;
    }

    const toolChoice = convertToolChoice(safeBody.tool_choice);
    if (toolChoice !== undefined) chat.tool_choice = toolChoice;

    if (typeof safeBody.temperature === 'number') chat.temperature = safeBody.temperature;
    if (typeof safeBody.top_p === 'number') chat.top_p = safeBody.top_p;
    if (typeof safeBody.max_output_tokens === 'number') chat.max_tokens = safeBody.max_output_tokens;
    if (safeBody.parallel_tool_calls === false) chat.parallel_tool_calls = false;

    // Pass reasoning effort through only to upstreams that honor OpenAI's
    // `reasoning_effort`; other providers reject or ignore unknown fields.
    // (cc-switch applies the same model gate.)
    if (supportsReasoningEffort(safeBody.model)) {
        const effort = safeBody.reasoning?.effort;
        if (typeof effort === 'string' && effort !== '') {
            chat.reasoning_effort = effort;
        }
    }

    if (safeBody.stream === true) {
        chat.stream = true;
        chat.stream_options = { include_usage: true };
    }

    return { chat, customToolNames };
}

function toPlainText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
        .join('');
}

// ============================================================================
// Usage mapping
// ============================================================================

function convertUsage(usage) {
    if (!usage || typeof usage !== 'object') return undefined;
    const result = {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    };
    const cached = usage.prompt_tokens_details?.cached_tokens;
    if (typeof cached === 'number') {
        result.input_tokens_details = { cached_tokens: cached };
    }
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoning === 'number') {
        result.output_tokens_details = { reasoning_tokens: reasoning };
    }
    return result;
}

// ============================================================================
// Non-streaming response: Chat Completions → Responses
// ============================================================================

function buildReasoningItem(text) {
    return {
        id: genId('rs'),
        type: 'reasoning',
        summary: [{ type: 'summary_text', text }],
    };
}

function buildMessageOutputItem(text, status = 'completed') {
    return {
        id: genId('msg'),
        type: 'message',
        status,
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
    };
}

/**
 * Convert a non-streaming Chat Completions response into a Responses API object.
 *
 * @param {object} chatResp parsed Chat Completions response
 * @param {{ customToolNames?: string[], model?: string }} [context]
 */
export function convertChatResponseToResponses(chatResp, context = {}) {
    const customToolNames = new Set(context.customToolNames ?? []);
    const choice = Array.isArray(chatResp?.choices) ? chatResp.choices[0] : undefined;
    const message = choice?.message ?? {};
    const output = [];

    if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
        output.push(buildReasoningItem(message.reasoning_content));
    }

    const text = toPlainText(message.content);
    if (text !== '') {
        output.push(buildMessageOutputItem(text));
    }

    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = toolCall.function?.name ?? '';
        const args = typeof toolCall.function?.arguments === 'string'
            ? toolCall.function.arguments
            : asJsonString(toolCall.function?.arguments);
        if (customToolNames.has(name)) {
            output.push({
                id: genId('ctc'),
                type: 'custom_tool_call',
                status: 'completed',
                call_id: toolCall.id ?? genId('call'),
                name,
                input: customToolInputFromChatArguments(args),
            });
        } else {
            output.push({
                id: genId('fc'),
                type: 'function_call',
                status: 'completed',
                call_id: toolCall.id ?? genId('call'),
                name,
                arguments: args,
            });
        }
    }

    return {
        id: chatResp?.id ?? genId('resp'),
        object: 'response',
        created_at: chatResp?.created ?? Math.floor(Date.now() / 1000),
        status: 'completed',
        model: chatResp?.model ?? context.model,
        output,
        usage: convertUsage(chatResp?.usage),
    };
}

// ============================================================================
// Streaming: Chat Completions chunks → Responses API events
// ============================================================================

/**
 * Incrementally converts Chat Completions SSE chunks into Responses API SSE
 * events. Feed each parsed chunk object to {@link handleChunk}; call
 * {@link finish} when the upstream stream ends. Both return arrays of
 * `{ event, data }` objects ready to be serialized as SSE frames.
 */
export class ChatToResponsesStreamConverter {
    constructor(context = {}) {
        this.customToolNames = new Set(context.customToolNames ?? []);
        this.model = context.model;
        this.responseId = genId('resp');
        this.createdAt = Math.floor(Date.now() / 1000);

        this.started = false;
        this.outputIndex = -1;
        this.openItem = null; // 'message' | 'function_call' | 'custom_tool_call' | 'reasoning'
        this.openItemId = null;
        this.contentIndex = 0;

        this.text = '';
        this.reasoningText = '';
        this.toolCalls = new Map(); // chat tool_calls index -> { outputIndex, itemId, callId, name, args, custom }
        this.completedItems = [];
        this.usage = undefined;
        this.finishReason = null;
    }

    responseSkeleton(status) {
        return {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            status,
            model: this.model,
            output: [],
        };
    }

    emit(event, data) {
        return { event, data: { type: event, ...data } };
    }

    ensureStarted() {
        if (this.started) return [];
        this.started = true;
        return [
            this.emit('response.created', { response: this.responseSkeleton('in_progress') }),
            this.emit('response.in_progress', { response: this.responseSkeleton('in_progress') }),
        ];
    }

    openMessageItem() {
        this.outputIndex += 1;
        this.contentIndex = 0;
        this.openItem = 'message';
        this.openItemId = genId('msg');
        this.text = '';
        const part = { type: 'output_text', text: '', annotations: [] };
        return [
            this.emit('response.output_item.added', {
                output_index: this.outputIndex,
                item: {
                    id: this.openItemId,
                    type: 'message',
                    status: 'in_progress',
                    role: 'assistant',
                    content: [],
                },
            }),
            this.emit('response.content_part.added', {
                item_id: this.openItemId,
                output_index: this.outputIndex,
                content_index: this.contentIndex,
                part,
            }),
        ];
    }

    openReasoningItem() {
        this.outputIndex += 1;
        this.openItem = 'reasoning';
        this.openItemId = genId('rs');
        this.reasoningText = '';
        return [
            this.emit('response.output_item.added', {
                output_index: this.outputIndex,
                item: { id: this.openItemId, type: 'reasoning', summary: [] },
            }),
            this.emit('response.reasoning_summary_part.added', {
                item_id: this.openItemId,
                output_index: this.outputIndex,
                summary_index: 0,
                part: { type: 'summary_text', text: '' },
            }),
        ];
    }

    openToolCallItem(chatIndex, firstDelta) {
        const name = firstDelta.function?.name ?? '';
        const custom = this.customToolNames.has(name);
        this.outputIndex += 1;
        const entry = {
            outputIndex: this.outputIndex,
            itemId: genId(custom ? 'ctc' : 'fc'),
            callId: firstDelta.id ?? genId('call'),
            name,
            args: '',
            custom,
        };
        this.toolCalls.set(chatIndex, entry);
        this.openItem = custom ? 'custom_tool_call' : 'function_call';
        this.openItemId = entry.itemId;

        const item = custom
            ? {
                  id: entry.itemId,
                  type: 'custom_tool_call',
                  status: 'in_progress',
                  call_id: entry.callId,
                  name: entry.name,
                  input: '',
              }
            : {
                  id: entry.itemId,
                  type: 'function_call',
                  status: 'in_progress',
                  call_id: entry.callId,
                  name: entry.name,
                  arguments: '',
              };
        return [this.emit('response.output_item.added', { output_index: entry.outputIndex, item })];
    }

    closeCurrentItem() {
        if (this.openItem === null) return [];
        const events = [];

        if (this.openItem === 'message') {
            const text = this.text;
            events.push(
                this.emit('response.output_text.done', {
                    item_id: this.openItemId,
                    output_index: this.outputIndex,
                    content_index: this.contentIndex,
                    text,
                }),
                this.emit('response.content_part.done', {
                    item_id: this.openItemId,
                    output_index: this.outputIndex,
                    content_index: this.contentIndex,
                    part: { type: 'output_text', text, annotations: [] },
                }),
                this.emit('response.output_item.done', {
                    output_index: this.outputIndex,
                    item: {
                        id: this.openItemId,
                        type: 'message',
                        status: 'completed',
                        role: 'assistant',
                        content: [{ type: 'output_text', text, annotations: [] }],
                    },
                }),
            );
            this.completedItems.push({
                id: this.openItemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text, annotations: [] }],
            });
        } else if (this.openItem === 'function_call' || this.openItem === 'custom_tool_call') {
            const entry = [...this.toolCalls.values()].find((t) => t.itemId === this.openItemId);
            if (entry) {
                if (entry.custom) {
                    // cc-switch strategy: custom tool arguments are buffered (they are
                    // the JSON envelope, not the raw payload); at completion the raw
                    // freeform input is extracted and emitted as a single delta + done.
                    const input = customToolInputFromChatArguments(entry.args);
                    events.push(
                        this.emit('response.custom_tool_call_input.delta', {
                            item_id: entry.itemId,
                            output_index: entry.outputIndex,
                            delta: input,
                        }),
                        this.emit('response.custom_tool_call_input.done', {
                            item_id: entry.itemId,
                            output_index: entry.outputIndex,
                            input,
                        }),
                        this.emit('response.output_item.done', {
                            output_index: entry.outputIndex,
                            item: {
                                id: entry.itemId,
                                type: 'custom_tool_call',
                                status: 'completed',
                                call_id: entry.callId,
                                name: entry.name,
                                input,
                            },
                        }),
                    );
                    this.completedItems.push({
                        id: entry.itemId,
                        type: 'custom_tool_call',
                        status: 'completed',
                        call_id: entry.callId,
                        name: entry.name,
                        input,
                    });
                } else {
                    events.push(
                        this.emit('response.function_call_arguments.done', {
                            item_id: entry.itemId,
                            output_index: entry.outputIndex,
                            arguments: entry.args,
                        }),
                        this.emit('response.output_item.done', {
                            output_index: entry.outputIndex,
                            item: {
                                id: entry.itemId,
                                type: 'function_call',
                                status: 'completed',
                                call_id: entry.callId,
                                name: entry.name,
                                arguments: entry.args,
                            },
                        }),
                    );
                    this.completedItems.push({
                        id: entry.itemId,
                        type: 'function_call',
                        status: 'completed',
                        call_id: entry.callId,
                        name: entry.name,
                        arguments: entry.args,
                    });
                }
            }
        } else if (this.openItem === 'reasoning') {
            const text = this.reasoningText;
            events.push(
                this.emit('response.reasoning_summary_text.done', {
                    item_id: this.openItemId,
                    output_index: this.outputIndex,
                    summary_index: 0,
                    text,
                }),
                this.emit('response.reasoning_summary_part.done', {
                    item_id: this.openItemId,
                    output_index: this.outputIndex,
                    summary_index: 0,
                    part: { type: 'summary_text', text },
                }),
                this.emit('response.output_item.done', {
                    output_index: this.outputIndex,
                    item: {
                        id: this.openItemId,
                        type: 'reasoning',
                        summary: [{ type: 'summary_text', text }],
                    },
                }),
            );
            this.completedItems.push({
                id: this.openItemId,
                type: 'reasoning',
                summary: [{ type: 'summary_text', text }],
            });
        }

        this.openItem = null;
        this.openItemId = null;
        return events;
    }

    /**
     * Feed one parsed Chat Completions stream chunk.
     * @param {object} chunk
     * @returns {Array<{event: string, data: object}>} Responses events to forward
     */
    handleChunk(chunk) {
        const events = this.ensureStarted();
        if (!chunk || typeof chunk !== 'object') return events;

        if (chunk.id) this.responseId = chunk.id;
        if (chunk.model) this.model = chunk.model;
        if (chunk.usage) this.usage = chunk.usage;

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        const delta = choice?.delta ?? {};

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
            if (this.openItem !== 'reasoning') {
                events.push(...this.closeCurrentItem());
                events.push(...this.openReasoningItem());
            }
            this.reasoningText += delta.reasoning_content;
            events.push(
                this.emit('response.reasoning_summary_text.delta', {
                    item_id: this.openItemId,
                    output_index: this.outputIndex,
                    summary_index: 0,
                    delta: delta.reasoning_content,
                }),
            );
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
            if (this.openItem !== 'message') {
                events.push(...this.closeCurrentItem());
                events.push(...this.openMessageItem());
            }
            this.text += delta.content;
            events.push(
                this.emit('response.output_text.delta', {
                    item_id: this.openItemId,
                    output_index: this.outputIndex,
                    content_index: this.contentIndex,
                    delta: delta.content,
                }),
            );
        }

        for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const chatIndex = toolCall.index ?? 0;
            if (!this.toolCalls.has(chatIndex)) {
                events.push(...this.closeCurrentItem());
                events.push(...this.openToolCallItem(chatIndex, toolCall));
            }
            const entry = this.toolCalls.get(chatIndex);
            // Late deltas may still carry id/name on some providers — prefer the first seen.
            const argsDelta = toolCall.function?.arguments;
            if (typeof argsDelta === 'string' && argsDelta !== '') {
                entry.args += argsDelta;
                // Custom tool arguments are the JSON envelope — buffered and emitted
                // as one extracted delta at completion (see closeCurrentItem), never
                // streamed chunk-by-chunk. (cc-switch does the same.)
                if (!entry.custom) {
                    events.push(
                        this.emit('response.function_call_arguments.delta', {
                            item_id: entry.itemId,
                            output_index: entry.outputIndex,
                            delta: argsDelta,
                        }),
                    );
                }
            }
        }

        if (choice?.finish_reason) {
            this.finishReason = choice.finish_reason;
        }

        return events;
    }

    /**
     * Close any open item and emit the terminal `response.completed` event.
     * Must be called exactly once when the upstream stream ends.
     */
    finish() {
        const events = this.ensureStarted();
        events.push(...this.closeCurrentItem());

        const status = this.finishReason === 'length' ? 'incomplete' : 'completed';
        const response = {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            status,
            model: this.model,
            output: this.completedItems,
            usage: convertUsage(this.usage),
        };
        if (status === 'incomplete') {
            response.incomplete_details = { reason: 'max_output_tokens' };
        }
        events.push(this.emit('response.completed', { response }));
        return events;
    }
}

/**
 * Serialize one Responses event into an SSE frame.
 * Codex expects both the `event:` line and a JSON `data:` payload.
 */
export function serializeSseEvent({ event, data }) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
