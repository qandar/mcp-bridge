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

// グローバルPrefixルーティング表のキャッシュ
let globalRoutesCache = null;

// ローカル組み込みの107件のデフォルトルーティング（オフライン / エッジ未デプロイ時フォールバック）
let defaultRoutes = [];
try {
    const defaultRoutesPath = fileURLToPath(new URL('./default-routes.json', import.meta.url));
    defaultRoutes = JSON.parse(readFileSync(defaultRoutesPath, 'utf8'));
} catch (e) {
    // ignore
}

async function getGlobalRoutes() {
    if (globalRoutesCache) return globalRoutesCache;
    try {
        const routesUrl = new URL('/routes.json', serverOrigin).href;
        const res = await fetch(routesUrl);
        if (res.ok) {
            globalRoutesCache = await res.json();
            return globalRoutesCache;
        }
    } catch (e) {
        if (debugEnabled) console.error('[DEBUG] Failed to fetch global routes.json:', e.message);
    }
    // エッジフェッチ失敗時は内蔵のデフォルトルーティングを使用
    return defaultRoutes;
}

/**
 * URL または相対パスから Qandar 上のアセットパス ({refId}/docs/{path}.json) を動的解決する
 */
async function resolveDocByUrl(inputUrl, staticCatalog) {
    if (!inputUrl || typeof inputUrl !== 'string') return null;

    const cleanUrl = inputUrl.split('?')[0].split('#')[0].trim();
    const localRoutes = staticCatalog.routes || [];
    const globalRoutes = await getGlobalRoutes();

    // routes の各エントリを正規化（prefix が完全URL形式の場合も pathname と host を抽出）
    function normalizeRoute(r) {
        let host = r.host;
        let prefixPath = r.prefix;
        let baseUrl = r.baseUrl || (r.prefix.startsWith('http') ? r.prefix : '');

        if (r.prefix.startsWith('http://') || r.prefix.startsWith('https://')) {
            try {
                const u = new URL(r.prefix);
                host = u.host;
                prefixPath = u.pathname.replace(/\/+$/, '') || '/';
            } catch (_) {}
        }

        const def = defaultRoutes.find(d => d.refId === r.refId) || {};

        return {
            refId: r.refId,
            name: r.name || def.name || r.refId,
            baseUrl: baseUrl || def.baseUrl || '',
            host: host || def.host || '',
            prefix: prefixPath || def.prefix || '/',
            docs: r.docs || def.docs || []
        };
    }

    const normalizedLocalRoutes = (localRoutes || []).map(normalizeRoute);
    const normalizedGlobalRoutes = (globalRoutes || []).map(normalizeRoute);

    // defaultRoutes / globalRoutes の最新 prefix (例: /docs) を最優先
    const combinedRoutes = [];
    const allRefs = new Set([
        ...normalizedLocalRoutes.map(r => r.refId),
        ...normalizedGlobalRoutes.map(r => r.refId)
    ]);

    for (const refId of allRefs) {
        const local = normalizedLocalRoutes.find(r => r.refId === refId);
        const globalR = normalizedGlobalRoutes.find(r => r.refId === refId);
        const def = defaultRoutes.find(d => d.refId === refId);

        // prefix は最長（より詳細なサブパス）を持つものを採用
        const candidates = [globalR, def, local].filter(Boolean);
        let bestPrefix = '/';
        for (const c of candidates) {
            if (c.prefix && c.prefix !== '/' && (bestPrefix === '/' || c.prefix.length > bestPrefix.length)) {
                bestPrefix = c.prefix;
            }
        }

        const baseObj = globalR || local || def;
        combinedRoutes.push({
            ...baseObj,
            prefix: bestPrefix,
            docs: (globalR?.docs?.length ? globalR.docs : (def?.docs?.length ? def.docs : local?.docs)) || []
        });
    }

    const isAbsoluteUrl = cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://');

    if (isAbsoluteUrl) {
        let inputUrlObj;
        try {
            inputUrlObj = new URL(cleanUrl);
        } catch (_) {
            return null;
        }

        // 1. host が一致するルートを抽出
        const hostRoutes = combinedRoutes.filter(r => r.host === inputUrlObj.host);

        // prefix の長い順にソートしてマッチ
        hostRoutes.sort((a, b) => (b.prefix || '').length - (a.prefix || '').length);

        for (const route of hostRoutes) {
            const prefix = (route.prefix || '/').replace(/\/+$/, '');
            const pathname = inputUrlObj.pathname;

            let matched = false;
            let subPath = '';

            if (prefix === '' || prefix === '/') {
                matched = true;
                subPath = pathname;
            } else if (pathname === prefix || pathname.startsWith(prefix + '/')) {
                matched = true;
                subPath = pathname.substring(prefix.length);
            }

            if (matched) {
                let normalized = subPath.replace(/^\/+/, '').replace(/\/+$/, '');
                normalized = normalized.replace(/\.(html|md|mdx)$/i, '');
                if (!normalized) normalized = 'index';

                const docList = route.docs || [];
                const exists = docList.length > 0 ? (docList.includes(normalized) || docList.includes(`${normalized}/index`)) : true;
                const childPrefix = normalized === 'index' ? '' : `${normalized}/`;
                const children = docList
                    .filter(d => childPrefix ? d.startsWith(childPrefix) : true)
                    .slice(0, 10);

                return {
                    refId: route.refId,
                    name: route.name || route.refId,
                    normalizedPath: normalized,
                    docPath: `${route.refId}/docs/${normalized}.json`,
                    fallbackIndexPath: normalized.endsWith('/index') ? null : `${route.refId}/docs/${normalized}/index.json`,
                    exists,
                    children
                };
            }
        }
    } else if (cleanUrl.startsWith('/')) {
        // 2. 相対パス (/d1/..., /docs/...) の場合
        // prefix が一致するルートを最長一致で探す
        const pathRoutes = [...combinedRoutes].sort((a, b) => (b.prefix || '').length - (a.prefix || '').length);

        for (const route of pathRoutes) {
            const prefix = (route.prefix || '').replace(/\/+$/, '');
            if (!prefix || prefix === '/') continue; // 単なる '/' は相対パスでは誤マッチを防ぐため除外

            if (cleanUrl === prefix || cleanUrl.startsWith(prefix + '/')) {
                const subPath = cleanUrl.substring(prefix.length);
                let normalized = subPath.replace(/^\/+/, '').replace(/\/+$/, '');
                normalized = normalized.replace(/\.(html|md|mdx)$/i, '');
                if (!normalized) normalized = 'index';

                const docList = route.docs || [];
                const exists = docList.length > 0 ? (docList.includes(normalized) || docList.includes(`${normalized}/index`)) : true;
                const childPrefix = normalized === 'index' ? '' : `${normalized}/`;
                const children = docList
                    .filter(d => childPrefix ? d.startsWith(childPrefix) : true)
                    .slice(0, 10);

                return {
                    refId: route.refId,
                    name: route.name || route.refId,
                    normalizedPath: normalized,
                    docPath: `${route.refId}/docs/${normalized}.json`,
                    fallbackIndexPath: normalized.endsWith('/index') ? null : `${route.refId}/docs/${normalized}/index.json`,
                    exists,
                    children
                };
            }
        }
    }

    return null;
}

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

            // 検索ツールの実行 (例: search_docs)
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

                // 1. クエリがURLやパスの場合、Prefix動的解決 & 存在確認を行う
                const isUrlOrPath = query.startsWith('http://') || query.startsWith('https://') || query.startsWith('/');
                const urlMatched = await resolveDocByUrl(query, staticCatalog);

                if (isUrlOrPath) {
                    if (urlMatched) {
                        const lines = [
                            `### URL / Internal Link Inspection: "${query}"`,
                            `- **Target OSS**: ${urlMatched.name} (\`${urlMatched.refId}\`)`,
                            `- **Qandar Document Exists**: ${urlMatched.exists ? '✅ YES (Available in Qandar)' : '⚠️ Partial Match (Directory or Parent only)'}`,
                            `- **Direct Topic / Path**: \`${urlMatched.docPath.replace(/\.json$/, '')}\``,
                            `- **Fetch Command**: Call \`get_docs(topic: "${query}")\` or \`get_docs(topic: "${urlMatched.docPath.replace(/\.json$/, '')}")\``,
                            ""
                        ];

                        if (urlMatched.children && urlMatched.children.length > 0) {
                            lines.push(`#### Available Sub-documents in this section:`);
                            for (const ch of urlMatched.children) {
                                lines.push(`- \`${urlMatched.refId}/docs/${ch}\``);
                            }
                            lines.push("");
                        }

                        return respond(id, {
                            content: [{
                                type: "text",
                                text: lines.join('\n')
                            }]
                        });
                    } else {
                        return respond(id, {
                            content: [{
                                type: "text",
                                text: `⚠️ The link or path "${query}" does not match any registered OSS prefix in Qandar.\nTo read this topic, you may search by keyword instead (e.g. search_docs(query: "keyword")).`
                            }]
                        });
                    }
                }

                // 2. キーワード検索インデックスの照合 (複数単語マッチ & スコアリング)
                const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
                const scoredMatches = [];

                for (const item of staticCatalog.searchIndex) {
                    const titleLower = item.title?.toLowerCase() || '';
                    const descLower = item.description?.toLowerCase() || '';
                    const topicLower = item.topic?.toLowerCase() || '';

                    let score = 0;
                    for (const term of terms) {
                        if (titleLower.includes(term)) score += 10;
                        if (topicLower.includes(term)) score += 5;
                        if (descLower.includes(term)) score += 2;
                    }

                    if (score > 0) {
                        scoredMatches.push({ item, score });
                    }
                }

                // スコア降順ソート
                scoredMatches.sort((a, b) => b.score - a.score);
                const matches = scoredMatches.map(m => m.item);

                // URL解決結果があれば先頭に追加 (通常キーワード検索でURL解決できたケース)
                if (urlMatched) {
                    const existingIdx = matches.findIndex(m => m.topic.endsWith(urlMatched.docPath.replace(/^.*\/docs\//, '').replace(/\.json$/, '')));
                    if (existingIdx === -1) {
                        matches.unshift({
                            topic: urlMatched.docPath.replace(/\.json$/, ''),
                            title: `Direct URL Match (${urlMatched.refId})`,
                            description: `Resolved from URL/path: ${query}`
                        });
                    }
                }

                if (matches.length === 0) {
                    return respond(id, {
                        content: [{
                            type: "text",
                            text: `No documentation topics matched the query: "${query}"`
                        }]
                    });
                }

                const MAX_RESULTS = 20;
                const totalCount = matches.length;
                const displayMatches = matches.slice(0, MAX_RESULTS);

                const markdownLines = [
                    `Found ${totalCount} topics matching "${query}"${totalCount > MAX_RESULTS ? ` (showing top ${MAX_RESULTS})` : ''}:`,
                    ""
                ];
                for (const match of displayMatches) {
                    markdownLines.push(`* **${match.topic}** - *${match.title}*`);
                    if (match.description) {
                        markdownLines.push(`  > ${match.description}`);
                    }
                }

                if (totalCount > MAX_RESULTS) {
                    markdownLines.push("", `*(+${totalCount - MAX_RESULTS} more topics omitted. Add more specific keywords to narrow results)*`);
                }

                return respond(id, {
                    content: [{
                        type: "text",
                        text: markdownLines.join('\n')
                    }]
                });
            }

            // 通常のドキュメント取得ツール (例: get_docs)
            const topicArg = params?.arguments?.topic;
            if (!topicArg) {
                return respond(id, {
                    isError: true,
                    content: [{ type: "text", text: "Error: Missing required argument 'topic'." }]
                });
            }

            // 1. 通常のトピック名マッチング
            let match = staticCatalog.catalog?.find(item => item.topic === topicArg);
            let targetDocUrl = null;

            if (match) {
                const baseDirUrl = catalogUrl.endsWith('/')
                    ? catalogUrl
                    : catalogUrl.substring(0, catalogUrl.lastIndexOf('/') + 1);
                targetDocUrl = new URL(match.path, baseDirUrl).href;
            } else {
                // 2. 公式URL / 相対パスからの動的Prefix解決 (Qandarグローバル解決)
                const resolved = await resolveDocByUrl(topicArg, staticCatalog);
                if (resolved) {
                    targetDocUrl = new URL(resolved.docPath, serverOrigin + '/').href;
                    if (debugEnabled) {
                        console.error(`[DEBUG] Resolved URL '${topicArg}' to dynamic asset: ${targetDocUrl}`);
                    }
                }
            }

            if (!targetDocUrl) {
                return respond(id, {
                    isError: true,
                    content: [{ type: "text", text: `Error: Topic or URL '${topicArg}' could not be found or resolved in Qandar documentation.` }]
                });
            }

            // ドキュメント本体をエッジ（R2/Workers）からピンポイントGET
            let docRes = await fetch(targetDocUrl);

            // 404の場合、fallbackIndex (/index.json) の試行
            if (!docRes.ok && docRes.status === 404 && !targetDocUrl.endsWith('/index.json')) {
                const fallbackUrl = targetDocUrl.replace(/\.json$/, '/index.json');
                const fallbackRes = await fetch(fallbackUrl);
                if (fallbackRes.ok) {
                    docRes = fallbackRes;
                    targetDocUrl = fallbackUrl;
                }
            }

            if (!docRes.ok) {
                throw new Error(`Failed to fetch document (${targetDocUrl}): HTTP ${docRes.status}`);
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