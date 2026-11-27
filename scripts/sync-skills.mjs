#!/usr/bin/env node
/**
 * sync-skills: copies the skills listed in skills.lock.json from
 * cloudinary-devs/skills into this plugin, and checks that they still match.
 *
 *   node scripts/sync-skills.mjs --ref <commit|branch>   sync to that skills commit
 *   node scripts/sync-skills.mjs --check [--base <ref>]  verify (CI)
 *
 * Sync, for every lock entry with "source": "skills-repo":
 *   - copies the skill directory at the target commit
 *   - rewrites install_source=skillspack to install_source=plugin in every file
 *   - derives the plugin version-check block from the npx block in SKILL.md
 *     (start comment, install source, update notice), so there is no second
 *     template to maintain
 *   - updates the lock entry (path, version, commit, tree)
 *   - bumps the plugin version in all three manifests when anything changed
 * skills.lock.json is the allowlist: skills that aren't in it are never added.
 * A sync to the commit the lock already records for every synced skill does
 * nothing.
 *
 * Check:
 *   - all three manifests carry the same version
 *   - skills/ and skills.lock.json list the same skills, with matching versions
 *   - every synced skill is byte-identical to what the sync derives from its
 *     lock commit, and its lock tree matches that commit
 *   - every synced SKILL.md carries the plugin block, and nothing under skills/
 *     still says install_source=skillspack
 *   - with --base: a change under skills/ or to skills.lock.json also bumps
 *     the plugin version
 *
 * Options:
 *   --ref <ref>          skills commit or branch to sync to (default: main)
 *   --bump <level>       patch | minor | major | auto (default auto: minor if a
 *                        synced skill had a minor or major bump, else patch)
 *   --skills-dir <path>  use an existing skills checkout instead of fetching
 *   --summary <file>     write a Markdown summary of the sync (for a PR body)
 *   --base <ref>         (check) git ref of this repo to compare versions with
 *
 * No dependencies: Node 20+ and git.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'skills.lock.json');
const MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json'];

const NPX_SOURCE = 'install_source=skillspack';
const PLUGIN_SOURCE = 'install_source=plugin';
const BLOCK_START_RE = /^<!-- version-check:start[^\n]*-->$/m;
const BLOCK_END = '<!-- version-check:end -->';
const PLUGIN_BLOCK_START = '<!-- version-check:start (derived from templates/version-check.md in cloudinary-devs/skills by scripts/sync-skills.mjs, never edit it here) -->';
const NPX_NOTICE_RE = /^- Newer: [^\n]*npx skills update[^\n]*$/gm;
const PLUGIN_NOTICE = "- Newer: tell the user in one line that a newer version of this skill is available, and that they can get it by updating the Cloudinary plugin from their agent's plugin manager (in Claude Code, run `/plugin`). This skill came with the Cloudinary plugin, so don't suggest `npx skills` commands, and don't run the update yourself.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args, { cwd = ROOT, input, allowFail = false, binary = false } = {}) {
    const r = spawnSync('git', args, { cwd, input, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) {
        if (allowFail) return null;
        throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
    }
    return binary ? r.stdout : r.stdout.trim();
}

function parseArgs(argv) {
    const args = { check: false, ref: 'main', bump: 'auto' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (a === '--check') args.check = true;
        else if (a === '--ref') args.ref = value();
        else if (a === '--bump') args.bump = value();
        else if (a === '--skills-dir') args.skillsDir = path.resolve(value());
        else if (a === '--summary') args.summary = path.resolve(value());
        else if (a === '--base') args.base = value();
        else throw new Error(`unknown argument ${a}`);
    }
    if (!['auto', 'patch', 'minor', 'major'].includes(args.bump)) throw new Error(`--bump must be auto, patch, minor, or major`);
    return args;
}

const readLock = () => JSON.parse(readFileSync(LOCK, 'utf8'));

function parseSemver(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '');
    if (!m) throw new Error(`not a plain semver version: ${JSON.stringify(v)}`);
    return m.slice(1).map(Number);
}

function compareSemver(a, b) {
    const [x, y] = [parseSemver(a), parseSemver(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

function bumpSemver(v, level) {
    const [maj, min, pat] = parseSemver(v);
    return level === 'major' ? `${maj + 1}.0.0` : level === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** metadata.version from the leading frontmatter of a SKILL.md. */
