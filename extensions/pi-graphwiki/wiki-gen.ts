/**
 * wiki-gen.ts — Core wiki generation engine for pi-graphwiki.
 *
 * Reads graphify's output (graph.json + analysis) and writes a wiki/
 * directory with concept pages, community overviews, comparisons, and a
 * glossary index. No external dependencies — pure data-structure work.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  GraphData,
  GraphNode,
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

/**
 * Slugify with dedup: second call with a different label that produces the same
 * slug appends a content hash suffix so wiki pages never silently overwrite.
 */
const _slugCache = new Map<string, string>();
function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "unnamed";

  // Check for collision
  for (const [existingLabel, existingSlug] of _slugCache) {
    if (existingSlug === base && existingLabel !== label) {
      // Collision: append short hash of the label
      const hash = createHash("md5").update(label).digest("hex").slice(0, 6);
      const deduped = `${base}-${hash}`;
      _slugCache.set(label, deduped);
      return deduped;
    }
  }

  _slugCache.set(label, base);
  return base;
}

function escapeMd(text: string): string {
  // Escape pipe (breaks tables), angle brackets (confuses browsers)
  return text.replace(/[<>&|]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "|": return "&#124;";
      default: return c;
    }
  });
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

// ──────────────────────────────────────────────────────────────────────────
// Graph analysis: re-derive what graphify deletes after Step 9
// ──────────────────────────────────────────────────────────────────────────

/**
 * graphify explicitly deletes `.graphify_analysis.json` in its cleanup step.
 * This function re-derives what we need directly from graph.json:
 * - community assignments (embedded in graph.json)
 * - degree centrality (god nodes ≈ high-degree nodes)
 * - cross-community surprising connections
 */
function deriveAnalysis(graph: GraphData): {
  nodeToCommunity: Map<string, number>;
  godNodeSet: Set<string>;
  surprises: Surprise[];
} {
  // 1. Community mapping — graphify stores community on each node (networkX
  //    node_link_data format). If missing, every node is community 0.
  const nodeToCommunity = new Map<string, number>();
  const communitySet = new Set<number>();

  for (const node of graph.nodes) {
    const cid = node.community ?? 0;
    nodeToCommunity.set(node.id, cid);
    communitySet.add(cid);
  }

  // 2. Degree-1.5 centrality to find god nodes
  //    (networks with nodes-and-links topology: degree centrality is sufficient)
  const degree = new Map<string, number>();
  for (const node of graph.nodes) degree.set(node.id, 0);
  for (const edge of graph.links) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }

  // God nodes: top 10% by degree, minimum 2 connections
  const sortedDegrees = [...degree.entries()]
    .filter(([, d]) => d >= 2)
    .sort((a, b) => b[1] - a[1]);
  const topCount = Math.max(1, Math.ceil(sortedDegrees.length * 0.1));
  const godNodeSet = new Set(sortedDegrees.slice(0, topCount).map(([id]) => id));

  // 3. Cross-community surprising connections:
  //    edges whose source and target belong to different communities
  const surprises: Surprise[] = [];
  if (nodeToCommunity.size > 0) {
    for (const edge of graph.links) {
      const srcComm = nodeToCommunity.get(edge.source);
      const tgtComm = nodeToCommunity.get(edge.target);
      if (srcComm !== undefined && tgtComm !== undefined && srcComm !== tgtComm) {
        const srcLabel = graph.nodes.find((n) => n.id === edge.source)?.label || edge.source;
        const tgtLabel = graph.nodes.find((n) => n.id === edge.target)?.label || edge.target;
        surprises.push({
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          communities: [String(srcComm), String(tgtComm)],
          reason: `${srcLabel} (community ${srcComm}) connects to ${tgtLabel} (community ${tgtComm}) via ${edge.relation}`,
        });
      }
    }
  }

  return { nodeToCommunity, godNodeSet, surprises };
}

interface LoadedData {
  graph: GraphData;
  nodesById: Map<string, GraphNode>;
  nodeToCommunity: Map<string, number>;
  godNodeSet: Set<string>;
  surprises: Surprise[];
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

  // Derive everything from graph.json — graphify deletes analysis files
  const { nodeToCommunity, godNodeSet, surprises } = deriveAnalysis(graph);

