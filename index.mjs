#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cachePath = join(__dirname, '.catalog_cache.json');

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

// AIからの入力を「一瞬の隙もなく」最優先で受け付ける
rl.on('line', async (line) => {
    if (!line.trim()) return;

    let requestId = undefined;
    try {
        const request = JSON.parse(line);
        requestId = request.id;
        const { method, id, params } = request;

        if (debugEnabled) {
            console.error(`[DEBUG] Received request: method=${method}, id=${id}, size=${Buffer.byteLength(line, 'utf8')} bytes`);
        }

        // 1. 初期化要求（initialize）
        if (method === 'initialize') {
            // キャッシュがあれば即時返却、なければ裏で走らせていた fetch の完了を待つ
            const staticCatalog = currentCatalog || await catalogPromise;

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
            return respond(id, staticCatalog ? staticCatalog.result : { tools: [] });
        }

        // 3. ツール実行要求（tools/call）
        if (method === 'tools/call') {
            const staticCatalog = currentCatalog || await catalogPromise;
            if (!staticCatalog) {
                return respond(id, { isError: true, content: [{ type: "text", text: "Catalog is unavailable." }] });
            }

            const toolName = params?.name;
            if (debugEnabled) {
                console.error(`[DEBUG] Calling tool: name=${toolName}, arguments=${JSON.stringify(params?.arguments || {})}`);
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
            const match = staticCatalog.catalog.find(item => item.topic === topicArg);

            if (!match) {
                return respond(id, {
                    isError: true,
                    content: [{ type: "text", text: `Error: Topic '${topicArg}' not found.` }]
                });
            }

            // ドキュメント本体をエッジ（R2/Workers）からピンポイントGET
            const docUrl = new URL(match.path, serverOrigin).href;
            const docRes = await fetch(docUrl);

            if (!docRes.ok) {
                throw new Error(`Failed to fetch document from Workers: HTTP ${docRes.status}`);
            }

            const docJson = await docRes.json();
            return respond(id, docJson.result);
        }

        if (id !== undefined) {
            respond(id, {});
        }

    } catch (err) {
        console.error('Bridge Inner Error:', err.message);
        if (requestId !== undefined) {
            respond(requestId, {
                isError: true,
                content: [{ type: "text", text: `Bridge Error: ${err.message}` }]
            });
        }
    }
});