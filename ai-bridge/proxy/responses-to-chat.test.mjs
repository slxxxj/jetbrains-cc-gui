import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    convertResponsesRequestToChat,
    convertChatResponseToResponses,
    customToolInputFromChatArguments,
    ChatToResponsesStreamConverter,
    serializeSseEvent,
} from './responses-to-chat.mjs';

const PROXY_PATH = fileURLToPath(new URL('./responses-proxy.mjs', import.meta.url));

// ============================================================================
// Request conversion: Responses → Chat
// ============================================================================

test('converts string input and instructions to chat messages', () => {
    const { chat, customToolNames } = convertResponsesRequestToChat({
        model: 'kimi-k3',
        instructions: 'You are a coding assistant.',
        input: 'hello',
    });

    assert.equal(chat.model, 'kimi-k3');
    assert.deepEqual(chat.messages, [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'hello' },
    ]);
    assert.deepEqual(customToolNames, []);
    assert.equal(chat.stream, undefined);
});

test('converts message items and collapses text parts', () => {
    const { chat } = convertResponsesRequestToChat({
        model: 'glm-5.2',
        input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'there' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how are you' }] },
        ],
    });

    assert.deepEqual(chat.messages, [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' },
        { role: 'user', content: 'how are you' },
    ]);
});

test('merges function_call items into assistant tool_calls and maps outputs to tool role', () => {
    const { chat } = convertResponsesRequestToChat({
        model: 'm',
        input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
            { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
            { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{"cmd":"pwd"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
            { type: 'function_call_output', call_id: 'call_2', output: '/home' },
        ],
    });

    assert.deepEqual(chat.messages, [
        { role: 'user', content: 'run ls' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
                { id: 'call_2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
        { role: 'tool', tool_call_id: 'call_2', content: '/home' },
    ]);
});

test('converts tools, custom tools, tool_choice, and sampling params', () => {
    const { chat, customToolNames } = convertResponsesRequestToChat({
        model: 'm',
        input: 'x',
        tools: [
            { type: 'function', name: 'shell', description: 'run cmd', parameters: { type: 'object' } },
            { type: 'custom', name: 'apply_patch', description: 'patch files' },
            { type: 'web_search' },
        ],
        tool_choice: { type: 'function', name: 'shell' },
        temperature: 0.3,
        top_p: 0.9,
        max_output_tokens: 1024,
        stream: true,
        parallel_tool_calls: false,
    });

    assert.equal(chat.tools.length, 2);
    assert.deepEqual(chat.tools[0], {
        type: 'function',
        function: { name: 'shell', description: 'run cmd', parameters: { type: 'object', properties: {} } },
    });

    // Custom tools use cc-switch's JSON envelope: a single required `input` string
    // plus the original tool definition embedded in the description.
    const customTool = chat.tools[1];
    assert.equal(customTool.type, 'function');
    assert.equal(customTool.function.name, 'apply_patch');
    assert.deepEqual(customTool.function.parameters, {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                description:
                    'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.',
            },
        },
        required: ['input'],
    });
    assert.ok(customTool.function.description.startsWith('patch files\n\nOriginal tool definition:'));
    assert.ok(customTool.function.description.includes('"name":"apply_patch"'));

    assert.deepEqual(customToolNames, ['apply_patch']);
    assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'shell' } });
    assert.equal(chat.temperature, 0.3);
    assert.equal(chat.top_p, 0.9);
    assert.equal(chat.max_tokens, 1024);
    assert.equal(chat.stream, true);
    assert.deepEqual(chat.stream_options, { include_usage: true });
    assert.equal(chat.parallel_tool_calls, false);
});

test('converts input_image parts and keeps multimodal arrays', () => {
    const { chat } = convertResponsesRequestToChat({
        model: 'm',
        input: [
            {
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: 'what is this?' },
                    { type: 'input_image', image_url: 'https://example.com/a.png' },
                ],
            },
        ],
    });

    assert.deepEqual(chat.messages[0].content, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
});

// ============================================================================
// Non-streaming response conversion: Chat → Responses
// ============================================================================

