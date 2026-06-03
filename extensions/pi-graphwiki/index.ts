/**
 * pi-graphwiki — Self-curating wiki from graphify knowledge graphs.
 *
 * Registers:
 * - `graphwiki_generate` tool — generate wiki from graphify output
 * - `graphwiki_status` tool — show generation status and indexing instructions
 * - `/graphwiki` command — quick operations (status, generate)
 *
 * Architecture: standalone pi extension. Does NOT fork or patch graphify.
 * Reads graphify's standard output format (graph.json only — analysis files
 * are deleted by graphify's post-processing, so everything is re-derived).
 */

import type { ExtensionAPI, ToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateWiki, type GenerateOptions } from "./wiki-gen.js";

// ──────────────────────────────────────────────────────────────────────────
// Runtime state
// ──────────────────────────────────────────────────────────────────────────

interface GraphWikiState {
  lastGraphDir: string | null;
  lastWikiDir: string | null;
  lastNodeCount: number;
  indexed: boolean;
}

const state: GraphWikiState = {
  lastGraphDir: null,
  lastWikiDir: null,
  lastNodeCount: 0,
  indexed: false,
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function findNearestGraphDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "graphify-out");
    if (fs.existsSync(path.join(candidate, "graph.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildStatusText(): string {
  if (!state.lastGraphDir) return "No wiki generated yet";
  return [
    `Graph dir: ${state.lastGraphDir}`,
    `Wiki dir: ${state.lastWikiDir || "N/A"}`,
    `Nodes wikified: ${state.lastNodeCount}`,
    `Indexed in mempalace: ${state.indexed ? "yes" : "no"}`,
  ].join("\n");
}

function countWikiFiles(wikiDir: string): number {
  let count = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".md")) {
        count++;
      }
    }
  };
  walk(wikiDir);
  return count;
}