  return {
    graph,
    nodesById,
    nodeToCommunity,
    godNodeSet,
    surprises,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Build per-node wiki data
// ──────────────────────────────────────────────────────────────────────────

function buildNodeWikis(data: LoadedData): NodeWiki[] {
  const { graph, nodesById, nodeToCommunity, godNodeSet } = data;

  // Build adjacency — single pass, O(E)
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
    const isGod = data.godNodeSet.has(node.id);
    // Find surprises involving this node by node ID (not slug)
    const surprises = data.surprises.filter(
      (s) => s.source === node.id || s.target === node.id
    );

    wikis.push({
      slug: slugify(node.label),
      label: node.label,
      fileType: node.file_type || "unknown",
      sourceFile: node.source_file || "",
      communityId,
      communityLabel: communityId !== null ? `Community ${communityId}` : null,
      degree: outEdges.length + inEdges.length,
      isGodNode: isGod,
      godScore: isGod ? degreeFromEdges(outEdges.length + inEdges.length) : null,
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

  // Compute cohesion per community: fraction of edges that stay within community
  const cohesion = new Map<number, number>();
  for (const [cid, members] of communities) {
    const memberIds = new Set(members.map((m) => m.label));
    let internal = 0;
    let total = 0;
    for (const m of members) {
      for (const e of m.outgoingEdges) {
        total++;
        if (memberIds.has(e.targetLabel)) internal++;
      }
    }
    cohesion.set(cid, total > 0 ? internal / total : 0);
  }

  const communityIds = [...communities.keys()].sort((a, b) => a - b);

  for (const cid of communityIds) {
    const members = communities.get(cid)!;
    const slug = slugify(`Community ${cid}`);

    // Bridge detection via node ID — use data.surprises which is already
    // derived from cross-community edges in graph.json
    const bridgeNodes: CommunityWiki["bridgeNodes"] = [];
    const memberNodeIds = new Map<string, NodeWiki>();
    for (const nw of nodeWikis) {
      if (nw.communityId === cid) {
        // Find the actual node ID for this wiki page
        const graphNode = data.graph.nodes.find((n) => slugify(n.label) === nw.slug);
        if (graphNode) memberNodeIds.set(graphNode.id, nw);
      }
    }

    for (const s of data.surprises) {
      if (memberNodeIds.has(s.source)) {
        const src = memberNodeIds.get(s.source)!;
        const tgtLabel = data.nodesById.get(s.target)?.label || s.target;
        bridgeNodes.push({
          nodeLabel: src.label,
          nodeSlug: src.slug,
          toCommunity: tgtLabel,
          relation: s.relation,
        });
      }
      if (memberNodeIds.has(s.target)) {
        const tgt = memberNodeIds.get(s.target)!;
        const srcLabel = data.nodesById.get(s.source)?.label || s.source;
        bridgeNodes.push({
          nodeLabel: tgt.label,
          nodeSlug: tgt.slug,
          toCommunity: srcLabel,
          relation: s.relation,
        });
      }
    }

    result.push({
      id: slug,
      label: `Community ${cid}`,
      cohesion: cohesion.get(cid) ?? 0,
      nodeCount: members.length,
      memberSummaries: members.map((m) => ({
        label: m.label,
        slug: m.slug,
        fileType: m.fileType,
        isGodNode: m.isGodNode,
      })),
      bridgeNodes: dedupeBridges(bridgeNodes),
    });
  }

  return result;
}

/** Remove duplicate bridge entries for the same node+target */
function dedupeBridges(bridges: CommunityWiki["bridgeNodes"]): CommunityWiki["bridgeNodes"] {
  const seen = new Set<string>();
  return bridges.filter((b) => {
    const key = `${b.nodeLabel}->${b.toCommunity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Build comparison pages
// ──────────────────────────────────────────────────────────────────────────

/** Pre-compute neighbor sets by node ID for fast comparison */
function buildNeighborMap(data: LoadedData): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const node of data.graph.nodes) map.set(node.id, new Set());
  for (const edge of data.graph.links) {
    map.get(edge.source)?.add(edge.target);
    map.get(edge.target)?.add(edge.source);
  }
  const result = new Map<string, string[]>();
  for (const [id, neighbors] of map) {
    result.set(
      id,
      [...neighbors]
        .map((nid) => data.nodesById.get(nid)?.label || nid)
        .filter(Boolean)
    );
  }
  return result;
}

function buildComparisons(nodeWikis: NodeWiki[], data: LoadedData): Comparison[] {
  const comparisons: Comparison[] = [];

  // Group nodes by community
  const byCommunity = new Map<number | null, NodeWiki[]>();
  for (const nw of nodeWikis) {
    const list = byCommunity.get(nw.communityId) || [];
    list.push(nw);
    byCommunity.set(nw.communityId, list);
  }

  // Pre-build neighbor map (O(E) once instead of O(E) per pair)
  const neighborByLabel = buildNeighborMap(data);
  const labelToId = new Map(data.graph.nodes.map((n) => [n.label, n.id]));

  const communityIds = [...byCommunity.keys()].filter((k) => k !== null) as number[];
  if (communityIds.length >= 2) {
    for (let i = 0; i < communityIds.length; i++) {
      for (let j = i + 1; j < communityIds.length; j++) {
        const ci = byCommunity.get(communityIds[i]) || [];
        const cj = byCommunity.get(communityIds[j]) || [];

        const topI = [...ci].sort((a, b) => b.degree - a.degree).slice(0, 5);
        const topJ = [...cj].sort((a, b) => b.degree - a.degree).slice(0, 5);

        for (const a of topI) {
          const aNeighbors = neighborByLabel.get(labelToId.get(a.label) ?? "") || [];
          for (const b of topJ) {
            const bNeighbors = neighborByLabel.get(labelToId.get(b.label) ?? "") || [];
            const sim = jaccard(aNeighbors, bNeighbors);

            if (sim >= 0.3) {
              const shared = aNeighbors.filter((l) => bNeighbors.includes(l));
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

  comparisons.sort((a, b) => b.similarity - a.similarity);
  return comparisons.slice(0, 20);
}

/** Generate a one-line prose description from a node's edges */
function synthesizeRole(nw: NodeWiki): string | null {
  if (nw.outgoingEdges.length === 0 && nw.incomingEdges.length === 0) return null;

  const parts: string[] = [];
  if (nw.outgoingEdges.length > 0) {
    const targets = [...new Set(nw.outgoingEdges.map((e) => e.targetLabel))];
    parts.push(`${nw.label} connects to ${targets.join(", ")}`);
  }
  if (nw.incomingEdges.length > 0) {
    const sources = [...new Set(nw.incomingEdges.map((e) => e.targetLabel))];
    parts.push(`is referenced by ${sources.join(", ")}`);
  }
  return [parts.join("; "), "."].join("");
}

/** Simple degree-derived score for god nodes without analysis file */
function degreeFromEdges(degree: number): number {
  // Normalize: degree 1-2 = 0.2, 3-5 = 0.5, 6+ = 0.8 (cap at 0.95)
  return Math.min(0.95, degree * 0.15 + 0.1);
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

  // Prose summary
  const role = synthesizeRole(nw);
  if (role) {
    lines.push(role);
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

  // Surprising connections (s.reason has full human-readable description)
  if (nw.surprisingConnections.length > 0) {
    lines.push("## Surprising Connections");
    lines.push("");
    for (const s of nw.surprisingConnections) {
      lines.push(`- ${escapeMd(s.reason)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderCommunityWiki(cw: CommunityWiki): string {
  const lines: string[] = [];
  const label = cw.label;

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

  // Reset slug cache on each generation (avoid stale collisions across runs)
  _slugCache.clear();

  // Validate graphify output exists
  const graphPath = path.join(graphDir, "graph.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error(
      `graphify output not found at ${graphDir}. ` +
      "Run graphify first to generate graph.json."
    );
  }

  // Load + derive everything from graph.json
  // (graphify deletes .graphify_analysis.json in Step 9, so we derive)
  const data = loadData(graphDir);

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
      const filePath = path.join(communitiesDir, `_${cw.id}.md`);
      fs.writeFileSync(filePath, renderCommunityWiki(cw), "utf-8");
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
