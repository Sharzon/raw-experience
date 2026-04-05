# Permission System for pi-coding-agent

A security extension for pi-coding-agent that controls file and tool access based on configurable rules.

## Features

- **Allow/Deny rules** for read, write, and edit operations
- **Wildcard support** (`*`, `**`) for path patterns
- **Global and local configuration** files
- **Priority system**: local > global, more specific > less specific
- **User confirmation** for restricted operations
- **Session-based permissions** that persist during the session
- **Custom tool** `request_permission` for proactive permission requests

## File Structure

```
raw-experience/
├── package.json              # Pi package manifest
├── permission/
│   ├── index.ts              # Main extension entry point
│   ├── types.ts              # TypeScript types
│   ├── config.ts             # Configuration loading
│   ├── path-matching.ts      # Wildcard/glob matching
│   └── configs/
│       ├── global.json       # Global config example
│       └── local.json        # Local config example
├── src/                      # Legacy source (for compatibility)
├── schema/                   # JSON schema
└── README.md
```

## Installation

```bash
pi install git:github.com/user/repo
```

Or as a local package:

```bash
npm install ./path/to/raw-experience
```

## Configuration

### Configuration Files

| Level | Path | Description |
|-------|------|-------------|
| Global | `~/.pi/agent/permission-settings.json` | Applies to all projects |
| Local | `.pi/permission-settings.json` | Applies to current project |

### Configuration Format

```json
{
  "allow": {
    "read": ["**"],
    "write": ["**"],
    "edit": ["**"]
  },
  "deny": {
    "read": [".env", ".ssh/**", "**/*.pem"],
    "write": [".ssh/**", "**/*.pem", "package-lock.json"],
    "edit": [".env", ".ssh/**", "**/*.pem"]
  },
  "autoDeny": false
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| allow.read | string[] | ["**"] | Paths allowed for reading |
| allow.write | string[] | ["**"] | Paths allowed for writing |
| allow.edit | string[] | ["**"] | Paths allowed for editing |
| deny.read | string[] | [] | Paths denied for reading |
| deny.write | string[] | [] | Paths denied for writing |
| deny.edit | string[] | [] | Paths denied for editing |
| autoDeny | boolean | false | Block operations without asking |

### Wildcard Syntax

- `*` — matches any characters within a single path segment
- `**` — matches any characters including subdirectories (recursive)
- Case-sensitive: **yes**

#### Examples

| Pattern | Matches | Does not match |
|---------|---------|----------------|
| `/project/*.js` | `/project/app.js` | `/project/lib/app.js` |
| `/project/**/*.js` | `/project/app.js`, `/project/lib/util.js` | `/project/package.json` |
| `/project/secrets` | Everything in `/project/secrets/` and subdirectories | - |

### Priority Rules

1. **Local config** has priority over global config
2. **More specific path** has priority over less specific:
   - Fewer matches = higher priority
   - Example: `/project/secrets/nested/deeper/` is more specific than `/project/secrets/`

#### Example

```json
{
  "deny": {
    "read": ["/project/secrets/**"]
  },
  "allow": {
    "read": ["/project/secrets/public/**"]
  }
}
```

- `/project/secrets/public/file.txt` → **allowed** (more specific allow)
- `/project/secrets/private/file.txt` → **denied** (only deny)

## Usage

### Commands

```bash
/permissions           # Show current permissions status
/permissions-reload    # Reload permissions configuration
/permissions-clear-session  # Clear session permissions
```

### request_permission Tool

Agents can proactively request permission before attempting operations:

```typescript
// Agent calls this tool
request_permission({
  path: ".env",
  action: "read",
  reason: "Need to read database configuration"
});
```

If the user confirms, the path is added to session permissions and the operation proceeds.

### Default Policy

- **Allowed**: Everything in the current working directory (cwd) where pi is running
- **Denied**: Everything outside the project (including system directories)

## Behavior

### Tool Interception

The extension subscribes to `tool_call` events and checks each call:

- **Read tool**: Checks `path` from arguments against `read` rules
- **Write tool**: Checks `path` from arguments against `write` rules
- **Edit tool**: Checks `path` from arguments against `edit` rules
- **Bash tool**: Analyzes the command and extracts paths before execution
- **Grep tool**: Checks files/directories being searched

### Blocking

When a restricted path is detected:

- **If `autoDeny: false`** (default):
  - User is prompted via `ctx.ui.confirm()`
  - User can allow or deny
  - If allowed, permission persists for the session

- **If `autoDeny: true`**:
  - Operation is blocked without prompt
  - Returns the reason for blocking

### Session Permissions

After user confirmation:
- Path/wildcard is added to session's allowed list
- Valid until the session ends
- Next access to the same path is allowed without prompt

## Configuration Examples

See `permission/configs/` for example configuration files:

- `permission/configs/global.json` - Global settings (applies to all projects)
- `permission/configs/local.json` - Local settings (applies to current project)

### Global Config (~/.pi/agent/permission-settings.json)

```json
{
  "allow": {
    "read": ["**"],
    "write": ["**"],
    "edit": ["**"]
  },
  "deny": {
    "read": [".env", ".ssh/**", "**/*.pem"],
    "write": [".ssh/**", "**/*.pem", "package-lock.json"],
    "edit": [".env", ".ssh/**", "**/*.pem"]
  },
  "autoDeny": false
}
```

### Local Config (.pi/permission-settings.json)

```json
{
  "allow": {
    "read": ["src/**", "tests/**", "docs/**", "*.md"],
    "write": ["src/**", "tests/**", "docs/**"],
    "edit": ["src/**"]
  },
  "deny": {
    "read": ["src/secrets/**"],
    "write": ["src/secrets/**", "**/*.test.ts"],
    "edit": ["src/secrets/**", "tests/**"]
  },
  "autoDeny": false
}
```

## References

- [Pi-coding-agent extensions documentation](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs/extensions.md)
- [Examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
