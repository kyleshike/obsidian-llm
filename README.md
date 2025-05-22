# Obsidian LLM Assistant

An extension of Obsidian that uses vector search and LLM to answer questions about your vault's contents. It uses RAG (Retrieval Augmented Generation) to include relevant content from your campaign notes and D&D sourcebooks.

## Features

- **Hybrid Search**: Vector similarity and keyword matching for content retrieval
- **RAG-Enhanced Responses**: Answers using D&D knowledge and campaign content
- **Real-time File Processing**: Processes and indexes markdown files
- **Metadata Filtering**: Search by files, headings, or metadata
- **Interactive CLI**: Command-line interface for queries
- **Error Handling**: Recovery from failures
- **Vector Store Management**: Cleanup and backup of vector store

## Prerequisites

- Node.js 18 or higher
- [Ollama](https://ollama.ai/) installed and running locally
- An Obsidian vault

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd dnd_llm
```

2. Install dependencies:

```bash
npm install
```

3. Install Ollama:
   - Follow the [official Ollama installation guide](https://ollama.ai/download)
   - Pull the required models:

```bash
ollama pull nomic-embed-text:latest
ollama pull mistral:latest
```

4. Configure your Obsidian vault:

   - Create a `vault` directory in the project root
   - Copy your Obsidian vault contents into this directory
   - Ensure your vault contains:
     - Core D&D books (PHB, DMG, MM, etc.)
     - Campaign notes
     - Session logs
     - World building documents
     - NPC information
     - House rules
     - Maps and locations
     - Faction information
     - Historical records

5. add the buildPrompt to prompt.ts:

```ts
export function buildPrompt(input: string, retrievedContent: string): string;
```

## Project Structure

```
dnd_llm/
├── vault/                 # Your Obsidian vault contents
├── db/                    # Vector store and cache
├── src/
│   ├── chunker.ts         # Processes and embeds markdown content with semantic chunking and vector embeddings.
│   ├── fileProcessing.ts  # File system watcher and processor for markdown files in a vault directory.
│   ├── ollama.ts          # Integration with the Ollama API for text embedding and model management.
│   ├── search.ts          # Hybrid search implementation combining vector similarity and keyword matching.
│   └── vectorStore.ts     # Vector store management for the LLM system using LocalIndex from vectra.
└── lib/                   # Utility functions
```

## Usage

1. Start the application:

```bash
npm start
```

2. Use the interactive CLI:
   - Enter natural language queries
   - Use metadata filters with `[key=value]` syntax
   - Special commands:
     - `/quit` - Exit the application
     - `/help` - Show help information

### Search Examples

- Basic search:

```
What are the rules for grappling?
```

- Search with metadata filter:

```
[filePath=PHB.md] What are the rules for grappling?
```

- Search within specific heading:

```
[heading=Combat] How does opportunity attack work?
```

## Configuration

The system uses several configuration files:

- `src/ollama.ts`: Ollama API configuration
- `src/vectorStore.ts`: Vector store settings
- `src/chunker.ts`: Text chunking parameters

Key configuration options:

- Vector store backup interval
- Chunk size limits
- Search result limits
- Model fallback settings

## Maintenance

The system automatically performs several maintenance tasks:

- Vector store optimization
- Orphaned vector cleanup
- Regular backups
- Cache management

## Troubleshooting

1. **Ollama Connection Issues**:

   - Ensure Ollama is running: `ollama serve`
   - Check if models are downloaded: `ollama list`
   - Verify API endpoint: `http://localhost:11434`

2. **Vector Store Issues**:

   - Check `db/` directory permissions
   - Verify sufficient disk space
   - Check logs for corruption warnings

3. **File Processing Issues**:
   - Ensure vault directory exists
   - Check file permissions
   - Verify markdown file format

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

[Your License Here]

## Acknowledgments

- [Ollama](https://ollama.ai/) for the LLM infrastructure
- [Vectra](https://github.com/vectra-ai/vectra) for vector storage
- [Obsidian](https://obsidian.md/) for the vault structure
