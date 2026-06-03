/**
 * wiki-gen.ts — Core wiki generation engine for pi-graphwiki.
 *
 * Reads graphify's output (graph.json + analysis) and writes a wiki/
 * directory with concept pages, community overviews, comparisons, and a
 * glossary index. No external dependencies — pure data-structure work.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  GraphData,
  GraphNode,
  GraphEdge,
  GraphAnalysis,
  NodeWiki,
  SynthesizedEdge,
  CommunityWiki,
  Comparison,
  WikiGenResult,
  Surprise,
} from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "unnamed";
}

function escapeMd(text: string): string {
  return text.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
  );
}

// Simple Jaccard similarity between two string arrays
function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ──────────────────────────────────────────────────────────────────────────
// Load
// ──────────────────────────────────────────────────────────────────────────

interface LoadedData {
  graph: GraphData;
  nodesById: Map<string, GraphNode>;
  analysis: GraphAnalysis | null;
  nodeToCommunity: Map<string, number>;
  communityLabels: Map<number, string>;
  godNodeSet: Set<string>;
  surprisesBySource: Map<string, Surprise[]>;
  surprisesByTarget: Map<string, Surprise[]>;
}

function loadData(graphDir: string): LoadedData {
  const graphPath = path.join(graphDir, "graph.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error(`graph.json not found at ${graphPath}. Run graphify first.`);
  }

  const graph: GraphData = JSON.parse(fs.readFileSync(graphPath, "utf-8"));

  // Build node index
  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    nodesById.set(n.id, n);
  }

  // Try to load analysis
  let analysis: GraphAnalysis | null = null;
  const analysisPath = path.join(graphDir, ".graphify_analysis.json");
  if (fs.existsSync(analysisPath)) {
    try {
      analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
    } catch {
      // Non-fatal — analysis is optional
    }
  }

  // Community mapping: node_id → community_id
  const nodeToCommunity = new Map<string, number>();
  const communityLabels = new Map<number, string>();

  if (analysis?.communities) {
    for (const [cidStr, nodeIds] of Object.entries(analysis.communities)) {
      const cid = Number(cidStr);
      for (const nid of nodeIds) {
        nodeToCommunity.set(nid, cid);
      }
    }
  }

  // Fallback: use inline community mapping from graph.json
  if (nodeToCommunity.size === 0 && graph.community) {
    for (const [nid, cid] of Object.entries(graph.community)) {
      nodeToCommunity.set(nid, cid);
    }
  }

  // God nodes set
  const godNodeSet = new Set<string>();
  if (analysis?.gods) {
    for (const g of analysis.gods) {
      godNodeSet.add(g.node);
    }
  }

  // Index surprising connections
  const surprisesBySource = new Map<string, Surprise[]>();
  const surprisesByTarget = new Map<string, Surprise[]>();
  if (analysis?.surprises) {
    for (const s of analysis.surprises) {
      const src = surprisesBySource.get(s.source) || [];
      src.push(s);
      surprisesBySource.set(s.source, src);
      const tgt = surprisesByTarget.get(s.target) || [];
      tgt.push(s);
      surprisesByTarget.set(s.target, tgt);
    }
  }

  return {
    graph,
    nodesById,
    analysis,
    nodeToCommunity,
    communityLabels,
    godNodeSet,
    surprisesBySource,
    surprisesByTarget,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Build per-node wiki data
// ──────────────────────────────────────────────────────────────────────────

function buildNodeWikis(data: LoadedData): NodeWiki[] {
  const { graph, nodesById, nodeToCommunity, godNodeSet, surprisesBySource, surprisesByTarget } = data;

  // Build adjacency
  const outgoing = new Map<string, SynthesizedEdge[]>();
  const incoming = new Map<string, SynthesizedEdge[]>();

  for (const edge of graph.links) {
    const src = nodesById.get(edge.source);
    const tgt = nodesById.get(edge.target);
    if (!src || !tgt) continue;

    const out = outgoing.get(edge.source) || [];
    out.push({
      targetLabel: tgt.label,
      targetSlug: slugify(tgt.label),
      relation: edge.relation,
      confidence: edge.confidence,
      direction: "outgoing",
    });
    outgoing.set(edge.source, out);

    const inc = incoming.get(edge.target) || [];
    inc.push({
      targetLabel: src.label,
      targetSlug: slugify(src.label),
      relation: edge.relation,
      confidence: edge.confidence,
      direction: "incoming",
    });
    incoming.set(edge.target, inc);
  }

  const wikis: NodeWiki[] = [];

  for (const node of graph.nodes) {
    const outEdges = outgoing.get(node.id) || [];
    const inEdges = incoming.get(node.id) || [];
    const communityId = nodeToCommunity.get(node.id) ?? null;
    const godScore =
      data.analysis?.gods?.find((g) => g.node === node.id)?.score ?? null;
    const surprises = [
      ...(surprisesBySource.get(node.id) || []),
      ...(surprisesByTarget.get(node.id) || []),
    ];

    wikis.push({
      slug: slugify(node.label),
      label: node.label,
      fileType: node.file_type || "unknown",
      sourceFile: node.source_file || "",
      communityId,
      communityLabel: communityId !== null ? `Community ${communityId}` : null,
      degree: outEdges.length + inEdges.length,
      isGodNode: godNodeSet.has(node.id),
      godScore,
      outgoingEdges: outEdges,
      incomingEdges: inEdges,
      surprisingConnections: surprises,
    });
  }

  return wikis;
}

// ──────────────────────────────────────────────────────────────────────────
// Build community wiki data
// ──────────────────────────────────────────────────────────────────────────

function buildCommunityWikis(nodeWikis: NodeWiki[], data: LoadedData): CommunityWiki[] {
  const communities = new Map<number, NodeWiki[]>();

  for (const nw of nodeWikis) {
    if (nw.communityId === null) continue;
    const list = communities.get(nw.communityId) || [];
    list.push(nw);
    communities.set(nw.communityId, list);
  }

  const result: CommunityWiki[] = [];
  const cohesion = data.analysis?.cohesion || {};

  // Detect bridge nodes — nodes in this community that connect to other communities
  const communityIds = [...communities.keys()].sort((a, b) => a - b);

  for (const cid of communityIds) {
    const members = communities.get(cid)!;
    const slug = slugify(`Community ${cid}`);

    // Bridge detection: find nodes whose outgoing edges go to other communities
    const bridgeNodes: CommunityWiki["bridgeNodes"] = [];
    const memberIdSet = new Set(members.map((m) => slugify(m.label)));

    for (const m of members) {
      for (const edge of m.outgoingEdges) {
        // Check if edge target belongs to another community
        const targetIsMember = memberIdSet.has(edge.targetSlug);
        if (!targetIsMember) {
          bridgeNodes.push({
            nodeLabel: m.label,
            nodeSlug: m.slug,
            toCommunity: edge.targetLabel,
            relation: edge.relation,
          });
        }
      }
    }

    result.push({
      id: slug,
      label: `Community ${cid}`,
      cohesion: cohesion[cid] ?? 0,
      nodeCount: members.length,
      memberSummaries: members.map((m) => ({
        label: m.label,
        slug: m.slug,
        fileType: m.fileType,
        isGodNode: m.isGodNode,
      })),
      bridgeNodes,
    });
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Build comparison pages
// ──────────────────────────────────────────────────────────────────────────

function buildComparisons(nodeWikis: NodeWiki[], data: LoadedData): Comparison[] {
  const comparisons: Comparison[] = [];

  // Group nodes by community
  const byCommunity = new Map<number | null, NodeWiki[]>();
  for (const nw of nodeWikis) {
    const list = byCommunity.get(nw.communityId) || [];
    list.push(nw);
    byCommunity.set(nw.communityId, list);
  }

  const nodeIds = data.graph.nodes.map((n) => n.id);
  const nodeLabelMap = new Map(data.graph.nodes.map((n) => [n.id, n.label]));

  // Cross-community structural rivals: find nodes from different communities
  // that share many neighbors (they likely solve similar problems)
  const communityIds = [...byCommunity.keys()].filter((k) => k !== null) as number[];
  if (communityIds.length >= 2) {
    for (let i = 0; i < communityIds.length; i++) {
      for (let j = i + 1; j < communityIds.length; j++) {
        const ci = byCommunity.get(communityIds[i]) || [];
        const cj = byCommunity.get(communityIds[j]) || [];

        // Compare high-degree nodes across communities
        const topI = [...ci].sort((a, b) => b.degree - a.degree).slice(0, 5);
        const topJ = [...cj].sort((a, b) => b.degree - a.degree).slice(0, 5);

        for (const a of topI) {
          for (const b of topJ) {
            const aNeighbors = data.graph.links
              .filter((e) => e.source === data.graph.nodes.find((n) => n.label === a.label)?.id || e.target === data.graph.nodes.find((n) => n.label === a.label)?.id)
              .map((e) => e.source === data.graph.nodes.find((n) => n.label === a.label)?.id ? e.target : e.source);
            const bNeighbors = data.graph.links
              .filter((e) => e.source === data.graph.nodes.find((n) => n.label === b.label)?.id || e.target === data.graph.nodes.find((n) => n.label === b.label)?.id)
              .map((e) => e.source === data.graph.nodes.find((n) => n.label === b.label)?.id ? e.target : e.source);

            // Get actual neighbor labels
            const aNeighborLabels = aNeighbors.map((nid) => nodeLabelMap.get(nid) || nid).filter(Boolean);
            const bNeighborLabels = bNeighbors.map((nid) => nodeLabelMap.get(nid) || nid).filter(Boolean);

            const sim = jaccard(aNeighborLabels, bNeighborLabels);

            if (sim >= 0.3) {
              const shared = aNeighborLabels.filter((l) => bNeighborLabels.includes(l));
              comparisons.push({
                a: { label: a.label, slug: a.slug },
                b: { label: b.label, slug: b.slug },
                similarity: Math.round(sim * 100) / 100,
                sharedNeighbors: [...new Set(shared)].slice(0, 10),
                type: "structural-rival",
                description: `"${a.label}" (${a.communityLabel}) and "${b.label}" (${b.communityLabel}) share ${shared.length} neighbor(s). They may solve related problems from different architectural approaches.`,
              });
            }
          }
        }
      }
    }
  }

  // Sort by similarity DESC, take top 20
  comparisons.sort((a, b) => b.similarity - a.similarity);
  return comparisons.slice(0, 20);
}

// ──────────────────────────────────────────────────────────────────────────
// Render markdown
// ──────────────────────────────────────────────────────────────────────────

function renderNodeWiki(nw: NodeWiki): string {
  const lines: string[] = [];

  lines.push(`# ${escapeMd(nw.label)}`);
  lines.push("");

  // Metadata block
  lines.push("**Type:** " + nw.fileType);
  if (nw.sourceFile) lines.push("**Source:** `" + nw.sourceFile + "`");
  lines.push(`**Degree:** ${nw.degree} connections`);
  if (nw.communityLabel) lines.push("**Community:** " + nw.communityLabel);
  if (nw.isGodNode) lines.push(`**★ God Node** (centrality: ${nw.godScore?.toFixed(3) ?? "N/A"})`);
  lines.push("");

  // Description: synthesize from edges
  if (nw.incomingEdges.length > 0) {
    const usedBy = nw.incomingEdges.map((e) => `[${escapeMd(e.targetLabel)}](${e.targetSlug}.md)`);
    lines.push(`**Used by:** ${usedBy.join(", ")}`);
    lines.push("");
  }

  if (nw.outgoingEdges.length > 0) {
    const uses = nw.outgoingEdges.map((e) => `[${escapeMd(e.targetLabel)}](${e.targetSlug}.md)`);
    lines.push(`**Uses:** ${uses.join(", ")}`);
    lines.push("");
  }

  // Relationship table
  if (nw.outgoingEdges.length > 0 || nw.incomingEdges.length > 0) {
    lines.push("## Relationships");
    lines.push("");
    lines.push("| Direction | Target | Relation | Confidence |");
    lines.push("|-----------|--------|----------|------------|");

    const allEdges = [
      ...nw.outgoingEdges.map((e) => ({ ...e, direction: "→" as const })),
      ...nw.incomingEdges.map((e) => ({ ...e, direction: "←" as const })),
    ];

    for (const e of allEdges) {
      const targetLink = `[${escapeMd(e.targetLabel)}](${e.targetSlug}.md)`;
      lines.push(`| ${e.direction} | ${targetLink} | ${e.relation} | ${e.confidence} |`);
    }
    lines.push("");
  }

  // Surprising connections
  if (nw.surprisingConnections.length > 0) {
    lines.push("## Surprising Connections");
    lines.push("");
    for (const s of nw.surprisingConnections) {
      const other = s.source === slugify(nw.label) ? s.target : s.source;
      const otherNode = other; // best effort — it's an ID
      lines.push(`- **[${other}](${slugify(other)}.md)** — ${s.relation} (${s.reason})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderCommunityWiki(cw: CommunityWiki, communityLabel: string | null): string {
  const lines: string[] = [];
  const label = communityLabel || cw.label;

  lines.push(`# ${escapeMd(label)}`);
  lines.push("");
  lines.push(`**Members:** ${cw.nodeCount} nodes`);
  lines.push(`**Cohesion:** ${cw.cohesion.toFixed(3)}`);
  lines.push("");

  // Members
  lines.push("## Members");
  lines.push("");
  lines.push("| Node | Type | God Node |");
  lines.push("|------|------|----------|");

  const sorted = [...cw.memberSummaries].sort((a, b) => {
    if (a.isGodNode !== b.isGodNode) return a.isGodNode ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  for (const m of sorted) {
    const link = `[${escapeMd(m.label)}](${m.slug}.md)`;
    lines.push(`| ${link} | ${m.fileType} | ${m.isGodNode ? "★" : ""} |`);
  }
  lines.push("");

  // Bridge nodes to other communities
  if (cw.bridgeNodes.length > 0) {
    lines.push("## Bridges to Other Communities");
    lines.push("");
    for (const b of cw.bridgeNodes) {
      const link = `[${escapeMd(b.nodeLabel)}](${b.nodeSlug}.md)`;
      lines.push(`- ${link} → ${b.toCommunity} (${b.relation})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderComparison(c: Comparison): string {
  const lines: string[] = [];

  lines.push(`## [${escapeMd(c.a.label)}](${c.a.slug}.md) ↔︎ [${escapeMd(c.b.label)}](${c.b.slug}.md)`);
  lines.push("");
  lines.push(`**Similarity:** ${c.similarity.toFixed(2)}`);
  lines.push(`**Type:** ${c.type.replace(/-/g, " ")}`);
  lines.push("");
  lines.push(c.description);
  lines.push("");

  if (c.sharedNeighbors.length > 0) {
    lines.push("**Shared neighbors:**");
    for (const n of c.sharedNeighbors) {
      const nSlug = slugify(n);
      lines.push(`- [${escapeMd(n)}](${nSlug}.md)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderIndex(nodeWikis: NodeWiki[]): string {
  const lines: string[] = [];

  lines.push("# Wiki Index");
  lines.push("");
  lines.push(`**${nodeWikis.length} concepts total**`);
  lines.push("");

  // Group by first letter
  const grouped = new Map<string, NodeWiki[]>();
  for (const nw of nodeWikis) {
    const first = nw.label[0]?.toUpperCase() || "#";
    const list = grouped.get(first) || [];
    list.push(nw);
    grouped.set(first, list);
  }

  const sortedLetters = [...grouped.keys()].sort();

  for (const letter of sortedLetters) {
    const group = grouped.get(letter)!;
    lines.push(`## ${escapeMd(letter)}`);
    lines.push("");
    for (const nw of group) {
      const link = `[${escapeMd(nw.label)}](nodes/${nw.slug}.md)`;
      const type = nw.fileType;
      const community = nw.communityLabel ? ` (${nw.communityLabel})` : "";
      const god = nw.isGodNode ? " ★" : "";
      lines.push(`- ${link} — ${type}${community}${god}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Main generate function
// ──────────────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Path to directory containing graphify-out/ */
  graphDir: string;
  /** Override wiki output directory (default: graphDir/wiki/) */
  wikiDir?: string;
  /** Only generate INDEX.md (skip per-node/community/comparison) */
  indexOnly?: boolean;
  /** Community label overrides: community_id → label */
  communityLabels?: Record<string, string>;
}

