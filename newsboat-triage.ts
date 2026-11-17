#!/usr/bin/env bun
// Tri des articles newsboat avec tev1 (endpoint Ollama /v1/systemone) :
//   passe 1 : question « choice » -> catégorie
//   passe 2 : question « noul »   -> probabilité que l'article soit intéressant
// Pose le flag « a » sur les articles dont la probabilité atteint le seuil.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const FLAG = "a";
const NONE = "none";
const MAX_OPTIONS = 24; // tev1 a été entraîné sur 2 à 24 options

const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local/share");
const xdgState = process.env.XDG_STATE_HOME ?? join(home, ".local/state");

const { values: opts } = parseArgs({
  options: {
    db: { type: "string" },
    config: { type: "string", default: join(xdgConfig, "newsboat-triage") },
    model: { type: "string", default: process.env.TRIAGE_MODEL ?? "tev1:4b" },
    host: { type: "string", default: process.env.OLLAMA_HOST ?? "http://localhost:11434" },
    threshold: { type: "string", default: "0.7" },
    limit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const model = opts.model as string;
const host = /^https?:\/\//.test(opts.host as string) ? (opts.host as string) : `http://${opts.host}`;
const threshold = Number(opts.threshold);
const limit = opts.limit ? Number(opts.limit) : Infinity;
const dryRun = opts["dry-run"] as boolean;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------- catégories : un fichier par catégorie ----------

type Category = { name: string; description: string; criteria: string[] };

function loadCategories(dir: string): Category[] {
  if (!existsSync(dir)) die(`Dossier de catégories introuvable : ${dir}`);
  const cats: Category[] = [];
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (file.startsWith(".") || !statSync(path).isFile()) continue;
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const name = file.replace(/\.(txt|md)$/i, "");
    if (name === NONE) die(`« ${NONE} » est réservé, renomme cette catégorie.`);
    if (lines.length === 1) console.warn(`⚠ ${name} : aucun critère, ses articles ne seront jamais flaggés`);
    cats.push({ name, description: lines[0], criteria: lines.slice(1) });
  }
  return cats;
}

// ---------- tev1 via /v1/systemone ----------

type Answers = Record<string, { choice?: string; noul?: number }>;

async function systemOne(state: object, questions: object): Promise<Answers> {
  const res = await fetch(`${host}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} : ${await res.text()}`);
  return ((await res.json()) as { answers: Answers }).answers;
}

// ---------- utilitaires ----------

// tev1 tourne avec ~2000 tokens de contexte : extrait court
function toText(html: string, max = 1200): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const addFlag = (flags: string | null, f: string) =>
  flags?.includes(f) ? flags : [...((flags ?? "") + f)].sort().join("");

// ---------- main ----------

const cats = loadCategories(join(opts.config as string, "categories"));
if (cats.length === 0) die("Aucune catégorie définie.");
if (cats.length + 1 > MAX_OPTIONS) die(`Trop de catégories (${cats.length}), maximum ${MAX_OPTIONS - 1}.`);
const byName = new Map(cats.map((c) => [c.name, c]));

const dbPath =
  opts.db ?? [join(xdgData, "newsboat/cache.db"), join(home, ".newsboat/cache.db")].find(existsSync);
if (!dbPath) die("cache.db introuvable, utilise --db.");

// état propre au script : on ne touche pas au schéma de newsboat
const statePath = join(xdgState, "newsboat-triage/state.db");
mkdirSync(dirname(statePath), { recursive: true });
const state = new Database(statePath, { create: true });
state.run(`CREATE TABLE IF NOT EXISTS decisions (
  guid TEXT NOT NULL, feedurl TEXT NOT NULL,
  category TEXT, score REAL,
  flagged INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  PRIMARY KEY (guid, feedurl)
)`);

type Item = { guid: string; feedurl: string; title: string; content: string | null };

// lecture seule pendant les appels au modèle : on ne verrouille pas la base de newsboat
const cache = new Database(dbPath, { readonly: true });
const items = cache
  .query("SELECT guid, feedurl, title, content FROM rss_item WHERE deleted = 0 AND unread = 1 ORDER BY pubDate DESC")
  .all() as Item[];
cache.close();

const seen = state.query("SELECT 1 FROM decisions WHERE guid = ? AND feedurl = ?");
const todo = items.filter((it) => !seen.get(it.guid, it.feedurl)).slice(0, limit);
console.log(`${todo.length} article(s) à traiter (modèle : ${model}, seuil : ${threshold})`);

// passe 1 : une question « choice », une option par catégorie + « none »
const classifyQuestions = {
  category: {
    type: "choice",
    instructions: "Which category best matches this RSS article?",
    criteria: {
      ...Object.fromEntries(cats.map((c) => [c.name, c.description])),
      [NONE]: "None of the listed categories matches.",
    },
  },
};

// passe 2 : une question « noul » (probabilité de « vrai ») avec les critères de la catégorie
const rateQuestions = (c: Category) => ({
  interesting: {
    type: "noul",
    instructions: `Is this ${c.name} article worth reading for this particular reader?`,
    criteria: {
      true: `The article clearly meets the reader's interests:\n${c.criteria.map((x) => `- ${x}`).join("\n")}`,
      false: "The article is routine, off-topic, or matches none of the reader's interests.",
    },
  },
});

const insert = state.query(
  "INSERT OR REPLACE INTO decisions (guid, feedurl, category, score, flagged, ts) VALUES (?, ?, ?, ?, ?, ?)",
);

let failures = 0;
let nFlagged = 0;
for (const it of todo) {
  try {
    const article = { title: it.title, source: it.feedurl, excerpt: toText(it.content ?? "") };

    const category = (await systemOne(article, classifyQuestions)).category?.choice;
    if (!category) throw new Error("réponse sans catégorie");

    let score = 0;
    const cat = byName.get(category);
    if (cat && cat.criteria.length > 0) {
      const p = (await systemOne(article, rateQuestions(cat))).interesting?.noul;
      if (typeof p !== "number") throw new Error("réponse sans probabilité");
      score = p;
    }

    const flagged = score >= threshold ? 1 : 0;
    nFlagged += flagged;
    console.log(`${flagged ? FLAG : "-"} ${score.toFixed(2)}  ${category.padEnd(14)} ${it.title.slice(0, 80)}`);
    if (!dryRun) insert.run(it.guid, it.feedurl, category, score, flagged, Date.now());
    failures = 0;
  } catch (e) {
    console.error(`Échec sur « ${it.title.slice(0, 60)} » : ${(e as Error).message}`);
    if (++failures >= 3) die("Trop d'échecs consécutifs, Ollama (≥ 0.35) et tev1 sont-ils bien là ?");
  }
}

// application des flags : écriture brève, en une transaction
if (!dryRun) {
  const pending = state
    .query("SELECT guid, feedurl FROM decisions WHERE flagged = 1 AND applied = 0")
    .all() as { guid: string; feedurl: string }[];
  if (pending.length > 0) {
    const rw = new Database(dbPath);
    rw.run("PRAGMA busy_timeout = 10000");
    const get = rw.query("SELECT flags FROM rss_item WHERE guid = ? AND feedurl = ?");
    const set = rw.query("UPDATE rss_item SET flags = ? WHERE guid = ? AND feedurl = ?");
    rw.transaction(() => {
      for (const p of pending) {
        const row = get.get(p.guid, p.feedurl) as { flags: string | null } | null;
        if (row) set.run(addFlag(row.flags, FLAG), p.guid, p.feedurl);
      }
    })();
    rw.close();
    state.run("UPDATE decisions SET applied = 1 WHERE flagged = 1 AND applied = 0");
  }
}
console.log(`Terminé : ${todo.length} traité(s), ${nFlagged} flaggé(s) « ${FLAG} »${dryRun ? " (dry-run)" : ""}.`);
