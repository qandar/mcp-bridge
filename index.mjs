#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

let catalogUrl = process.argv[2];

if (!catalogUrl) {
    console.error('Error: Please provide a valid Qandar catalog URL.');
    process.exit(1);
}

const debugEnabled = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// ユーザー設定(mcp_config.json)のURL末尾に.jsonが付いていない場合の自動補完
if (!catalogUrl.endsWith('.json')) {
    catalogUrl = catalogUrl + '.json';
}

const serverOrigin = new URL(catalogUrl).origin;

// ローカルキャッシュの読み込み
const cacheDir = join(homedir(), '.qandar');
try {
    mkdirSync(cacheDir, { recursive: true });
} catch (e) {
    // ignore
}
const cachePath = join(cacheDir, 'catalog_cache.json');

let cacheData = {};
try {
    cacheData = JSON.parse(readFileSync(cachePath, 'utf8'));
} catch (e) {
    // ignore
}
let cachedCatalog = cacheData[catalogUrl] || null;
let currentCatalog = cachedCatalog;

// 🟢【重要】fetchは非同期で裏で走らせ、トップレベルを絶対にブロックしない！
// これにより、この下の readline が「1ミリ秒」で即座に起動します。
const catalogPromise = fetch(catalogUrl)
    .then(res => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json();
    })
    .then(catalog => {
        currentCatalog = catalog;
        try {
            cacheData[catalogUrl] = catalog;
            writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf8');
        } catch (err) {
            console.error('Cache Write Error:', err.message);
        }
        return catalog;
    })
    .catch(err => {
        console.error('Background Catalog Fetch Error:', err.message);
        return currentCatalog;
    });

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

function respond(id, result) {
    const responseObj = { jsonrpc: "2.0", id, result };
    const payload = JSON.stringify(responseObj);
    if (debugEnabled) {
        console.error(`[DEBUG] Sending response: id=${id}, size=${Buffer.byteLength(payload, 'utf8')} bytes`);
    }
    process.stdout.write(payload + "\n");
}

function respondError(id, code, message, data = null) {
    const responseObj = {
        jsonrpc: "2.0",
        id,
        error: { code, message }
    };
    if (data !== null) {
        responseObj.error.data = data;
    }
    const payload = JSON.stringify(responseObj);
    if (debugEnabled) {
        console.error(`[DEBUG] Sending error: id=${id}, code=${code}, message=${message}`);
    }
    process.stdout.write(payload + "\n");
}