test('converts non-streaming chat response with tool calls, reasoning and usage', () => {
    const resp = convertChatResponseToResponses(
        {
            id: 'chatcmpl-1',
            created: 1700000000,
            model: 'kimi-k3',
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: 'working on it',
                        reasoning_content: 'let me think',
                        tool_calls: [
                            { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
                            { id: 'call_2', type: 'function', function: { name: 'apply_patch', arguments: '*** patch' } },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                prompt_tokens_details: { cached_tokens: 4 },
                completion_tokens_details: { reasoning_tokens: 3 },
            },
        },
        { customToolNames: ['apply_patch'] },
    );

    assert.equal(resp.id, 'chatcmpl-1');
    assert.equal(resp.status, 'completed');
    assert.equal(resp.model, 'kimi-k3');
    assert.equal(resp.output[0].type, 'reasoning');
    assert.equal(resp.output[0].summary[0].text, 'let me think');
    assert.equal(resp.output[1].type, 'message');
    assert.equal(resp.output[1].content[0].text, 'working on it');
    assert.equal(resp.output[2].type, 'function_call');
    assert.equal(resp.output[2].call_id, 'call_1');
    assert.equal(resp.output[2].arguments, '{"cmd":"ls"}');
    assert.equal(resp.output[3].type, 'custom_tool_call');
    assert.equal(resp.output[3].input, '*** patch');
    assert.deepEqual(resp.usage, {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 3 },
    });
});

// ============================================================================
// Streaming conversion
// ============================================================================

function eventNames(events) {
    return events.map((e) => e.event);
}

test('stream converter maps text deltas to responses events and completes', () => {
    const converter = new ChatToResponsesStreamConverter({ model: 'm' });

    const e1 = converter.handleChunk({ id: 'c1', model: 'm', choices: [{ delta: { role: 'assistant' } }] });
    assert.deepEqual(eventNames(e1), ['response.created', 'response.in_progress']);

    const e2 = converter.handleChunk({ id: 'c1', choices: [{ delta: { content: 'Hello' } }] });
    assert.deepEqual(eventNames(e2), [
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
    ]);
    assert.equal(e2[2].data.delta, 'Hello');

    const e3 = converter.handleChunk({ id: 'c1', choices: [{ delta: { content: ' world' } }] });
    assert.deepEqual(eventNames(e3), ['response.output_text.delta']);

    const e4 = converter.handleChunk({
        id: 'c1',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    assert.equal(e4.length, 0);

    const done = converter.finish();
    assert.deepEqual(eventNames(done), [
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
    ]);
    const completed = done[3].data.response;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.length, 1);
    assert.equal(completed.output[0].content[0].text, 'Hello world');
    assert.deepEqual(completed.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });

    // SSE frames must carry both event: and data: lines
    const frame = serializeSseEvent(done[3]);
    assert.ok(frame.startsWith('event: response.completed\n'));
    assert.ok(frame.includes('\ndata: {'));
    assert.ok(frame.endsWith('\n\n'));
});

test('stream converter maps index-based tool call deltas', () => {
    const converter = new ChatToResponsesStreamConverter({ model: 'm' });

    converter.handleChunk({ choices: [{ delta: { content: 'ok' } }] });
    const e1 = converter.handleChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '' } }] } }],
    });
    assert.deepEqual(eventNames(e1), [
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.output_item.added',
    ]);
    assert.equal(e1[3].data.item.type, 'function_call');
    assert.equal(e1[3].data.item.call_id, 'call_1');

    const e2 = converter.handleChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } }],
    });
    assert.deepEqual(eventNames(e2), ['response.function_call_arguments.delta']);

    converter.handleChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }],
    });
    const done = converter.finish();
    const completed = done.at(-1).data.response;
    assert.equal(completed.output.length, 2);
    assert.equal(completed.output[1].type, 'function_call');
    assert.equal(completed.output[1].arguments, '{"cmd":"ls"}');
});

test('stream converter maps reasoning_content deltas to reasoning events', () => {
    const converter = new ChatToResponsesStreamConverter({ model: 'glm-5.2' });

    const e1 = converter.handleChunk({ choices: [{ delta: { reasoning_content: 'think' } }] });
    assert.deepEqual(eventNames(e1), [
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_text.delta',
    ]);
    assert.equal(e1[2].data.item.type, 'reasoning');

    converter.handleChunk({ choices: [{ delta: { reasoning_content: 'ing…' } }] });
    const e3 = converter.handleChunk({ choices: [{ delta: { content: 'answer' } }] });
    assert.ok(eventNames(e3).includes('response.reasoning_summary_text.done'));
    assert.ok(eventNames(e3).includes('response.output_item.added'));

    const done = converter.finish();
    const completed = done.at(-1).data.response;
    assert.equal(completed.output[0].type, 'reasoning');
    assert.equal(completed.output[0].summary[0].text, 'thinking…');
    assert.equal(completed.output[1].type, 'message');
});

