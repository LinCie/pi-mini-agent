# pi-mini-agent

A minimal subagent extension for Pi.

## Features

- `agent` tool with `read` and `work` modes
- isolated child Pi process
- inherits parent model and thinking effort
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
// read-only investigation
agent { mode: "read", prompt: "Summarize architecture" }
// work mode can edit
agent { mode: "work", prompt: "Refactor X and add tests", cwd: "/path" }
```

## Requirements

- Node >=20
- pi-coding-agent

## License

MIT