// AIからの入力を「一瞬の隙もなく」最優先で受け付ける
rl.on('line', async (line) => {
    if (!line.trim()) return;

    let request = null;
    try {
        request = JSON.parse(line);
    } catch (err) {
        respondError(null, -32700, `Parse error: ${err.message}`);
        return;
    }

    const { jsonrpc, method, id, params } = request;

    if (jsonrpc !== "2.0") {
        if (id !== undefined) {
            respondError(id, -32600, "Invalid Request: jsonrpc version must be '2.0'");
        }
        return;
    }

    if (debugEnabled) {
        console.error(`[DEBUG] Received request: method=${method}, id=${id}, size=${Buffer.byteLength(line, 'utf8')} bytes`);
    }

    try {
        // 1. 初期化要求（initialize）
        if (method === 'initialize') {
            const staticCatalog = currentCatalog || await catalogPromise;

            if (id === undefined) return;

            return respond(id, {
                protocolVersion: "2024-11-05",
                capabilities: {
                    tools: {}
                },
                serverInfo: staticCatalog ? staticCatalog.serverInfo : { name: "qandar-mcp", version: "1.0.0" }
            });
        }

        // 2. ツール一覧要求（tools/list）
        if (method === 'tools/list') {
            const staticCatalog = currentCatalog || await catalogPromise;
            if (id === undefined) return;
            return respond(id, staticCatalog ? staticCatalog.result : { tools: [] });
        }

        // 3. ツール実行要求（tools/call）
        if (method === 'tools/call') {
            if (id === undefined) return;

            const staticCatalog = currentCatalog || await catalogPromise;
            if (!staticCatalog) {
                return respond(id, { isError: true, content: [{ type: "text", text: "Catalog is unavailable." }] });
            }

            const toolName = params?.name;
            if (debugEnabled) {
                console.error(`[DEBUG] Calling tool: name=${toolName}, arguments=${JSON.stringify(params?.arguments || {})}`);
            }

            const toolsList = staticCatalog.result?.tools || [];
            const isToolDefined = toolsList.some(t => t.name === toolName);

            if (!isToolDefined) {
                return respond(id, {
                    isError: true,
                    content: [{ type: "text", text: `Error: Tool '${toolName}' is not defined in the catalog.` }]
                });
            }

            // 検索ツールの実行 (例: search_nuxt_i18n_docs)
            if (toolName && toolName.startsWith('search_')) {
                const query = params?.arguments?.query;
                if (!query) {
                    return respond(id, {
                        isError: true,
                        content: [{ type: "text", text: "Error: Missing required argument 'query'." }]
                    });
                }

                if (!staticCatalog.searchIndex) {
                    return respond(id, {
                        isError: true,
                        content: [{ type: "text", text: "Error: Search index is not available in the catalog." }]
                    });
                }

                const queryLower = query.toLowerCase();
                const matches = staticCatalog.searchIndex.filter(item => {
                    const titleMatch = item.title?.toLowerCase().includes(queryLower);
                    const descMatch = item.description?.toLowerCase().includes(queryLower);
                    const topicMatch = item.topic?.toLowerCase().includes(queryLower);
                    return titleMatch || descMatch || topicMatch;
                });

                if (matches.length === 0) {
                    return respond(id, {
                        content: [{
                            type: "text",
                            text: `No documentation topics matched the query: "${query}"`
                        }]
                    });
                }

                const markdownLines = [
                    `Found ${matches.length} topics matching "${query}":`,
                    ""
                ];
                for (const match of matches) {
                    markdownLines.push(`* **${match.topic}** - *${match.title}*`);
                    if (match.description) {
                        markdownLines.push(`  > ${match.description}`);
                    }
                }

                return respond(id, {
                    content: [{
                        type: "text",
                        text: markdownLines.join('\n')
                    }]
                });
            }

            // 通常のドキュメント取得ツール (例: get_nuxt_i18n_docs)
            const topicArg = params?.arguments?.topic;
            if (!topicArg) {
                return respond(id, {
                    isError: true,
                    content: [{ type: "text", text: "Error: Missing required argument 'topic'." }]
                });
            }

            const match = staticCatalog.catalog?.find(item => item.topic === topicArg);

            if (!match) {
                return respond(id, {
                    isError: true,
                    content: [{ type: "text", text: `Error: Topic '${topicArg}' not found.` }]
                });
            }

            // ドキュメント本体をエッジ（R2/Workers）からピンポイントGET
            const baseDirUrl = catalogUrl.endsWith('/')
                ? catalogUrl
                : catalogUrl.substring(0, catalogUrl.lastIndexOf('/') + 1);
            const docUrl = new URL(match.path, baseDirUrl).href;
            const docRes = await fetch(docUrl);

            if (!docRes.ok) {
                throw new Error(`Failed to fetch document from Workers: HTTP ${docRes.status}`);
            }

            const docJson = await docRes.json();
            return respond(id, docJson.result);
        }

        if (id !== undefined) {
            respondError(id, -32601, `Method not found: ${method}`);
        }

    } catch (err) {
        console.error('Bridge Inner Error:', err.message);
        if (id !== undefined) {
            if (method === 'tools/call') {
                respond(id, {
                    isError: true,
                    content: [{ type: "text", text: `Bridge Error: ${err.message}` }]
                });
            } else {
                respondError(id, -32603, `Internal error: ${err.message}`);
            }
        }
    }
});