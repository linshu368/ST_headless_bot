import moment from 'moment';
import showdown from 'showdown';
import _ from 'lodash';
import Handlebars from 'handlebars';
import { TextDecoder, TextEncoder } from 'util';

/**
 * Creates a standard mock Element for the virtual DOM
 */
class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.style = {};
        this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} };
        this.attributes = {};
        this.dataset = {};
        this.value = '';
        this.innerHTML = '';
        this.textContent = '';
        this.children = [];

        // Use Proxy to allow property access to attributes (e.g. element.id, element.method)
        return new Proxy(this, {
            get: (target, prop) => {
                if (prop in target) return target[prop];
                // Fallback to attributes
                if (typeof prop === 'string' && target.attributes[prop] !== undefined) {
                    return target.attributes[prop];
                }
                return undefined;
            },
            set: (target, prop, value) => {
                if (prop in target) {
                    target[prop] = value;
                    return true;
                }
                // Update attribute
                target.attributes[prop] = value;
                return true;
            }
        });
    }
    getAttribute(name) { return this.attributes[name] || null; }
    setAttribute(name, val) { this.attributes[name] = val; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { this.children.push(child); }
    append(child) { this.children.push(child); }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {}
    val() { return this.value; }
    querySelector() { return new MockElement(); }
    querySelectorAll() { return []; }
    closest() { return new MockElement(); }
    
    // [Added for Compatibility]
    insertAdjacentHTML(position, text) {}
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    focus() {}
    blur() {}
    scrollIntoView() {}
    contains() { return false; }
}

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

/**
 * Creates the Virtual Environment (Window, Document, $) for SillyTavern
 * @param {Object} options
 * @param {Function} options.configProvider - (key) => value: Callback to get value for a DOM ID
 * @param {Function} options.configUpdater - (key, value) => void: Callback to set value for a DOM ID
 * @param {Function} options.fetchImplementation - The fetch function to inject
 */