// ============================================================================
// cc-switch parity: custom tool envelope, reasoning effort, parameter cleanup
// ============================================================================

test('custom_tool_call history items ride the JSON envelope', () => {
    const { chat } = convertResponsesRequestToChat({
        model: 'm',
        input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] },
            { type: 'custom_tool_call', call_id: 'call_9', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
            { type: 'function_call_output', call_id: 'call_9', output: 'ok' },
        ],
    });

    assert.equal(chat.messages[1].tool_calls[0].function.arguments,
        '{"input":"*** Begin Patch\\n*** End Patch"}');
});

test('customToolInputFromChatArguments extracts the envelope input', () => {
    assert.equal(customToolInputFromChatArguments('{"input":"*** patch text"}'), '*** patch text');
    // Model ignored the envelope → raw arguments are the payload
    assert.equal(customToolInputFromChatArguments('*** raw patch'), '*** raw patch');
    assert.equal(customToolInputFromChatArguments('{"other":1}'), '{"other":1}');
    assert.equal(customToolInputFromChatArguments(''), '');
    assert.equal(customToolInputFromChatArguments(undefined), '');
});

test('non-streaming custom tool call extracts input from envelope arguments', () => {
    const resp = convertChatResponseToResponses(
        {
            choices: [{
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }],
                },
            }],
        },
        { customToolNames: ['apply_patch'] },
    );
    assert.equal(resp.output[0].type, 'custom_tool_call');
    assert.equal(resp.output[0].input, '*** Begin Patch');
});

test('function tool parameters are normalized to type object', () => {
    const { chat } = convertResponsesRequestToChat({
        model: 'm',
        input: 'x',
        tools: [
            { type: 'function', name: 'a', parameters: null },
            { type: 'function', name: 'b', parameters: { type: null } },
        ],
    });
    assert.deepEqual(chat.tools[0].function.parameters, { type: 'object', properties: {} });
    assert.equal(chat.tools[1].function.parameters.type, 'object');
});

test('reasoning effort passes through only for OpenAI-family models', () => {
    const openai = convertResponsesRequestToChat({
        model: 'gpt-5.4',
        input: 'x',
        reasoning: { effort: 'high' },
    });
    assert.equal(openai.chat.reasoning_effort, 'high');

    const oSeries = convertResponsesRequestToChat({
        model: 'o4-mini',
        input: 'x',
        reasoning: { effort: 'low' },
    });
    assert.equal(oSeries.chat.reasoning_effort, 'low');

    const kimi = convertResponsesRequestToChat({
        model: 'kimi-k3',
        input: 'x',
        reasoning: { effort: 'high' },
    });
    assert.equal(kimi.chat.reasoning_effort, undefined);

    const glm = convertResponsesRequestToChat({
        model: 'glm-5.2',
        input: 'x',
        reasoning: { effort: 'high' },
    });
    assert.equal(glm.chat.reasoning_effort, undefined);
});

test('stream converter buffers custom tool args and emits one extracted delta at completion', () => {
    const converter = new ChatToResponsesStreamConverter({ model: 'm', customToolNames: ['apply_patch'] });

    const e1 = converter.handleChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'apply_patch', arguments: '' } }] } }],
    });
    assert.equal(e1.at(-1).data.item.type, 'custom_tool_call');

    const e2 = converter.handleChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"input":"*** Begin' } }] } }],
    });
    // No per-chunk deltas for custom tools — the envelope chunks are not the payload
    assert.equal(e2.length, 0);

    converter.handleChunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' Patch\\n*** End Patch"}' } }] } }],
    });

    const done = converter.finish();
    assert.deepEqual(eventNames(done), [
        'response.custom_tool_call_input.delta',
        'response.custom_tool_call_input.done',
        'response.output_item.done',
        'response.completed',
    ]);
    assert.equal(done[0].data.delta, '*** Begin Patch\n*** End Patch');
    const completed = done.at(-1).data.response;
    assert.equal(completed.output[0].type, 'custom_tool_call');
    assert.equal(completed.output[0].input, '*** Begin Patch\n*** End Patch');
});

// ============================================================================
// Proxy integration: spawn the real proxy against a mock upstream
// ============================================================================

