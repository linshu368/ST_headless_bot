/**
 * Prompt 模板加载器
 * 用于加载和渲染 prompt 模板
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prompt 目录路径
const PROMPT_DIR = process.env.PROMPT_DIR || path.join(__dirname, 'prompt');

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

/**
 * 加载 solid_save 目录下的项目上下文文件
 */
export function loadProjectContext() {
    const solidSavePath = path.join(PROMPT_DIR, 'solid_save');
    
    const loadFile = (relativePath: string): string => {
        const fullPath = path.join(solidSavePath, relativePath);
        if (!fs.existsSync(fullPath)) {
            console.warn(`[PromptLoader] 文件不存在: ${fullPath}`);
            return '';
        }
        return fs.readFileSync(fullPath, 'utf-8');
    };

    return {
        // 长期不变的上下文
        arch: loadFile('long/arch.txt'),
        principle: loadFile('long/principle.txt'),
        businessGoal: loadFile('long/project_business_goal.txt'),
        
        // 阶段性上下文
        functionalSpec: loadFile('mid/requirements_functional_spec.txt'),
        currentMission: loadFile('mid/workstream/current_mission.txt'),
    };
}

/**
 * Prompt 模板集合
 */
export const PromptTemplates = {
    /**
     * Commit 消息生成模板
     */
    get commitProcessDiff(): string {
        return readPromptTemplate('commit_process_diff.prompt');
    },

    /**
     * Push 日志目录名生成模板
     */
    get pushLogTitle(): string {
        return readPromptTemplate('push_log_title.prompt');
    },

    /**
     * 面向产品的 Push 总结模板
     */
    get pushLogArch2Pr(): string {
        return readPromptTemplate('push_log_arch2pr.prompt');
    }
};

/**
 * 渲染 commit 消息 prompt
 */
export function renderCommitPrompt(diffContent: string): string {
    const context = loadProjectContext();
    const template = PromptTemplates.commitProcessDiff;
    
    return template
        .replace('{project_arch}', context.arch)
        .replace('{project_principle}', context.principle)
        .replace('{workstream_current_mission}', context.currentMission)
        .replace('{git_push_commit_logs}', diffContent);
}

/**
 * 渲染面向工程的 push 日志 prompt
 */
export function renderPushLogPrompt(diffContent: string): string {
    const context = loadProjectContext();
    const template = PromptTemplates.commitProcessDiff;
    
    return template
        .replace('{project_arch}', context.arch)
        .replace('{project_principle}', context.principle)
        .replace('{workstream_current_mission}', context.currentMission)
        .replace('{git_push_commit_logs}', diffContent);
}

/**
 * 渲染面向产品的 push 日志 prompt
 */
export function renderArch2PrPrompt(diffContent: string): string {
    const context = loadProjectContext();
    const template = PromptTemplates.pushLogArch2Pr;
    
    return template
        .replace('{product_business_goal}', context.businessGoal)
        .replace('{requirements_functional_spec}', context.functionalSpec)
        .replace('{project_architecture}', context.arch)
        .replace('{project_principle}', context.principle)
        .replace('{git_push_commit_logs}', diffContent);
}

/**
 * 渲染 push 日志目录名 prompt
 */
export function renderPushLogTitlePrompt(message: string): string {
    const template = PromptTemplates.pushLogTitle;
    return template.replace('{message}', message);
}
