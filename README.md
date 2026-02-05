# Dapr Workflow Visualizer

Visualize [Dapr workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/) as interactive graphs directly in VS Code.

## Features

- **Visual Workflow Graphs** — Convert Dapr workflow code into interactive flow diagrams
- **Multi-Language Support** — Python, C#, JavaScript, TypeScript
- **Click-to-Navigate** — Click any node to jump to that line in your code
- **Auto-Refresh** — Updates automatically when you save
- **Export to SVG** — Save diagrams for documentation

## Quick Start

1. Open a Dapr workflow file
2. Click **"Visualize Workflow"** in the CodeLens above `@workflow` / `[Workflow]`

Or use Command Palette: `Dapr: Visualize Dapr Workflow`

## Node Types

| Node | Shape | Description |
|------|-------|-------------|
| Start | Green pill | Workflow entry point |
| End | Red pill | Workflow completion |
| Activity | Blue rectangle | Activity invocation |
| Event | Orange hexagon | External event wait |
| Decision | Yellow diamond | Conditional branch |
| Parallel | Double-border | Fan-out/fan-in join |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+G` | Navigate to node at cursor |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `daprWorkflowVisualizer.defaultLayout` | `dagre` | Layout algorithm |
| `daprWorkflowVisualizer.showActivityDetails` | `true` | Show details on hover |

## Requirements

- VS Code 1.108.0 or higher
- Dapr workflow files (Python, C#, JS/TS)

## Links

- [Dapr Workflow Documentation](https://docs.dapr.io/developing-applications/building-blocks/workflow/)

## License

Apache 2.0
