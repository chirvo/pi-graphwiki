/**
 * types.ts — Shared type definitions for pi-graphwiki.
 */

/** A single node in the graphify graph */
export interface GraphNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string | null;
  /** Community assignment stored per-node by graphify (networkX node_link_data) */
  community?: number;
}

/** An edge between two nodes */
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  confidence_score?: number;
  source_file?: string;
  weight?: number;
}

/** Community cluster data from graphify analysis */
export interface GraphAnalysis {
  communities: Record<string, string[]>;       // community_id → node_ids
  cohesion: Record<string, number>;             // community_id → cohesion score
  gods: Array<{ node: string; score: number }>; // sorted by score DESC
  surprises: Surprise[];
  questions: string[];
}

/** A "surprising connection" — cross-community bridge */
export interface Surprise {
  source: string;
  target: string;
  relation: string;
  communities: [string, string];
  reason: string;
}

/** Full graphify graph.json shape (node_link_data format) */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphEdge[];
}

/** Per-node wiki page data after synthesis */
export interface NodeWiki {
  slug: string;
  label: string;
  fileType: string;
  sourceFile: string;
  communityId: number | null;
  communityLabel: string | null;
  degree: number;
  isGodNode: boolean;
  godScore: number | null;
  outgoingEdges: SynthesizedEdge[];
  incomingEdges: SynthesizedEdge[];
  surprisingConnections: Surprise[];
}

/** Edge with human-readable labels for wiki display */
export interface SynthesizedEdge {
  targetLabel: string;
  targetSlug: string;
  relation: string;
  confidence: string;
  direction: "outgoing" | "incoming";
}

/** Per-community wiki page data */
export interface CommunityWiki {
  id: string;
  label: string;
  cohesion: number;
  nodeCount: number;
  memberSummaries: Array<{
    label: string;
    slug: string;
    fileType: string;
    isGodNode: boolean;
  }>;
  bridgeNodes: Array<{
    nodeLabel: string;
    nodeSlug: string;
    toCommunity: string;
    relation: string;
  }>;
}

/** Comparison pair */
export interface Comparison {
  a: { label: string; slug: string };
  b: { label: string; slug: string };
  similarity: number;
  sharedNeighbors: string[];
  type: "structural-rival" | "semantic-parallel" | "cross-community-bridge";
  description: string;
}

/** Result of a wiki generation run */
export interface WikiGenResult {
  nodeCount: number;
  communityCount: number;
  wikiDir: string;
  generatedFiles: string[];
  comparisonCount: number;
  duration: number;
}
