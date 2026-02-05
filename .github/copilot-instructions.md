# Dapr Workflow Visualizer - VS Code Extension

## Project Overview
This is a VS Code extension for visualizing Dapr workflows as interactive graphs. It parses workflow definitions from code files and renders them in a webview panel.

## Tech Stack
- TypeScript for extension code
- D3.js for graph visualization
- Webpack for bundling
- VS Code Extension API

## Key Features
- Parse Dapr workflow definitions (C#, Python, JavaScript)
- Visualize workflow activities and orchestrations
- Interactive graph navigation
- State transition visualization

## Development Guidelines
- Use VS Code Webview API for rendering graphs
- Follow VS Code extension best practices
- Keep visualization performant for large workflows
- Support multiple Dapr SDK languages

## Commands
- `dapr-workflow-visualizer.visualize` - Open workflow visualization
- `dapr-workflow-visualizer.refresh` - Refresh current visualization

## File Structure
- `src/extension.ts` - Extension entry point
- `src/parsers/` - Workflow parsers for different languages
- `src/webview/` - Webview panel and graph rendering
- `media/` - Static assets for webview
