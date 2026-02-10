// @ts-ignore
import CoreFactory from './CoreFactory.cjs';
// @ts-ignore
import { createVirtualContext } from './VirtualContext.js';
import { ISTEngine, STContextData, ISTNetworkHandler } from '../../core/ports/ISTEngine.js';
import { logger, internalLogger } from '../../platform/logger.js';

const COMPONENT = 'STEngine';

// Map DOM IDs to Config Keys
export const DOM_ID_MAP: Record<string, string> = {
    '#main_api': 'main_api',
    '#api_key_openai': 'api_key_openai',
    '#api_url_openai': 'api_url_openai',
    '#model_openai_select': 'openai_model',
    '#send_textarea': 'send_textarea',
    // 关键 Prompt 设置映射
    '#preset_settings_openai': 'preset_settings_openai',
    '#context_template': 'context_template',
    '#system_prompt': 'system_prompt',
    '#jailbreak_prompt': 'jailbreak_prompt',
    // 更多可能需要的映射
    '#temp_openai': 'openai_temperature',
    '#max_context_openai': 'openai_max_context',
    '#max_tokens_openai': 'openai_max_tokens',
};

export interface UserConfig {
    [key: string]: any;
}

/**
 * Adapter for the SillyTavern Core Engine
 * Implements the ISTEngine interface
 */
export class STEngineAdapter implements ISTEngine {
    private userConfig: UserConfig;
    private networkHandler: ISTNetworkHandler;
    private instance: any = null;
    private connectAttemptInProgress = false;
    private hasConnected = false;
    private lastSyncedMainApi: string | null = null;

    constructor(userConfig: UserConfig, networkHandler: ISTNetworkHandler) {
        this.userConfig = userConfig; // Reference to Layer 2 Config
        this.networkHandler = networkHandler; // Injected Network Handler
    }

    /**
     * Update engine configuration at runtime
     */
    async setConfiguration(config: Record<string, any>): Promise<void> {
        Object.keys(config).forEach(key => {
            this.userConfig[key] = config[key];
            if (this.instance && this.instance.window) {
                this.instance.window[key] = config[key];
            }
        });
        
        // If main_api changed, sync it
        if (config.main_api) {
            this._syncMainApi();
        }

        // [Fix] Sync config to Network Handler (FetchInterceptor)
        // PipelineChannel sends config here, but FetchInterceptor holds a stale copy in its closure.
        // We need to explicitly update it.
        if (this.networkHandler.setConfig) {
            this.networkHandler.setConfig(config);
        }
    }

    /**
     * Initialize the CoreFactory with a Virtual Context
     */
    async initialize(): Promise<void> {
        logger.info({ kind: 'sys', component: COMPONENT, message: 'Initializing Virtual Context' });
        
        const context = createVirtualContext({
            configProvider: (selector: string) => this._resolveConfigValue(selector),
            configUpdater: (selector: string, value: any) => this._updateConfigValue(selector, value),
            fetchImplementation: this.networkHandler
        });

        // Initialize Core
        this.instance = CoreFactory(context);
        
        // [INTERCEPTION] Hijack Window Console to redirect ST internal logs
        // This prevents console spam while preserving logs in a separate file for debugging
        if (this.instance.window) {
            const win = this.instance.window;
            win.console = {
                ...win.console, // Keep original methods like time/timeEnd if needed, but override main ones
                log: (...args: any[]) => internalLogger.info(args.map(String).join(' ')),
                debug: (...args: any[]) => internalLogger.debug(args.map(String).join(' ')),
                info: (...args: any[]) => internalLogger.info(args.map(String).join(' ')),
                warn: (...args: any[]) => internalLogger.warn(args.map(String).join(' ')),
                error: (...args: any[]) => internalLogger.error(args.map(String).join(' ')),
                trace: (...args: any[]) => internalLogger.debug(args.map(String).join(' ')),
            };
        }
        
        // Post-Init Fixes
        this._applyPatches();

        // Inject initial config into window globals immediately
        // ST often reads these globals directly instead of querying the DOM
        Object.keys(this.userConfig).forEach(key => {
            this.instance.window[key] = this.userConfig[key];
        });

        // Ensure main_api is synced into ST's internal state
        this._syncMainApi();

        // Initial state sync
        // Note: ST might call /api/characters/all automatically on init.
        if (this.instance.window.setOnlineStatus && !this.instance.window.online_status) {
            this.instance.window.setOnlineStatus('no_connection'); // Start offline if unset
        }

        // Ensure connection attempt happens after ST finishes binding handlers.
        // This prevents a "lost click" before onConnectButtonClick is registered.
        await this._ensureConnected();
        
        logger.info({ kind: 'sys', component: COMPONENT, message: 'Core initialized' });
    }