function skillVersion(skillMd) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillMd)?.[1] ?? '';
    return /^[ \t]+version:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/m.exec(fm)?.[1] ?? '';
}

function manifestVersion(text, label) {
    const m = /"version":\s*"([^"]+)"/.exec(text);
    if (!m) throw new Error(`${label}: no "version" field`);
    return m[1];
}

/** Relative path -> Buffer for every file under dir. */
function readTree(dir, rel = '') {
    const out = new Map();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) for (const [k, v] of readTree(abs, r)) out.set(k, v);
        else if (entry.isFile()) out.set(r, readFileSync(abs));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Skills repo access
// ---------------------------------------------------------------------------

class SkillsRepo {
    constructor(slug, dir) {
        this.url = `https://github.com/${slug}.git`;
        this.own = !dir;
        this.dir = dir ?? mkdtempSync(path.join(os.tmpdir(), 'cld-skills-'));
        if (this.own) {
            git(['init', '--quiet'], { cwd: this.dir });
            git(['remote', 'add', 'origin', this.url], { cwd: this.dir });
        }
    }

    /** Full commit SHA for a branch, tag, or SHA, fetching it if needed. */
    resolve(ref) {
        const isSha = /^[0-9a-f]{40}$/.test(ref);
        if (isSha && git(['cat-file', '-e', `${ref}^{commit}`], { cwd: this.dir, allowFail: true }) !== null) return ref;
        if (!this.own) {
            const local = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: this.dir, allowFail: true });
            if (local) return local;
        }
        git(['fetch', '--quiet', '--depth', '1', this.own ? 'origin' : this.url, ref], { cwd: this.dir });
        return git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: this.dir });
    }

    tree(commit, dir) {
        return git(['rev-parse', '--verify', '--quiet', `${commit}:${dir}`], { cwd: this.dir, allowFail: true });
    }

    /** Directory of the skill at that commit: the lock path, or wherever it moved to. */
    locate(commit, name, lockPath) {
        if (lockPath && this.tree(commit, `${lockPath}/SKILL.md`)) return lockPath;
        const hit = git(['ls-tree', '-r', '--name-only', commit, '--', 'skills'], { cwd: this.dir })
            .split('\n').filter(p => p.endsWith(`/${name}/SKILL.md`));
        if (hit.length !== 1) throw new Error(`${name}: expected one SKILL.md in the skills repo at ${commit.slice(0, 8)}, found ${hit.length}. If the skill was removed or renamed, update skills.lock.json by hand.`);
        return path.posix.dirname(hit[0]);
    }

    /** Names of every skill at that commit. */
    names(commit) {
        return git(['ls-tree', '-r', '--name-only', commit, '--', 'skills'], { cwd: this.dir })
            .split('\n').filter(p => p.endsWith('/SKILL.md')).map(p => path.posix.basename(path.posix.dirname(p)));
    }

    /** Relative path -> Buffer for every file of a skill directory at that commit. */
    files(commit, dir) {
        const out = new Map();
        const listing = git(['ls-tree', '-r', '-z', commit, '--', `${dir}/`], { cwd: this.dir });
        for (const line of listing.split('\0').filter(Boolean)) {
            const [meta, file] = line.split('\t');
            const [mode, type, sha] = meta.split(' ');
            if (type !== 'blob' || mode === '120000') throw new Error(`${file}: only regular files can be synced (found ${type}, mode ${mode})`);
            out.set(file.slice(dir.length + 1), git(['cat-file', 'blob', sha], { cwd: this.dir, binary: true }));
        }
        if (!out.has('SKILL.md')) throw new Error(`${dir}: no SKILL.md at ${commit.slice(0, 8)}`);
        return out;
    }

    dispose() {
        if (this.own) rmSync(this.dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Source -> plugin transform
// ---------------------------------------------------------------------------

/** Turns the npx version-check block of a SKILL.md into the plugin block. */
function toPluginBlock(skillMd, label) {
    const start = BLOCK_START_RE.exec(skillMd);
    const end = skillMd.indexOf(BLOCK_END);
    if (!start || end < start.index) throw new Error(`${label}: no version-check block in the source SKILL.md`);
    if (skillMd.indexOf(BLOCK_END, end + 1) !== -1 || BLOCK_START_RE.exec(skillMd.slice(start.index + 1))) {
        throw new Error(`${label}: more than one version-check block`);
    }
    let block = skillMd.slice(start.index, end);
    if (!block.includes(PLUGIN_SOURCE)) throw new Error(`${label}: the version-check URL has no install_source to rewrite. The template in cloudinary-devs/skills changed, so update scripts/sync-skills.mjs.`);
    const notices = block.match(NPX_NOTICE_RE) ?? [];
    if (notices.length !== 1) throw new Error(`${label}: expected one "- Newer:" line with the npx update command in the version-check block, found ${notices.length}. The template in cloudinary-devs/skills changed, so update scripts/sync-skills.mjs.`);
    block = block.replace(start[0], PLUGIN_BLOCK_START).replace(notices[0], PLUGIN_NOTICE);
    if (/npx skills (add|update)/.test(block)) throw new Error(`${label}: the version-check block still mentions an npx install command after the rewrite. Update scripts/sync-skills.mjs.`);
    return skillMd.slice(0, start.index) + block + skillMd.slice(end);
}

/** Plugin version of one source file. Binary files pass through untouched. */
function toPlugin(rel, buf, label) {
    if (buf.includes(0)) return buf;
    let text = buf.toString('utf8').replaceAll(NPX_SOURCE, PLUGIN_SOURCE);
    if (rel === 'SKILL.md') text = toPluginBlock(text, label);
    return Buffer.from(text, 'utf8');
}

function derive(repo, commit, dir, name) {
    const out = new Map();
    for (const [rel, buf] of repo.files(commit, dir)) out.set(rel, toPlugin(rel, buf, name));
    return out;
}

/** Differences between two file maps, as human-readable lines. */
function diffTrees(want, have) {
    const out = [];
    for (const [rel, buf] of want) {
        if (!have.has(rel)) out.push(`missing ${rel}`);
        else if (!buf.equals(have.get(rel))) out.push(`differs ${rel}`);
    }
    for (const rel of have.keys()) if (!want.has(rel)) out.push(`unexpected ${rel}`);
    return out;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function sync(args) {
    const lock = readLock();
    const repo = new SkillsRepo(lock.skillsRepo, args.skillsDir);
    try {
        const target = repo.resolve(args.ref);
        const synced = lock.skills.filter(s => s.source === 'skills-repo');
        // The lock already records this commit for every synced skill, so there's nothing to release.
        if (synced.length && synced.every(s => s.commit === target)) {
            const line = `Already synced to ${lock.skillsRepo}@${target.slice(0, 8)}.`;
            console.log(line);
            if (args.summary) writeFileSync(args.summary, line + '\n');
            if (process.env.GITHUB_OUTPUT) {
                const current = manifestVersion(readFileSync(path.join(ROOT, MANIFESTS[0]), 'utf8'), MANIFESTS[0]);
                appendFileSync(process.env.GITHUB_OUTPUT, `changed=false\nversion=${current}\ncommit=${target}\n`);
            }
            return;
        }
        const rows = [];
        let level = 'patch';
        for (const entry of synced) {
            const dir = repo.locate(target, entry.name, entry.path);
            const tree = repo.tree(target, dir);
            const files = derive(repo, target, dir, entry.name);
            const version = skillVersion(files.get('SKILL.md').toString('utf8'));
            parseSemver(version);

            const dest = path.join(ROOT, 'skills', entry.name);
            const before = existsSync(dest) ? readTree(dest) : new Map();
            const changed = diffTrees(files, before).length > 0;
            if (changed) {
                rmSync(dest, { recursive: true, force: true });
                for (const [rel, buf] of files) {
                    mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
                    writeFileSync(path.join(dest, rel), buf);
                }
            }
            if (tree !== entry.tree && entry.version === version) {
                throw new Error(`${entry.name}: content changed in the skills repo but its version is still ${version}. Bump metadata.version in cloudinary-devs/skills first.`);
            }
            // A new lock entry (no version yet) or a minor/major skill bump makes it a minor plugin release.
            const [was, now] = [entry.version ? parseSemver(entry.version) : null, parseSemver(version)];
            if (!was || was[0] !== now[0] || was[1] !== now[1]) level = 'minor';
            // An untouched skill keeps its lock commit, so the lock only moves for real changes.
            if (tree !== entry.tree || dir !== entry.path || changed) {
                rows.push({ name: entry.name, from: entry.version, to: version, changed });
                Object.assign(entry, { path: dir, version, commit: target, tree });
            }
        }

        const tracked = new Set(lock.skills.map(s => s.name));
        const untracked = repo.names(target).filter(n => !tracked.has(n)).sort();
        const anyChange = rows.some(r => r.changed);

        let pluginVersion = manifestVersion(readFileSync(path.join(ROOT, MANIFESTS[0]), 'utf8'), MANIFESTS[0]);
        const previous = pluginVersion;
        if (anyChange) {
            // Bump from the committed version, so a second run on the same branch doesn't bump twice.
            const committed = git(['show', `HEAD:${MANIFESTS[0]}`], { allowFail: true });
            const base = committed ? manifestVersion(committed, MANIFESTS[0]) : pluginVersion;
            pluginVersion = bumpSemver(base, args.bump === 'auto' ? level : args.bump);
            for (const m of MANIFESTS) {
                const file = path.join(ROOT, m);
                writeFileSync(file, readFileSync(file, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${pluginVersion}$2`));
            }
        }
        if (rows.length) writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');

        const lines = [];
        if (anyChange) {
            lines.push(`Syncs skills from [${lock.skillsRepo}@${target.slice(0, 8)}](https://github.com/${lock.skillsRepo}/commit/${target}) and bumps the plugin from ${previous} to ${pluginVersion}.`, '');
            lines.push('| Skill | Version |', '|---|---|');
            for (const r of rows.filter(r => r.changed)) lines.push(`| ${r.name} | ${!r.from ? `${r.to} (new)` : r.from === r.to ? r.to : `${r.from} → ${r.to}`} |`);
        } else {
            lines.push(`No synced skill changed at ${lock.skillsRepo}@${target.slice(0, 8)}.`);
        }
        if (untracked.length) lines.push('', `Not in \`skills.lock.json\`, so not synced: ${untracked.join(', ')}.`);
        console.log(lines.join('\n'));
        if (args.summary) writeFileSync(args.summary, lines.join('\n') + '\n');
        if (process.env.GITHUB_OUTPUT) {
            appendFileSync(process.env.GITHUB_OUTPUT, `changed=${anyChange}\nversion=${pluginVersion}\ncommit=${target}\n`);
        }
    } finally {
        repo.dispose();
    }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function check(args) {
    const errors = [];
    const lock = readLock();

    const versions = MANIFESTS.map(m => [m, manifestVersion(readFileSync(path.join(ROOT, m), 'utf8'), m)]);
    if (new Set(versions.map(v => v[1])).size !== 1) {
        errors.push(`manifests disagree on the plugin version: ${versions.map(([m, v]) => `${m} ${v}`).join(', ')}`);
    }
    const pluginVersion = versions[0][1];

    const skillsRoot = path.join(ROOT, 'skills');
    const onDisk = readdirSync(skillsRoot).filter(n => statSync(path.join(skillsRoot, n)).isDirectory()).sort();
    const locked = lock.skills.map(s => s.name).sort();
    for (const n of onDisk.filter(n => !locked.includes(n))) errors.push(`skills/${n} has no entry in skills.lock.json`);
    for (const n of locked.filter(n => !onDisk.includes(n))) errors.push(`skills.lock.json lists ${n}, but skills/${n} doesn't exist`);

    for (const [rel, buf] of readTree(skillsRoot)) {
        if (!buf.includes(0) && buf.toString('utf8').includes(NPX_SOURCE)) errors.push(`skills/${rel} still contains ${NPX_SOURCE}`);
    }

    const repo = new SkillsRepo(lock.skillsRepo, args.skillsDir);
    try {
        for (const entry of lock.skills.filter(s => onDisk.includes(s.name))) {
            const dest = path.join(skillsRoot, entry.name);
            const have = readTree(dest);
            const skillMd = have.get('SKILL.md')?.toString('utf8') ?? '';
            if (!skillMd) { errors.push(`${entry.name}: no SKILL.md`); continue; }
            if (skillVersion(skillMd) !== entry.version) {
                errors.push(`${entry.name}: lock says ${entry.version}, SKILL.md says ${skillVersion(skillMd) || 'nothing'}`);
            }
            if (entry.source !== 'skills-repo') continue;

            if (!skillMd.includes(PLUGIN_BLOCK_START) || !skillMd.includes(PLUGIN_NOTICE)) {
                errors.push(`${entry.name}: SKILL.md doesn't carry the plugin version-check block`);
            }
            try {
                const commit = repo.resolve(entry.commit);
                const tree = repo.tree(commit, entry.path);
                if (tree !== entry.tree) errors.push(`${entry.name}: lock tree ${entry.tree} doesn't match ${entry.path} at ${commit.slice(0, 8)} (${tree ?? 'path not found'})`);
                if (!tree) continue;
                for (const d of diffTrees(derive(repo, commit, entry.path, entry.name), have)) {
                    errors.push(`${entry.name}: ${d} (compared with ${lock.skillsRepo}@${commit.slice(0, 8)}). Synced skills are never edited here: change them in ${lock.skillsRepo} and run scripts/sync-skills.mjs.`);
                }
            } catch (e) {
                errors.push(`${entry.name}: ${e.message}`);
            }
        }
    } finally {
        repo.dispose();
    }

    if (args.base) {
        const baseManifest = git(['show', `${args.base}:${MANIFESTS[0]}`], { allowFail: true });
        const touched = git(['diff', '--name-only', args.base, 'HEAD', '--', 'skills', 'skills.lock.json']);
        if (baseManifest && touched) {
            const baseVersion = manifestVersion(baseManifest, MANIFESTS[0]);
            if (compareSemver(pluginVersion, baseVersion) <= 0) {
                errors.push(`skills changed but the plugin version is still ${pluginVersion} (base ${baseVersion}). Bump it in all three manifests.`);
            }
        }
    }

    if (errors.length) {
        for (const e of errors) console.log(process.env.GITHUB_ACTIONS ? `::error::${e}` : `✖ ${e}`);
        process.exit(1);
    }
    console.log(`✔ plugin ${pluginVersion}: ${locked.length} skills match skills.lock.json and their source commits`);
}

try {
    const args = parseArgs(process.argv.slice(2));
    if (args.check) check(args); else sync(args);
} catch (e) {
    console.error(`✖ sync-skills: ${e.message}`);
    process.exit(1);
}
