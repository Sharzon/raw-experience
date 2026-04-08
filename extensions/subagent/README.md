# Subagent Extension

Generic subagent tool with configurable nesting depth control.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Nesting depth control**: Limit how deep subagents can create other subagents
- **Configurable**: Local (`.pi/subagent-config.json`) or global (`~/.pi/agent/subagent-config.json`) config
- **Streaming support**: See progress as subagent works

## Installation

The extension is already part of the raw-experience package. It will be automatically loaded when using the package.

To use standalone, symlink:
```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf /path/to/raw-experience/extensions/subagent/index.ts ~/.pi/agent/extensions/subagent/index.ts
```

## Configuration

### Priority

1. **Local config**: `./.pi/subagent-config.json` (project-level)
2. **Global config**: `~/.pi/agent/subagent-config.json` (user-level)
3. **Default**: `maxDepth: 1`

### Config File Format

```json
{
  "maxDepth": 2
}
```

- `maxDepth: 1` - Main agent can create subagents, but subagents cannot create more
- `maxDepth: 2` - Main → subagent → subagent (2 levels)
- `maxDepth: 3` - Main → subagent → subagent → subagent (3 levels)

## Usage

### Basic

```
Call subagent with task: Write a summary of the current directory structure
```

### Nested Call (if maxDepth > 1)

```
Call subagent with task: Call subagent again with task: Find all TODO comments
```

### With Custom Options

```
Use subagent tool with:
- task: "Analyze the code"
- model: "claude-sonnet-4-5"
- thinking: "high"
```

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | string | Task/prompt for the subagent |
| `model` | string? | Model to use (e.g., 'claude-sonnet-4-5') |
| `tools` | string[]? | List of tools to enable |
| `systemPrompt` | string? | Custom system prompt for subagent |
| `thinking` | string? | Thinking level: off, minimal, low, medium, high, xhigh |
| `maxDepth` | number? | Override max depth for this call |

## Commands

- `/subagent-config` - Show current configuration
- `/subagent-config <number>` - Set max depth (saves to global config)

## Examples

### Depth = 1 (Default)

```
agent → subagent (cannot create more)
```

### Depth = 2

```
agent → subagent → subagent (last one cannot create more)
```

### Depth = 3

```
agent → subagent → subagent → subagent (cannot go deeper)
```

## How It Works

1. Main agent has `remainingDepth = maxDepth`
2. When calling subagent, passes `remainingDepth - 1` via environment variable
3. Subagent process receives the depth and enforces the limit
4. When `remainingDepth = 0`, subagent cannot create more subagents
