---
name: graphwiki
description: "Generate self-curating wikis from graphify knowledge graphs. Use when: graphify-out/graph.json exists and the user wants browsable docs, concept pages, community overviews, or a glossary from the knowledge graph. Also use when you want to make a graph's contents searchable via ctx_index / mempalace."
---

# graphwiki — Self-Curating Wiki from Knowledge Graphs

Reads `graphify-out/graph.json` (plus community analysis) and generates a browsable wiki with concept pages, community overviews, structural comparisons, and a glossary index. All wiki content can be indexed into mempalace for semantic search.

## Quick Start

```bash
# 1. Generate graph (if not already done)
/graphify .

# 2. Generate wiki from the graph
graphwiki_generate(graphDir: "./graphify-out")

# 3. Index into mempalace for semantic search
ctx_index(path: "./graphify-out/wiki/", source: "graphify-wiki")
```

## Tools

| Tool | Purpose |
|------|---------|
| `graphwiki_generate` | Generate wiki from graphify output |
| `graphwiki_index` | Mark wiki for indexing into mempalace |

## Commands

| Command | Purpose |
|---------|---------|
| `/graphwiki status` | Show generation status |
| `/graphwiki generate [path]` | Generate wiki from graph dir |
| `/graphwiki reindex` | Mark last wiki for re-indexing |

## Output

```
graphify-out/
└── wiki/
    ├── INDEX.md                  — Full glossary A–Z
    ├── nodes/                    — One page per graph node
    │   ├── transformer.md        — "Transformer" concept page
    │   ├── attention.md          — "Attention" concept page
    │   └── ...
    ├── communities/              — Per-community overviews
    │   ├── _community-0.md       — Cluster summary
    │   └── ...
    └── comparisons/              — Auto-detected structural rivals
        └── structural-rivals.md
```

## Workflow Integration

```
graphify --update → graphify-out/graph.json
       ↓
graphwiki_generate → graphify-out/wiki/
       ↓
ctx_index(path: "./graphify-out/wiki/", source: "graphify-wiki")
       ↓
ctx_search("transformer architecture", source: "graphify-wiki")
      → returns synthesized wiki prose
```

## Best Practices

- **Always index** after generating — wiki is most useful when searchable
- **Re-generate** after every `graphify --update` to keep wiki fresh
- **Use community labels** in community pages to make them readable (renames "Community 0" → "Attention Mechanism")
- **The wiki is not versioned** — it regenerates from the graph each time. If you need a snapshot, copy `wiki/` elsewhere.
