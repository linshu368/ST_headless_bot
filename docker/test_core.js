
import CoreFactory from './CoreFactory.cjs';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch'; // 引入真实的 fetch
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// 1. Mock Dependencies

// Layer 2: User Configuration (The Source of Truth)
const defaultUserConfig = {
    // Core Settings
    main_api: 'openai', // 'openai', 'kobold', 'novel', etc.
    
    // OpenAI / Compatible Settings (Used for DeepSeek, Grok, etc.)
    api_key_openai: 'sk-mztgmqtkmhfgbdgkgbejivwswyspwzjzuadgaracjwmzkegr',
    api_url_openai: 'https://api.siliconflow.cn/v1',
    openai_model: 'deepseek-ai/DeepSeek-V2.5', // Modified to a known working model
    temp_openai: 0.7,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    context_length_openai: 4096,
    max_length_openai: 300,
    
    // TextGenWebUI Settings
    api_key_textgenerationwebui: '',
    api_url_textgenerationwebui: 'http://127.0.0.1:5000',
    
    // Global Settings
    model_openai_select: 'deepseek-ai/DeepSeek-V2.5', // Redundant mapping sometimes needed
    send_textarea: '', // User input buffer
    
    // NovelAI
    api_key_novel: '',
    
    // Internal State
    character_name: 'Seraphina',
    your_name: 'User',
};

