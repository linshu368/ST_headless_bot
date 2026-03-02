/**
 * Prompt 模板加载器
 * 用于加载和渲染 prompt 模板
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectSrcCode } from './srcCollector.js';
import { runtimeConfig } from '../../src/infrastructure/runtime_config/RuntimeConfigService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prompt 目录路径
const PROMPT_DIR = process.env.PROMPT_DIR || path.join(__dirname, 'prompt');

// 项目根路径
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const RUNTIME_PROMPT_KEYS = {
    commitProcessDiff: 'ops_prompt_commit_process_diff',
    projectArch: 'ops_prompt_project_arch',
    projectPrinciple: 'ops_prompt_project_principle',
} as const;

/**
 * 读取 prompt 模板文件
 */
export function readPromptTemplate(templatePath: string): string {
    const fullPath = path.isAbsolute(templatePath) 
        ? templatePath 
        : path.join(PROMPT_DIR, templatePath);
    
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Prompt 模板文件不存在: ${fullPath}`);
    }
    
    return fs.readFileSync(fullPath, 'utf-8');
}

async function readPromptTemplateFromRuntime(templatePath: string, runtimeKey?: string): Promise<string> {
    const fallback = readPromptTemplate(templatePath);
    if (!runtimeKey) return fallback;
    try {
        if (runtimeKey === RUNTIME_PROMPT_KEYS.commitProcessDiff) {
            return await runtimeConfig.getOpsPromptCommitProcessDiff(fallback);
        }
        return await runtimeConfig.get<string>(runtimeKey, fallback);
    } catch (error: any) {
        console.warn(`[PromptLoader] runtime_config 读取失败: ${runtimeKey}`, error?.message || error);
        return fallback;
    }
}

/**
 * 加载 solid_save 目录下的项目上下文文件
 */
export async function loadProjectContext(): Promise<{ arch: string; principle: string }> {
    const solidSavePath = path.join(PROMPT_DIR, 'solid_save');
    
    const loadFile = (relativePath: string): string => {
        const fullPath = path.join(solidSavePath, relativePath);
        if (!fs.existsSync(fullPath)) {
            console.warn(`[PromptLoader] 文件不存在: ${fullPath}`);
            return '';
        }
        return fs.readFileSync(fullPath, 'utf-8');
    };

    const fallbackArch = loadFile('long/arch.txt');
    const fallbackPrinciple = loadFile('long/principle.txt');

    const [arch, principle] = await Promise.all([
        runtimeConfig.getOpsPromptProjectArch(fallbackArch),
        runtimeConfig.getOpsPromptProjectPrinciple(fallbackPrinciple),
    ]);

    return { arch, principle };
}

/**
 * Prompt 模板集合
 */
export const PromptTemplates = {
    /**
     * Commit 消息生成模板
     */
    get commitProcessDiff(): Promise<string> {
        return readPromptTemplateFromRuntime('commit_process_diff.prompt', RUNTIME_PROMPT_KEYS.commitProcessDiff);
    },

    /**
     * Push 日志目录名生成模板
     */
    get pushLogTitle(): string {
        return readPromptTemplate('push_log_title.prompt');
    },
};

/**
 * 渲染 commit 消息 prompt
 */
export async function renderCommitPrompt(diffContent: string): Promise<string> {
    const context = await loadProjectContext();
    const srcCode = collectSrcCode(PROJECT_ROOT);
    const template = await PromptTemplates.commitProcessDiff;
    
    return template
        .replace('{project_arch}', context.arch)
        .replace('{project_principle}', context.principle)
        .replace('{src_code}', srcCode)
        .replace('{git_push_commit_logs}', diffContent);
}

/**
 * 渲染面向工程的 push 日志 prompt
 */
export async function renderPushLogPrompt(diffContent: string): Promise<string> {
    const context = await loadProjectContext();
    const srcCode = collectSrcCode(PROJECT_ROOT);
    const template = await PromptTemplates.commitProcessDiff;
    
    return template
        .replace('{project_arch}', context.arch)
        .replace('{project_principle}', context.principle)
        .replace('{src_code}', srcCode)
        .replace('{git_push_commit_logs}', diffContent);
}

/**
 * 渲染 push 日志目录名 prompt
 */
export function renderPushLogTitlePrompt(message: string): string {
    const template = PromptTemplates.pushLogTitle;
    return template.replace('{message}', message);
}
