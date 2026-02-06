import { SimpleChat } from './SimpleChat.js';
import { SessionManager } from '../../session/usecases/SessionManager.js';
import { IChannelRegistry } from '../ports/IChannelRegistry.js';
import { IAIChannel } from '../ports/IAIChannel.js';
import { logger } from '../../../platform/logger.js';

// Mock Logger to avoid noise
logger.info = () => {};
logger.debug = () => {};
logger.warn = () => {};
logger.error = console.error;

// Mock Channel Registry
class MockChannelRegistry implements IChannelRegistry {
    getChannel(channelId: string): IAIChannel | undefined {
        return {
            streamGenerate: async function* () { yield "test response"; }
        } as any;
    }
}

async function testPromptAssembly() {
    console.log("Starting Prompt Assembly Test...");

    const simpleChat = new SimpleChat(new MockChannelRegistry());
    
    // 1. Mock Character Data
    const character = {
        name: "TestChar",
        system_prompt: "System Prompt",
        first_mes: "First Message"
    };

    // 2. Test Case A: Empty History
    // Expected: System -> First Message
    const historyA: any[] = [];
    // Access private method via casting
    const contextA = (simpleChat as any)._buildFullContext(character, historyA);
    
    console.log("\nTest Case A (Empty History):");
    console.log("Context Length:", contextA.length);
    console.log("Item 0 Role:", contextA[0]?.role); // Should be system
    console.log("Item 1 Role:", contextA[1]?.role); // Should be assistant (first mes)
    
    if (contextA[0]?.content === "System Prompt" && contextA[1]?.content === "First Message") {
        console.log("PASS: System Prompt and First Message present.");
    } else {
        console.error("FAIL: Incorrect context structure.");
        console.log(JSON.stringify(contextA, null, 2));
    }

    // 3. Test Case B: History with user message
    // Expected: System -> First Message -> User Message
    const historyB = [
        { role: 'user', content: 'Hello' }
    ];
    const contextB = (simpleChat as any)._buildFullContext(character, historyB);

    console.log("\nTest Case B (History with User Msg):");
    if (contextB.length === 3 && 
        contextB[1].content === "First Message" && 
        contextB[2].content === "Hello") {
        console.log("PASS: History appended correctly.");
    } else {
        console.error("FAIL: Incorrect context structure.");
        console.log(JSON.stringify(contextB, null, 2));
    }

    // 4. Test Case C: History ALREADY has First Message (Legacy Data)
    // Expected: System -> First Message (Dynamic) -> User Message (History[1])
    // The duplicate First Message in history[0] should be SKIPPED.
    const historyC = [
        { role: 'assistant', content: 'First Message' },
        { role: 'user', content: 'Reply to first' }
    ];
    const contextC = (simpleChat as any)._buildFullContext(character, historyC);

    console.log("\nTest Case C (De-duplication):");
    // Should have: System, First Message, User Reply. Total 3.
    // NOT: System, First Message, First Message, User Reply.
    
    if (contextC.length === 3 && 
        contextC[1].content === "First Message" && 
        contextC[2].content === "Reply to first") {
        console.log("PASS: Duplicate First Message skipped.");
    } else {
        console.error("FAIL: De-duplication failed.");
        console.log(JSON.stringify(contextC, null, 2));
    }

    console.log("\nTest Case D (SessionManager verification):");
    // Verify SessionManager does NOT put first_mes in history on creation
    const sessionManager = new SessionManager();
    // We use a dummy user ID
    try {
        const session = await sessionManager.getOrCreateSession("test_user_unique_" + Date.now());
        console.log("Session History Length:", session.history.length);
        if (session.history.length === 0) {
            console.log("PASS: New session history is empty (no first_mes injected).");
        } else {
            // Note: If existing session was found (unlikely with unique ID but possible if mock persisted), it might have history.
            // But getOrCreateSession logic for new session is what we care about.
            // Check if first message is first_mes
            const firstMsg = session.history[0];
            if (firstMsg && firstMsg.role === 'assistant' && firstMsg.content === session.character.first_mes) {
                 console.error("FAIL: first_mes found in session history!");
            } else {
                 console.log("PASS: Session history does not start with first_mes (or is empty).");
            }
        }
    } catch (e) {
        console.error("Error creating session (might be due to config/files):", e);
    }
}

testPromptAssembly().catch(console.error);