// Layer 2: DOM ID Mapping Table
const domIdMap = {
    // API Connections
    '#main_api': 'main_api',
    '#api_key_openai': 'api_key_openai',
    '#api_url_openai': 'api_url_openai',
    '#api_key_textgenerationwebui': 'api_key_textgenerationwebui',
    '#api_url_textgenerationwebui': 'api_url_textgenerationwebui',
    
    // Model Params
    '#model_openai_select': 'openai_model',
    '#temp_openai': 'temp_openai',
    '#freq_pen_openai': 'freq_pen_openai',
    '#pres_pen_openai': 'pres_pen_openai',
    
    // Inputs
    '#send_textarea': 'send_textarea',
};

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.style = {};
        this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} };
        this.attributes = {};
        this.dataset = {}; // Added dataset
        this.value = '';
        this.innerHTML = '';
        this.textContent = '';
        this.children = [];
    }
    getAttribute(name) { return this.attributes[name] || null; }
    setAttribute(name, val) { this.attributes[name] = val; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { this.children.push(child); }
    append(child) { this.children.push(child); }
    insertAdjacentHTML(position, text) { 
        // Mock implementation: just append for now, as we don't parse HTML string to DOM nodes here
        // console.log(`[MockElement] insertAdjacentHTML(${position}, ${text.substring(0, 20)}...)`);
        this.innerHTML += text;
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {} // Added dispatchEvent
    val() { return this.value; }
    querySelector() { return new MockElement(); }
    querySelectorAll() { return []; }
    getElementsByClassName(name) { return [new MockElement()]; }
    closest() { return new MockElement(); }
}

const eventRegistry = {};

const mockJQuery = function(selector) {
    // console.log(`[jQuery] Access: ${selector}`); // Debug log
    
    // Smart Proxy: Intercept ID selectors
    if (typeof selector === 'string' && selector.startsWith('#')) {
        const configKey = domIdMap[selector];
        if (configKey !== undefined) {
            // Return a "Smart Object" that reads from config
            return {
                remove: () => {},
                empty: () => {}, // Added empty
                detach: () => {}, // Added detach
                before: () => {}, // Added before
                after: () => {}, // Added after
                replaceWith: () => {}, // Added replaceWith
                val: (newValue) => {
                    // Getter
                    if (newValue === undefined) {
                        const val = defaultUserConfig[configKey];
                        // console.log(`[SmartMock] Read ${selector} -> "${val}"`);
                        return val;
                    } 
                    // Setter (Optional: Update config if ST tries to write back)
                    // console.log(`[SmartMock] Write ${selector} <- "${newValue}"`);
                    defaultUserConfig[configKey] = newValue;
                    return mockJQuery(selector); // Return self for chaining
                },
                // Add other jQuery methods as needed (stubs)
                append: () => {},
                on: (event, handler) => {
                    console.log(`[jQuery] ${selector}.on('${event}')`);
                    if (!eventRegistry[selector]) eventRegistry[selector] = {};
                    if (!eventRegistry[selector][event]) eventRegistry[selector][event] = [];
                    eventRegistry[selector][event].push(handler);
                    return mockJQuery(selector);
                },
                off: () => {},
                click: () => {},
                prop: (key, val) => {
                    if (val === undefined && typeof key !== 'object') return false;
                    return mockJQuery(selector);
                },
                attr: (key, val) => {
                    if (val === undefined && typeof key !== 'object') return '';
                    return mockJQuery(selector);
                },
                html: () => mockJQuery(selector),
                text: () => mockJQuery(selector),
                css: () => mockJQuery(selector),
                show: () => {},
                hide: () => {},
                slideUp: () => {}, // Added slideUp
                slideDown: () => {}, // Added slideDown
                fadeIn: () => {}, // Added fadeIn
                fadeOut: () => {}, // Added fadeOut
                toggle: () => {},
                addClass: () => {},
                removeClass: () => {},
                toggleClass: () => {}, // Added toggleClass
                find: () => mockJQuery(selector),
                length: 1, // Simulate element exists
                each: () => {},
                scrollTop: () => {},
                trigger: async (event) => {
                    const handlers = (eventRegistry[selector] && eventRegistry[selector][event]) || [];
                    console.log(`[jQuery] ${selector}.trigger('${event}') - Found ${handlers.length} handlers`);
                    for (const h of handlers) {
                         try { await h(); } catch(e) { console.error(e); }
                    }
                    return mockJQuery(selector);
                },
                autocomplete: () => {},
                data: () => {},
                closest: () => mockJQuery(selector),
                filter: () => mockJQuery(selector),
                parent: () => mockJQuery(selector),
                parents: () => mockJQuery(selector),
                children: () => mockJQuery(selector),
                contents: () => mockJQuery(selector),
                clone: () => mockJQuery(selector), // Added clone
                prev: () => mockJQuery(selector),
                next: () => mockJQuery(selector),
                eq: () => mockJQuery(selector),
                first: () => mockJQuery(selector),
                last: () => mockJQuery(selector),
                [Symbol.iterator]: function* () { yield this; }, // Allow for...of
                0: new MockElement()
            };
        }
    }

    // Default "Dumb" Mock for unmapped selectors
    return {
        val: () => '',
        empty: () => { console.log(`[jQuery] ${selector}.empty()`); return mockJQuery(selector); },
        detach: () => { console.log(`[jQuery] ${selector}.detach()`); return mockJQuery(selector); },
        append: () => { console.log(`[jQuery] ${selector}.append()`); },
        on: () => { console.log(`[jQuery] ${selector}.on()`); },
        off: () => { console.log(`[jQuery] ${selector}.off()`); },
        click: () => { console.log(`[jQuery] ${selector}.click()`); },
        prop: (key, val) => { 
            console.log(`[jQuery] ${selector}.prop('${key}', ${val})`); 
            if (val === undefined && typeof key !== 'object') return false; 
            return mockJQuery(selector); 
        },
        attr: (key, val) => { 
            console.log(`[jQuery] ${selector}.attr('${key}', ${val})`); 
            if (val === undefined && typeof key !== 'object') return ''; 
            return mockJQuery(selector); 
        },
        html: () => { console.log(`[jQuery] ${selector}.html()`); return mockJQuery(selector); },
        text: () => { console.log(`[jQuery] ${selector}.text()`); return mockJQuery(selector); },
        css: () => { console.log(`[jQuery] ${selector}.css()`); return mockJQuery(selector); },
        show: () => { console.log(`[jQuery] ${selector}.show()`); },
        hide: () => { console.log(`[jQuery] ${selector}.hide()`); },
        slideUp: () => { console.log(`[jQuery] ${selector}.slideUp()`); return mockJQuery(selector); },
        slideDown: () => { console.log(`[jQuery] ${selector}.slideDown()`); return mockJQuery(selector); },
        fadeIn: () => { console.log(`[jQuery] ${selector}.fadeIn()`); return mockJQuery(selector); },
        fadeOut: () => { console.log(`[jQuery] ${selector}.fadeOut()`); return mockJQuery(selector); },
        toggle: () => { console.log(`[jQuery] ${selector}.toggle()`); },
        addClass: (cls) => { console.log(`[jQuery] ${selector}.addClass('${cls}')`); return mockJQuery(selector); },
        removeClass: (cls) => { console.log(`[jQuery] ${selector}.removeClass('${cls}')`); return mockJQuery(selector); },
        toggleClass: (cls) => { console.log(`[jQuery] ${selector}.toggleClass('${cls}')`); return mockJQuery(selector); }, // Added toggleClass
        find: (sel) => { console.log(`[jQuery] ${selector}.find('${sel}')`); return mockJQuery(sel); },
        length: 0,
        each: () => {},
        scrollTop: () => {},
        trigger: (evt) => { console.log(`[jQuery] ${selector}.trigger('${evt}')`); },
        autocomplete: () => {},
        data: () => {},
        closest: () => mockJQuery(selector),
        filter: () => mockJQuery(selector),
        clone: () => mockJQuery(selector), // Added clone
        parent: () => mockJQuery(selector),
        parents: () => mockJQuery(selector),
        children: () => mockJQuery(selector),
        contents: () => mockJQuery(selector),
        prev: () => mockJQuery(selector),
        next: () => mockJQuery(selector),
        eq: () => mockJQuery(selector),
        first: () => mockJQuery(selector),
        last: () => mockJQuery(selector),
        [Symbol.iterator]: function* () { yield this; },
        0: new MockElement(),
    };
};
// Static methods
Object.assign(mockJQuery, {
    extend: Object.assign,
    inArray: (item, arr) => arr ? arr.indexOf(item) : -1,
    trim: (str) => str ? str.trim() : '',
    each: (arr, cb) => arr.forEach((v, i) => cb(i, v)),
    map: (arr, cb) => arr.map(cb),
    ajax: async (options) => {
        // console.log(`[jQuery] ajax: ${options.url}`);
        // Redirect to hijackedFetch for consistency, or handle simple mocks here
        
        // Mock Tokenizer APIs
        if (options.url && options.url.includes('/api/tokenizers/')) {
             // console.log(`[jQuery] Mocking Tokenizer: ${options.url}`);
             let count = 0;
             if (options.data) {
                 try {
                     const body = typeof options.data === 'string' ? JSON.parse(options.data) : options.data;
                     const text = body.text || (Array.isArray(body) ? body[0]?.content : '') || '';
                     count = Math.ceil(text.length / 3); // Crude estimation
                 } catch (e) {}
             }
             
             const response = { token_count: count, count: count, ids: [], text: '', chunks: [] };
             if (options.success) options.success(response);
             return response;
        }
        
        // Handle other AJAX calls if necessary
        return {};
    },
    ajaxPrefilter: () => {}, // Mock
    get: async () => ({}),
    post: async () => ({}),
    cleanData: () => {},
});

// 2. Prepare Context
// Load Libraries
const moment = require('moment');
const showdown = require('showdown');
// const DOMPurify = require('dompurify');
const DOMPurify = {
    sanitize: (str) => str,
    addHook: () => {},
    setConfig: () => {},
    clearConfig: () => {},
    isValidAttribute: () => true,
    removeHook: () => {},
};
const Handlebars = require('handlebars');
const _ = require('lodash'); // Require lodash

// Polyfills
const uuidv4 = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};
const debounce = _.debounce;
const extractTextFromPDF = async () => ''; // Mock
const extractTextFromDocx = async () => ''; // Mock
const extractTextFromTextFile = async () => ''; // Mock
const extractTextFromEpub = async () => ''; // Mock
const extractTextFromHTML = async () => ''; // Mock
const extractTextFromMarkdown = async () => ''; // Mock
const extractTextFromOffice = async () => ''; // Mock
const extractTextFromUrl = async () => ''; // Mock
const canUseNegativeLookbehind = () => true; // Mock
const extension_prompt_types = {}; // Mock
const extension_prompt_roles = {}; // Mock
const favsToHotswap = []; // Mock
const libs = {
    moment,
    showdown,
    DOMPurify,
    _: _,
    lodash: _,
    toastr: {
        info: () => {},
        success: () => {},
        warning: () => {},
        error: () => {},
        options: {},
        clear: () => {},
    },
};

