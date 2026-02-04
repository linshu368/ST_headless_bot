import { PipelineChannel } from './PipelineChannel.js';
import { ISTEngine, STContextData } from '../../../core/ports/ISTEngine.js';
import config from '../../../platform/config.js';
import { logger } from '../../../platform/logger.js';

// --- Mock Implementations ---

class MockEngine implements ISTEngine {
    constructor(
        private behaviors: Array<{
            ttftDelay?: number;
            chunks?: string[];
            chunkDelays?: number[]; // delay AFTER each chunk
        }>
    ) {}

    private callCount = 0;

    async initialize(): Promise<void> {}
    async loadContext(contextData: STContextData): Promise<void> {}
    async setConfiguration(config: Record<string, any>): Promise<void> {}
    async generate(prompt: string): Promise<any> { return {}; }

    async *generateStream(prompt: string): AsyncIterable<string> {
        const behavior = this.behaviors[this.callCount % this.behaviors.length];
        this.callCount++;

        console.log(`[MockEngine] Call #${this.callCount}: TTFT Delay=${behavior.ttftDelay || 0}ms`);

        // Simulate TTFT
        if (behavior.ttftDelay) {
            await new Promise(resolve => setTimeout(resolve, behavior.ttftDelay));
        }

        const chunks = behavior.chunks || ['A', 'B', 'C'];
        const delays = behavior.chunkDelays || [];

        for (let i = 0; i < chunks.length; i++) {
            yield chunks[i];
            
            // Simulate Inter-chunk delay
            const delay = delays[i] || 0;
            if (delay > 0) {
                // console.log(`[MockEngine] Waiting ${delay}ms after chunk ${chunks[i]}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}

// Helper to run a test case
async function runTestCase(name: string, fn: () => Promise<void>) {
    console.log(`\n=== TEST CASE: ${name} ===`);
    try {
        await fn();
        console.log(`✅ PASSED: ${name}`);
    } catch (e: any) {
        console.error(`❌ FAILED: ${name}`);
        console.error(e);
    }
}

// --- Test Suite ---

async function main() {
    // Override global config for testing
    // Note: We access the writable properties of the imported config object
    config.timeouts.interChunk = 200; // 200ms inter-chunk limit
    config.timeouts.total = 500;      // 500ms total limit

    console.log('--- Configuration ---');
    console.log('Global Inter-Chunk Timeout:', config.timeouts.interChunk, 'ms');
    console.log('Global Total Timeout:', config.timeouts.total, 'ms');
    
    // Silence logger partially
    // logger.info = () => {}; 
    // logger.warn = (obj: any) => console.log(`[Logger Warn] ${obj.message}`, obj.meta || '');
    // logger.error = (obj: any) => console.log(`[Logger Error] ${obj.message}`, obj.meta || '');

    await runTestCase('TTFT Failover (Timeout -> Success)', async () => {
        // Setup: 
        // Step 1: Timeout 100ms. Mock Engine delays 300ms. -> Should Fail
        // Step 2: Timeout 1000ms. Mock Engine delays 50ms. -> Should Success
        
        const steps = [
            { id: 'step1', provider: 'test', url: '', key: '', model: 'fail', timeout: 100 },
            { id: 'step2', provider: 'test', url: '', key: '', model: 'success', timeout: 1000 }
        ];

        const mockEngine = new MockEngine([
            { ttftDelay: 300, chunks: ['Fail'] }, // For Step 1
            { ttftDelay: 50, chunks: ['Success', 'Data'] } // For Step 2
        ]);

        const channel = new PipelineChannel('test-pipeline', steps);
        
        const result: string[] = [];
        const generator = channel.streamGenerate([], { engine: mockEngine, userInput: 'test' });
        
        for await (const chunk of generator) {
            result.push(chunk);
        }

        if (result.join('') !== 'SuccessData') {
            throw new Error(`Expected 'SuccessData', got '${result.join('')}'`);
        }
    });

    await runTestCase('Inter-Chunk Timeout (Truncation)', async () => {
        // Setup:
        // Global Inter-chunk: 200ms
        // Step 1: 3 chunks. Delay after 2nd chunk is 400ms.
        // Expected: Should yield 1st and 2nd chunk, then stop silently.

        const steps = [
            { id: 'step1', provider: 'test', url: '', key: '', model: 'ok', timeout: 1000 }
        ];

        const mockEngine = new MockEngine([
            { 
                ttftDelay: 10, 
                chunks: ['One', 'Two', 'Three'], 
                chunkDelays: [50, 400, 50] // Delay after 'One' is 50ms (OK), after 'Two' is 400ms (Fail)
            }
        ]);

        const channel = new PipelineChannel('test-inter-chunk', steps);
        
        const result: string[] = [];
        const generator = channel.streamGenerate([], { engine: mockEngine, userInput: 'test' });
        
        for await (const chunk of generator) {
            result.push(chunk);
        }

        // It should yield 'One' and 'Two'. 'Three' is never reached because iterator is closed.
        // Actually, depending on implementation:
        // managedStream loop: 
        // 1. yield One
        // 2. wait 50ms
        // 3. yield Two
        // 4. wait 400ms -> TIMEOUT -> return
        if (result.join('') !== 'OneTwo') {
            throw new Error(`Expected 'OneTwo', got '${result.join('')}'`);
        }
    });

    await runTestCase('Total Timeout (Truncation)', async () => {
        // Setup:
        // Global Total: 500ms
        // Step 1: Many chunks with 100ms delay.
        // Expected: Should yield ~5 chunks then stop.

        const steps = [
            { id: 'step1', provider: 'test', url: '', key: '', model: 'ok', timeout: 1000 }
        ];

        const mockEngine = new MockEngine([
            { 
                ttftDelay: 0, 
                chunks: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], 
                chunkDelays: [100, 100, 100, 100, 100, 100, 100] // 100ms each
            }
        ]);

        const channel = new PipelineChannel('test-total', steps);
        
        const startTime = Date.now();
        const result: string[] = [];
        const generator = channel.streamGenerate([], { engine: mockEngine, userInput: 'test' });
        
        for await (const chunk of generator) {
            result.push(chunk);
        }
        const duration = Date.now() - startTime;

        console.log(`Yielded ${result.length} chunks: ${result.join('')}`);
        console.log(`Duration: ${duration}ms`);

        // Expect roughly 5-6 chunks (0, 100, 200, 300, 400, 500). 
        // 5 * 100ms = 500ms.
        if (result.length < 4 || result.length > 7) {
             throw new Error(`Expected around 5-6 chunks, got ${result.length}`);
        }
    });
}

main().catch(console.error);
