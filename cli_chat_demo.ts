import * as readline from 'readline';
import { SimpleChat } from './src/features/chat/usecases/SimpleChat.js';

// Initialize the Chat Usecase
const chatService = new SimpleChat();
const USER_ID = 'cli_tester_001';

// Setup Readline interface for CLI input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function main() {
    console.log('=============================================');
    console.log('       SillyTavern Matrix - CLI Demo         ');
    console.log('=============================================');
    console.log('Initializing virtual environment...\n');

    // Manually trigger session creation to get the first message (intro)
    // In a real app, this might be implicit or explicit via a 'start' command
    // We hack this by accessing the private session creation logic logic via a public wrapper if we had one, 
    // or just sending an empty or "Hello" message to kickstart it.
    
    // For this demo, let's just send a "System Init" signal or just start chatting.
    // However, to show the first message properly without user input, we'd need to peek into the session.
    
    console.log('Type your message and press Enter. (Type "exit" to quit)');
    
    const askQuestion = () => {
        rl.question('\n> You: ', async (userInput) => {
            if (userInput.toLowerCase() === 'exit') {
                console.log('Goodbye!');
                rl.close();
                process.exit(0);
            }

            try {
                // Determine if this is the first interaction
                const isFirstRun = !chatService.getHistory(USER_ID).length;
                
                if (isFirstRun) {
                     console.log('(First run: Initializing engine and loading character...)');
                }

                const reply = await chatService.chat(USER_ID, userInput);
                
                // Print Bot Reply
                console.log(`\n> Seraphina: ${reply}`);
                
                // Debug: Show internal stats
                // const history = chatService.getHistory(USER_ID);
                // console.log(`\n[Debug] History Length: ${history.length} messages`);

            } catch (error) {
                console.error('\n[Error]', error);
            }

            // Loop
            askQuestion();
        });
    };

    askQuestion();
}

main().catch(console.error);

