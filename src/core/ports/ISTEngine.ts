/**
 * Interface definition for STEngine
 * The core contract for interacting with the SillyTavern Matrix
 */

export interface ISTEngine {
    /**
     * Initialize the engine and virtual environment
     */
    initialize(): Promise<void>;

    /**
     * Load context data (characters, history) into the engine
     * @param contextData Data to inject
     */
    loadContext(contextData: STContextData): Promise<void>;

    /**
     * Trigger a generation request
     * @param prompt User input
     * @returns The generated message object (ST format) or null
     */
    generate(prompt: string): Promise<any>;

    /**
     * Trigger a streaming generation request
     * @param prompt User input
     * @returns Async stream of text deltas
     */
    generateStream(prompt: string): AsyncIterable<string>;
}

export interface STContextData {
    characters?: any[];
    characterId?: number;
    chat?: any[];
}

export interface ISTNetworkHandler {
    (url: string | URL | Request, options?: any): Promise<Response>;
    setMockData?(data: any): void;
    setStreamMode?(enabled: boolean): void;
    setStreamSink?(sink: any | null): void;
}