// ──────────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool: graphwiki_generate ──────────────────────────────────────────
  pi.registerTool({
    name: "graphwiki_generate",
    label: "GraphWiki Generate",
    description:
      "Generate a self-curating wiki from graphify output. " +
      "Reads graphify-out/graph.json and produces concept pages, community " +
      "overviews, comparisons, and a glossary index. " +
      "After generation, index into mempalace with: ctx_index(path, source=\"graphify-wiki\")",
    promptSnippet: "Generate wiki docs from a knowledge graph",
    promptGuidelines: [
      "Use graphwiki_generate after graphify has finished building a graph.",
      "After generation, index the wiki into mempalace with ctx_index for semantic search.",
    ],
    parameters: Type.Object({
      graphDir: Type.Optional(
        Type.String({
          description:
            "Path to graphify output directory (containing graph.json). " +
            "Defaults to the nearest graphify-out/ directory.",
        })
      ),
      outputDir: Type.Optional(
        Type.String({
          description:
            "Override wiki output directory. Defaults to <graphDir>/wiki/.",
        })
      ),
    }),
    async execute(
      toolCallId: string,
      params: { graphDir?: string; outputDir?: string },
      signal: AbortSignal,
      onUpdate: ((update: ToolResult) => void) | undefined,
      _ctx: unknown
    ): Promise<ToolResult> {
      const graphDir =
        params.graphDir ||
        findNearestGraphDir(process.cwd()) ||
        path.join(process.cwd(), "graphify-out");

      if (!fs.existsSync(path.join(graphDir, "graph.json"))) {
        return {
          content: [
            {
              type: "text",
              text:
                `No graph.json found at ${graphDir}. ` +
                "Run graphify first to generate the knowledge graph.",
            },
          ],
          details: {},
        };
      }

      const opts: GenerateOptions = {
        graphDir,
        wikiDir: params.outputDir,
      };

      onUpdate?.({ content: [{ type: "text", text: "Generating wiki..." }], details: {} });

      try {
        const result = generateWiki(opts);

        state.lastGraphDir = graphDir;
        state.lastWikiDir = result.wikiDir;
        state.lastNodeCount = result.nodeCount;
        state.indexed = false;

        const summary = [
          `**Wiki generated in ${result.duration}ms**`,
          "",
          `- Nodes: ${result.nodeCount}`,
          `- Communities: ${result.communityCount}`,
          `- Comparisons: ${result.comparisonCount}`,
          `- Files: ${result.generatedFiles.length}`,
          "",
          `Output: \`${result.wikiDir}/\``,
          `  INDEX.md        — Full glossary`,
          `  nodes/          — ${result.nodeCount} concept pages`,
          `  communities/    — ${result.communityCount} community overviews`,
          result.comparisonCount > 0
            ? `  comparisons/    — ${result.comparisonCount} structural comparisons`
            : "",
          "",
          "To index into mempalace for semantic search:",
          "",
          `  ctx_index(path: "${result.wikiDir}", source: "graphify-wiki")`,
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text: summary }],
          details: {
            nodeCount: result.nodeCount,
            communityCount: result.communityCount,
            comparisonCount: result.comparisonCount,
            fileCount: result.generatedFiles.length,
            wikiDir: result.wikiDir,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Wiki generation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── Tool: graphwiki_status ───────────────────────────────────────────
  pi.registerTool({
    name: "graphwiki_status",
    label: "GraphWiki Status",
    description:
      "Show the status of the last wiki generation: how many nodes, " +
      "communities, and files were generated, and the output directory.",
    promptSnippet: "Check wiki generation status",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal,
      _onUpdate: ((update: ToolResult) => void) | undefined,
      _ctx: unknown
    ): Promise<ToolResult> {
      if (!state.lastWikiDir) {
        return {
          content: [
            {
              type: "text",
              text: "No wiki has been generated yet. Run graphwiki_generate first.",
            },
          ],
          details: {},
        };
      }

      const fileCount = countWikiFiles(state.lastWikiDir);

      return {
        content: [
          {
            type: "text",
            text: [
              `**GraphWiki Status**`,
              "",
              `- Graph dir: ${state.lastGraphDir}`,
              `- Wiki dir: ${state.lastWikiDir}`,
              `- Nodes wikified: ${state.lastNodeCount}`,
              `- Wiki files: ${fileCount}`,
              `- Indexed in mempalace: ${state.indexed ? "yes" : "no"}`,
              "",
              "To index into mempalace for semantic search:",
              "",
              `  ctx_index(path: "${state.lastWikiDir}", source: "graphify-wiki")`,
            ].join("\n"),
          },
        ],
        details: {
          graphDir: state.lastGraphDir,
          wikiDir: state.lastWikiDir,
          nodeCount: state.lastNodeCount,
          fileCount,
          indexed: state.indexed,
        },
      };
    },
  });

  // ── Command: /graphwiki ──────────────────────────────────────────────
  pi.registerCommand("graphwiki", {
    description: "GraphWiki commands: status, generate",
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0] || "status";

      switch (cmd) {
        case "status": {
          ctx.ui.notify(buildStatusText(), "info");
          break;
        }

        case "generate": {
          const graphDir = parts[1] || findNearestGraphDir(ctx.cwd) || "";
          if (!graphDir) {
            ctx.ui.notify(
              "No graphify-out directory found. Provide a path or run graphify first.",
              "error"
            );
            return;
          }
          try {
            const result = generateWiki({ graphDir });
            state.lastGraphDir = graphDir;
            state.lastWikiDir = result.wikiDir;
            state.lastNodeCount = result.nodeCount;
            state.indexed = false;
            ctx.ui.notify(
              `Wiki generated: ${result.nodeCount} nodes, ${result.communityCount} communities → ${result.wikiDir}/`,
              "info"
            );
          } catch (err) {
            ctx.ui.notify(
              `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
              "error"
            );
          }
          break;
        }

        default:
          ctx.ui.notify("Commands: status, generate [path]", "info");
      }
    },
  });
}
