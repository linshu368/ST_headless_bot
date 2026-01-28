
const fs = require('fs');
const path = require('path');
const createCoreInstance = require('./CoreFactory.js');

// --- Layer 2: Service / State Manager ---
const configStore = {
    '#api_url_text': 'http://127.0.0.1:5000',
    '#api_key_text': '123456',
    '#model_info_text': 'gpt-3.5-turbo',
};

// --- Mock Infrastructure ---
const mockLocalStorage = {
    getItem: (key) => configStore[key] || null,
    setItem: (key, val) => configStore[key] = val,
    removeItem: (key) => delete configStore[key],
    clear: () => {},
};

const mockJQuery = function(selector) {
    // console.log(`[jQuery] Select: ${selector}`);
    
    // 1. Selector is window/document?
    if (selector === window || selector === document) {
        return {
            on: () => {},
            ready: (cb) => {
                console.log('[jQuery] Document Ready triggered');
                // Don't run immediately, or maybe do?
                // cb(); 
            },
            off: () => {},
            trigger: () => {},
            scrollTop: () => 0,
            height: () => 1080,
            width: () => 1920,
        };
    }

    // 2. Mock Element Wrapper
    return {
        val: (arg) => {
            if (arg === undefined) {
                // Getter
                const val = configStore[selector];
                // console.log(`[jQuery] Read ${selector} = ${val}`);
                return val !== undefined ? val : ''; // Default to empty string
            } else {
                // Setter
                // console.log(`[jQuery] Write ${selector} = ${arg}`);
                configStore[selector] = arg;
                return this; // Chainable
            }
        },
        text: (arg) => { return arg === undefined ? '' : this; },
        html: (arg) => { return arg === undefined ? '' : this; },
        append: () => this,
        prepend: () => this,
        find: () => mockJQuery('dummy_child'), // Recursive mock
        closest: () => mockJQuery('dummy_parent'),
        parent: () => mockJQuery('dummy_parent'),
        children: () => mockJQuery('dummy_child'),
        attr: (k, v) => { if (v === undefined) return ''; return this; },
        css: () => this,
        hide: () => this,
        show: () => this,
        fadeIn: () => this,
        fadeOut: () => this,
        addClass: () => this,
        removeClass: () => this,
        toggleClass: () => this,
        prop: () => false, // Default checkbox false
        on: () => this,
        off: () => this,
        trigger: () => this,
        focus: () => this,
        blur: () => this,
        click: () => this,
        change: () => this,
        select: () => this,
        each: (cb) => { return this; }, // Don't iterate
        // ... add more as needed
    };
};
// Static jQuery methods
mockJQuery.extend = Object.assign;
mockJQuery.ajax = () => Promise.resolve({});
mockJQuery.get = () => Promise.resolve({});
mockJQuery.post = () => Promise.resolve({});
mockJQuery.each = (arr, cb) => { if(Array.isArray(arr)) arr.forEach((v,i)=>cb(i,v)); };


// --- Context Injection ---
const context = {
    window: {
        location: { href: 'http://localhost', search: '' },
        navigator: { userAgent: 'NodeMatrix', clipboard: { writeText: () => {} } },
        addEventListener: () => {},
        removeEventListener: () => {},
        matchMedia: () => ({ matches: false, addListener: () => {} }),
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        console: console,
        Image: class { constructor() { this.src=''; this.onload=null; } },
    },
    document: {
        getElementById: (id) => ({ value: configStore['#'+id] || '' }),
        createElement: (tag) => ({ 
            style: {}, 
            classList: { add:()=>{}, remove:()=>{}, toggle:()=>{} },
            setAttribute: ()=>{},
            appendChild: ()=>{},
        }),
        querySelector: (sel) => null,
        querySelectorAll: (sel) => [],
        body: { appendChild: ()=>{} },
        head: { appendChild: ()=>{} },
        addEventListener: () => {},
    },
    $: mockJQuery,
    console: console,
    fetch: fetch, // Use Node 18+ native fetch
    localStorage: mockLocalStorage,
    
    // Libs
    lib: {}, 
    moment: { duration: () => ({ humanize: () => 'time' }) }, // Mock moment
    showdown: { Converter: class { makeHtml(x){return x;} } }, // Mock showdown
};

// Circular references
context.window.document = context.document;
context.window.localStorage = context.localStorage;

console.log("Creating Matrix Instance...");
try {
    const instance = createCoreInstance(context);
    console.log("Matrix Instance Created Successfully!");
    
    // Verify Critical State
    if (context.window.chat && Array.isArray(context.window.chat)) {
        console.log("Verified: window.chat is accessible.");
    } else {
        console.error("Failed: window.chat is missing or invalid.");
    }

    if (context.window.generateRaw) {
        console.log("Verified: generateRaw is exposed.");
    } else {
        // generateRaw might not be on window, check return
    }

} catch (e) {
    console.error("Matrix Initialization Failed:");
    console.error(e);
}