    private _resolveConfigValue(selector: string): any {
        const key = DOM_ID_MAP[selector];
        if (!key) return '';

        // 1. Try top-level config
        if (this.userConfig[key] !== undefined) {
            return this.userConfig[key];
        }

        // 2. Try nested oai_settings (Common for OpenAI params)
        if (this.userConfig.oai_settings && this.userConfig.oai_settings[key] !== undefined) {
            return this.userConfig.oai_settings[key];
        }

        // 3. Fallback: Check window globals
        // This is important for things like 'main_api' if ST tries to read them from DOM but we want to supply them via config
        if (this.instance && this.instance.window[key] !== undefined) {
             return this.instance.window[key];
        }
        return ''; // Default empty string
    }

    private _updateConfigValue(selector: string, value: any): void {
        const key = DOM_ID_MAP[selector];
        if (key) {
            this.userConfig[key] = value;
            // Also update the window global if it exists, as ST often mirrors DOM to globals
            if (this.instance && this.instance.window) {
                this.instance.window[key] = value;
            }
        }
    }

    private _applyPatches(): void {
        const win = this.instance.window;
        
        // 1. Stub UI Functions (The Lobotomy)
        // Prevent ST from trying to render UI or manage tags
        const noOp = () => {};
        const functionsToKill = [
            'printTagFilters',
            'printCharacters',
            'printCharactersDebounced',
            'saveSettings',
            'saveSettingsDebounced', 
            'renderChat',
            'scrollChatToBottom',
            'showToast',
            'hideToast',
            'toastr', // Kill the toastr object itself if possible, or its methods
        ];

        functionsToKill.forEach(funcName => {
            if (typeof win[funcName] === 'function') {
                win[funcName] = noOp;
            }
        });

        // Kill toastr methods specifically
        if (win.toastr) {
            win.toastr.info = noOp;
            win.toastr.success = noOp;
            win.toastr.warning = noOp;
            win.toastr.error = noOp;
            win.toastr.clear = noOp;
        }

        // 2. Runtime State Fixes
        win.is_send_press = false;
        
        // Ensure character list exists
        if (!win.characters) win.characters = [];

        // Mock the global converter if it's missing (needed for messageFormatting)
        // Note: The variable 'converter' is used in ST via with(window), so setting it on win should work.
        // However, if ST defined 'let converter;' in script.js scope (which bundler merged), we can't easily overwrite it if it's not exported.
        // But messageFormatting usually uses the global one.
        if (!win.converter) {
            win.converter = { makeHtml: (s: any) => s };
        }
        
        // Also inject it into the context directly if CoreFactory exposes a setter or if we can hack it
        // Since we can't easily access the closure scope, we rely on window property access.
        // If messageFormatting uses a local variable 'converter' that is initialized from window.converter, we might need to trigger that init.
        if (win.reloadMarkdownProcessor) {
             win.reloadMarkdownProcessor();
        }
    }

    private _syncMainApi(): void {
        if (!this.instance || !this.instance.window) return;
        const win = this.instance.window;
        const mainApi = this.userConfig.main_api;
        if (!mainApi) return;

        // Update DOM-mapped value
        if (win.$ && typeof win.$ === 'function') {
            try {
                win.$('#main_api').val(mainApi);
            } catch {
                // ignore
            }
        }

        // Update global and internal state
        const shouldChangeApi = this.lastSyncedMainApi !== mainApi || win.main_api !== mainApi;
        win.main_api = mainApi;
        if (shouldChangeApi && typeof win.changeMainAPI === 'function') {
            win.changeMainAPI();
        }
        this.lastSyncedMainApi = mainApi;
        // Defer connection attempts to a guarded async flow.
        this._ensureConnected().catch(() => {
            // Best-effort: connection retries are handled inside _ensureConnected.
        });
    }

