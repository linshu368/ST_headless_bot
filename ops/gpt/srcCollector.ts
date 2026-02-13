/**
 * Source Code Collector
 * 收集项目 src/ 下的源代码文本，用于注入 AI prompt
 *
 * 过滤优先级（从高到低）：
 *   1. excludeDirs / excludeFiles — 手动排除的目录和文件
 *   2. excludeSuffixes — 黑名单后缀（优先级 > includeExtensions）
 *   3. includeExtensions — 白名单后缀，只收集这些后缀的文件
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 配置类型 ──────────────────────────────────────────

export interface SrcCollectConfig {
    /** 扫描根目录（相对于项目根） */
    rootDir: string;

    /** 白名单：只收集这些后缀的文件 */
    includeExtensions: string[];

    /** 黑名单：匹配这些后缀的文件将被排除（优先级 > includeExtensions） */
    excludeSuffixes: string[];

    /** 排除的目录名（匹配任意层级的目录名） */
    excludeDirs: string[];

    /** 排除的具体文件（文件名 或 相对于 rootDir 的路径） */
    excludeFiles: string[];
}

// ─── 默认配置（一次写好，通常不需要再改） ─────────────

export const DEFAULT_CONFIG: SrcCollectConfig = {
    rootDir: 'src',

    includeExtensions: ['.ts', '.js'],

    excludeSuffixes: [
        '.test.ts',
        '.manual.test.ts',
        '.golden.ts',
        '.d.ts',
    ],

    excludeDirs: [
        'mock_data',
        'tokenizers',
        'node_modules',
    ],

    excludeFiles: [
        'transformers.js',
        'ports/ISTEngine.js',
    ],
};

// ─── 核心逻辑 ──────────────────────────────────────────

/**
 * 收集源代码，返回拼接后的文本
 */
export function collectSrcCode(
    projectRoot?: string,
    config: SrcCollectConfig = DEFAULT_CONFIG
): string {
    const root = path.resolve(
        projectRoot || path.resolve(__dirname, '../..'),
        config.rootDir
    );

    if (!fs.existsSync(root)) {
        console.warn(`[SrcCollector] 目录不存在: ${root}`);
        return '';
    }

    const files = walkDir(root, root, config);
    files.sort(); // 保证输出顺序稳定

    const parts: string[] = [];
    for (const filePath of files) {
        const relativePath = path.relative(root, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        parts.push(`// === ${relativePath} ===\n${content}`);
    }

    return parts.join('\n\n');
}

/**
 * 递归遍历目录，返回通过过滤的文件路径列表
 */
function walkDir(
    dir: string,
    root: string,
    config: SrcCollectConfig
): string[] {
    const results: string[] = [];

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (config.excludeDirs.includes(entry.name)) continue;
            results.push(...walkDir(fullPath, root, config));
            continue;
        }

        if (!entry.isFile()) continue;

        const relativePath = path.relative(root, fullPath);

        // 1. 手动排除的具体文件
        if (isExcludedFile(relativePath, config.excludeFiles)) continue;

        // 2. 白名单：后缀必须在 includeExtensions 中
        if (!config.includeExtensions.some(ext => entry.name.endsWith(ext))) continue;

        // 3. 黑名单：后缀匹配 excludeSuffixes 则排除（优先级最高）
        if (config.excludeSuffixes.some(suffix => entry.name.endsWith(suffix))) continue;

        results.push(fullPath);
    }

    return results;
}

/**
 * 判断文件是否命中 excludeFiles 规则
 * 支持文件名匹配（如 'transformers.js'）和路径后缀匹配（如 'ports/ISTEngine.js'）
 */
function isExcludedFile(relativePath: string, excludeFiles: string[]): boolean {
    for (const pattern of excludeFiles) {
        if (relativePath === pattern) return true;
        if (relativePath.endsWith('/' + pattern)) return true;
    }
    return false;
}
