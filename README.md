# Cloudinary Plugin for Cursor

A Cursor plugin that brings Cloudinary's media management capabilities directly into your coding workflow. It connects your AI coding agent to Cloudinary's MCP servers and provides a documentation skill so you can get accurate, up-to-date answers about Cloudinary APIs without leaving your editor.

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

> **Note:** The `cloudinary-mediaflows` server requires your Cloudinary credentials (`cloud_name`, `api_key`, `api_secret`) to be set in the headers.

### Skills (`skills/cloudinary-docs/`)

The **cloudinary-docs** skill teaches the agent how to answer Cloudinary questions by fetching live documentation directly from `cloudinary.com/documentation/llms.txt`. This ensures answers are accurate and include real code examples, rather than relying on potentially outdated training data.

## Getting Started

1. Install this plugin in Cursor.
2. Add your Cloudinary credentials to the `cloudinary-mediaflows` server headers in `mcp.json`.
3. Ask your agent anything about Cloudinary — uploads, transformations, metadata, analysis, and more.
