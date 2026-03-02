#!/usr/bin/env npx ts-node
/**
 * AI 生成 Commit 消息
 * 基于 git diff 内容，调用 GPT 生成规范的提交信息
 */

import fs from 'fs';
import { execSync } from 'child_process';
import { parseArgs } from 'util';
import { GptCaller } from '../../gpt/gptCaller.js';
import { renderCommitPrompt } from '../../gpt/promptLoader.js';

interface CommitLog {
    commit_id: string | null;
    author: string;
    date: string;
    message: string;
}

async function main() {
    // 解析命令行参数
    const { values } = parseArgs({
        options: {
            diff: { type: 'string' },
            'commit-id': { type: 'string' }
        }
    });

    const diffFile = values.diff;
    const commitId = values['commit-id'] || null;

    if (!diffFile) {
        console.error('用法: gen_commit_msg.ts --diff <diff文件路径>');
        process.exit(1);
    }

    // 读取 diff 文件内容
    if (!fs.existsSync(diffFile)) {
        console.error(`Diff 文件不存在: ${diffFile}`);
        process.exit(1);
    }

    const diffContent = fs.readFileSync(diffFile, 'utf-8');

    // 构建 prompt
    const prompt = await renderCommitPrompt(diffContent);

    // 调用 GPT
    const gpt = new GptCaller();
    let message: string;

    try {
        console.error('正在调用 AI 生成 commit 消息...');
        message = await gpt.getResponse(prompt);
        console.error('AI 生成成功!');
    } catch (error: any) {
        message = `> AI 生成失败: ${error.message}`;
        console.error(`AI 调用失败: ${error.message}`);
    }

    // 获取 Git 用户信息
    const userName = execSync('git config user.name').toString().trim();
    const userEmail = execSync('git config user.email').toString().trim();

    // 构建输出对象
    const commitLog: CommitLog = {
        commit_id: commitId,
        author: `${userName} <${userEmail}>`,
        date: new Date().toISOString(),
        message: message
    };

    // 输出 JSON 给调用方，确保 stdout 刷新完毕后再退出。
    // 当 stdout 是 pipe（shell 命令替换）时 write 是异步的，
    // 直接 process.exit() 会截断输出导致 jq 解析失败。
    process.stdout.write(JSON.stringify(commitLog, null, 2) + '\n', () => {
        process.exit(0);
    });
}

main().catch(error => {
    console.error('执行失败:', error);
    process.exit(1);
});
