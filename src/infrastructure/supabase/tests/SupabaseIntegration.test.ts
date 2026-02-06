import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabase } from '../SupabaseClient.js';
import { mapDbRowToCharacterV2, type RoleDataRow } from '../CharacterMapper.js';
import config from '../../../platform/config.js';

// 模拟数据：与数据库各字段完全对应的测试数据
const MOCK_ROLE_ROW: RoleDataRow = {
    id: 9999,
    role_id: 'test_role_001',
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Test Character',
    description: 'A test character description',
    personality: 'Friendly and helpful',
    scenario: 'Test scenario',
    first_mes: 'Hello world',
    mes_example: 'User: Hi\nChar: Hello',
    creator: 'Test Creator',
    character_version: '1.0.0',
    creator_notes: 'Notes for testing',
    system_prompt: 'You are a test bot',
    post_history_instructions: 'Always be nice',
    alternate_greetings: ['Hi there', 'Greetings'],
    character_book: { entries: [] },
    tags: ['test', 'bot'],
    title: 'Test Bot Title',
    summary: 'A summary of the test bot',
    deeplink: 'https://t.me/test_bot',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
};

describe('Supabase Integration & Mapping Tests', () => {

    // 1. 测试 Supabase 连接与配置
    describe('1. Configuration & Connection', () => {
        it('should load Supabase credentials from config', () => {
            expect(config.supabase.url).toBeDefined();
            expect(config.supabase.url).not.toBe('');
            expect(config.supabase.key).toBeDefined();
            expect(config.supabase.key).not.toBe('');
        });

        it('should initialize Supabase client', () => {
            expect(supabase).toBeDefined();
            expect(supabase).not.toBeNull();
        });
    });

    // 2. 测试数据适配层 (Mapper)
    describe('2. Data Mapper (Flat -> Nested V2)', () => {
        it('should correctly map a flat DB row to V2 nested structure', () => {
            const v2Card = mapDbRowToCharacterV2(MOCK_ROLE_ROW);

            // 验证顶层结构
            expect(v2Card.spec).toBe('chara_card_v2');
            expect(v2Card.spec_version).toBe('2.0');

            // 验证 data 层核心字段
            expect(v2Card.data.name).toBe(MOCK_ROLE_ROW.name);
            expect(v2Card.data.description).toBe(MOCK_ROLE_ROW.description);
            expect(v2Card.data.personality).toBe(MOCK_ROLE_ROW.personality);
            
            // 验证新增字段
            expect(v2Card.data.creator).toBe(MOCK_ROLE_ROW.creator);
            expect(v2Card.data.character_version).toBe(MOCK_ROLE_ROW.character_version);
            expect(v2Card.data.creator_notes).toBe(MOCK_ROLE_ROW.creator_notes);

            // 验证 JSONB 字段
            expect(v2Card.data.tags).toEqual(MOCK_ROLE_ROW.tags);
            expect(v2Card.data.alternate_greetings).toEqual(MOCK_ROLE_ROW.alternate_greetings);

            // 验证 Extensions 重新组装
            expect(v2Card.data.extensions).toBeDefined();
            expect(v2Card.data.extensions.role_id).toBe(MOCK_ROLE_ROW.role_id);
            expect(v2Card.data.extensions.title).toBe(MOCK_ROLE_ROW.title);
            expect(v2Card.data.extensions.deeplink).toBe(MOCK_ROLE_ROW.deeplink);
        });

        it('should handle missing optional fields gracefully', () => {
            const partialRow = { ...MOCK_ROLE_ROW, creator: null, tags: null } as any;
            const v2Card = mapDbRowToCharacterV2(partialRow);

            expect(v2Card.data.creator).toBe(''); // Should default to empty string
            expect(v2Card.data.tags).toEqual([]); // Should default to empty array
        });
    });

    // 3. 测试 Supabase CRUD 操作 (集成测试)
    // 注意：这将真实连接到数据库进行操作，建议使用测试用的 Table 或确保数据可清理
    describe('3. Supabase CRUD Operations', () => {
        const TEST_ROLE_ID = `test_crud_${Date.now()}`;
        let createdId: number;

        it('should INSERT a new record', async () => {
            if (!supabase) throw new Error('Supabase client not initialized');

            const { data, error } = await supabase
                .from('role-data')
                .insert({
                    ...MOCK_ROLE_ROW,
                    role_id: TEST_ROLE_ID, // Use unique ID
                    id: undefined // Let DB generate ID
                })
                .select()
                .single();

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data.role_id).toBe(TEST_ROLE_ID);
            
            createdId = data.id;
        });

        it('should SELECT the record by role_id', async () => {
            if (!supabase) throw new Error('Supabase client not initialized');

            const { data, error } = await supabase
                .from('role-data')
                .select('*')
                .eq('role_id', TEST_ROLE_ID)
                .single();

            expect(error).toBeNull();
            expect(data).toBeDefined();
            expect(data.name).toBe(MOCK_ROLE_ROW.name);
        });

        it('should UPDATE the record', async () => {
            if (!supabase) throw new Error('Supabase client not initialized');

            const newName = 'Updated Name';
            const { error } = await supabase
                .from('role-data')
                .update({ name: newName })
                .eq('role_id', TEST_ROLE_ID);

            expect(error).toBeNull();

            // Verify update
            const { data } = await supabase
                .from('role-data')
                .select('name')
                .eq('role_id', TEST_ROLE_ID)
                .single();
            
            expect(data?.name).toBe(newName);
        });

        it('should DELETE the record', async () => {
            if (!supabase) throw new Error('Supabase client not initialized');

            const { error } = await supabase
                .from('role-data')
                .delete()
                .eq('role_id', TEST_ROLE_ID);

            expect(error).toBeNull();

            // Verify deletion
            const { data } = await supabase
                .from('role-data')
                .select('*')
                .eq('role_id', TEST_ROLE_ID)
                .single();
            
            expect(data).toBeNull();
        });
    });
});
