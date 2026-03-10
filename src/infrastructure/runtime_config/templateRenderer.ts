/**
 * 轻量模板渲染器
 *
 * 语法：
 *   {{key}}                 — 变量替换（缺失则替换为空串）
 *   {{#if key}}...{{/if}}   — 条件块（key 非空时保留内容，否则整段移除）
 *
 * 设计原则：零依赖、~15 行核心逻辑、运营可直接在 Supabase 编辑模板
 */

export function renderTemplate(
    template: string,
    vars: Record<string, string>,
): string {
    // 1. 条件块：{{#if key}}content{{/if}}
    let result = template.replace(
        /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, key: string, content: string) => (vars[key] ? content : ''),
    );

    // 2. 变量占位符：{{key}}
    result = result.replace(
        /\{\{(\w+)\}\}/g,
        (_, key: string) => vars[key] ?? '',
    );

    return result;
}
