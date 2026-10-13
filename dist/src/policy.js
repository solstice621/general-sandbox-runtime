/** Strict, fail-closed v1 policy validation. Preflight does not replace OS enforcement. */
import fs, {} from "node:fs";
import { posix as path } from "node:path";
export const INVALID_POLICY = "INVALID_POLICY";
export const UNSUPPORTED_POLICY = "UNSUPPORTED_POLICY";
export const BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE";
export const SANDBOX_SETUP_FAILED = "SANDBOX_SETUP_FAILED";
export const MAX_POLICY_BYTES = 64 * 1024;
export const MAX_AUDIT_ENTRIES = 100_000;
export const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export class RuntimeError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "RuntimeError";
        this.code = code;
    }
}
const safeNames = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const localeValue = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u;
const terminalValue = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/u;
const timezoneValue = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;
function invalid(message, cause) {
    throw new RuntimeError(INVALID_POLICY, message, cause === undefined ? undefined : { cause });
}
function unsupported(message, cause) {
    throw new RuntimeError(UNSUPPORTED_POLICY, message, cause === undefined ? undefined : { cause });
}
function wellFormed(value) {
    for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = value.charCodeAt(++i);
            if (!(low >= 0xdc00 && low <= 0xdfff))
                return false;
        }
        else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return false;
        }
    }
    return true;
}
function decodeBytes(value, message) {
    try {
        return utf8.decode(value);
    }
    catch (cause) {
        return invalid(message, cause);
    }
}
/** A small JSON reader retains duplicate keys and numeric spelling before JS conversion. */
class StrictJSON {
    offset = 0;
    source;
    constructor(source) { this.source = source; }
    parse() {
        const result = this.value(0);
        this.whitespace();
        if (this.offset !== this.source.length)
            invalid("policy must contain exactly one JSON document");
        return result;
    }
    whitespace() {
        while (/[\t\n\r ]/u.test(this.source.charAt(this.offset)) && this.offset < this.source.length)
            this.offset++;
    }
    string() {
        if (this.source.charAt(this.offset) !== '"')
            invalid("JSON object keys must be strings");
        const start = this.offset++;
        while (this.offset < this.source.length) {
            const current = this.source.charAt(this.offset++);
            if (current === "\\") {
                this.offset++;
                continue;
            }
            if (current === '"') {
                let decoded;
                try {
                    decoded = JSON.parse(this.source.slice(start, this.offset));
                }
                catch (cause) {
                    return invalid("invalid JSON string", cause);
                }
                if (typeof decoded !== "string" || !wellFormed(decoded))
                    invalid("unpaired Unicode surrogate escape");
                return decoded;
            }
        }
        return invalid("unterminated JSON string");
    }
    value(depth) {
        if (depth > 12)
            invalid("JSON nesting exceeds policy schema");
        this.whitespace();
        const current = this.source.charAt(this.offset);
        if (current === '"')
            return this.string();
        if (current === "{") {
            this.offset++;
            const result = Object.create(null);
            this.whitespace();
            if (this.source.charAt(this.offset) === "}") {
                this.offset++;
                return result;
            }
            for (;;) {
                this.whitespace();
                const key = this.string();
                if (Object.hasOwn(result, key))
                    invalid(`duplicate JSON key ${JSON.stringify(key)}`);
                this.whitespace();
                if (this.source.charAt(this.offset++) !== ":")
                    invalid("expected ':' after JSON key");
                result[key] = this.value(depth + 1);
                this.whitespace();
                const separator = this.source.charAt(this.offset++);
                if (separator === "}")
                    return result;
                if (separator !== ",")
                    invalid("expected ',' or '}' in JSON object");
            }
        }
        if (current === "[") {
            this.offset++;
            const result = [];
            this.whitespace();
            if (this.source.charAt(this.offset) === "]") {
                this.offset++;
                return result;
            }
            for (;;) {
                result.push(this.value(depth + 1));
                this.whitespace();
                const separator = this.source.charAt(this.offset++);
                if (separator === "]")
                    return result;
                if (separator !== ",")
                    invalid("expected ',' or ']' in JSON array");
            }
        }
        for (const [word, value] of [["true", true], ["false", false], ["null", null]]) {
            if (this.source.startsWith(word, this.offset)) {
                this.offset += word.length;
                return value;
            }
        }
        const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.offset));
        if (!match)
            return invalid("invalid JSON value");
        const token = match[0];
        this.offset += token.length;
        if (!/^-?(?:0|[1-9][0-9]*)$/u.test(token))
            invalid("policy numeric values must use integer tokens");
        const number = Number(token);
        if (!Number.isSafeInteger(number))
            invalid("policy integer is out of range");
        return number;
    }
}
function object(value, allowed, required, location) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        invalid(`${location} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalid(`${location} must be a plain object`);
    if (Object.getOwnPropertySymbols(value).length !== 0)
        invalid(`${location} has unknown symbol fields`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const values = Object.create(null);
    for (const [name, descriptor] of Object.entries(descriptors)) {
        if (!allowed.includes(name))
            invalid(`unknown field ${location}.${name}`);
        if (!("value" in descriptor))
            invalid(`${location}.${name} must be a data property`);
        values[name] = descriptor.value;
    }
    for (const name of required)
        if (!Object.hasOwn(values, name))
            invalid(`missing field ${location}.${name}`);
    return values;
}
function array(value, location) {
    if (!Array.isArray(value))
        invalid(`${location} must be an array`);
    if (value.length > MAX_POLICY_BYTES)
        invalid(`${location} exceeds the policy size limit`);
    if (Object.getOwnPropertySymbols(value).length !== 0)
        invalid(`${location} has unknown symbol fields`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== value.length + 1)
        invalid(`${location} must be a dense data array`);
    const result = [];
    for (let i = 0; i < value.length; i++) {
        const descriptor = descriptors[String(i)];
        if (descriptor === undefined || !("value" in descriptor))
            invalid(`${location}[${i}] must be a data property`);
        result.push(descriptor.value);
    }
    return result;
}
function string(value, location) {
    if (typeof value !== "string" || !wellFormed(value))
        invalid(`${location} must be a well-formed Unicode string`);
    return value;
}
function optionalArray(values, key, location) {
    return Object.hasOwn(values, key) ? array(values[key], `${location}.${key}`) : [];
}
function readRules(values, key, allowLogical) {
    return optionalArray(values, key, "filesystem").map((value, index) => {
        const location = `filesystem.${key}[${index}]`;
        const raw = object(value, allowLogical ? ["path", "scope", "logical"] : ["path", "scope"], ["path", "scope"], location);
        const rulePath = string(raw.path, `${location}.path`);
        const scope = string(raw.scope, `${location}.scope`);
        if (scope !== "file" && scope !== "tree")
            invalid(`${location}.scope must be file or tree`);
        if (Object.hasOwn(raw, "logical")) {
            return { path: rulePath, scope, logical: string(raw.logical, `${location}.logical`) };
        }
        return { path: rulePath, scope };
    });
}
function readPolicy(value, allowLogical) {
    const raw = object(value, ["version", "filesystem", "network", "ipc", "environment"], ["version", "filesystem", "network", "ipc", "environment"], "policy");
    if (typeof raw.version !== "number" || !Number.isSafeInteger(raw.version))
        invalid("policy.version must be an integer");
    if (raw.version !== 1)
        unsupported("policy version must be 1");
    const files = object(raw.filesystem, ["read", "denyRead", "allowWrite", "denyWrite", "temp"], ["read", "temp"], "filesystem");
    const read = string(files.read, "filesystem.read");
    if (read !== "host")
        unsupported("filesystem.read must be host");
    const temp = string(files.temp, "filesystem.temp");
    if (temp !== "none" && temp !== "private")
        unsupported("filesystem.temp must be none or private");
    const network = object(raw.network, ["mode"], ["mode"], "network");
    const mode = string(network.mode, "network.mode");
    if (mode !== "deny" && mode !== "host")
        unsupported("network.mode must be deny or host");
    const ipc = object(raw.ipc, ["hostUnixSockets"], ["hostUnixSockets"], "ipc");
    if (string(ipc.hostUnixSockets, "ipc.hostUnixSockets") !== "deny")
        unsupported("ipc.hostUnixSockets must be deny");
    const environment = object(raw.environment, ["inherit"], [], "environment");
    const names = optionalArray(environment, "inherit", "environment").map((name, index) => string(name, `environment.inherit[${index}]`));
    const inherited = new Set();
    for (const name of names) {
        if (!safeNames.has(name))
            unsupported(`environment variable ${JSON.stringify(name)} cannot be inherited`);
        if (inherited.has(name))
            invalid(`duplicate inherited environment variable ${JSON.stringify(name)}`);
        inherited.add(name);
    }
    return {
        version: 1,
        filesystem: { read, denyRead: readRules(files, "denyRead", allowLogical), allowWrite: readRules(files, "allowWrite", allowLogical), denyWrite: readRules(files, "denyWrite", allowLogical), temp },
        network: { mode }, ipc: { hostUnixSockets: "deny" }, environment: { inherit: names },
    };
}
/** Parses the original UTF-8 wire representation; logical is intentionally not a wire field. */
export function parsePolicy(data) {
    let source;
    if (typeof data === "string") {
        if (!wellFormed(data))
            invalid("policy is not valid Unicode");
        if (Buffer.byteLength(data, "utf8") > MAX_POLICY_BYTES)
            invalid(`policy exceeds ${MAX_POLICY_BYTES} bytes`);
        source = data;
    }
    else if (data instanceof Uint8Array) {
        if (data.byteLength > MAX_POLICY_BYTES)
            invalid(`policy exceeds ${MAX_POLICY_BYTES} bytes`);
        source = decodeBytes(data, "policy is not valid UTF-8");
    }
    else {
        return invalid("policy must be a string or UTF-8 bytes");
    }
    return validatePolicy(readPolicy(new StrictJSON(source).parse(), false));
}
function clean(value) {
    const normalized = path.normalize(value);
    return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}
function validLiteral(value) {
    if (typeof value !== "string" || !wellFormed(value) || !path.isAbsolute(value) || controlCharacters.test(value))
        invalid("path must be an absolute Unicode literal without control characters");
    if (/[*?\[\]]/u.test(value))
        invalid(`glob syntax is not supported in path ${JSON.stringify(value)}`);
    if (value.split("/").some((part) => part === "." || part === ".."))
        invalid(`dot path components are not supported in ${JSON.stringify(value)}`);
}
function realpath(value, label = "path") {
    try {
        const resolved = clean(decodeBytes(fs.realpathSync.native(value, { encoding: "buffer" }), `${label} resolves to invalid UTF-8`));
        validLiteral(resolved);
        return resolved;
    }
    catch (cause) {
        if (cause instanceof RuntimeError)
            throw cause;
        return invalid(`${label} ${JSON.stringify(value)} must exist`, cause);
    }
}
function stat(value) {
    try {
        return fs.statSync(value, { bigint: true });
    }
    catch (cause) {
        return invalid(`cannot stat ${JSON.stringify(value)}`, cause);
    }
}
function lstat(value) {
    try {
        return fs.lstatSync(value, { bigint: true });
    }
    catch (cause) {
        return invalid(`cannot inspect ${JSON.stringify(value)}`, cause);
    }
}
function sameIdentity(first, second) {
    return first.dev === second.dev && first.ino === second.ino;
}
function sameFile(first, second) {
    if (first === second)
        return true;
    return sameIdentity(stat(first), stat(second));
}
function within(candidate, root) {
    if (candidate === root || candidate.startsWith(`${root}/`) || root === "/")
        return true;
    const rootInfo = stat(root);
    for (let current = candidate;; current = path.dirname(current)) {
        if (sameIdentity(stat(current), rootInfo))
            return true;
        if (current === path.dirname(current))
            return false;
    }
}
function logical(rule) { return rule.logical ?? rule.path; }
function covers(rule, candidate, useLogical = false) {
    const root = useLogical ? logical(rule) : rule.path;
    return sameFile(root, candidate) || (rule.scope === "tree" && within(candidate, root));
}
function freezeRule(rulePath, scope, original) {
    const result = { path: rulePath, scope };
    Object.defineProperty(result, "logical", { value: original, enumerable: false, writable: false, configurable: false });
    return Object.freeze(result);
}
function normalizeRules(input, label) {
    const rules = [];
    const identities = new Set();
    for (const rule of input) {
        const original = logical(rule);
        validLiteral(original);
        validLiteral(rule.path);
        const originalClean = clean(original);
        const resolved = realpath(originalClean, label);
        if (rule.logical !== undefined && realpath(rule.path) !== resolved)
            invalid(`path ${JSON.stringify(originalClean)} changed since validation`);
        const info = stat(resolved);
        if (rule.scope === "tree" && !info.isDirectory())
            invalid(`tree path ${JSON.stringify(originalClean)} is not a directory`);
        if (rule.scope === "file" && !info.isFile())
            invalid(`file path ${JSON.stringify(originalClean)} is not a regular file`);
        if (rule.scope === "file" && info.nlink > 1n)
            unsupported(`hardlinked file rule ${JSON.stringify(originalClean)} cannot be safely isolated`);
        const key = `${info.dev}:${info.ino}:${rule.scope}`;
        if (identities.has(key))
            invalid(`duplicate ${label} rule through filesystem alias ${JSON.stringify(originalClean)}`);
        identities.add(key);
        rules.push(freezeRule(resolved, rule.scope, originalClean));
    }
    return rules;
}
function rejectMutableSymlinks(rule, writable) {
    let parts = logical(rule).split("/");
    let prefix = "/";
    let links = 0;
    while (parts.length !== 0) {
        const part = parts.shift();
        if (part === undefined || part === "" || part === ".")
            continue;
        if (part === "..") {
            prefix = path.dirname(prefix);
            continue;
        }
        const candidate = path.join(prefix, part);
        const info = lstat(candidate);
        if (!info.isSymbolicLink()) {
            prefix = candidate;
            continue;
        }
        if (++links > 40)
            unsupported("symlink resolution exceeds 40 hops");
        for (const allow of writable) {
            if (allow.scope === "tree" && within(prefix, allow.path))
                unsupported(`symlink ${JSON.stringify(candidate)} is mutable inside allowWrite ${JSON.stringify(logical(allow))}`);
        }
        let target;
        try {
            target = decodeBytes(fs.readlinkSync(candidate, { encoding: "buffer" }), "symlink target is not valid UTF-8");
        }
        catch (cause) {
            if (cause instanceof RuntimeError)
                throw cause;
            return invalid(`cannot inspect symlink ${JSON.stringify(candidate)}`, cause);
        }
        if (path.isAbsolute(target))
            prefix = "/";
        parts = [...target.split("/"), ...parts];
    }
    if (!sameFile(clean(prefix), rule.path))
        invalid(`path ${JSON.stringify(logical(rule))} changed during validation`);
}
/** Streaming directory traversal bounds work and memory before reading a huge directory. */
function auditTrees(rules) {
    let count = 0;
    const visitedDirectories = new Set();
    const visitedPaths = new Set();
    const frames = [];
    const inspect = (candidate) => {
        if (visitedPaths.has(candidate))
            return;
        visitedPaths.add(candidate);
        let info;
        try {
            info = fs.lstatSync(candidate, { bigint: true });
        }
        catch (cause) {
            return unsupported(`cannot audit policy path ${JSON.stringify(candidate)}`, cause);
        }
        const key = `${info.dev}:${info.ino}`;
        if (info.isDirectory() && visitedDirectories.has(key))
            return;
        if (++count > MAX_AUDIT_ENTRIES)
            unsupported(`policy tree audit exceeds ${MAX_AUDIT_ENTRIES} entries`);
        if (info.isSymbolicLink())
            return;
        if (info.isFile() && info.nlink > 1n)
            unsupported(`hardlink ${JSON.stringify(candidate)} could alias a protected or outside file`);
        if (info.isDirectory()) {
            visitedDirectories.add(key);
            // Buffer names prevent invalid filesystem UTF-8 from being silently
            // replaced and causing a different directory entry to be inspected.
            // Node 24 supports Buffer Dirent names; @types/node 24.0.0 incorrectly
            // narrows this option to BufferEncoding (which omits the "buffer" mode).
            frames.push({ directory: fs.opendirSync(candidate, { encoding: "buffer" }), root: candidate });
        }
    };
    try {
        for (const rule of rules) {
            if (rule.scope !== "tree")
                continue;
            inspect(rule.path);
            while (frames.length !== 0) {
                const frame = frames[frames.length - 1];
                if (frame === undefined)
                    break;
                const entry = frame.directory.readSync();
                if (entry === null) {
                    frame.directory.closeSync();
                    frames.pop();
                    continue;
                }
                const rawName = entry.name;
                const name = rawName instanceof Uint8Array ? decodeBytes(rawName, "directory entry is not valid UTF-8") : string(rawName, "directory entry");
                inspect(path.join(frame.root, name));
            }
        }
    }
    catch (cause) {
        if (cause instanceof RuntimeError && cause.code === UNSUPPORTED_POLICY)
            throw cause;
        return unsupported("cannot complete policy tree audit", cause);
    }
    finally {
        for (const frame of frames) {
            try {
                frame.directory.closeSync();
            }
            catch { /* Preserve the validation failure. */ }
        }
    }
}
function freezePolicy(policy) {
    Object.freeze(policy.filesystem.denyRead);
    Object.freeze(policy.filesystem.allowWrite);
    Object.freeze(policy.filesystem.denyWrite);
    Object.freeze(policy.filesystem);
    Object.freeze(policy.network);
    Object.freeze(policy.ipc);
    Object.freeze(policy.environment.inherit);
    Object.freeze(policy.environment);
    return Object.freeze(policy);
}
/** Validates current filesystem state and returns an independent immutable snapshot. */
export function validatePolicy(input) {
    const policy = readPolicy(input, true);
    // The object API has the same wire-size bound, excluding internal logical fields.
    const wire = {
        ...policy,
        filesystem: {
            ...policy.filesystem,
            denyRead: policy.filesystem.denyRead.map(({ path: rulePath, scope }) => ({ path: rulePath, scope })),
            allowWrite: policy.filesystem.allowWrite.map(({ path: rulePath, scope }) => ({ path: rulePath, scope })),
            denyWrite: policy.filesystem.denyWrite.map(({ path: rulePath, scope }) => ({ path: rulePath, scope })),
        },
    };
    if (Buffer.byteLength(JSON.stringify(wire), "utf8") > MAX_POLICY_BYTES)
        invalid(`policy exceeds ${MAX_POLICY_BYTES} bytes`);
    const denyRead = normalizeRules(policy.filesystem.denyRead, "denyRead");
    const allowWrite = normalizeRules(policy.filesystem.allowWrite, "allowWrite");
    const denyWrite = normalizeRules(policy.filesystem.denyWrite, "denyWrite");
    const denials = [...denyRead, ...denyWrite];
    for (const allow of allowWrite) {
        for (const deny of denials) {
            if (covers(deny, allow.path) || covers(deny, logical(allow), true))
                invalid(`allowWrite ${JSON.stringify(logical(allow))} is contained in denied path ${JSON.stringify(logical(deny))}; deny exceptions are unsupported`);
        }
    }
    for (const rule of [...denials, ...allowWrite])
        rejectMutableSymlinks(rule, allowWrite);
    auditTrees([...allowWrite, ...denyRead]);
    return freezePolicy({ ...policy, filesystem: { ...policy.filesystem, denyRead, allowWrite, denyWrite } });
}
/** Protects trusted installation paths even when a broader writable ancestor is granted. */
export function addProtected(input, ...paths) {
    const policy = validatePolicy(input);
    const denyWrite = [...policy.filesystem.denyWrite];
    for (const candidate of paths) {
        validLiteral(candidate);
        const info = stat(candidate);
        const rule = normalizeRules([{ path: candidate, scope: info.isDirectory() ? "tree" : "file" }], "protected")[0];
        if (rule === undefined)
            invalid("missing protected rule");
        // Do not let canonical deduplication hide a writable alias to a trusted file.
        rejectMutableSymlinks(rule, policy.filesystem.allowWrite);
        for (const deny of policy.filesystem.denyRead) {
            if (covers(deny, rule.path) || covers(deny, logical(rule), true) || (rule.scope === "tree" && (covers(rule, deny.path) || covers(rule, logical(deny), true))))
                invalid(`protected path ${JSON.stringify(candidate)} overlaps denyRead ${JSON.stringify(logical(deny))}`);
        }
        if (!denyWrite.some((deny) => covers(deny, rule.path)))
            denyWrite.push(rule);
    }
    return validatePolicy({ ...policy, filesystem: { ...policy.filesystem, denyWrite } });
}
/** Must also be applied by the trusted launcher BEFORE it starts Node/Runner. */
export function safeEnvironment(input, environment, tempDir) {
    const policy = readPolicy(input, true);
    if (environment === null || typeof environment !== "object")
        invalid("host environment must be an object");
    const result = { PATH: SAFE_PATH };
    for (const name of policy.environment.inherit) {
        if (name === "PATH")
            continue;
        const descriptor = Object.getOwnPropertyDescriptor(environment, name);
        if (descriptor === undefined)
            continue;
        if (!("value" in descriptor))
            invalid(`environment variable ${name} must be a data property`);
        const raw = descriptor.value;
        if (raw === undefined || raw === "")
            continue;
        let value = string(raw, `environment.${name}`);
        if (Buffer.byteLength(value, "utf8") > 4096 || controlCharacters.test(value))
            invalid(`unsafe value for ${name}`);
        switch (name) {
            case "HOME":
                validLiteral(value);
                value = realpath(value, "HOME");
                if (!stat(value).isDirectory())
                    invalid("HOME must be an existing absolute directory");
                break;
            case "LANG":
            case "LC_ALL":
                if (!localeValue.test(value) || value.includes(".."))
                    invalid(`unsafe locale value for ${name}`);
                break;
            case "TZ":
                if (Buffer.byteLength(value, "utf8") > 128 || !timezoneValue.test(value))
                    invalid("TZ must be a timezone name");
                break;
            case "TERM":
                if (!terminalValue.test(value))
                    invalid("unsafe TERM value");
                break;
        }
        result[name] = value;
    }
    if (policy.filesystem.temp === "none") {
        if (tempDir !== "")
            invalid("temp directory supplied with filesystem.temp=none");
    }
    else {
        validLiteral(tempDir);
        const info = lstat(tempDir);
        if (!info.isDirectory() || (info.mode & 511n) !== 448n)
            invalid("private temp must be a real directory with mode 0700");
        const resolved = realpath(tempDir, "private temp");
        result.TMPDIR = resolved;
        result.TMP = resolved;
        result.TEMP = resolved;
    }
    return result;
}
//# sourceMappingURL=policy.js.map