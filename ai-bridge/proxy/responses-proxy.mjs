#!/usr/bin/env node
/**
 * Responses API → Chat Completions API local conversion proxy.
 *
 * New Codex versions only speak the Responses API (wire_api = "responses"),
 * while many third-party OpenAI-compatible providers (Kimi, GLM, DeepSeek,
 * relays, ...) only offer Chat Completions. This tiny localhost HTTP server
 * plays the same role as cc-switch's local router: the Codex provider's
 * base_url is pointed at this proxy with wire_api = "responses", and every
 * request is converted to Chat Completions before being forwarded upstream
 * (responses are converted back, including SSE streams).
 *
 * Managed by the plugin (ResponsesProxyService on the Java side); not meant
 * to be started by hand. Lifecycle:
 *   node responses-proxy.mjs --port 0 [--upstream https://api.example.com/v1]
 *   → prints `RESPONSES_PROXY_READY {"port":<port>}` on stdout once listening.
 * The upstream can be changed at runtime via `POST /__config {"upstream": ...}`
 * (localhost only), so provider switching never needs a proxy restart.
 *
 * API keys are never stored: the incoming Authorization header from Codex is
 * forwarded to the upstream verbatim.
 */

import http from 'node:http';
import {
    convertResponsesRequestToChat,
    convertChatResponseToResponses,
    ChatToResponsesStreamConverter,
    serializeSseEvent,
} from './responses-to-chat.mjs';

const READY_PREFIX = 'RESPONSES_PROXY_READY ';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
]);
/** Headers forwarded from the incoming Codex request to the upstream provider. */
const FORWARDED_REQUEST_HEADERS = [
    'authorization',
    'x-api-key',
    'openai-organization',
    'openai-project',
    'user-agent',
];

function parseArgs(argv) {
    const args = { port: 0, upstream: process.env.RESPONSES_PROXY_UPSTREAM ?? null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port' && argv[i + 1]) {
            args.port = Number.parseInt(argv[i + 1], 10) || 0;
            i++;
        } else if (argv[i] === '--upstream' && argv[i + 1]) {
            args.upstream = argv[i + 1];
            i++;
        }
    }
    return args;
}

function normalizeUpstream(url) {
    if (typeof url !== 'string' || url.trim() === '') return null;
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed;
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function buildUpstreamHeaders(req, streaming) {
    const headers = {
        'content-type': 'application/json',
        accept: streaming ? 'text/event-stream' : 'application/json',
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string' && value !== '') {
            headers[name] = value;
        }
    }
    return headers;
}

/**
 * Parse an upstream Chat Completions SSE stream, run the converter, and write
 * Responses API SSE frames to the client response.
 */