    private async _ensureConnected(): Promise<void> {
        if (this.connectAttemptInProgress) return;
        if (!this.instance || !this.instance.window) return;

        const win = this.instance.window;
        if (this.userConfig.main_api !== 'openai') return;

        const currentStatus = win.online_status;
        if (currentStatus && currentStatus !== 'no_connection') {
            this.hasConnected = true;
            return;
        }

        this.connectAttemptInProgress = true;
        try {
            const maxAttempts = 12;
            const delayMs = 250;

            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                const status = win.online_status;
                if (status && status !== 'no_connection') {
                    this.hasConnected = true;
                    return;
                }

                if (win.$ && typeof win.$ === 'function') {
                    try {
                        win.$('#api_button_openai').trigger('click');
                    } catch {
                        // ignore
                    }
                }

                await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            // Fallback: avoid permanent "no_connection" gate if handlers never bind.
            if (!this.hasConnected && win.setOnlineStatus) {
                logger.warn({ kind: 'sys', component: COMPONENT, message: 'Forcing online status after retries' });
                win.setOnlineStatus('Connected');
                win.online_status = 'Connected';
            }
        } finally {
            this.connectAttemptInProgress = false;
        }
    }

    private _ensureOnlineStatus(): void {
        if (!this.instance || !this.instance.window) return;
        const win = this.instance.window;
        if (this.userConfig.main_api !== 'openai') return;

        if (win.setOnlineStatus) {
            if (!win.online_status || win.online_status === 'no_connection') {
                win.setOnlineStatus('Connected');
                win.online_status = 'Connected';
            }
        } else if (!win.online_status || win.online_status === 'no_connection') {
            win.online_status = 'Connected';
        }
    }