class MockEvent {
    constructor(type) { this.type = type; }
    initCustomEvent() {}
}

class MockMutationObserver {
    constructor(cb) {}
    observe() {}
    disconnect() {}
}

class MockSlashCommandParser {
    constructor() {}
    getHelpString() { return ''; }
    static addCommand() {}
}

class MockBulkEditOverlay {
    constructor() {}
}

const mockLocalForage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    keys: async () => [],
    length: async () => 0,
    iterate: async () => {},
    config: () => {},
    createInstance: () => mockLocalForage, // Recursive
};

const windowMock = {
    location: { href: 'http://localhost/', search: '' },
    navigator: { userAgent: 'NodeJS', platform: 'Linux' },
    innerWidth: 1024,
    innerHeight: 768,
    // Polyfills for Stream Decoding
    TextDecoder: TextDecoder,
    TextEncoder: TextEncoder,
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
    },
    // Injected Libs
    moment,
    showdown,
    DOMPurify,
    Handlebars,
    uuidv4,
    debounce,
    extractTextFromPDF,
    extractTextFromDocx,
    extractTextFromTextFile,
    extractTextFromEpub,
    extractTextFromHTML,
    extractTextFromMarkdown,
    extractTextFromOffice,
    extractTextFromUrl,
    canUseNegativeLookbehind,
    extension_prompt_types,
    extension_prompt_roles,
    favsToHotswap,
    libs,
    toastr: libs.toastr,
    lodash: _, // ST uses 'lodash' variable sometimes?
    _: _,
    localforage: mockLocalForage,
    $: mockJQuery,
    jQuery: mockJQuery,
    console: console,
    // Globals (ST Settings Objects)
    textgenerationwebui_settings: {},
    koboldai_settings: {},
    oai_settings: {},
    nai_settings: {},
    power_user: {},
    
    // Globals (Browser/Environment)
    Event: MockEvent,
    CustomEvent: MockEvent,
    MutationObserver: MockMutationObserver,
    SlashCommandParser: MockSlashCommandParser,
    BulkEditOverlay: MockBulkEditOverlay,
    HTMLFormElement: class {},
    HTMLElement: class {},
    HTMLInputElement: class {}, // Mock HTMLInputElement
    HTMLSelectElement: class {}, // Mock HTMLSelectElement
    HTMLTextAreaElement: class {}, // Mock HTMLTextAreaElement
    Element: class {},
    Node: class {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    open: () => {},
    alert: console.log,
    prompt: () => '',
    confirm: () => true,
    Image: class {},
    FileReader: class {},
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    Popper: { createPopper: () => ({ destroy: () => {} }) },
    ModuleWorkerWrapper: class { 
        constructor() {}
        postMessage() {} 
        onmessage() {} 
        terminate() {} 
    },
};

