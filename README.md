# pi-mini-agent

A minimal subagent extension for Pi.

## Features

- `agent` tool with `explorer` (medium), `reviewer` (xhigh), and `work` (high) modes
- isolated child Pi process
- inherits the parent model with role-specific thinking levels
- streams assistant and tool activity
- reports input/output/cache tokens and cost
- abort propagation
- disposable sessions
- child extensions disabled

## Install

```sh
pi install npm:@lincie/pi-mini-agent
```

## Usage

```ts
// quick read-only discovery
agent { mode: "explorer", prompt: "Find the authentication flow" }
// deep read-only review
agent { mode: "reviewer", prompt: "Review the authentication flow for risks" }
// work mode can edit
agent { mode: "work", prompt: "Refactor X and add tests", cwd: "/path" }
```

## Requirements

- Node >=20
- pi-coding-agent

## License

MIT