    /**
     * Load Context (Character and History)
     * @param contextData Data to inject
     */
    async loadContext(contextData: STContextData): Promise<void> {
        // Direct Memory Injection (No API calls, no UI refresh)
        if (!this.instance) throw new Error('STEngine not initialized');
        const win = this.instance.window;

        // 1. Inject Character
        if (contextData.characters && contextData.characters.length > 0) {
            // Normalize character data (Handle V2 Spec -> Runtime Memory Format)
            const activeChar = contextData.characters[0];
            
            // [TRANSFORMATION] SillyTavern Runtime expects V2 fields (system_prompt, etc.) to be inside a 'data' property.
            // However, exported JSONs usually have them at the top level.
            // We create a hybrid object that satisfies both V1 (top-level) and V2 (data-nested) access patterns.
            if (!activeChar.data) {
                activeChar.data = {
                    name: activeChar.name,
                    description: activeChar.description,
                    personality: activeChar.personality,
                    scenario: activeChar.scenario,
                    first_mes: activeChar.first_mes,
                    mes_example: activeChar.mes_example,
                    creator_notes: activeChar.creator_notes,
                    system_prompt: activeChar.system_prompt,
                    post_history_instructions: activeChar.post_history_instructions,
                    tags: activeChar.tags,
                    creator: activeChar.creator,
                    character_version: activeChar.character_version,
                    alternate_greetings: activeChar.alternate_greetings,
                    extensions: activeChar.extensions || {}
                };
            }

            // Ensure essential V2 fields are present for ST
            // ST uses 'description', 'first_mes', 'mes_example', 'scenario', 'personality'
            // We might need to ensure they are accessible on the object.
            
            // MUTATION STRATEGY: Update the existing array instead of replacing it
            // This preserves the reference held by the local 'characters' variable inside the closure
            if (win.characters && Array.isArray(win.characters)) {
                win.characters.length = 0;
                win.characters.push(activeChar);
            } else {
                win.characters = [activeChar];
            }
            
            win.this_chid = 0;
            
            // [FIX] Set global name1/name2 variables
            // ST relies on these globals to replace {{user}} and {{char}} in mes_example
            // Without them, the regex replacement fails and examples might be dropped or malformed
            win.name1 = 'User'; 
            win.name2 = activeChar.name;

            // Call internal setter if available to sync state, otherwise direct set
            if (typeof win.setCharacterId === 'function') {
                win.setCharacterId(win.this_chid);
            }
            
            logger.debug({ 
                kind: 'sys', 
                component: COMPONENT, 
                message: 'Character injected', 
                meta: { 
                    name: activeChar.name,
                    hasSystemPrompt: !!win.characters[0]?.data?.system_prompt,
                    hasDescription: !!win.characters[0]?.description
                } 
            });
        }

        // 2. Inject Chat History
        if (contextData.chat) {
            // Convert standard OpenAI format (Layer 2) to ST internal format (Layer 3)
            // if the input appears to be OpenAI format (has 'role' but not 'is_user')
            const stHistory = contextData.chat.map((msg: any) => {
                if (msg.role && typeof msg.is_user === 'undefined') {
                    return this._convertToSTMessage(msg, win.characters[0]?.name || 'Assistant');
                }
                return msg;
            });

            // [FIX] Inject First Message into Virtual Chat History
            // Since SessionManager keeps Redis clean (no first_mes), we must inject it here at runtime.
            // This ensures the prompt includes the character's opening line.
            if (win.characters[0] && win.characters[0].data && win.characters[0].data.first_mes) {
                 const firstMes = win.characters[0].data.first_mes;
                 // Avoid duplication if it's already there
                 const firstMsgContent = stHistory.length > 0 && typeof stHistory[0].mes === 'string' ? stHistory[0].mes : '';
                 
                 // If history is empty OR first message doesn't match (meaning it's a user message or something else)
                 if (stHistory.length === 0 || firstMsgContent !== firstMes) {
                     logger.debug({ kind: 'sys', component: COMPONENT, message: 'Injecting first_mes into virtual history' });
                     stHistory.unshift({
                        name: win.characters[0].name,
                        is_user: false,
                        is_name: true,
                        send_date: this._getHumanizedTime(),
                        mes: firstMes,
                        force_avatar: ''
                     });
                 }
            }
            
            logger.debug({ 
                kind: 'sys', 
                component: COMPONENT, 
                message: 'Loading context chat', 
                meta: {
                    inputLength: contextData.chat.length,
                    stLength: stHistory.length,
                    tail: this._summarizeChat(stHistory)
                }
            });

            // Replace the chat array reference or content
            if (win.chat && Array.isArray(win.chat)) {
                win.chat.length = 0;
                stHistory.forEach((msg: any) => win.chat.push(msg));
            } else {
                win.chat = stHistory;
            }
            
            // Ensure 'chat_metadata' exists if ST needs it
            if (!win.chat_metadata) win.chat_metadata = {};
            
            // [REMOVED] Workaround removed. Prompt Manager now handles System Prompt via configuration.
            /* 
            // [WORKAROUND] Inject System Prompt into Chat History
            // Since PromptManager logic is failing to build the system prompt from settings in the virtual environment,
            // we inject it directly into the chat history as a system message. 
            // The 'Empty OpenAI messages' fallback in openai.js will pick this up.
            if (win.characters[0]) {
                const char = win.characters[0];
                const systemPrompt = char.data?.system_prompt || char.description || `You are ${char.name}.`;
                
                // Check if system prompt is already at start
                if (win.chat.length === 0 || !win.chat[0].is_system) {
                    logger.debug({ kind: 'sys', component: COMPONENT, message: 'Injecting system prompt workaround' });
                    win.chat.unshift({
                        name: 'System',
                        is_user: false,
                        is_system: true,
                        send_date: this._getHumanizedTime(),
                        mes: systemPrompt,
                        force_avatar: ''
                    });
                }
            }
            */
            
            logger.debug({ 
                kind: 'sys', 
                component: COMPONENT, 
                message: 'Context loaded', 
                meta: { messageCount: win.chat.length } 
            });
        }

        // 3. Set Online Status (Fake it)
        if (win.setOnlineStatus) {
            win.setOnlineStatus('Connected');
        }
        win.online_status = 'Connected';
    }

