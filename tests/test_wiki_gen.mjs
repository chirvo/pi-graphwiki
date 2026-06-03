/**
 * test_wiki_gen.mjs — Tests for pi-graphwiki wiki generation.
 *
 * Creates a synthetic graphify output, runs wiki generation, and
 * validates the output structure and content.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, ".test-output");

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

let generateWiki;
try {
  const mod = await import("../extensions/pi-graphwiki/wiki-gen.ts");
  generateWiki = mod.generateWiki;
} catch {
  // Fallback: try the JS path (tsx required for .ts)
  console.log("Direct TS import failed, trying JS transpile...");
  // Dynamic import via tsx
  const { execSync } = await import("node:child_process");
  execSync("npx tsx -e ''", { cwd: join(__dirname, ".."), stdio: "pipe" });
  // Actually try again - npx tsx should be available
  try {
    const mod = await import("../extensions/pi-graphwiki/wiki-gen.ts");
    generateWiki = mod.generateWiki;
  } catch {
    console.error("Cannot import wiki-gen.ts. Run: npx tsx tests/test_wiki_gen.mjs");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    process.stdout.write("  ✅ " + message + "\n");
  } else {
    failed++;
    process.stdout.write("  ❌ " + message + "\n");
  }
}

function assertFileExists(filepath, message) {
  assert(existsSync(filepath), message);
}

function assertFileContains(filepath, substr, message) {
  const content = readFileSync(filepath, "utf-8");
  assert(content.includes(substr), message);
}

// ---------------------------------------------------------------------------
// Setup: create synthetic graphify output
// ---------------------------------------------------------------------------

function setup() {
  // Clean and recreate
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // graph.json — minimal synthetic graph
  const graph = {
    nodes: [
      { id: "app_main", label: "Main App", file_type: "code", source_file: "src/main.ts" },
      { id: "app_auth", label: "Auth Module", file_type: "code", source_file: "src/auth.ts" },
      { id: "app_db", label: "Database", file_type: "code", source_file: "src/db.ts" },
      { id: "app_cache", label: "Cache Layer", file_type: "code", source_file: "src/cache.ts" },
      { id: "doc_api", label: "API Docs", file_type: "document", source_file: "docs/api.md" },
      { id: "doc_arch", label: "Architecture Doc", file_type: "document", source_file: "docs/arch.md" },
    ],
    links: [
      { source: "app_main", target: "app_auth", relation: "imports", confidence: "EXTRACTED", weight: 1.0 },
      { source: "app_main", target: "app_db", relation: "imports", confidence: "EXTRACTED", weight: 1.0 },
      { source: "app_db", target: "app_cache", relation: "uses", confidence: "EXTRACTED", weight: 0.8 },
      { source: "app_auth", target: "app_db", relation: "reads", confidence: "EXTRACTED", weight: 1.0 },
      { source: "doc_api", target: "app_auth", relation: "documents", confidence: "EXTRACTED", weight: 0.9 },
      { source: "doc_api", target: "app_main", relation: "documents", confidence: "EXTRACTED", weight: 0.9 },
      { source: "doc_arch", target: "app_main", relation: "describes", confidence: "EXTRACTED", weight: 0.8 },
      { source: "doc_arch", target: "app_db", relation: "describes", confidence: "EXTRACTED", weight: 0.8 },
      { source: "app_cache", target: "app_db", relation: "caches", confidence: "INFERRED", weight: 0.7 },
    ],
    community: {
      "app_main": 0,
      "app_auth": 0,
      "app_db": 0,
      "app_cache": 0,
      "doc_api": 1,
      "doc_arch": 1,
    },
  };

  writeFileSync(join(TMP_DIR, "graph.json"), JSON.stringify(graph, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n📚 pi-graphwiki tests\n");

// Setup
setup();

// Test 1: Generate wiki
console.log(":: Basic generation");
try {
  const result = generateWiki({ graphDir: TMP_DIR });
  assert(result.nodeCount === 6, `Expected 6 nodes, got ${result.nodeCount}`);
  assert(result.communityCount === 2, `Expected 2 communities, got ${result.communityCount}`);
  assert(result.generatedFiles.length > 0, "Generated at least one file");
  assert(existsSync(result.wikiDir), "Wiki directory created");
} catch (e) {
  console.error("Generation failed:", e);
  failed++;
}

// Test 2: INDEX.md exists and has all nodes
console.log("\n:: Glossary index");
const indexPath = join(TMP_DIR, "wiki", "INDEX.md");
assertFileExists(indexPath, "INDEX.md exists");
assertFileContains(indexPath, "Main App", "INDEX.md contains 'Main App'");
assertFileContains(indexPath, "Auth Module", "INDEX.md contains 'Auth Module'");
assertFileContains(indexPath, "Database", "INDEX.md contains 'Database'");
assertFileContains(indexPath, "6 concepts", "INDEX.md shows 6 concepts total");

// Test 3: Node pages exist
console.log("\n:: Node pages");
const mainAppPage = join(TMP_DIR, "wiki", "nodes", "main-app.md");
const authPage = join(TMP_DIR, "wiki", "nodes", "auth-module.md");
const dbPage = join(TMP_DIR, "wiki", "nodes", "database.md");

assertFileExists(mainAppPage, "Main App page exists");
assertFileExists(authPage, "Auth Module page exists");
assertFileExists(dbPage, "Database page exists");

assertFileContains(mainAppPage, "Main App", "Main App page has correct title");
assertFileContains(mainAppPage, "Uses", "Main App page has 'Uses' section");
assertFileContains(mainAppPage, "Relationships", "Main App page has relationship table");
assertFileContains(mainAppPage, "Community 0", "Main App page has community context");

// Test 4: Community pages exist
console.log("\n:: Community pages");
const comm0Page = join(TMP_DIR, "wiki", "communities", "_community-0.md");
const comm1Page = join(TMP_DIR, "wiki", "communities", "_community-1.md");

assertFileExists(comm0Page, "Community 0 page exists");
assertFileExists(comm1Page, "Community 1 page exists");
assertFileContains(comm0Page, "4 nodes", "Community 0 has 4 members");
assertFileContains(comm1Page, "2 nodes", "Community 1 has 2 members");

// Test 5: God nodes without analysis file
console.log("\n:: Missing analysis gracefully handled");
// Should work without .graphify_analysis.json
const result2 = generateWiki({ graphDir: TMP_DIR });
assert(result2.nodeCount === 6, "Still generates 6 nodes without analysis");

// Test 6: Comparisons
console.log("\n:: Comparisons");
const rivalsPath = join(TMP_DIR, "wiki", "comparisons", "structural-rivals.md");
assertFileExists(rivalsPath, "Comparisons file exists");

// Test 7: indexOnly mode
console.log("\n:: indexOnly mode");
const result3 = generateWiki({ graphDir: TMP_DIR, indexOnly: true });
// Should still have INDEX.md but fewer total files
assert(result3.nodeCount === 6, "Nodes counted correctly in indexOnly mode");
assert(result3.generatedFiles.length === 1, "Only INDEX.md generated in indexOnly mode");

// Test 8: Error handling — nonexistent directory
console.log("\n:: Error handling");
try {
  generateWiki({ graphDir: "/nonexistent/path" });
  assert(false, "Should have thrown for nonexistent path");
} catch (e) {
  assert(e.message.includes("graphify output not found"), "Throws descriptive error for missing graph");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

// Cleanup
if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });

if (failed > 0) process.exit(1);
