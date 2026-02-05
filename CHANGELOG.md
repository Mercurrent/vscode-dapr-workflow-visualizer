# Changelog

All notable changes to the "Dapr Workflow Visualizer" extension will be documented in this file.

## [0.0.1] - 2026-01-27

### Added
- Initial release
- Parse Dapr workflows from Python, C#, JavaScript, and TypeScript files
- Interactive graph visualization with Dagre layout
- Multi-workflow support (multiple workflows per file)
- Click-to-navigate from graph nodes to source code
- Hover tooltips showing activity inputs, outputs, and line numbers
- Node types: Start, End, Activity, Event, Decision, Parallel (fan-out/fan-in)
- Auto-refresh visualization on file save
- Export workflow diagrams to SVG
- CodeLens annotations for quick visualization access
- Keyboard shortcut (Cmd/Ctrl+Shift+G) to navigate to node at cursor
- VS Code theme integration (light/dark mode support)

### Supported Dapr Workflow Patterns
- Sequential activities (`await ctx.call_activity(...)`)
- Parallel execution (`when_all`, `when_any`)
- External events (`wait_for_external_event`)
- Conditional branching (`if`/`else`)
- Sub-orchestrations (`call_child_workflow`)