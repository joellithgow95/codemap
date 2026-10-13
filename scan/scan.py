"""Scan a git repo into the codemap.json the web app renders."""

import argparse
import ast
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

MAX_TEXT_BYTES = 200_000
MAX_PATCH_LINES = 150
MAX_DATA_BYTES = 20_000
BINARY_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".lock", ".pdf", ".pkl", ".xlsx", ".zip"}
DATA_EXTS = {".json", ".csv", ".txt", ".jsonl", ".tsv", ".xml"}
LANGS = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".html": "html",
    ".css": "css",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".json": "json",
    ".sh": "shell",
    ".sql": "sql",
    ".mako": "python",
}
JS_SYMBOL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|class)\s+(\w+))", re.M
)


def git(repo: Path, *args: str) -> str:
    """Return stdout of a git command run in the repo."""
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    ).stdout


def lang_of(path: str) -> str:
    """Return the language label for a file path."""
    name = Path(path).name
    if name in {"Dockerfile", "Justfile"}:
        return "shell"
    return LANGS.get(Path(path).suffix, "text")


def list_files(repo: Path) -> list[str]:
    """Return tracked plus untracked-but-not-ignored files that exist on disk."""
    out = git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    return sorted({p for p in out.split("\0") if p and (repo / p).is_file()})


def read_text(repo: Path, path: str) -> str | None:
    """Return file text, or None for binary or oversized files."""
    if Path(path).suffix in BINARY_EXTS:
        return None
    data = (repo / path).read_bytes()
    limit = MAX_DATA_BYTES if Path(path).suffix in DATA_EXTS else MAX_TEXT_BYTES
    if len(data) > limit or b"\0" in data:
        return None
    return data.decode("utf-8", errors="replace")


def python_symbols(text: str) -> list[dict]:
    """Return top-level classes and functions, with methods nested one level."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    kinds = {ast.ClassDef: "class", ast.FunctionDef: "function", ast.AsyncFunctionDef: "function"}

    def describe(node: ast.AST, parent: str | None) -> dict:
        return {
            "name": node.name,
            "kind": "method" if parent and kinds[type(node)] == "function" else kinds[type(node)],
            "line": node.lineno,
            "end": node.end_lineno,
            "parent": parent,
        }

    symbols = []
    for node in tree.body:
        if type(node) not in kinds:
            continue
        symbols.append(describe(node, None))
        if isinstance(node, ast.ClassDef):
            symbols += [describe(c, node.name) for c in node.body if type(c) in kinds]
    return symbols


def js_symbols(text: str) -> list[dict]:
    """Return top-level function, const, and class declarations in JS."""
    return [
        {
            "name": m.group(1) or m.group(2),
            "kind": "function" if m.group(1) else "const",
            "line": text.count("\n", 0, m.start()) + 1,
            "end": None,
            "parent": None,
        }
        for m in JS_SYMBOL.finditer(text)
    ]


def python_imports(text: str, path: str, module_index: dict[str, str]) -> list[str]:
    """Return repo paths this Python file imports."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    package = module_name(path)
    parts = package.split(".") if package else []
    wanted: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            wanted |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = parts[: len(parts) - node.level + (1 if path.endswith("__init__.py") else 0)]
                base_name = ".".join(base + ([node.module] if node.module else []))
            else:
                base_name = node.module or ""
            wanted.add(base_name)
            wanted |= {f"{base_name}.{a.name}" for a in node.names}
    return sorted({module_index[m] for m in wanted if m in module_index} - {path})


