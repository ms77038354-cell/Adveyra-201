# ADVEYRA AI STUDIO

A GitHub-ready starter for a private, browser-based AI coding workspace.

## Included

- Single-admin login (no public signup)
- OpenAI Responses API integration
- AI tool calling for listing, reading, creating and editing workspace files
- Three-panel interface: agent chat, file editor, static HTML preview
- Optional GitHub push integration using a fine-grained personal access token
- Render deployment configuration

## Important scope and limitations

This is a working starter, not a full replacement for Google AI Studio or a full cloud IDE.

The agent can create, read and edit project files. It **does not** execute arbitrary shell commands, install npm packages, run backend project previews, or deploy arbitrary generated projects. Those capabilities require a separately provisioned isolated sandbox/runner and are intentionally not exposed on this starter to avoid executing untrusted model-generated commands on the production server.

The static preview supports HTML files only. The workspace filesystem on free hosting may be ephemeral. For durable project files, use GitHub push or attach persistent storage supported by your host.

OpenAI API usage is billed separately from ChatGPT subscriptions. The model name in `OPENAI_MODEL` must be available to your API account.

## Run locally

Requirements: Node.js 20+

```bash
npm install
```

Create a password hash:

```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('CHOOSE_A_STRONG_PASSWORD',12))"
```

Set environment variables (do not commit `.env`):

```bash
export ADMIN_USERNAME="your-admin-username"
export ADMIN_PASSWORD_HASH="paste-the-bcrypt-hash"
export SESSION_SECRET="use-a-long-random-secret"
export OPENAI_API_KEY="your-openai-api-key"
export OPENAI_MODEL="gpt-5.5"
npm start
```

Open `http://localhost:10000`.

## Deploy from GitHub to Render

1. Create a new **private** GitHub repository.
2. Upload/push all files from this project to the repository root.
3. In Render, choose **New > Web Service**, connect the repository, and deploy.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add these environment variables in Render:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD_HASH` (generate locally using the command above)
   - `SESSION_SECRET` (long random secret)
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (a model enabled for your API account)
   - Optional GitHub push:
     - `GITHUB_TOKEN`
     - `GITHUB_OWNER`
     - `GITHUB_REPO`
     - `GITHUB_BRANCH` (usually `main`)

Never put secrets in GitHub source files. Use the hosting provider's environment variable settings.

## GitHub token permissions

For the optional push button, create a fine-grained GitHub token restricted to the target repository with **Contents: Read and write**. Keep it private and configure it only as `GITHUB_TOKEN` on the server.

## Production hardening before public use

- Use a strong unique admin password and session secret.
- Keep the GitHub repository private if it contains private project source.
- Configure HTTPS (Render provides it).
- Add persistent storage or use GitHub as the durable source of truth.
- Add a sandbox service before enabling terminal execution or live execution of generated code.
- Review OpenAI API usage and spending limits in the OpenAI Platform.
