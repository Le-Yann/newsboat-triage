# newsboat-triage

A small [Bun](https://bun.sh) script that triages your unread [Newsboat](https://newsboat.org) articles with a local [tev1](https://ollama.com) model served by Ollama. It sorts each article into one of your own categories, rates how likely it is to interest you, and sets a flag on the ones that pass a threshold, so you can browse only the good stuff.

Everything runs locally. Newsboat's schema is never modified: the script keeps its own state in a separate SQLite file.

## How it works

For every unread article that hasn't been processed yet, the script makes up to two calls to the `/v1/systemone` endpoint:

1. **Classification** (`choice` question): which of your categories best matches the article? A built-in `none` option is always offered.
2. **Rating** (`noul` question): using the criteria you wrote for that category, what is the probability that the article is worth reading?

If the probability reaches the threshold (default `0.7`), the article gets the Newsboat flag `a`. Flags are written to `cache.db` at the end of the run, in a single short transaction, so Newsboat's database is only locked briefly.

Categories without any criteria (and the `none` result) get a score of `0` and are never flagged.

## Requirements

- [Bun](https://bun.sh)
- Newsboat, with an existing `cache.db`
- [Ollama](https://ollama.com) **0.35 or later**, running locally or reachable over the network
- The `tev1` model pulled in Ollama (default: `tev1:4b`)

## Installation

```sh
git clone https://github.com/Le-Yann/newsboat-triage.git && cd newsboat-triage
chmod +x newsboat-triage.ts
# optional: put it on your PATH
ln -s "$PWD/newsboat-triage.ts" ~/.local/bin/newsboat-triage
```

No dependencies to install: the script only uses Bun and Node built-ins.

## Configuring categories

Categories live in a directory, **one file per category**:

```
~/.config/newsboat-triage/categories/
├── linux.txt
├── gamedev.md
└── science.txt
```

- The category name is the file name without its `.txt` / `.md` extension.
- **First line**: a short description of the category (used for classification).
- **Following lines**: one criterion per line, describing what *you* find interesting in that category (used for rating).
- Blank lines and files starting with `.` are ignored.

Example, `linux.txt`:

```
Linux, open-source software and command-line tools.
New releases of tools I use daily (Neovim, WezTerm, Podman, systemd)
Deep dives into how something works internally
Practical tutorials for self-hosting and automation
```

Constraints:

- `none` is a reserved name.
- At most 23 categories (tev1 was trained on 2 to 24 options, and one slot is taken by `none`).
- A category with only a description line triggers a warning: its articles will never be flagged.

## Usage

```sh
# See what would happen without writing anything
newsboat-triage --dry-run --limit 20

# Real run
newsboat-triage
```

Example output:

```
42 article(s) à traiter (modèle : tev1:4b, seuil : 0.7)
a 0.91  linux          Neovim 0.12 released: what's new
- 0.12  science        Yet another benchmark of a CPU nobody asked for
- 0.00  none           Weekly newsletter #214
Terminé : 42 traité(s), 5 flaggé(s) « a ».
```

A leading `a` means the article was flagged; `-` means it wasn't.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--db <path>` | `$XDG_DATA_HOME/newsboat/cache.db`, then `~/.newsboat/cache.db` | Path to Newsboat's `cache.db` |
| `--config <dir>` | `$XDG_CONFIG_HOME/newsboat-triage` | Config directory (categories are read from its `categories/` subfolder) |
| `--model <name>` | `$TRIAGE_MODEL` or `tev1:4b` | Ollama model to use |
| `--host <url>` | `$OLLAMA_HOST` or `http://localhost:11434` | Ollama server (the `http://` prefix is optional) |
| `--threshold <0-1>` | `0.7` | Minimum probability required to set the flag |
| `--limit <n>` | no limit | Process at most `n` new articles |
| `--dry-run` | off | Classify and rate, print results, but record nothing and flag nothing |

## Using the flag in Newsboat

Article attributes such as `flags` are only available in filters applied to **articles**, so the most reliable way to use the flag is a [query feed](https://newsboat.org/releases/2.45.1/docs/newsboat.html#_query_feeds). Add this line to your Newsboat `urls` file:

```
"query:Worth reading:flags # \"a\" and unread = \"yes\""
```

It then shows up as a virtual feed named "Worth reading" in the feed list. Drop `and unread = "yes"` if you also want to see articles you've already read.

Note that pressing `F` (select filter) in the *feed list* filters feeds, not articles, and will fail with an error saying that the `flags` attribute is not available. Use a query feed instead, or apply the filter from within an article list.

## Files and state

| Path | Purpose |
| --- | --- |
| `$XDG_STATE_HOME/newsboat-triage/state.db` | Decisions already made (category, score, flagged, applied). Default: `~/.local/state/newsboat-triage/state.db` |
| `$XDG_CONFIG_HOME/newsboat-triage/categories/` | Your category files |

Because decisions are stored, each article is only processed **once**. To re-evaluate everything (after changing your criteria, for instance), delete `state.db`, or remove specific rows from its `decisions` table.

Flags from a previous run that could not be written (database busy, crash) are picked up and applied at the end of the next run.

## Notes and limitations

- Only articles that are unread and not deleted are considered.
- tev1 works with a small context window (about 2000 tokens), so only the title, feed URL and the first 1200 characters of the article (HTML stripped) are sent to the model.
- The Newsboat database is opened **read-only** while the model is running, then briefly opened for writing at the end (with a 10 s busy timeout). Avoid triggering a reload in Newsboat at that exact moment, or simply close it while the script runs.
- The script aborts after 3 consecutive failures, which usually means Ollama is down, too old, or the model isn't installed.
- Log messages are currently in French.

## Automating it

A systemd user timer or a cron job works well, for example every hour:

```cron
0 * * * * /home/you/.local/bin/newsboat-triage >> ~/.local/state/newsboat-triage/run.log 2>&1
```

## License

[MIT](LICENSE) © Yann Perrin. You are free to use, modify and redistribute this script, as long as the copyright notice and the license text are kept.