def module_name(path: str) -> str:
    """Return the dotted module name for a Python file under src/ or the root."""
    p = Path(path)
    if p.suffix != ".py":
        return ""
    rel = p.relative_to("src") if p.parts[0] == "src" else p
    parts = list(rel.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def blame(repo: Path, path: str, sha_index: dict[str, int]) -> list[int]:
    """Return, per line, the index of the commit that last touched it."""
    try:
        out = git(repo, "blame", "--porcelain", "-w", "HEAD", "--", path)
    except subprocess.CalledProcessError:
        return []
    lines = []
    for raw in out.splitlines():
        head = raw.split(" ")
        if len(head) >= 3 and re.fullmatch(r"[0-9a-f]{40}", head[0]):
            lines.append(sha_index.get(head[0], -1))
    return lines


def worktree_changes(repo: Path) -> dict[str, dict]:
    """Return per-path working-tree state and the changed line numbers vs HEAD."""
    state: dict[str, dict] = {}
    for entry in git(repo, "status", "--porcelain", "-z").split("\0"):
        if len(entry) < 4:
            continue
        x, y, path = entry[0], entry[1], entry[3:]
        label = "untracked" if x == "?" else "staged" if y == " " else "modified"
        state[path] = {"status": label, "lines": []}
    diff = git(repo, "diff", "-U0", "HEAD", "--no-color")
    current = None
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
        elif line.startswith("@@") and current in state:
            m = re.search(r"\+(\d+)(?:,(\d+))?", line)
            start, count = int(m.group(1)), int(m.group(2) or 1)
            state[current]["lines"] += list(range(start, start + count))
    return state


def parse_commits(repo: Path) -> list[dict]:
    """Return commits oldest-first with per-file add/del counts and renames."""
    marker = "\x1e"
    raw = git(
        repo, "log", "--reverse", "-M", "-z", "--numstat",
        f"--format={marker}%H%x00%h%x00%an%x00%aI%x00%s",
    )
    commits = []
    for block in raw.split(marker)[1:]:
        fields = block.split("\0")
        sha, short, author, date, subject = fields[:5]
        rest = fields[5:]
        files = []
        i = 0
        while i < len(rest):
            token = rest[i].lstrip("\n")
            if not token:
                i += 1
                continue
            add, dele, path = token.split("\t", 2)
            old = None
            if path == "":
                old, path = rest[i + 1], rest[i + 2]
                i += 2
            files.append(
                {
                    "path": path,
                    "old": old,
                    "add": 0 if add == "-" else int(add),
                    "del": 0 if dele == "-" else int(dele),
                }
            )
            i += 1
        commits.append(
            {"sha": sha, "short": short, "author": author, "date": date,
             "subject": subject, "files": files}
        )
    return commits


def attach_patches(repo: Path, commits: list[dict]) -> None:
    """Add a truncated unified patch to each file entry of each commit."""
    for commit in commits:
        out = git(repo, "show", "-M", "--format=", "--no-color", "-U3", commit["sha"])
        patches: dict[str, list[str]] = {}
        current = None
        for line in out.splitlines():
            if line.startswith("diff --git "):
                current = line.split(" b/", 1)[1]
                patches[current] = []
            elif current and not line.startswith(("index ", "--- ", "+++ ")):
                patches[current].append(line)
        for f in commit["files"]:
            lines = [] if Path(f["path"]).suffix in DATA_EXTS | BINARY_EXTS else patches.get(f["path"], [])
            f["patch"] = "\n".join(lines[:MAX_PATCH_LINES])
            f["truncated"] = len(lines) > MAX_PATCH_LINES


def build(repo: Path) -> dict:
    """Return the full codemap document for a repo."""
    paths = list_files(repo)
    commits = parse_commits(repo)
    attach_patches(repo, commits)
    sha_index = {c["sha"]: i for i, c in enumerate(commits)}
    tracked = set(git(repo, "ls-files", "-z").split("\0"))
    changes = worktree_changes(repo)

    module_index = {module_name(p): p for p in paths if module_name(p)}
    history: dict[str, dict] = {}
    for idx, c in enumerate(commits):
        for f in c["files"]:
            h = history.setdefault(
                f["path"], {"commits": [], "added": 0, "deleted": 0, "authors": set()}
            )
            if f["old"] and f["old"] in history:
                prior = history.pop(f["old"])
                h["commits"] += prior["commits"]
                h["added"] += prior["added"]
                h["deleted"] += prior["deleted"]
                h["authors"] |= prior["authors"]
            h["commits"].append(idx)
            h["added"] += f["add"]
            h["deleted"] += f["del"]
            h["authors"].add(c["author"])

    files = []
    for path in paths:
        text = read_text(repo, path)
        lang = lang_of(path)
        h = history.get(path, {"commits": [], "added": 0, "deleted": 0, "authors": set()})
        symbols = []
        imports = []
        if text is not None and lang == "python":
            symbols = python_symbols(text)
            imports = python_imports(text, path, module_index)
        elif text is not None and lang == "javascript":
            symbols = js_symbols(text)
        change = changes.get(path, {"status": "clean", "lines": []})
        files.append(
            {
                "path": path,
                "lang": lang,
                "loc": text.count("\n") + (0 if text.endswith("\n") else 1) if text else 0,
                "bytes": (repo / path).stat().st_size,
                "text": text,
                "symbols": symbols,
                "imports": imports,
                "commits": h["commits"],
                "added": h["added"],
                "deleted": h["deleted"],
                "authors": sorted(h["authors"]),
                "tracked": path in tracked,
                "status": change["status"],
                "dirtyLines": change["lines"],
                "blame": blame(repo, path, sha_index) if path in tracked and text else [],
            }
        )

    return {
        "repo": repo.name,
        "head": git(repo, "rev-parse", "--short", "HEAD").strip(),
        "branch": git(repo, "branch", "--show-current").strip(),
        "generated": datetime.now(timezone.utc).isoformat(),
        "commits": commits,
        "files": files,
    }


def main() -> None:
    """Parse arguments, scan the repo, and write the JSON document."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path, nargs="?", default=Path("~/Code/personal/dash"))
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).parent.parent / "web/local-maps")
    args = parser.parse_args()
    repo = args.repo.expanduser().resolve()
    doc = build(repo)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"{slug_of(repo)}.json"
    out.write_text(json.dumps(doc))
    update_manifest(args.out_dir, doc, repo)
    print(f"{len(doc['files'])} files, {len(doc['commits'])} commits -> {out}")


def slug_of(repo: Path) -> str:
    """Return the lowercase repo name used for the map file and manifest entry."""
    return repo.name.lower()


def update_manifest(out_dir: Path, doc: dict, repo: Path) -> None:
    """Record the scanned repo in manifest.json so the web app can list and rescan it."""
    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    manifest = [m for m in manifest if m["name"] != slug_of(repo)]
    manifest.append(
        {
            "name": slug_of(repo),
            "path": str(repo),
            "files": len(doc["files"]),
            "commits": len(doc["commits"]),
            "generated": doc["generated"],
        }
    )
    manifest_path.write_text(json.dumps(sorted(manifest, key=lambda m: m["name"]), indent=1))


if __name__ == "__main__":
    main()