// Circular reference for 'window.window'
windowMock.window = windowMock;
windowMock.self = windowMock;
windowMock.globalThis = windowMock;


const documentMock = {
    getElementById: (id) => new MockElement(),
    createElement: (tag) => new MockElement(tag),
    createComment: () => ({}),
    createTextNode: () => ({}),
    createEvent: (type) => new MockEvent(type),
    body: new MockElement('body'),
    head: new MockElement('head'),
    querySelector: (sel) => { 
        const el = new MockElement(); 
        el.id = sel; 
        return el; 
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: 'complete',
    activeElement: new MockElement(), // Added activeElement
};


// 3. Network Hijack (The Bridge)
// 这是一个中间人 Fetch，它欺骗 ST 以为在发往 API，实际上我们在 Node 端截获它。
const hijackedFetch = async (url, options) => {
    // 1. Intercept Ping
    if (url === 'api/ping') {
        console.log('[Network] Hijacked Ping. Returning 200 OK.');
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: () => null },
            json: async () => ({}),
            text: async () => '{}',
        };
    }
    
    // 2. Intercept Character Fetch (Crucial for Initialization)
    if (url === '/api/characters/all') {
         console.log('[Network] Hijacked /api/characters/all. Returning empty list (Injection handles the rest).');
         return {
             ok: true,
             status: 200,
             headers: { get: () => null },
             json: async () => []
         };
    }
    
    // 3. Intercept Chat Fetch
    if (url === '/api/chats/get') {
         console.log('[Network] Hijacked /api/chats/get. Returning empty list.');
         return {
             ok: true,
             status: 200,
             headers: { get: () => null },
             json: async () => []
         };
    }

    // 3.1 Intercept Stats
    if (url.includes('/api/stats/get') || url.includes('/api/stats/update')) {
         return {
             ok: true,
             json: async () => ({})
         };
    }

    // 3.2 Intercept Chat Save
    if (url === '/api/chats/save') {
        console.log('[Network] Hijacked /api/chats/save. Success.');
        return {
            ok: true,
            status: 200,
            json: async () => ({})
        };
    }

    // 3.3 Intercept Chat Generation (Proxy to Real LLM)
    if (url === '/api/backends/chat-completions/generate') {
        console.log('[Network] Hijacked Chat Generation Request.');
        try {
            // Construct target URL (User config usually has base URL like .../v1)
            const baseUrl = (defaultUserConfig.api_url_openai || 'https://api.openai.com/v1').replace(/\/$/, '');
            const targetUrl = `${baseUrl}/chat/completions`;
            
            console.log(`[Network] Forwarding to LLM: ${targetUrl}`);
            
            // Prepare Headers
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${defaultUserConfig.api_key_openai}`
            };

            // Parse and Prepare Body
            // We pass the body through. ST frontend sends standard OpenAI-like format mostly.
            // Note: If SiliconFlow is strict about extra fields, we might need to sanitize requestBody.
            let requestBody = {};
            try {
                requestBody = JSON.parse(options.body);
            } catch (e) {
                console.error('[Network] Failed to parse body', e);
            }

            // Force override model to ensure it matches our config (ST frontend might send defaults like gpt-4-turbo)
            if (defaultUserConfig.openai_model) {
                 console.log(`[Network] Overriding model: ${requestBody.model} -> ${defaultUserConfig.openai_model}`);
                 requestBody.model = defaultUserConfig.openai_model;
            }

            const bodyStr = JSON.stringify(requestBody);
            console.log('[Network] Request Body Payload:', bodyStr); // Debug log

            /*
            // REAL NETWORK REQUEST (Commented out for Sandbox/Offline Test)
            const proxyResponse = await fetch(targetUrl, {
                method: 'POST',
                headers: headers,
                body: bodyStr
            });
            */
            
            // MOCK NETWORK RESPONSE (For Testing Loop)
            const isStreaming = requestBody.stream !== false; // Default to true if not specified, but ST sends false explicitly
            
            console.log(`[Network] SIMULATING LLM Response (Streaming: ${isStreaming})...`);
            
            const mockContent = "你好！我是 Seraphina，很高兴见到你。我是一个友好的 AI 助手，无论你有什么问题或者想要聊什么，我都在这里随时准备帮助你。请问今天有什么我可以为你做的吗？";

            if (!isStreaming) {
                // Non-streaming response (JSON)
                 const responseJson = {
                    id: "chatcmpl-mock-static",
                    object: "chat.completion",
                    created: Date.now(),
                    model: requestBody.model,
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant",
                            content: mockContent
                        },
                        finish_reason: "stop"
                    }],
                    usage: {
                        prompt_tokens: 50,
                        completion_tokens: 50,
                        total_tokens: 100
                    }
                };
                
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => 'application/json' },
                    json: async () => responseJson,
                    text: async () => JSON.stringify(responseJson),
                    body: null // non-streaming usually doesn't need body stream access in this context
                };

            }
            
            // Streaming Response
            const stream = new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    const chunks = mockContent.split(/(?=[，。！？])/); // Split by punctuation for effect
                    
                    for (const chunk of chunks) {
                        await new Promise(r => setTimeout(r, 100)); // Simulate network delay
                        
                        const data = JSON.stringify({
                            id: "chatcmpl-mock-stream",
                            object: "chat.completion.chunk",
                            created: Date.now(),
                            model: requestBody.model,
                            choices: [{
                                index: 0,
                                delta: { content: chunk },
                                finish_reason: null
                            }]
                        });
                        
                        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                    }
                    
                    // End of stream
                    const doneData = JSON.stringify({
                        id: "chatcmpl-mock-stream",
                        object: "chat.completion.chunk",
                        created: Date.now(),
                        model: requestBody.model,
                        choices: [{
                            index: 0,
                            delta: {},
                            finish_reason: "stop"
                        }]
                    });
                    controller.enqueue(encoder.encode(`data: ${doneData}\n\n`));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            });

            // Create a Mock Response Object compatible with node-fetch
            const proxyResponse = {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => 'application/json' },
                body: stream, // Standard Fetch API uses 'body' as ReadableStream
                // Node-fetch specific:
                // url: targetUrl, 
            };
            
            // Node environment might need a wrapper if ST expects node-fetch specific streams,
            // but ST's frontend fetch usually expects standard ReadableStream for text decoding.
            // Let's ensure text/json methods are still there just in case (though not used for streaming)
             proxyResponse.text = async () => { throw new Error("Cannot call .text() on stream"); };
             proxyResponse.json = async () => { throw new Error("Cannot call .json() on stream"); };
             
            // ------------------------------------------------

            console.log(`[Network] LLM Response: ${proxyResponse.status} ${proxyResponse.statusText}`);
            
            if (!proxyResponse.ok) {
                const errText = await proxyResponse.text();
                console.error('[Network] LLM Error Body:', errText);
                // Return a fake error response to ST
                 return {
                     ok: false,
                     status: proxyResponse.status,
                     statusText: proxyResponse.statusText,
                     text: async () => errText,
                     json: async () => { try { return JSON.parse(errText) } catch(e) { return {error: errText} } }
                 };
            }

            // Return the real response directly to handle streaming
            return proxyResponse;

        } catch (err) {
            console.error('[Network] Chat Generation Proxy Failed:', err);
            return {
                ok: false,
                status: 500,
                statusText: 'Internal Error',
                text: async () => err.toString(),
                json: async () => ({ error: err.toString() })
            };
        }
    }

    // 4. Fallback: Serve Static Files (Crucial for Templates, WASM, etc.)
    if (!url.startsWith('http')) {
        console.log(`[Network] Static File Request: ${url}`);
        try {
            // Remove query params
            const cleanUrl = url.split('?')[0];
            
            // ST sometimes requests paths starting with /, sometimes relative.
            // Ensure we join correctly with public dir.
            const relativePath = cleanUrl.startsWith('/') ? cleanUrl.slice(1) : cleanUrl;
            // Fix: Use __dirname relative to the script location (SillyTavern/docker) -> SillyTavern/public
            const filePath = path.join(__dirname, '..', 'public', relativePath);
            
            console.log(`[Network] Resolve Path: ${filePath}`);

            if (fs.existsSync(filePath)) {
                 const content = fs.readFileSync(filePath); // Read as Buffer
                 console.log(`[Network] Served Static File: ${filePath} (${content.length} bytes)`);
                 return {
                     ok: true,
                     status: 200,
                     headers: { get: () => null },
                     arrayBuffer: async () => {
                         const buf = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
                         return buf;
                     },
                     text: async () => content.toString('utf-8'), 
                     json: async () => JSON.parse(content.toString('utf-8')), 
                     blob: async () => ({ arrayBuffer: async () => content.buffer }), 
                 };
            } else {
                 console.warn(`[Network] Static File Not Found: ${filePath}`);
                 // IMPORTANT: Return 404 instead of throwing, so ST handles it gracefully
                 return {
                     ok: false,
                     status: 404,
                     headers: { get: () => null },
                     text: async () => 'Not Found',
                     json: async () => ({}),
                 };
            }
        } catch (fileErr) {
            console.error(`[Network] Static File Error:`, fileErr);
             return {
                 ok: false,
                 status: 500,
                 headers: { get: () => null },
                 text: async () => 'Internal Error',
                 json: async () => ({}),
             };
        }
    }

    console.log(`\n[Network] Intercepted Request to: ${url}`);
    
    // Parse Payload
    if (options && options.body) {
        try {
            const body = JSON.parse(options.body);
            console.log('[Network] Payload (Preview):', JSON.stringify(body, null, 2).slice(0, 500) + '...');
            
            // 可以在这里检查 body.messages 是否正确包含了我们的输入
        } catch (e) {
            console.log('[Network] Payload is not JSON:', options.body);
        }
    }

    // Pass through using real node-fetch (Layer 4)
    // 注意：如果是发给 127.0.0.1 (TextGenWebUI)，需要确保本地服务已启动。
    // 如果是 OpenAI，需要确保 api_key 正确。
    
    // 使用 node-fetch 发送真实请求
    try {
        console.log('[Network] Sending Real Request...');
        const response = await fetch(url, options);
        console.log(`[Network] Response Status: ${response.status}`);
        return response;
    } catch (error) {
        console.error('[Network] Request Failed:', error);
        throw error;
    }
};

// Mock XMLHttpRequest using hijackedFetch
class MockXMLHttpRequest {
    constructor() {
        this.headers = {};
        this.responseURL = '';
        this.status = 0;
        this.statusText = '';
        this.responseText = '';
        this.readyState = 0;
        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
    }
    open(method, url) {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(k, v) { this.headers[k] = v; }
    async send(body) {
        // Use the hijacked fetch to resolve this request
        try {
            const res = await hijackedFetch(this.url, {
                method: this.method,
                headers: this.headers,
                body: body
            });
            
            this.status = res.status;
            this.statusText = res.statusText;
            this.responseText = await res.text();
            this.readyState = 4; // DONE
            
            if (this.onreadystatechange) this.onreadystatechange();
            if (this.onload) this.onload();
        } catch (e) {
            console.error('[MockXHR] Error:', e);
            if (this.onerror) this.onerror();
        }
    }
}
windowMock.XMLHttpRequest = MockXMLHttpRequest;

const context = {
    window: windowMock,
    document: documentMock,
    $: mockJQuery,
    console: console,
    fetch: hijackedFetch, // Inject Hijacked Fetch
    localStorage: windowMock.localStorage,
};

try {
    console.log('Initializing Core...');
    const instance = CoreFactory(context);
    console.log('Core initialized successfully!');

    // --- Fixes for Headless Environment ---
    console.log('[Fix] Mocking save settings to prevent retry loop');
    instance.window.settingsReady = true; // Try to set it if exposed
    instance.window.saveSettings = async () => { console.log('[Mock] saveSettings called - suppressed'); };
    instance.window.saveSettingsDebounced = () => { console.log('[Mock] saveSettingsDebounced called - suppressed'); };

    console.log('[Fix] Resetting is_send_press');
    instance.window.is_send_press = false;
    
    // --- Step 6.1: Check Generate Entry Point ---
    console.log('Checking for Generate function...');
    
    // Global Error Handler for Promises
    process.on('unhandledRejection', (reason, p) => {
        console.error('Unhandled Rejection at:', p, 'reason:', reason);
    });

    if (typeof instance.window.Generate === 'function') {
        console.log('SUCCESS: Generate function found on window.');
        
        // --- Step 6.2: Inject Virtual Character & History ---
        console.log('\n--- Injecting Virtual State ---');
        
        // 1. Inject Character
        // ST uses 'characters' array and 'this_chid' index
        const virtualChar = {
            name: 'Seraphina',
            description: 'A friendly AI assistant.',
            personality: 'Helpful, kind, smart.',
            first_mes: 'Hello! How can I help you today?',
            avatar: 'default.png',
            chat: 'chat_log_123', // Virtual filename
            data_last: 0,
            extensions: {} // Prevent crash
        };
        
        // Initialize characters array if not exists (it should from script.js)
        if (!instance.window.characters) instance.window.characters = [];
        
        instance.window.characters[0] = virtualChar;
        // instance.window.this_chid = 0;
        instance.window.setCharacterId(0); // Use setter to update internal state
        instance.window.characters.length = 1; // Ensure length is correct
        
        console.log(`State Injected: Character = ${instance.window.characters[0].name}, ID = ${instance.window.this_chid}`);
        
        // 2. Inject Chat History
        // ST uses 'chat' array.
        // Format: { name: 'User', is_user: true, mes: '...' }
        
        const history = [
            {
                name: 'Seraphina',
                is_user: false,
                is_system: false,
                mes: 'Hello! How can I help you today?',
                send_date: '2023-10-27',
                force_avatar: ''
            }
        ];
        
        // We need to push into the existing array, not replace the reference (if it's exported as let)
        // Accessing the exported 'chat' variable
        if (instance.window.chat) {
            instance.window.chat.length = 0; // Clear
            history.forEach(msg => instance.window.chat.push(msg));
            console.log(`State Injected: Chat History (${instance.window.chat.length} messages)`);
        } else {
             // If chat is not exposed on window (it should be via bundler), create it
             console.warn('WARNING: chat array not found on window. Creating new one.');
             instance.window.chat = history;
        }

        // Mock eventSource (required for Generate)
        if (!instance.window.eventSource) {
             instance.window.eventSource = { emit: () => {} };
        }
        
        // Mock main_api settings to ensure it picks OpenAI
        instance.window.main_api = 'openai';
        // Force trigger change event to update internal state in CoreFactory
        // await instance.window.$('#main_api').trigger('change');
        
        if (typeof instance.window.changeMainAPI === 'function') {
            console.log('Calling changeMainAPI() directly...');
            instance.window.changeMainAPI();
        } else {
            console.error('WARNING: changeMainAPI not found on window. CoreFactory execution incomplete?');
             // Fallback: Try to trigger if function not exposed
             await instance.window.$('#main_api').trigger('change');
        }

        // --- Step 6.2.5: Monkey Patching for Debugging ---
        // Probe into the internal function calls to find the bottleneck
        
        const originalGetCombinedPrompt = instance.window.getCombinedPrompt;
        if (originalGetCombinedPrompt) {
            instance.window.getCombinedPrompt = async function(...args) {
                console.log('[Probe] getCombinedPrompt called');
                try {
                    const result = await originalGetCombinedPrompt.apply(this, args);
                    console.log('[Probe] getCombinedPrompt returned');
                    return result;
                } catch (e) {
                    console.error('[Probe] getCombinedPrompt failed:', e);
                    throw e;
                }
            };
        } else {
            console.warn('[Probe] Warning: getCombinedPrompt not found on window');
        }

        const originalGenerateRaw = instance.window.generateRaw;
        if (originalGenerateRaw) {
            instance.window.generateRaw = async function(...args) {
                console.log('[Probe] generateRaw called');
                return originalGenerateRaw.apply(this, args);
            };
        }

        // Check EventSource
        const originalEmit = instance.window.eventSource.emit;
        instance.window.eventSource.emit = async function(type, ...args) {
             console.log(`[Probe] Event Emitted: ${type}`);
             if (originalEmit) {
                 return originalEmit.apply(this, [type, ...args]);
             }
        };

        // --- ADDED PROBES ---
        ['sendMessageAsUser', 'hideSwipeButtons', 'addOneMessage', 'saveChatConditional', 'getTokenCountAsync', 'runGenerationInterceptors', 'getWorldInfoPrompt'].forEach(funcName => {
            const original = instance.window[funcName];
            if (original) {
                instance.window[funcName] = async function(...args) {
                    console.log(`[Probe] ${funcName} called`);
                    try {
                        const res = await original.apply(this, args);
                        console.log(`[Probe] ${funcName} returned`);
                        return res;
                    } catch (e) {
                        console.error(`[Probe] ${funcName} failed:`, e);
                        throw e;
                    }
                };
            } else {
                console.warn(`[Probe] Warning: ${funcName} not found on window`);
            }
        });
        // --------------------


        // --- Step 6.2.6: Tokenizer Smoke Test ---
        console.log('\n--- Tokenizer Smoke Test ---');
        try {
            if (instance.window.getTokenCountAsync) {
                console.log('Calling getTokenCountAsync("Hello World")...');
                // Use a timeout to detect hang
                const tokenPromise = instance.window.getTokenCountAsync('Hello World');
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Tokenizer Timed Out')), 2000));
                
                const count = await Promise.race([tokenPromise, timeoutPromise]);
                console.log(`Tokenizer Result: ${count}`);
            } else {
                console.warn('WARNING: getTokenCountAsync not found on window.');
            }
        } catch (e) {
            console.error('Tokenizer Test Failed:', e);
        }

        // --- Step 6.3: Test Generation ---
        console.log('\n--- Triggering Generation ---');
        
        // 1. Set User Input
        defaultUserConfig.send_textarea = "你好，请做一下自我介绍"; // Chinese input test
        
        // 2. Trigger
        console.log('Setting online_status...');
        instance.window.setOnlineStatus('Connected');
        instance.window.online_status = 'Connected'; // Update window prop for test visibility

        console.log('online_status:', instance.window.online_status);

        // Ensure markdown converter is initialized
        if (!instance.window.converter && instance.window.reloadMarkdownProcessor) {
             console.log('Initializing Markdown Converter...');
             instance.window.reloadMarkdownProcessor();
        }

        console.log('Calling Generate("normal")...');
        // Ensure send press is false before starting
        instance.window.is_send_press = false;
        try {
            await instance.window.Generate('normal');
        } catch (genError) {
             console.error('Generate() crashed:', genError);
        } finally {
            console.log('[Fix] Resetting is_send_press in finally block');
            instance.window.is_send_press = false;
        }
        
    } else {
        console.error('FAILURE: Generate function NOT found on window.');
        const keys = Object.keys(instance.window).filter(k => !k.startsWith('on'));
        console.log('Available window keys:', keys.slice(0, 50).join(', '));
    }
    
} catch (e) {
    console.error('Core initialization failed:', e);
}