    /**
     * Helper: Convert OpenAI format to SillyTavern format
     */
    private _convertToSTMessage(openAIMsg: any, charName: string): any {
        const isUser = openAIMsg.role === 'user';
        return {
            name: isUser ? 'User' : charName,
            is_user: isUser,
            is_name: true,
            send_date: this._getHumanizedTime(), // ST needs a display string
            mes: openAIMsg.content,
            force_avatar: '',
            // extra metadata if needed
        };
    }

    private _getHumanizedTime(): string {
        return new Date().toLocaleString('en-US', { 
            hour: 'numeric', minute: 'numeric', hour12: true, 
            month: 'long', day: 'numeric', year: 'numeric' 
        });
    }

    private _summarizeChat(chat: any[], limit = 3) {
        const tail = chat.slice(-limit);
        return tail.map((m: any) => ({
            role: m.role,
            is_user: m.is_user,
            is_system: m.is_system,
            name: m.name,
            mes: typeof m.mes === 'string' ? m.mes.slice(0, 60) : undefined,
            content: typeof m.content === 'string' ? m.content.slice(0, 60) : undefined
        }));
    }

    private _createAsyncQueue<T>() {
        const queue: T[] = [];
        let pendingResolve: ((value: IteratorResult<T>) => void) | null = null;
        let pendingReject: ((reason?: any) => void) | null = null;
        let isClosed = false;

        const push = (item: T) => {
            if (isClosed) return;
            if (pendingResolve) {
                pendingResolve({ value: item, done: false });
                pendingResolve = null;
                pendingReject = null;
            } else {
                queue.push(item);
            }
        };

        const close = () => {
            if (isClosed) return;
            isClosed = true;
            if (pendingResolve) {
                pendingResolve({ value: undefined as T, done: true });
                pendingResolve = null;
                pendingReject = null;
            }
        };

        const error = (err: Error) => {
            if (isClosed) return;
            isClosed = true;
            if (pendingReject) {
                pendingReject(err);
                pendingResolve = null;
                pendingReject = null;
            }
        };

        const iterator = {
            [Symbol.asyncIterator](): AsyncIterator<T> {
                return {
                    next: (): Promise<IteratorResult<T>> => {
                        if (queue.length > 0) {
                            const value = queue.shift() as T;
                            return Promise.resolve({ value, done: false });
                        }
                        if (isClosed) {
                            return Promise.resolve({ value: undefined as T, done: true });
                        }
                        return new Promise<IteratorResult<T>>((resolve, reject) => {
                            pendingResolve = resolve;
                            pendingReject = reject;
                        });
                    }
                };
            }
        };

        return { iterator, push, close, error };
    }

    /**
     * Triggers the generation process
     * @param prompt - The user's input text
     * @param trace - Optional trace object
     * @returns The last message generated (ST Message Object)
     */
    async generate(prompt: string, trace?: any): Promise<any> {
        return this._runGeneration(prompt, trace);
    }

    generateStream(prompt: string, trace?: any): AsyncIterable<string> {
        if (!this.networkHandler.setStreamMode || !this.networkHandler.setStreamSink) {
            throw new Error('Network handler does not support streaming.');
        }

        // [Trace] Pass trace context to network handler
        if (trace && this.networkHandler.setTraceContext) {
            this.networkHandler.setTraceContext(trace);
        }

        const streamQueue = this._createAsyncQueue<string>();
        this.networkHandler.setStreamMode(true);
        this.networkHandler.setStreamSink({
            onDelta: (text: string) => streamQueue.push(text),
            onComplete: () => streamQueue.close(),
            onError: (error: Error) => streamQueue.error(error),
        });

        const generationPromise = this._runGeneration(prompt, trace).catch((error) => {
            streamQueue.error(error instanceof Error ? error : new Error(String(error)));
            throw error;
        });

        const cleanup = async () => {
            this.networkHandler.setStreamMode?.(false);
            this.networkHandler.setStreamSink?.(null);
            try {
                await generationPromise;
            } catch {
                // generation errors are surfaced via stream iterator
            }
        };

        const iterator = {
            [Symbol.asyncIterator]: () => streamQueue.iterator[Symbol.asyncIterator]()
        };

        const wrappedIterator = async function* () {
            try {
                for await (const delta of iterator as AsyncIterable<string>) {
                    yield delta;
                }
            } finally {
                await cleanup();
            }
        };

        return wrappedIterator();
    }

