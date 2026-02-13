#!/usr/bin/env npx ts-node
/**
 * AI 生成 Push 日志
 * 基于 push 的 diff 内容，生成工程视角总结
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';
import { GptCaller } from '../../gpt/gptCaller.js';
import { 
    renderPushLogPrompt, 
    renderPushLogTitlePrompt 
} from '../../gpt/promptLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志目录
const LOGS_DIR = process.env.LOGS_DIR || path.resolve(__dirname, '../logs');

interface PushLog {
    push_id: string;
    remote: string;
    branch: string;
    date: string;
    commits: string[];
    message: string;           // 工程侧总结
    dir_name: string;
}

/**
 * 获取本次 push 的整体 diff
 */
function collectPushDiff(remote: string, branch: string): string {
    const revRange = `${remote}/${branch}..HEAD`;
    try {
        const diff = execSync(`git diff ${revRange}`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        return diff;
    } catch (error) {
        console.error(`获取 diff 失败: ${error}`);
        return '';
    }
}

/**
 * 格式化日期为 YYYYMMDD
 */
function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

/**
 * 格式化日期时间为 YYYYMMDD-HHMMSS
 */
function formatDateTime(date: Date): string {
    const dateStr = formatDate(date);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${dateStr}-${hours}${minutes}${seconds}`;
}

/**
 * 清理非法路径字符
 */
function sanitizeDirName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

async function main() {
    // 解析命令行参数
    const { values } = parseArgs({
        options: {
            remote: { type: 'string' },
            branch: { type: 'string' },
            commits: { type: 'string' }
        }
    });

    const remote = values.remote;
    const branch = values.branch;
    const commitsStr = values.commits || '';

    if (!remote || !branch) {
        console.error('用法: gen_pushlog.ts --remote <remote> --branch <branch> --commits <commits>');
        process.exit(1);
    }

    const commits = commitsStr.split(/\s+/).filter(Boolean);
    if (commits.length === 0) {
        console.log('没有需要推送的 commits');
        process.exit(0);
    }

    const now = new Date();
    const pushId = formatDateTime(now);

    // 收集本次 push 的 diff 内容
    console.error('收集 diff 内容...');
    const diffContent = collectPushDiff(remote, branch);

    if (!diffContent) {
        console.error('警告: diff 内容为空');
    }

    // 创建 GPT 调用器
    const gpt = new GptCaller();

    // 1. 生成工程视角总结
    console.error('正在生成工程视角总结...');
    let message: string;
    try {
        const prompt = renderPushLogPrompt(diffContent);
        message = await gpt.getResponse(prompt);
        console.error('工程视角总结生成成功!');
    } catch (error: any) {
        message = `> AI 生成失败: ${error.message}`;
        console.error(`工程视角总结生成失败: ${error.message}`);
    }

    // 2. 生成目录名
    console.error('正在生成目录名...');
    let dirName: string;
    try {
        const prompt = renderPushLogTitlePrompt(message);
        dirName = sanitizeDirName(await gpt.getResponse(prompt));
        if (!dirName) {
            dirName = '未命名改动';
        }
        console.error(`目录名: ${dirName}`);
    } catch (error: any) {
        dirName = '未命名改动';
        console.error(`目录名生成失败: ${error.message}`);
    }

    // 构建 pushlog 对象
    const pushlog: PushLog = {
        push_id: pushId,
        remote,
        branch,
        date: now.toISOString(),
        commits,
        message,
        dir_name: dirName
    };

    // 写入 pushlog 目录
    const pushDirName = `${dirName}_${formatDate(now)}`;
    const pushDir = path.join(LOGS_DIR, 'pushlogs', pushDirName);
    const commitsDir = path.join(pushDir, 'commits');

    fs.mkdirSync(commitsDir, { recursive: true });

    // 写入 push_log.json
    const pushLogPath = path.join(pushDir, 'push_log.json');
    fs.writeFileSync(pushLogPath, JSON.stringify(pushlog, null, 2), 'utf-8');
    console.error(`Push 日志已保存: ${pushLogPath}`);

    // 迁移 snapshots 目录下的快照
    const snapshotsDir = path.join(LOGS_DIR, 'snapshots');
    if (fs.existsSync(snapshotsDir)) {
        const files = fs.readdirSync(snapshotsDir);
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const src = path.join(snapshotsDir, file);
            const dst = path.join(commitsDir, file);
            try {
                fs.renameSync(src, dst);
                console.error(`迁移快照: ${file}`);
            } catch (error) {
                console.error(`迁移快照失败: ${file}`);
            }
        }
    }

    console.error('Push 日志生成完成!');
}

main().catch(error => {
    console.error('执行失败:', error);
    process.exit(1);
});
