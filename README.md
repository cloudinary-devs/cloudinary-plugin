# Cloudinary Plugin

A coding agent plugin that brings Cloudinary's media management capabilities directly into your coding workflow. It connects your AI coding agent to Cloudinary's MCP servers and provides a documentation skill so you can get accurate, up-to-date answers about Cloudinary APIs without leaving your editor.

## What's Included

### MCP Servers (`mcp.json`)

Five Cloudinary MCP servers are pre-configured:

| Server | Description |
|---|---|
| `cloudinary-asset-mgmt` | Upload, manage, and transform media assets |
| `cloudinary-env-config` | Configure your Cloudinary environment settings |
| `cloudinary-smd` | Work with structured metadata on assets |
| `cloudinary-analysis` | Analyze images and videos with AI |
| `cloudinary-mediaflows` | Build and run automated media workflows |

> **Auth:** The first four servers use OAuth2 — you'll be prompted to log in with your Cloudinary account on first use via Cursor or Claude. The `cloudinary-mediaflows` server requires your Cloudinary credentials (`cloud_name`, `api_key`, `api_secret`) to be set in the headers in `mcp.json`.

### Skills

Two skills are included to give the agent deep Cloudinary knowledge:

| Skill | Directory | Description |
|---|---|---|
| **cloudinary-docs** | `skills/cloudinary-docs/` | Answers Cloudinary questions by fetching live documentation from `cloudinary.com/documentation/llms.txt`, ensuring accurate and up-to-date responses with real code examples. |
| **cloudinary-transformations** | `skills/cloudinary-transformations/` | Creates and debugs Cloudinary transformation URLs from natural language. Covers resize/crop, generative AI effects, video transformations, overlays, named transformations, and cost optimization — with a built-in validation checklist and debugging guide. |

## Getting Started

### Cursor

1. Copy the contents of `mcp.json` into your project's `.cursor/mcp.json` (create the file if it doesn't exist).
2. Copy the `skills/` directory into your project root.
3. In `.cursor/rules/`, create one rule file per skill — each pointing to its `SKILL.md`. Cursor will use the rule description to decide when to invoke the skill.
4. For `cloudinary-mediaflows`, replace `YOUR_CLOUD_NAME`, `YOUR_API_KEY`, and `YOUR_API_SECRET` in `mcp.json` with your Cloudinary credentials (found in the [Cloudinary Console](https://console.cloudinary.com/settings/api-keys)).
5. On first use, approve the OAuth login prompt that Cursor shows for the other four MCP servers.

### Claude Code

1. Run: `claude --plugin-dir /path/to/cloudinary-plugin`
2. For `cloudinary-mediaflows`, replace the credential placeholders in `mcp.json` before starting.
3. On first use, complete the OAuth login for the other four MCP servers.

Once installed, ask your agent anything about Cloudinary — uploads, transformations, metadata, analysis, and more. The agent will automatically use the right skill and MCP server for the job.

### Example prompts

- "Upload this image to my Cloudinary account and resize it to 800px wide: [URL]"
- "Remove the background from my product photo and replace it with a white padded square at 1000x1000"
- "Debug this Cloudinary URL — it's not cropping correctly: [URL]"
- "How do I set up the Cloudinary Node.js SDK in my Express app?"
- "List all images in my account uploaded in the last 7 days"
