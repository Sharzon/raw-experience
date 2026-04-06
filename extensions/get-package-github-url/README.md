# get-package-github-url

Pi Extension for getting GitHub repository URL for packages by language and package name.

## Features

- **Python packages** - Uses PyPI API to find GitHub repository URL
- **JavaScript/TypeScript packages** - Uses npm registry to find GitHub repository URL
- **Automatic fallback** - Falls back to GitHub Search if package not found in primary providers

## Installation

```bash
# Global (for all projects)
cp -r get-package-github-url ~/.pi/agent/extensions/

# Or local (for project)
mkdir -p .pi/extensions
cp -r get-package-github-url .pi/extensions/
```

## Usage

In Pi, ask for GitHub URL of a package:

```
User: Get GitHub URL for python package "requests"
LLM: [Tool: get_package_github_url] language=python package=requests
→ {"github_url": "https://github.com/psf/requests", "provider": "pypi"}
```

## Supported Languages

- `python` - PyPI
- `javascript` - npm
- `typescript` - npm

## Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| language | string | Yes | Programming language: python, javascript, or typescript |
| package | string | Yes | Package name |

## Response Format

Success:
```json
{
  "github_url": "https://github.com/user/repo",
  "provider": "pypi" | "npm" | "github_fallback"
}
```

Error:
```json
{
  "error": "Error message"
}
```