    private async _runGeneration(prompt: string, trace?: any): Promise<any> {
        if (!this.instance) throw new Error('STEngine not initialized');
        
        // [Trace] Ensure trace context is set (redundant for stream but necessary for regular generate)
        if (trace && this.networkHandler.setTraceContext) {
            this.networkHandler.setTraceContext(trace);
        }

        // 1. Set Input
        this.userConfig.send_textarea = prompt;
        // Also sync to window global for ST to pick it up
        if (this.instance && this.instance.window) {
            this.instance.window.send_textarea = prompt;
            // ST often uses jQuery val() to get input, which our VirtualContext routes to configProvider
            // But just in case it reads the global directly or via some other mechanism:
             // Ensure the 'main_api' is set correctly before generation
            if (this.userConfig.main_api) {
                this.instance.window.main_api = this.userConfig.main_api;
            }
        }

        // Ensure main_api is synced before generation
        this._syncMainApi();

        // Ensure the internal online_status is not blocking Generate.
        this._ensureOnlineStatus();
        
        // 2. Call Generate
        logger.debug({ kind: 'sys', component: COMPONENT, message: 'Calling Generate' });
        const win = this.instance.window;
        
        // [DEBUG] Check Character Selection State before generation
        logger.debug({ 
            kind: 'sys', 
            component: COMPONENT, 
            message: 'Pre-Generate state check', 
            meta: {
                this_chid: win.this_chid,
                hasCharacter: !!win.characters?.[0],
                oai_settings_keys: Object.keys(win.oai_settings || {}).join(', '),
                prompts_length: win.oai_settings?.prompts?.length
            }
        });
        
        // Ensure character is selected if not already (Double Tap)
        if (typeof win.selectCharacterById === 'function' && win.this_chid !== 0) {
             logger.debug({ kind: 'sys', component: COMPONENT, message: 'Force-calling selectCharacterById(0)' });
             await win.selectCharacterById(0);
        }

        // Capture the chat length before generation to detect new messages
        const initialChatLength = win.chat ? win.chat.length : 0;
        logger.debug({ 
            kind: 'sys', 
            component: COMPONENT, 
            message: 'Pre-Generate chat state', 
            meta: { length: initialChatLength, tail: this._summarizeChat(win.chat || []) }
        });

        try {
            await win.Generate('normal');
        } catch (e: any) {
            // ST sometimes throws "Cannot read properties of undefined (reading 'prompt')" at the very end 
            // because generate_data global is cleared or not set correctly in our mock env.
            // But usually the request has already been sent.
            if (e.message && e.message.includes("reading 'prompt'")) {
                logger.warn({ kind: 'sys', component: COMPONENT, message: 'Suppressing expected ST error', meta: { error: e.message } });
            } else {
                // 关键：完整暴露原始错误
                logger.error({ kind: 'sys', component: COMPONENT, message: 'Generate failed', error: e });
                throw e;
            }
        }
        
        // 3. Return the last message
        // In ST, the last message in the chat array is the one just generated (or the one being streamed)
        // Note: For streaming, we might need to wait or hook into the stream.
        // For MVP (non-streaming or pseudo-streaming), we assume Generate() completes when the promise resolves.
        // However, ST's Generate is async but might return before the stream is done if not awaited properly in our mock.
        // Assuming our FetchInterceptor awaits the full response, ST should have updated the chat array.
        
        if (win.chat && win.chat.length > initialChatLength) {
            logger.debug({ 
                kind: 'sys', 
                component: COMPONENT, 
                message: 'Post-Generate chat state', 
                meta: { length: win.chat.length, tail: this._summarizeChat(win.chat) }
            });
            const lastMsg = win.chat[win.chat.length - 1];
            return lastMsg;
        }
        
        return null; 
    }
}
