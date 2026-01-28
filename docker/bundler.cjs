
const fs = require('fs');
const path = require('path');

const rootDir = path.join(process.cwd(), 'public');
const outputDir = path.join(process.cwd(), 'docker'); // Output directory
const entryFile = 'script.js';

// --- Configuration ---

// Files to exclude from the bundle (Pure UI, Audio, etc.)
// We will generate stubs for their exports.
const EXCLUDE_FILES = new Set([
    'scripts/sounds.js', // Assuming this exists or similar
    'scripts/dragdrop.js',
    'scripts/loader.js',
    'scripts/browser-fixes.js', // Browser specific hacks
    'scripts/a11y.js', // Accessibility
    'scripts/dom-handlers.js', // Pure DOM event handlers
    'scripts/audio-player.js',
    'scripts/welcome-screen.js',
    'scripts/BulkEditOverlay.js',
    'scripts/bulk-edit.js',
    'scripts/keyboard.js', // Keyboard shortcuts
    'scripts/kai-settings.js',
    // 'scripts/popup.js', // Keep for now, might need to mock Popup class
]);

// Libraries that are imported but should be injected via Context, not bundled source
// Key: import path ending, Value: Global variable name in context
const EXTERNAL_LIBS = {
    'lib.js': 'lib', // Special case: lib.js exports many things
};

// --- Helper Functions ---

function resolveImport(currentFile, importPath) {
    if (importPath.startsWith('.')) {
        return path.join(path.dirname(currentFile), importPath);
    }
    return path.join(rootDir, importPath);
}

// 1. Dependency Analysis (Reusing logic from analyze_deps.js)
const visited = new Set();
const dependencyGraph = new Map(); // File -> Set<Dependencies>
const fileExports = new Map(); // File -> Set<ExportNames>

function scanFile(filePath) {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // --- Extract Imports ---
        const imports = [];
        const importRegex = /import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            let importPath = match[1];
            // Normalize path
            if (!importPath.endsWith('.js') && !importPath.endsWith('.mjs')) {
                 // importPath += '.js'; // ST mostly uses extensions
            }
            
            // Check if it's an external lib (shimmed)
            let isLib = false;
            for (const libKey of Object.keys(EXTERNAL_LIBS)) {
                if (importPath.endsWith(libKey)) isLib = true;
            }

            const resolvedPath = resolveImport(filePath, importPath);
            
            if (!isLib && resolvedPath.startsWith(rootDir) && fs.existsSync(resolvedPath)) {
                 imports.push(resolvedPath);
                 scanFile(resolvedPath);
            }
        }
        dependencyGraph.set(filePath, new Set(imports));

        // --- Extract Exports (for Shim generation) ---
        // Regex for: export function foo..., export const bar..., export class Baz...
        // Does NOT handle 'export { foo, bar }' or 'export default' perfectly yet, but good enough for stubs
        const exports = new Set();
        const exportRegex = /export\s+(?:async\s+)?(function|const|let|var|class)\s+([a-zA-Z0-9_$]+)/g;
        while ((match = exportRegex.exec(content)) !== null) {
            exports.add(match[2]);
        }
        
        // Handle: export { name1, name2 }
        const exportListRegex = /export\s+\{([^}]+)\}/g;
        while ((match = exportListRegex.exec(content)) !== null) {
            const names = match[1].split(',').map(s => s.trim().split(' as ')[0]); // ignore 'as' aliases for now
            names.forEach(n => exports.add(n));
        }

        fileExports.set(filePath, exports);

    } catch (e) {
        console.warn(`Warning: Could not read file ${filePath}: ${e.message}`);
        dependencyGraph.set(filePath, new Set());
    }
}

// 2. Topological Sort
function getSortedFiles(entryPath) {
    const sorted = [];
    const tempVisited = new Set();
    const permVisited = new Set();

    function visit(node) {
        if (permVisited.has(node)) return;
        if (tempVisited.has(node)) return; // Cycle detected, ignore

        tempVisited.add(node);

        const deps = dependencyGraph.get(node) || new Set();
        for (const dep of deps) {
            visit(dep);
        }

        tempVisited.delete(node);
        permVisited.add(node);
        sorted.push(node);
    }

    visit(entryPath);
    return sorted;
}

// 3. Shim Generator
function generateShims(excludedFiles) {
    let shimCode = "\n    // --- Auto-Generated Shims for Excluded UI Files ---\n";
    
    for (const filePath of excludedFiles) {
        const exports = fileExports.get(filePath);
        if (!exports || exports.size === 0) continue;
        
        const relName = path.relative(rootDir, filePath);
        shimCode += `    // Shims for ${relName}\n`;
        
        for (const exportName of exports) {
            // Default void function stub
            shimCode += `    const ${exportName} = () => { console.log('[Shim] Called ${exportName}'); };\n`;
        }
        shimCode += "\n";
    }
    return shimCode;
}

