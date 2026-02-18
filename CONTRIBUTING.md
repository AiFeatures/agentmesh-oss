# Contributing

Thanks for contributing to AgentMesh OSS.

## Requirements

- Node.js 22+
- pnpm 9+

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Development Workflow

1. Create a branch from `main`.
2. Make focused changes.
3. Run checks locally:

```bash
pnpm lint
pnpm test
pnpm build
```

4. Update docs when API, protocol, or behavior changes.
5. Open a pull request using `.github/PULL_REQUEST_TEMPLATE.md`.

## Code Style

- TypeScript, strict mode
- Biome for formatting/linting
- Keep dependencies minimal and OSS-friendly
- Prefer small, composable modules

## Commit Guidelines

- Use clear commit messages with intent
- Keep each commit focused on one change
- Avoid bundling refactors with behavior changes unless necessary

## Pull Request Expectations

- Describe the problem and why the change is needed
- List behavior changes
- Include test coverage for new logic
- Note any migration or compatibility impact

## Security

- Never commit secrets
- Report vulnerabilities privately as described in `docs/security.md`
- Keep shared-secret and auth flows simple and explicit