function startMockUpstream(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function startProxy(extraArgs = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [PROXY_PATH, '--port', '0', ...extraArgs], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let buffer = '';
        const onData = (data) => {
            buffer += data.toString('utf8');
            const match = buffer.match(/RESPONSES_PROXY_READY (\{.*\})/);
            if (match) {
                child.stdout.off('data', onData);
                resolve({ child, port: JSON.parse(match[1]).port });
            }
        };
        child.stdout.on('data', onData);
        child.on('exit', (code) => reject(new Error(`proxy exited early: ${code}`)));
        setTimeout(() => reject(new Error('proxy ready timeout')), 10000);
    });
}

async function readSseFrames(res) {
    const text = await res.text();
    return text
        .split('\n\n')
        .map((frame) => {
            const eventMatch = frame.match(/^event: (.+)$/m);
            const dataMatch = frame.match(/^data: (.+)$/m);
            if (!dataMatch) return null;
            return {
                event: eventMatch ? eventMatch[1] : null,
                data: dataMatch[1] === '[DONE]' ? '[DONE]' : JSON.parse(dataMatch[1]),
            };
        })
        .filter(Boolean);
}

test('proxy converts non-streaming and streaming requests against a mock upstream', async (t) => {
    const upstreamRequests = [];
    const upstream = await startMockUpstream((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const parsed = JSON.parse(body);
            upstreamRequests.push({ url: req.url, body: parsed, authorization: req.headers.authorization });
            if (parsed.stream === true) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
                res.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
                res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'chatcmpl-9',
                    model: parsed.model,
                    choices: [{ message: { role: 'assistant', content: 'plain answer' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            }
        });
    });
    t.after(() => upstream.close());

    const upstreamPort = upstream.address().port;
    const { child, port } = await startProxy();
    t.after(() => child.kill());

    // Configure the upstream at runtime
    const configResp = await fetch(`http://127.0.0.1:${port}/__config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upstream: `http://127.0.0.1:${upstreamPort}/v1` }),
    });
    assert.equal(configResp.status, 200);

    // --- Non-streaming ---
    const nonStreamResp = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({ model: 'kimi-k3', input: 'hello', instructions: 'be nice' }),
    });
    assert.equal(nonStreamResp.status, 200);
    const nonStreamJson = await nonStreamResp.json();
    assert.equal(nonStreamJson.object, 'response');
    assert.equal(nonStreamJson.status, 'completed');
    assert.equal(nonStreamJson.output[0].content[0].text, 'plain answer');

    // Upstream saw the converted chat request, with the auth header forwarded
    const chatReq = upstreamRequests[0];
    assert.equal(chatReq.url, '/v1/chat/completions');
    assert.equal(chatReq.authorization, 'Bearer sk-test');
    assert.deepEqual(chatReq.body.messages, [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hello' },
    ]);
    assert.equal(chatReq.body.stream, undefined);

    // --- Streaming ---
    const streamResp = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'kimi-k3', input: 'hi', stream: true }),
    });
    assert.equal(streamResp.status, 200);
    assert.match(streamResp.headers.get('content-type'), /text\/event-stream/);

    const frames = await readSseFrames(streamResp);
    const names = frames.map((f) => f.event);
    assert.ok(names.includes('response.created'));
    assert.ok(names.includes('response.output_text.delta'));
    assert.ok(names.includes('response.completed'));
    assert.equal(frames.at(-1).data, '[DONE]');

    const deltas = frames.filter((f) => f.event === 'response.output_text.delta').map((f) => f.data.delta);
    assert.equal(deltas.join(''), 'Hi there');

    const completed = frames.find((f) => f.event === 'response.completed').data.response;
    assert.equal(completed.output[0].content[0].text, 'Hi there');
    assert.deepEqual(completed.usage, { input_tokens: 7, output_tokens: 2, total_tokens: 9 });

    // Upstream received stream:true plus include_usage
    const streamChatReq = upstreamRequests[1];
    assert.equal(streamChatReq.body.stream, true);
    assert.deepEqual(streamChatReq.body.stream_options, { include_usage: true });
});

test('proxy forwards upstream error status verbatim', async (t) => {
    const upstream = await startMockUpstream((req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    t.after(() => upstream.close());

    const { child, port } = await startProxy();
    t.after(() => child.kill());

    await fetch(`http://127.0.0.1:${port}/__config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upstream: `http://127.0.0.1:${upstream.address().port}/v1` }),
    });

    const resp = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', input: 'x' }),
    });
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.equal(body.error.message, 'bad key');
});