export function createVirtualContext({ configProvider, configUpdater, fetchImplementation }) {
    
    const uuidv4 = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
    const debounce = _.debounce;
    
    // Mocks for file extraction and extensions
    const extractTextFromPDF = async () => ''; 
    const extractTextFromDocx = async () => ''; 
    const extractTextFromTextFile = async () => ''; 
    const extractTextFromEpub = async () => ''; 
    const extractTextFromHTML = async () => ''; 
    const extractTextFromMarkdown = async () => ''; 
    const extractTextFromOffice = async () => ''; 
    const extractTextFromUrl = async () => ''; 
    const canUseNegativeLookbehind = () => true; 
    const extension_prompt_types = {
        NONE: -1,
        IN_PROMPT: 0,
        IN_CHAT: 1,
        BEFORE_PROMPT: 2,
    }; 
    const extension_prompt_roles = {
        SYSTEM: 0,
        USER: 1,
        ASSISTANT: 2,
    }; 
    const favsToHotswap = []; 
    const libs = {
        moment,
        showdown,
        DOMPurify: { sanitize: s=>s },
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

    const eventRegistry = {};

    const mockJQuery = function(selector) {
        // 1. Define the base behavior (preserves val/on logic)
        // We capture the selector in the closure so methods can use it
        
        const isIdSelector = typeof selector === 'string' && selector.startsWith('#');

        const base = {
            val: (newValue) => {
                if (newValue === undefined) {
                    return isIdSelector ? configProvider(selector) : '';
                }
                if (isIdSelector) {
                    configUpdater(selector, newValue);
                }
                return proxy; // Chain
            },
            on: (event, handler) => {
                // Allow binding events to ID selectors AND objects (like document/window)
                // For objects, we use a special key in the registry
                let storageKey = selector;
                if (typeof selector !== 'string') {
                    // If it's an object (document/window), use a unique symbol or fallback string
                    // For simplicity in this mock, we can just treat document/window as generic event targets
                    if (selector === documentMock) storageKey = 'DOCUMENT_MOCK';
                    else if (selector === windowMock) storageKey = 'WINDOW_MOCK';
                    else storageKey = 'GENERIC_MOCK';
                }

                if (storageKey) {
                    if (!eventRegistry[storageKey]) eventRegistry[storageKey] = {};
                    if (!eventRegistry[storageKey][event]) eventRegistry[storageKey][event] = [];
                    eventRegistry[storageKey][event].push(handler);
                }
                return proxy;
            },
            trigger: async (event) => {
                let storageKey = selector;
                if (typeof selector !== 'string') {
                    if (selector === documentMock) storageKey = 'DOCUMENT_MOCK';
                    else if (selector === windowMock) storageKey = 'WINDOW_MOCK';
                    else storageKey = 'GENERIC_MOCK';
                }

                if (storageKey) {
                    const handlers = (eventRegistry[storageKey] && eventRegistry[storageKey][event]) || [];
                    const mockEvent = {
                        type: event,
                        stopPropagation: () => {},
                        preventDefault: () => {},
                        target: selector // pass the target back
                    };
                    for (const h of handlers) {
                         try { await h(mockEvent); } catch(e) { console.error(e); }
                    }
                }
                return proxy;
            },
            each: (cb) => {
                if (cb) cb(0, new MockElement());
                return proxy;
            },
            map: (cb) => {
                const results = [cb(0, new MockElement())];
                return {
                    ...proxy,
                    [Symbol.iterator]: function*() { yield* results; },
                    get: () => results
                };
            },
            [Symbol.iterator]: function* () { yield new MockElement(); },
            0: new MockElement(),
            length: 1 // Pretend we found something to avoid "not found" checks failing too early
        };

        // 2. Create the Recursive Black Hole Proxy
        const proxy = new Proxy(base, {
            get: (target, prop) => {
                // If the property exists in our base object (e.g. val, on), use it
                if (prop in target) return target[prop];
                
                // If it's a promise-like check, return undefined to avoid async/await confusion
                if (prop === 'then') return undefined;
                if (typeof prop === 'symbol') return undefined;
                
                // For any other property (sortable, draggable, slideUp, etc.),
                // return a function that returns the proxy itself (allowing infinite chaining)
                return (...args) => proxy;
            }
        });

        return proxy;
    };

    // Static jQuery methods
    Object.assign(mockJQuery, {
        extend: Object.assign,
        inArray: (item, arr) => arr ? arr.indexOf(item) : -1,
        trim: (str) => str ? str.trim() : '',
        each: (arr, cb) => arr.forEach((v, i) => cb(i, v)),
        map: (arr, cb) => arr.map(cb),
        ajax: async (options) => {
            // Mock Tokenizer API to prevent TokenBudgetExceededError
            if (options.url && typeof options.url === 'string' && options.url.includes('/api/tokenizers/')) {
                let textLength = 0;
                try {
                    const data = typeof options.data === 'string' ? JSON.parse(options.data) : options.data;
                    if (Array.isArray(data)) {
                        // OpenAI format: array of messages
                        data.forEach(msg => {
                            if (msg && msg.content) textLength += String(msg.content).length;
                        });
                    } else if (data && data.text) {
                        // Other formats: object with text property
                        textLength += String(data.text).length;
                    }
                } catch (e) {
                    console.warn('[VirtualContext] Failed to parse ajax data for tokenizer', e);
                }
                
                // Estimate: ~3.5 chars per token
                const count = Math.ceil(textLength / 3.5);
                return { token_count: count, count: count, ids: [] };
            }
            return {};
        },
        ajaxPrefilter: () => {},
        get: async () => ({}),
        post: async () => ({}),
        cleanData: () => {},
    });
    
    // Mock XMLHttpRequest
    class MockXMLHttpRequest {
        open(method, url, async) {}
        send(data) {
            // Simulate success or empty response
            if (this.onload) {
                 // Fake a 200 OK empty response or 404
                 this.status = 200;
                 this.responseText = '';
                 this.onload();
            }
        }
        setRequestHeader() {}
    }

    const windowMock = {
        location: { href: 'http://localhost/', search: '' },
        navigator: { userAgent: 'NodeJS', platform: 'Linux' },
        innerWidth: 1024,
        innerHeight: 768,
        TextDecoder: TextDecoder,
        TextEncoder: TextEncoder,
        structuredClone: (obj) => {
            try {
                return structuredClone(obj);
            } catch (e) {
                // Return original object if clone fails (e.g. Proxy objects)
                return obj;
            }
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
            clear: () => {}
        },
        moment,
        showdown,
        lodash: _,
        _: _,
        $: mockJQuery,
        jQuery: mockJQuery,
        console: console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        addEventListener: () => {},
        removeEventListener: () => {},
        alert: console.log,
        prompt: () => '',
        confirm: () => true,
        Popper: { createPopper: () => ({ destroy: () => {} }) },
        ModuleWorkerWrapper: class { 
            constructor() {}
            postMessage() {} 
            onmessage() {} 
            terminate() {} 
        },
        // Mock Classes
        Event: MockEvent,
        CustomEvent: MockEvent,
        MutationObserver: MockMutationObserver,
        SlashCommandParser: MockSlashCommandParser,
        BulkEditOverlay: MockBulkEditOverlay,
        HTMLElement: MockElement,
        Element: MockElement,
        Node: MockElement,
        Image: class {},
        FileReader: class {},
        XMLHttpRequest: MockXMLHttpRequest, // ADDED
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        
        // Injected Globals for ST
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

        // Empty Globals to prevent crash
        toastr: { info:()=>{}, success:()=>{}, warning:()=>{}, error:()=>{}, clear:()=>{} },
        
        // Settings Globals
        textgenerationwebui_settings: {},
        koboldai_settings: {},
        oai_settings: {
            // [CRITICAL] Default OpenAI Settings
            preset_settings_openai: 'Default',
            openai_model: 'gpt-3.5-turbo', 
            system_prompt: 'You are {{char}}. Write a response that stays in character.', 
            context_template: 'Default',
            chat_completion_source: 'openai',
            openai_max_context: 4096,
            // openai_max_tokens: 10000, // Removed per user request
            openai_temperature: 0.7,
            prompts: [
                { 'name': 'Main Prompt', 'system_prompt': true, 'role': 'system', 'content': 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.', 'identifier': 'main' },
                { 'name': 'Auxiliary Prompt', 'system_prompt': true, 'role': 'system', 'content': '', 'identifier': 'nsfw' },
                { 'identifier': 'dialogueExamples', 'name': 'Chat Examples', 'system_prompt': true, 'marker': true },
                { 'name': 'Post-History Instructions', 'system_prompt': true, 'role': 'system', 'content': '', 'identifier': 'jailbreak' },
                { 'identifier': 'chatHistory', 'name': 'Chat History', 'system_prompt': true, 'marker': true },
                { 'identifier': 'worldInfoAfter', 'name': 'World Info (after)', 'system_prompt': true, 'marker': true },
                { 'identifier': 'worldInfoBefore', 'name': 'World Info (before)', 'system_prompt': true, 'marker': true },
                { 'identifier': 'enhanceDefinitions', 'role': 'system', 'name': 'Enhance Definitions', 'content': 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.', 'system_prompt': true, 'marker': false },
                { 'identifier': 'charDescription', 'name': 'Char Description', 'system_prompt': true, 'marker': true },
                { 'identifier': 'charPersonality', 'name': 'Char Personality', 'system_prompt': true, 'marker': true },
                { 'identifier': 'scenario', 'name': 'Scenario', 'system_prompt': true, 'marker': true },
                { 'identifier': 'personaDescription', 'name': 'Persona Description', 'system_prompt': true, 'marker': true },
            ],
            prompt_order: [
                { 'identifier': 'main', 'enabled': true },
                { 'identifier': 'worldInfoBefore', 'enabled': true },
                { 'identifier': 'personaDescription', 'enabled': true },
                { 'identifier': 'charDescription', 'enabled': true },
                { 'identifier': 'charPersonality', 'enabled': true },
                { 'identifier': 'scenario', 'enabled': true },
                { 'identifier': 'enhanceDefinitions', 'enabled': false },
                { 'identifier': 'nsfw', 'enabled': true },
                { 'identifier': 'worldInfoAfter', 'enabled': true },
                { 'identifier': 'dialogueExamples', 'enabled': true },
                { 'identifier': 'chatHistory', 'enabled': true },
                { 'identifier': 'jailbreak', 'enabled': true },
            ]
        },
        nai_settings: {},
        power_user: {
            console_log_prompts: false, // Avoid logging prompt to console to prevent error accessing prompt
            collapse_newlines: false,
            pin_examples: false,
            disable_description_formatting: false,
            disable_scenario_formatting: false,
            disable_personality_formatting: false,
            disable_examples_formatting: false,
        },

        DOMPurify: { sanitize: s=>s },
        Handlebars, // Minimal mock
        converter: { makeHtml: (s) => s }, // Mock Showdown converter
        localforage: mockLocalForage,
        uuidv4,
        debounce,
    };

        // Explicitly add HTMLFormElement
    windowMock.HTMLFormElement = class HTMLFormElement extends MockElement {};
    windowMock.HTMLInputElement = class HTMLInputElement extends MockElement {};
    windowMock.HTMLSelectElement = class HTMLSelectElement extends MockElement {};
    
    // Circular refs
    windowMock.window = windowMock;
    windowMock.self = windowMock;
    windowMock.globalThis = windowMock;

    // Ensure converter is available on window
    windowMock.converter = { makeHtml: (s) => s };

    const documentMock = {
        getElementById: (id) => new MockElement(),
        createElement: (tag) => new MockElement(tag),
        createComment: () => ({}),
        createTextNode: () => ({}),
        createEvent: (type) => new MockEvent(type),
        body: new MockElement('body'),
        head: new MockElement('head'),
        querySelector: (sel) => { const el = new MockElement(); el.id = sel; return el; },
        querySelectorAll: () => [],
        addEventListener: () => {},
        readyState: 'complete',
        activeElement: new MockElement(),
    };

    return {
        window: windowMock,
        document: documentMock,
        $: mockJQuery,
        console: console,
        fetch: fetchImplementation,
        localStorage: windowMock.localStorage,
    };
}