async function pipeChatStreamToResponses(upstreamBody, res, converter) {
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];

    const flushEvent = () => {
        if (dataLines.length === 0) return;
        const raw = dataLines.join('\n');
        dataLines = [];
        if (raw === '[DONE]') return;
        let chunk;
        try {
            chunk = JSON.parse(raw);
        } catch {
            return; // ignore non-JSON keep-alives / comments
        }
        for (const event of converter.handleChunk(chunk)) {
            res.write(serializeSseEvent(event));
        }
    };

    for await (const chunk of upstreamBody) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            if (line === '') {
                flushEvent();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
            // event:/id:/retry: lines from upstream are dropped — event types are
            // derived from the converted payload instead.
        }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
        const line = buffer.replace(/\r$/, '');
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    flushEvent();

    for (const event of converter.finish()) {
        res.write(serializeSseEvent(event));
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

async function handleResponsesRequest(req, res, getUpstream) {
    const upstream = getUpstream();
    if (!upstream) {
        sendJson(res, 500, {
            error: {
                message: 'Responses proxy has no upstream configured yet. Switch/apply a Codex provider first.',
                type: 'proxy_not_configured',
            },
        });
        return;
    }

    let bodyText;
    try {
        bodyText = await readRequestBody(req);
    } catch (error) {
        sendJson(res, 413, { error: { message: String(error.message ?? error) } });
        return;
    }

    let responsesReq;
    try {
        responsesReq = JSON.parse(bodyText || '{}');
    } catch {
        sendJson(res, 400, { error: { message: 'Invalid JSON request body' } });
        return;
    }

    const { chat, customToolNames } = convertResponsesRequestToChat(responsesReq);
    const streaming = chat.stream === true;

    const abort = new AbortController();
    req.on('close', () => {
        if (!res.writableEnded) abort.abort();
    });

    let upstreamResp;
    try {
        upstreamResp = await fetch(`${upstream}/chat/completions`, {
            method: 'POST',
            headers: buildUpstreamHeaders(req, streaming),
            body: JSON.stringify(chat),
            signal: abort.signal,
        });
    } catch (error) {
        if (res.writableEnded) return;
        sendJson(res, 502, {
            error: {
                message: `Failed to reach upstream ${upstream}: ${error.message ?? error}`,
                type: 'upstream_unreachable',
            },
        });
        return;
    }

    if (!upstreamResp.ok) {
        // Forward the provider's error verbatim — Codex surfaces it to the user.
        const errorBody = await upstreamResp.text();
        res.writeHead(upstreamResp.status, {
            'content-type': upstreamResp.headers.get('content-type') ?? 'application/json',
        });
        res.end(errorBody);
        return;
    }

    if (!streaming) {
        let chatResp;
        try {
            chatResp = await upstreamResp.json();
        } catch {
            sendJson(res, 502, { error: { message: 'Upstream returned invalid JSON', type: 'upstream_invalid' } });
            return;
        }
        sendJson(
            res,
            200,
            convertChatResponseToResponses(chatResp, { customToolNames, model: chat.model }),
        );
        return;
    }

    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });

    const converter = new ChatToResponsesStreamConverter({ customToolNames, model: chat.model });
    try {
        await pipeChatStreamToResponses(upstreamResp.body, res, converter);
    } catch (error) {
        if (!res.writableEnded) {
            try {
                res.write(serializeSseEvent({
                    event: 'response.failed',
                    data: {
                        type: 'response.failed',
                        response: {
                            id: converter.responseId,
                            object: 'response',
                            created_at: converter.createdAt,
                            status: 'failed',
                            model: converter.model,
                            output: [],
                            error: { message: String(error.message ?? error) },
                        },
                    },
                }));
            } finally {
                res.end();
            }
        }
    }
}

async function handleModelsRequest(req, res, getUpstream) {
    const upstream = getUpstream();
    if (!upstream) {
        sendJson(res, 500, { error: { message: 'Responses proxy has no upstream configured yet.' } });
        return;
    }
    try {
        const upstreamResp = await fetch(`${upstream}/models`, {
            method: 'GET',
            headers: buildUpstreamHeaders(req, false),
        });
        const body = await upstreamResp.text();
        res.writeHead(upstreamResp.status, {
            'content-type': upstreamResp.headers.get('content-type') ?? 'application/json',
        });
        res.end(body);
    } catch (error) {
        sendJson(res, 502, { error: { message: `Failed to reach upstream: ${error.message ?? error}` } });
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    let currentUpstream = normalizeUpstream(args.upstream);

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;

        try {
            if (path === '/__health' && req.method === 'GET') {
                sendJson(res, 200, { status: 'ok', upstream: currentUpstream });
                return;
            }

            if (path === '/__config' && req.method === 'POST') {
                const bodyText = await readRequestBody(req);
                let body;
                try {
                    body = JSON.parse(bodyText || '{}');
                } catch {
                    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
                    return;
                }
                const upstream = normalizeUpstream(body.upstream);
                if (!upstream) {
                    sendJson(res, 400, { error: { message: 'upstream must be an http(s) URL' } });
                    return;
                }
                currentUpstream = upstream;
                console.log(`[responses-proxy] upstream set to ${currentUpstream}`);
                sendJson(res, 200, { status: 'ok', upstream: currentUpstream });
                return;
            }

            if ((path === '/v1/responses' || path === '/responses') && req.method === 'POST') {
                await handleResponsesRequest(req, res, () => currentUpstream);
                return;
            }

            if ((path === '/v1/models' || path === '/models') && req.method === 'GET') {
                await handleModelsRequest(req, res, () => currentUpstream);
                return;
            }

            sendJson(res, 404, { error: { message: `Unknown path: ${path}` } });
        } catch (error) {
            console.error('[responses-proxy] unhandled error:', error);
            if (!res.writableEnded) {
                sendJson(res, 500, { error: { message: String(error.message ?? error) } });
            }
        }
    });

    server.listen(args.port, '127.0.0.1', () => {
        const address = server.address();
        console.log(`${READY_PREFIX}${JSON.stringify({ port: address.port })}`);
        console.log(`[responses-proxy] listening on 127.0.0.1:${address.port}`);
    });

    const shutdown = () => {
        console.log('[responses-proxy] shutting down');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main();
