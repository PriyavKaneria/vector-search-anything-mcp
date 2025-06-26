import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { pipeline } from "@xenova/transformers";
import * as fs from "fs";
import * as XLSX from "xlsx";
class TextSearchServer {
    db;
    embedder;
    isInitialized = false;
    constructor() {
        // Initialize SQLite database
        this.db = new Database("text_search.db");
        this.initializeDatabase();
    }
    initializeDatabase() {
        // Create table for storing text and embeddings
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS text_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        embedding BLOB
      );
      
      CREATE INDEX IF NOT EXISTS idx_text ON text_chunks(text);
    `);
    }
    async initializeEmbedder() {
        if (this.isInitialized)
            return;
        console.error("Loading embedding model...");
        // Use a small, fast model for embeddings
        this.embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
        this.isInitialized = true;
        console.error("Embedding model loaded!");
    }
    async getEmbedding(text) {
        await this.initializeEmbedder();
        const output = await this.embedder(text, { pooling: "mean", normalize: true });
        return new Float32Array(output.data);
    }
    cosineSimilarity(a, b) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    async addText(text) {
        if (!text || text.trim().length === 0) {
            throw new Error("Text cannot be empty");
        }
        const cleanText = text.trim();
        // Check if text already exists
        const existingText = this.db.prepare("SELECT id FROM text_chunks WHERE text = ?").get(cleanText);
        if (existingText) {
            console.error(`Text already exists with ID: ${existingText.id}`);
            return existingText.id;
        }
        const embedding = await this.getEmbedding(cleanText);
        const embeddingBuffer = Buffer.from(embedding.buffer);
        const insertStmt = this.db.prepare("INSERT INTO text_chunks (text, embedding) VALUES (?, ?)");
        const result = insertStmt.run(cleanText, embeddingBuffer);
        const newId = result.lastInsertRowid;
        console.error(`Added text with ID: ${newId}`);
        return newId;
    }
    async loadSpreadsheet(filePath, clearExisting = true) {
        console.error(`Loading spreadsheet: ${filePath}`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        const fileData = fs.readFileSync(filePath);
        const workbook = XLSX.read(fileData);
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
        // Clear existing data if requested
        if (clearExisting) {
            this.db.exec("DELETE FROM text_chunks");
        }
        const insertStmt = this.db.prepare("INSERT INTO text_chunks (text, embedding) VALUES (?, ?)");
        let count = 0;
        let skipped = 0;
        for (const row of data) {
            for (const cell of row) {
                if (cell && typeof cell === "string" && cell.trim().length > 0) {
                    const text = cell.trim();
                    // Skip if text already exists (when not clearing)
                    if (!clearExisting) {
                        const existingText = this.db.prepare("SELECT id FROM text_chunks WHERE text = ?").get(text);
                        if (existingText) {
                            skipped++;
                            continue;
                        }
                    }
                    const embedding = await this.getEmbedding(text);
                    const embeddingBuffer = Buffer.from(embedding.buffer);
                    insertStmt.run(text, embeddingBuffer);
                    count++;
                    if (count % 10 === 0) {
                        console.error(`Processed ${count} text chunks...`);
                    }
                }
            }
        }
        console.error(`Loaded ${count} text chunks into database${skipped > 0 ? ` (skipped ${skipped} duplicates)` : ''}`);
    }
    async searchSimilar(query, topN = 5) {
        await this.initializeEmbedder();
        const queryEmbedding = await this.getEmbedding(query);
        // Get all text chunks with embeddings
        const allChunks = this.db.prepare("SELECT id, text, embedding FROM text_chunks WHERE embedding IS NOT NULL").all();
        const similarities = [];
        for (const chunk of allChunks) {
            const embedding = new Float32Array(chunk.embedding.buffer);
            const similarity = this.cosineSimilarity(queryEmbedding, embedding);
            similarities.push({
                id: chunk.id,
                text: chunk.text,
                similarity: similarity
            });
        }
        // Sort by similarity (descending) and return top N
        similarities.sort((a, b) => b.similarity - a.similarity);
        return similarities.slice(0, topN);
    }
}
// Create server instance
const server = new Server({
    name: "text-search-server",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
const searchServer = new TextSearchServer();
// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "load_spreadsheet",
                description: "Load text data from a spreadsheet file into the search database",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: {
                            type: "string",
                            description: "Path to the spreadsheet file (Excel, CSV, etc.)",
                        },
                        clear_existing: {
                            type: "boolean",
                            description: "Whether to clear existing data before loading (default: true)",
                            default: true,
                        },
                    },
                    required: ["file_path"],
                },
            },
            {
                name: "add_text",
                description: "Add a single piece of text to the search database",
                inputSchema: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The text to add to the database",
                        },
                    },
                    required: ["text"],
                },
            },
            {
                name: "search_text",
                description: "Search for similar text chunks using semantic similarity",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query text",
                        },
                        top_n: {
                            type: "number",
                            description: "Number of top results to return (default: 5)",
                            default: 5,
                        },
                    },
                    required: ["query"],
                },
            },
        ],
    };
});
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "load_spreadsheet": {
                const { file_path, clear_existing = true } = args;
                await searchServer.loadSpreadsheet(file_path, clear_existing);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully loaded spreadsheet data from ${file_path}${clear_existing ? " (cleared existing data)" : " (appended to existing data)"}`,
                        },
                    ],
                };
            }
            case "add_text": {
                const { text } = args;
                const id = await searchServer.addText(text);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully added text to database with ID: ${id}`,
                        },
                    ],
                };
            }
            case "search_text": {
                const { query, top_n = 5 } = args;
                const results = await searchServer.searchSimilar(query, top_n);
                const formattedResults = results.map((result, index) => `${index + 1}. (Similarity: ${result.similarity.toFixed(4)}) ${result.text}`).join('\n\n');
                return {
                    content: [
                        {
                            type: "text",
                            text: `Found ${results.length} similar text chunks:\n\n${formattedResults}`,
                        },
                    ],
                };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});
// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Text Search MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