/**
 * Generate wiki from graphify output.
 *
 * @returns WikiGenResult with paths to generated files.
 */
export function generateWiki(options: GenerateOptions): WikiGenResult {
  const startTime = Date.now();
  const graphDir = options.graphDir;
  const wikiDir = options.wikiDir || path.join(graphDir, "wiki");

  // Validate graphify output exists
  const graphPath = path.join(graphDir, "graph.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error(
      `graphify output not found at ${graphDir}. ` +
      "Run graphify first to generate graph.json."
    );
  }

  // Load
  const data = loadData(graphDir);

  // Apply custom community labels from options
  if (options.communityLabels) {
    for (const [cid, label] of Object.entries(options.communityLabels)) {
      data.communityLabels.set(Number(cid), label);
    }
  }

  // Build wiki data
  const nodeWikis = buildNodeWikis(data);
  const communityWikis = buildCommunityWikis(nodeWikis, data);
  const comparisons = buildComparisons(nodeWikis, data);

  // Ensure output directories
  const nodesDir = path.join(wikiDir, "nodes");
  const communitiesDir = path.join(wikiDir, "communities");
  const comparisonsDir = path.join(wikiDir, "comparisons");
  fs.mkdirSync(nodesDir, { recursive: true });
  fs.mkdirSync(communitiesDir, { recursive: true });
  fs.mkdirSync(comparisonsDir, { recursive: true });

  const generatedFiles: string[] = [];

  if (!options.indexOnly) {
    // Write node pages
    for (const nw of nodeWikis) {
      const filePath = path.join(nodesDir, `${nw.slug}.md`);
      fs.writeFileSync(filePath, renderNodeWiki(nw), "utf-8");
      generatedFiles.push(filePath);
    }

    // Write community pages
    for (const cw of communityWikis) {
      const labelOverride = cw.id ? data.communityLabels.get(Number(cw.id.split("-").pop()) ?? null) ?? null : null;
      const filePath = path.join(communitiesDir, `_${cw.id}.md`);
      fs.writeFileSync(filePath, renderCommunityWiki(cw, labelOverride), "utf-8");
      generatedFiles.push(filePath);
    }

    // Write comparisons
    if (comparisons.length > 0) {
      const compLines: string[] = [
        "# Structural Comparisons",
        "",
        `**${comparisons.length} comparison(s) detected**`,
        "",
      ];

      for (const c of comparisons) {
        compLines.push(renderComparison(c));
      }

      const filePath = path.join(comparisonsDir, "structural-rivals.md");
      fs.writeFileSync(filePath, compLines.join("\n"), "utf-8");
      generatedFiles.push(filePath);
    }
  }

  // Write index
  const indexPath = path.join(wikiDir, "INDEX.md");
  fs.writeFileSync(indexPath, renderIndex(nodeWikis), "utf-8");
  generatedFiles.push(indexPath);

  return {
    nodeCount: nodeWikis.length,
    communityCount: communityWikis.length,
    wikiDir,
    generatedFiles,
    comparisonCount: comparisons.length,
    duration: Date.now() - startTime,
  };
}
