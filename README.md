# vector-search-anything-mcp
A MCP server that I can use as a tool in somewhere like Ollama, to vector search related text from any user text from a local sqlite db

# Usage

1. Clone the repo
2. npm install
3. npm run build
> Setup config file as in example config.json else if you want to use in Ollama follow below steps
4. Install mcpo using `pipx install mcpo`
> Update the path to the dist file with the base path in `config.json`
5. Run mcp proxy server - `mcpo --config config.json`
6. Use in Ollama tools as `http://localhost:8000/text-search`