// 4. Bundler Core
function buildBundle() {
    const entryPath = path.join(rootDir, entryFile);
    console.log("Scanning dependencies...");
    scanFile(entryPath);
    
    const sortedFiles = getSortedFiles(entryPath);
    console.log(`Total files in dependency tree: ${sortedFiles.length}`);
    
    let bundleContent = "";
    
    // --- Header ---
    bundleContent += `
/**
 * SillyTavern Core Matrix Bundle
 * Auto-generated by bundler.js
 */
module.exports = function createCoreInstance(context) {
    // 1. Inject Context Globals
    const { 
        window, document, $, console, 
        fetch, localStorage, 
        // Libs
        lib, moment, showdown 
    } = context;

    // Polyfill self/globalThis if needed
    const self = window;
    const globalThis = window;

`;

    // --- Shims ---
    const filesToBundle = [];
    const filesToShim = [];
    
    sortedFiles.forEach(f => {
        const relPath = path.relative(rootDir, f);
        // Check if excluded (exact match or path match)
        let isExcluded = false;
        if (EXCLUDE_FILES.has(relPath)) isExcluded = true;
        // Also check if any exclude pattern matches
        // (Simple set check for now)

        if (isExcluded) {
            filesToShim.push(f);
        } else {
            filesToBundle.push(f);
        }
    });
    
    console.log(`Bundling ${filesToBundle.length} files.`);
    console.log(`Shimming ${filesToShim.length} files.`);
    
    bundleContent += generateShims(filesToShim);

    // --- File Concatenation ---
    for (const filePath of filesToBundle) {
        let code = fs.readFileSync(filePath, 'utf8');
        const relPath = path.relative(rootDir, filePath);
        
        console.log(`Processing: ${relPath}`);
        
        // STRIP IMPORTS: remove "import ... from ..."
        code = code.replace(/import\s+(?:[\s\S]*?from\s+)?['"][^'"]+['"];?/g, (match) => {
            return `// [Bundler] Removed import: ${match.replace(/\n/g, ' ')}`;
        });

    // STRIP EXPORTS: remove "export " keyword but keep the declaration
    // 0. Handle simple "export default identifier" (e.g., export default dialogPolyfill;)
    code = code.replace(/export\s+default\s+([a-zA-Z0-9_$]+)\s*;?/g, '// [Bundler] Removed export default: $1;');

    // 1. export default ... -> // export default ...
    code = code.replace(/export\s+(default\s+)?(async\s+)?(function|const|let|var|class)\s+/g, (match, p1, p2, p3, offset) => {
        // [MOD] Critical State Exposure Strategy
        // If the variable is one of our critical state containers, we explicitly expose it to the window object.
        // This ensures that when the bundler wraps code in 'with(window)', the local variable 
        // is actually referencing the property on the injected window object.
        // This solves the "Character Not Found" issue where STEngineAdapter writes to window.characters
        // but the internal logic uses a disconnected local variable.

        if (p3 === 'let' || p3 === 'var' || p3 === 'const') {
            const nextChunk = code.substring(offset + match.length, offset + match.length + 50);
            
            // List of variables to force-expose
            const criticalVars = ['characters', 'chat', 'this_chid', 'online_status', 'main_api', 'api_key_openai', 'oai_settings'];
            
            for (const varName of criticalVars) {
                // Check if the declaration matches "export let varName"
                if (nextChunk.startsWith(varName + ' ') || nextChunk.startsWith(varName + '=') || nextChunk.startsWith(varName + ';')) {
                    console.log(`[Bundler] Exposing critical state variable: ${varName}. MATCH="${match}" REPLACING_WITH="/* EXPOSED */ " NEXT_CHUNK="${nextChunk.substring(0, 20)}..."`);
                    return (p2 || '') + '/* EXPOSED */ '; 
                }
            }
        }
        
        // Default behavior for non-critical variables: keep the declaration keyword (let/const/class)
        return (p2 || '') + p3 + ' ';
    });

        // export { foo, bar } -> // export { foo, bar }
        code = code.replace(/export\s+\{[^}]+\};?/g, (match) => {
             return `// [Bundler] Removed export list: ${match.replace(/\n/g, ' ')}`;
        });

        // [MOD] Specific fix for oai_settings which is a local const but needs to be global
        if (relPath.endsWith('openai.js')) {
            code = code.replace(/const oai_settings =/g, '/* EXPOSED */ oai_settings =');
        }

        bundleContent += `\n    // --- Start File: ${relPath} ---\n`;
        bundleContent += code;
        bundleContent += `\n    // --- End File: ${relPath} ---\n`;
    }

    // --- Footer ---
    // Expose public API
    bundleContent += `
    
    // [Bundler] Force Exposure of Critical State (One-way binding Init)
    // We bind local variables to window so external code can access the SAME OBJECT REFERENCES.
    // External code must MUTATE these objects (e.g. array.push) instead of reassigning window.prop.
    try { window.characters = characters; } catch(e) {}
    try { window.chat = chat; } catch(e) {}
    try { window.this_chid = this_chid; } catch(e) {}
    try { window.online_status = online_status; } catch(e) {}
    try { window.main_api = main_api; } catch(e) {}
    try { window.oai_settings = oai_settings; } catch(e) {}

    // --- Public Interface ---
    return {
        // Core functions we want to expose to Layer 2
        // generate: generate, // assuming generate is defined
        // saveSettings: saveSettingsDebounced,
        // ... add more as we discover them
    };
};
`;

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }
    
    const outputPath = path.join(outputDir, 'CoreFactory.cjs');
    fs.writeFileSync(outputPath, bundleContent);
    console.log(`Bundle successfully written to: ${outputPath}`);
}

// Run
buildBundle();

