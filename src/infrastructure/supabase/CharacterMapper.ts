// 定义数据库行类型
export interface RoleDataRow {
    id: number;
    spec: string;
    spec_version: string;
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    
    // 新增字段
    creator: string;
    character_version: string;
    creator_notes: string;

    system_prompt: string;
    post_history_instructions: string;
    
    // JSONB 字段在 Supabase JS 中会自动转为对象/数组
    alternate_greetings: string[]; 
    character_book: any;
    tags: string[];
    
    title: string;
    role_id: string;
    summary: string;
    deeplink: string;
    
    created_at: string;
    updated_at: string;
}

// 适配器函数：Flat DB Row -> Nested V2 JSON
export function mapDbRowToCharacterV2(row: RoleDataRow) {
    return {
        spec: row.spec || 'chara_card_v2',
        spec_version: row.spec_version || '2.0',
        data: {
            name: row.name,
            description: row.description || '',
            personality: row.personality || '',
            scenario: row.scenario || '',
            first_mes: row.first_mes || '',
            mes_example: row.mes_example || '',
            
            // 新增字段映射
            creator: row.creator || '',
            character_version: row.character_version || '',
            creator_notes: row.creator_notes || '',

            system_prompt: row.system_prompt || '',
            post_history_instructions: row.post_history_instructions || '',
            alternate_greetings: row.alternate_greetings || [],
            character_book: row.character_book || null,
            tags: row.tags || [],
            
            // 将扩展字段重新组装回 extensions 对象
            extensions: {
                title: row.title || '',
                role_id: row.role_id,
                summary: row.summary || '',
                deeplink: row.deeplink || ''
            }
        }
    };
}
