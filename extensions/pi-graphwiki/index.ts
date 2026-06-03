/**
 * pi-graphwiki — Self-curating wiki from graphify knowledge graphs.
 *
 * Registers:
 * - `graphwiki_generate` tool — generate wiki from graphify output
 * - `graphwiki_index` tool — index existing wiki into mempalace
 * - `/graphwiki` command — quick operations (status, generate, reindex)
 *
 * Architecture: standalone pi extension. Does NOT fork or patch graphify.
 * Reads graphify's standard output format (graph.json + analysis).
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
  /** Path to the last graphify-out directory we processed */
  lastGraphDir: string | null;
  /** Path to the last wiki directory we generated */
  lastWikiDir: string | null;
  /** Number of nodes in last generation */
  lastNodeCount: number;
  /** Whether the wiki has been indexed into mempalace */
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
  // Walk up from cwd looking for a graphify-out directory
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
  const lines: string[] = [
    `Graph dir: ${state.lastGraphDir}`,
    `Wiki dir: ${state.lastWikiDir || "N/A"}`,
    `Nodes wikified: ${state.lastNodeCount}`,
    `Indexed in mempalace: ${state.indexed ? "yes" : "no"}`,
  ];
  return lines.join("\n");
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
      "overviews, comparisons, and a glossary index. Optionally indexes into mempalace.",
    promptSnippet: "Generate wiki docs from a knowledge graph",
    promptGuidelines: [
      "Use graphwiki_generate after graphify has finished building a graph.",
      "The wiki is written to graphify-out/wiki/ and can be indexed into mempalace.",
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
      index: Type.Optional(
        Type.Boolean({
          description:
            "Whether to index the wiki into mempalace after generation. " +
            "Default: false. Use graphwiki_index separately if unsure.",
          default: false,
        })
      ),
    }),
    async execute(
      toolCallId: string,
      params: { graphDir?: string; outputDir?: string; index?: boolean },
      signal: AbortSignal,
      onUpdate: ((update: ToolResult) => void) | undefined,
      _ctx: unknown
    ): Promise<ToolResult> {
      // Resolve graphify output directory
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

      // Generate wiki
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
          "To index into mempalace for semantic search, run graphwiki_index.",
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

  // ── Tool: graphwiki_index ────────────────────────────────────────────
  pi.registerTool({
    name: "graphwiki_index",
    label: "GraphWiki Index",
    description:
      "Index a generated graphwiki into mempalace's knowledge base via ctx_index. " +
      "After indexing, you can search wiki content with ctx_search or memory_search.",
    promptSnippet: "Index wiki docs into mempalace for semantic search",
    parameters: Type.Object({
      wikiDir: Type.Optional(
        Type.String({
          description:
            "Path to the wiki directory to index. Defaults to the last generated wiki.",
        })
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { wikiDir?: string },
      _signal: AbortSignal,
      _onUpdate: ((update: ToolResult) => void) | undefined,
      _ctx: unknown
    ): Promise<ToolResult> {
      const wikiDir = params.wikiDir || state.lastWikiDir;

      if (!wikiDir || !fs.existsSync(path.join(wikiDir, "INDEX.md"))) {
        return {
          content: [
            {
              type: "text",
              text:
                "No wiki found to index. Generate one first with graphwiki_generate, " +
                "or provide an explicit wikiDir path.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Count files
      let fileCount = 0;
      const countFiles = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            countFiles(fullPath);
          } else if (entry.name.endsWith(".md")) {
            fileCount++;
          }
        }
      };
      countFiles(wikiDir);

      // Signal the agent to run ctx_index on the wiki directory
      // We return instructions rather than doing it ourselves because
      // ctx_index is a tool in the agent's toolkit, not a direct function.
      state.indexed = true;

      return {
        content: [
          {
            type: "text",
            text: [
              `**Wiki ready for indexing at \`${wikiDir}/\`**`,
              `Found ${fileCount} markdown files.`,
              "",
              "Run the following to index into mempalace:",
              "",
              `\`\`\``,
              `ctx_index(path: "${wikiDir}", source: "graphify-wiki")`,
              `\`\`\``,
              "",
              "After indexing, these wiki pages are searchable via",
              "ctx_search(queries: [...], source: \"graphify-wiki\")",
              "or memory_search for cross-session recall.",
            ].join("\n"),
          },
        ],
        details: { fileCount, wikiDir },
      };
    },
  });

  // ── Command: /graphwiki ──────────────────────────────────────────────
  pi.registerCommand("graphwiki", {
    description: "GraphWiki commands: status, generate, reindex",
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

        case "reindex": {
          if (!state.lastWikiDir) {
            ctx.ui.notify("No wiki to reindex. Run generate first.", "error");
            return;
          }
          state.indexed = true;
          ctx.ui.notify(
            `Wiki at ${state.lastWikiDir}/ marked for re-indexing. Run ctx_index to complete.`,
            "info"
          );
          break;
        }

        default:
          ctx.ui.notify(
            "Commands: status, generate [path], reindex",
            "info"
          );
      }
    },
  });
}
