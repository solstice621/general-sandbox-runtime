import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addProtected, INVALID_POLICY, MAX_AUDIT_ENTRIES, MAX_POLICY_BYTES, parsePolicy, RuntimeError, safeEnvironment, SAFE_PATH, UNSUPPORTED_POLICY, validatePolicy, } from "../src/policy.js";
const validJSON = '{"version":1,"filesystem":{"read":"host","denyRead":[],"allowWrite":[],"denyWrite":[],"temp":"none"},"network":{"mode":"deny"},"ipc":{"hostUnixSockets":"deny"},"environment":{"inherit":["PATH","HOME","LANG","LC_ALL","TZ","TERM"]}}';
function base() { return parsePolicy(validJSON); }
function withRules(rules) {
    const policy = base();
    return { ...policy, filesystem: { ...policy.filesystem, ...rules } };
}
function temporary(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-policy-test-"));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function directory(parent, name) {
    const result = path.join(parent, name);
    fs.mkdirSync(result, { mode: 0o700 });
    return result;
}
function file(parent, name) {
    const result = path.join(parent, name);
    fs.writeFileSync(result, "secret\n", { mode: 0o600 });
    return result;
}
function code(action, wanted) {
    assert.throws(action, (error) => error instanceof RuntimeError && error.code === wanted);
}
test("strict JSON rejects ambiguous, malformed, extra and unpaired input", async (context) => {
    const inputs = {
        "duplicate root": validJSON.replace('"version":1', '"version":1,"version":1'),
        "escaped duplicate": validJSON.replace('"version":1', '"version":1,"vers\\u0069on":1'),
        "duplicate nested": validJSON.replace('"mode":"deny"', '"mode":"deny","mode":"host"'),
        "unknown": validJSON.replace('"version":1', '"version":1,"future":true'),
        "case alias": validJSON.replace('"version":1', '"Version":1'),
        "case duplicate": validJSON.replace('"version":1', '"version":1,"Version":1'),
        "prototype field": validJSON.replace('"version":1', '"version":1,"__proto__":{}'),
        "null object": validJSON.replace('{"hostUnixSockets":"deny"}', 'null'),
        "null list": validJSON.replace('"denyRead":[]', '"denyRead":null'),
        "null scalar": validJSON.replace('"version":1', '"version":null'),
        "null rule": validJSON.replace('"denyRead":[]', '"denyRead":[null]'),
        "fractional version": validJSON.replace('"version":1', '"version":1.0'),
        "exponent version": validJSON.replace('"version":1', '"version":1e0'),
        "overflow version": validJSON.replace('"version":1', '"version":18446744073709551616'),
        "string version": validJSON.replace('"version":1', '"version":"1"'),
        "leading zero": validJSON.replace('"version":1', '"version":01'),
        "missing required": validJSON.replace('"read":"host",', ''),
        "string array": validJSON.replace('"denyRead":[]', '"denyRead":"none"'),
        "wire logical": validJSON.replace('"denyRead":[]', '"denyRead":[{"path":"/","scope":"tree","logical":"/tmp"}]'),
        "trailing object": `${validJSON}{}`,
        "trailing scalar": `${validJSON}true`,
        "trailing junk": `${validJSON}#`,
        "trailing comma": validJSON.replace('"version":1,', '"version":1,,'),
        "root array": '[]',
        "raw high surrogate": `"\ud800"`,
        "raw low surrogate": `"\udfff"`,
        "escaped high surrogate": validJSON.replace('"denyRead":[]', '"denyRead":[{"path":"/\\ud800","scope":"file"}]'),
        "escaped low surrogate": validJSON.replace('"denyRead":[]', '"denyRead":[{"path":"/\\udfff","scope":"file"}]'),
        "high followed by nonlow": validJSON.replace('"denyRead":[]', '"denyRead":[{"path":"/\\ud800\\u0041","scope":"file"}]'),
        "invalid UTF-8": new Uint8Array([0xff]),
        "UTF-8 BOM": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validJSON)]),
        "oversize whitespace": `${" ".repeat(MAX_POLICY_BYTES)}${validJSON}`,
        "too deep": `${"[".repeat(14)}${"]".repeat(14)}`,
    };
    for (const [name, input] of Object.entries(inputs)) {
        await context.test(name, () => code(() => parsePolicy(input), INVALID_POLICY));
    }
});
test("wire byte limit includes UTF-8 and whitespace exactly", () => {
    const padded = validJSON + " ".repeat(MAX_POLICY_BYTES - Buffer.byteLength(validJSON));
    assert.equal(parsePolicy(Buffer.from(padded)).version, 1);
    code(() => parsePolicy(`${padded} `), INVALID_POLICY);
    const wide = validJSON.replace('"PATH"', `"${"中".repeat(MAX_POLICY_BYTES / 2)}"`);
    assert.ok(wide.length < MAX_POLICY_BYTES);
    code(() => parsePolicy(wide), INVALID_POLICY);
});
test("omitted arrays become frozen arrays and round-trip as valid wire JSON", () => {
    const minimal = '{"version":1,"filesystem":{"read":"host","temp":"none"},"network":{"mode":"host"},"ipc":{"hostUnixSockets":"deny"},"environment":{}}';
    const policy = parsePolicy(minimal);
    assert.deepEqual(policy.filesystem.denyRead, []);
    assert.deepEqual(parsePolicy(JSON.stringify(policy)), policy);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.filesystem));
    assert.ok(Object.isFrozen(policy.filesystem.denyRead));
    assert.ok(Object.isFrozen(policy.environment.inherit));
});
test("direct object validation rejects getters, unknown fields, inheritance and sparse arrays", () => {
    let getterCalled = false;
    const getter = { ...base() };
    Object.defineProperty(getter, "filesystem", { get() { getterCalled = true; throw new Error("must not run"); } });
    code(() => validatePolicy(getter), INVALID_POLICY);
    assert.equal(getterCalled, false);
    code(() => validatePolicy({ ...base(), extra: true }), INVALID_POLICY);
    code(() => validatePolicy(Object.create(base())), INVALID_POLICY);
    const sparse = [];
    sparse.length = 2;
    code(() => validatePolicy(withRules({ allowWrite: sparse })), INVALID_POLICY);
    const accessor = [];
    Object.defineProperty(accessor, "0", { get() { getterCalled = true; throw new Error("must not run"); } });
    code(() => validatePolicy(withRules({ allowWrite: accessor })), INVALID_POLICY);
    assert.equal(getterCalled, false);
    const unknownArray = [];
    unknownArray.unexpected = 1;
    code(() => validatePolicy(withRules({ allowWrite: unknownArray })), INVALID_POLICY);
});
test("unsupported capability requests fail closed", () => {
    const policies = [
        { ...base(), version: 2 },
        withRules({ read: "workspace" }),
        withRules({ temp: "shared" }),
        { ...base(), network: { mode: "proxy" } },
        { ...base(), ipc: { hostUnixSockets: "host" } },
        ...["DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV", "DSH_SUBPROCESS_CONTROL"].map((name) => ({ ...base(), environment: { inherit: [name] } })),
    ];
    for (const policy of policies)
        code(() => validatePolicy(policy), UNSUPPORTED_POLICY);
});
test("canonical paths retain logical aliases without mutating input or leaking internal wire fields", (context) => {
    const root = temporary(context);
    const target = directory(root, "target");
    const alias = path.join(root, "alias");
    fs.symlinkSync(target, alias);
    const original = { path: alias, scope: "tree" };
    const input = withRules({ allowWrite: [original] });
    const policy = validatePolicy(input);
    const actual = policy.filesystem.allowWrite[0];
    assert.equal(actual?.path, fs.realpathSync.native(target));
    assert.equal(actual?.logical, alias);
    assert.deepEqual(original, { path: alias, scope: "tree" });
    assert.ok(Object.isFrozen(actual));
    assert.equal(Object.getOwnPropertyDescriptor(actual, "logical")?.enumerable, false);
    assert.equal(JSON.stringify(policy).includes('"logical"'), false);
    assert.equal(validatePolicy(policy).filesystem.allowWrite[0]?.logical, alias);
    const next = directory(root, "next");
    fs.unlinkSync(alias);
    fs.symlinkSync(next, alias);
    code(() => validatePolicy(policy), INVALID_POLICY);
});
test("paths require existing correctly typed literal objects", (context) => {
    const root = temporary(context);
    const regular = file(root, "file");
    const rules = [
        { path: "relative", scope: "file" }, { path: "~/private", scope: "tree" },
        { path: path.join(root, "missing"), scope: "file" }, { path: path.join(root, "*"), scope: "file" },
        { path: `${regular}\n`, scope: "file" }, { path: `${regular}\0`, scope: "file" },
        { path: regular, scope: "tree" }, { path: root, scope: "file" },
        { path: root, scope: "recursive" },
    ];
    for (const rule of rules)
        code(() => validatePolicy(withRules({ denyWrite: [rule] })), INVALID_POLICY);
    const quoted = file(root, 'quote";$(false)');
    assert.equal(validatePolicy(withRules({ denyWrite: [{ path: quoted, scope: "file" }] })).filesystem.denyWrite.length, 1);
    const unicode = file(root, "unicode-😀");
    const json = JSON.stringify(withRules({ denyWrite: [{ path: unicode, scope: "file" }] })).replace("😀", "\\ud83d\\ude00");
    assert.equal(parsePolicy(json).filesystem.denyWrite.length, 1);
});
test("denial precedence respects filesystem identity and component boundaries", (context) => {
    const root = temporary(context);
    const workspace = directory(root, "work");
    const control = directory(workspace, "control");
    const neighbor = directory(root, "workspace");
    assert.equal(validatePolicy(withRules({ allowWrite: [{ path: workspace, scope: "tree" }], denyWrite: [{ path: control, scope: "tree" }] })).filesystem.denyWrite.length, 1);
    for (const denial of ["denyRead", "denyWrite"]) {
        code(() => validatePolicy(withRules({ allowWrite: [{ path: control, scope: "tree" }], [denial]: [{ path: workspace, scope: "tree" }] })), INVALID_POLICY);
    }
    assert.equal(validatePolicy(withRules({ allowWrite: [{ path: neighbor, scope: "tree" }], denyWrite: [{ path: workspace, scope: "tree" }] })).filesystem.allowWrite.length, 1);
});
test("mutable symlink chains including hidden target hops are rejected", (context) => {
    const root = temporary(context);
    const workspace = directory(root, "workspace");
    const outside = directory(root, "outside");
    const secret = file(outside, "secret");
    const inner = path.join(workspace, "inner");
    const outer = path.join(root, "outer");
    fs.symlinkSync(outside, inner);
    fs.symlinkSync(inner, outer);
    for (const candidate of [inner, outer]) {
        code(() => validatePolicy(withRules({ allowWrite: [{ path: workspace, scope: "tree" }], denyRead: [{ path: candidate, scope: "tree" }] })), UNSUPPORTED_POLICY);
    }
    assert.equal(validatePolicy(withRules({ allowWrite: [{ path: workspace, scope: "tree" }], denyRead: [{ path: secret, scope: "file" }] })).filesystem.denyRead.length, 1);
});
test("case-insensitive aliases cannot bypass denial, duplicate or mutable-link checks", (context) => {
    const root = temporary(context);
    const workspace = directory(root, "MixedCaseWorkspace");
    const alias = path.join(root, "mixedcaseworkspace");
    if (!fs.existsSync(alias)) {
        context.skip("requires a case-insensitive filesystem");
        return;
    }
    const outside = directory(root, "outside");
    fs.symlinkSync(outside, path.join(workspace, "link"));
    code(() => validatePolicy(withRules({ allowWrite: [{ path: workspace, scope: "tree" }], denyRead: [{ path: path.join(alias, "link"), scope: "tree" }] })), UNSUPPORTED_POLICY);
    code(() => validatePolicy(withRules({ allowWrite: [{ path: alias, scope: "tree" }], denyWrite: [{ path: workspace, scope: "tree" }] })), INVALID_POLICY);
    code(() => validatePolicy(withRules({ denyWrite: [{ path: alias, scope: "tree" }, { path: workspace, scope: "tree" }] })), INVALID_POLICY);
});
test("dot components are rejected before symlink traversal can change their meaning", (context) => {
    const root = temporary(context);
    const outside = directory(root, "outside");
    const nested = directory(outside, "nested");
    file(root, "secret");
    file(outside, "secret");
    const alias = path.join(root, "alias");
    fs.symlinkSync(nested, alias);
    code(() => validatePolicy(withRules({ denyRead: [{ path: `${alias}/../secret`, scope: "file" }] })), INVALID_POLICY);
});
test("preexisting hardlinks fail closed for file rules, writable trees and denyRead trees", (context) => {
    const root = temporary(context);
    const workspace = directory(root, "workspace");
    const privateDirectory = directory(root, "private");
    const secret = file(privateDirectory, "secret");
    fs.linkSync(secret, path.join(workspace, "alias"));
    const policies = [
        withRules({ denyRead: [{ path: secret, scope: "file" }] }),
        withRules({ allowWrite: [{ path: workspace, scope: "tree" }] }),
        withRules({ denyRead: [{ path: privateDirectory, scope: "tree" }] }),
    ];
    for (const policy of policies)
        code(() => validatePolicy(policy), UNSUPPORTED_POLICY);
});
test("tree audit fails closed on unreadable traversal and closes open directory handles", (context) => {
    const root = temporary(context);
    const originalOpen = fs.opendirSync;
    let closed = false;
    context.mock.method(fs, "opendirSync", (candidate, options) => {
        if (String(candidate) === fs.realpathSync.native(root)) {
            return { readSync() { throw new Error("injected readdir failure"); }, closeSync() { closed = true; } };
        }
        return Reflect.apply(originalOpen, fs, [candidate, options]);
    });
    code(() => validatePolicy(withRules({ allowWrite: [{ path: root, scope: "tree" }] })), UNSUPPORTED_POLICY);
    assert.equal(closed, true);
});
test("streaming audit stops at its bound without materializing a giant directory", (context) => {
    const root = temporary(context);
    const canonical = fs.realpathSync.native(root);
    const sample = file(root, "sample");
    const sampleInfo = fs.statSync(sample, { bigint: true });
    const originalLstat = fs.lstatSync;
    const originalOpen = fs.opendirSync;
    let reads = 0;
    let closed = false;
    context.mock.method(fs, "lstatSync", (candidate, options) => {
        if (String(candidate).startsWith(`${canonical}/synthetic-`))
            return sampleInfo;
        return Reflect.apply(originalLstat, fs, [candidate, options]);
    });
    context.mock.method(fs, "opendirSync", (candidate, options) => {
        if (String(candidate) === canonical) {
            return { readSync() { return { name: Buffer.from(`synthetic-${++reads}`) }; }, closeSync() { closed = true; } };
        }
        return Reflect.apply(originalOpen, fs, [candidate, options]);
    });
    code(() => validatePolicy(withRules({ allowWrite: [{ path: root, scope: "tree" }] })), UNSUPPORTED_POLICY);
    assert.equal(reads, MAX_AUDIT_ENTRIES);
    assert.equal(closed, true);
});
test("invalid UTF-8 directory names are never silently audited as another file", (context) => {
    const root = temporary(context);
    file(root, "�");
    const canonical = fs.realpathSync.native(root);
    const originalOpen = fs.opendirSync;
    let first = true;
    // APFS rejects invalid UTF-8 filenames. Supply the raw directory response so
    // this security regression also runs on hosts that cannot create such names.
    context.mock.method(fs, "opendirSync", (candidate, options) => {
        if (String(candidate) === canonical) {
            return { readSync() { if (first) {
                    first = false;
                    return { name: Buffer.from([0xff]) };
                } return null; }, closeSync() { } };
        }
        return Reflect.apply(originalOpen, fs, [candidate, options]);
    });
    code(() => validatePolicy(withRules({ allowWrite: [{ path: root, scope: "tree" }] })), UNSUPPORTED_POLICY);
});
test("trusted protection remains additive, immutable and idempotent under writable ancestors", (context) => {
    const root = temporary(context);
    const runner = file(root, "runner");
    const source = withRules({ allowWrite: [{ path: root, scope: "tree" }] });
    const protectedPolicy = addProtected(source, runner, runner);
    assert.equal(protectedPolicy.filesystem.denyWrite.length, 1);
    assert.equal(source.filesystem.denyWrite.length, 0);
    assert.deepEqual(addProtected(protectedPolicy, runner), protectedPolicy);
    code(() => addProtected(withRules({ denyRead: [{ path: runner, scope: "file" }] }), runner), INVALID_POLICY);
});
test("repeated protection preserves deep original aliases and checks skipped aliases", (context) => {
    const root = temporary(context);
    const workspace = directory(root, "workspace");
    const deep = directory(workspace, "deep");
    const runner = file(deep, "runner");
    const helper = file(deep, "helper");
    const alias = path.join(root, "stable-alias");
    fs.symlinkSync(workspace, alias);
    const logicalRunner = path.join(alias, "deep", "runner");
    let policy = addProtected(withRules({ allowWrite: [{ path: workspace, scope: "tree" }] }), logicalRunner);
    for (let i = 0; i < 4; i++) {
        policy = addProtected(validatePolicy(policy), logicalRunner, runner, helper);
        assert.equal(policy.filesystem.denyWrite.length, 2);
        assert.equal(policy.filesystem.denyWrite[0]?.logical, logicalRunner);
        assert.equal(policy.filesystem.denyWrite[0]?.path, fs.realpathSync.native(runner));
    }
    const trusted = directory(root, "trusted");
    const protectedRunner = file(trusted, "runner");
    const mutableAlias = path.join(workspace, "runner-link");
    fs.symlinkSync(protectedRunner, mutableAlias);
    code(() => addProtected(withRules({ allowWrite: [{ path: workspace, scope: "tree" }], denyWrite: [{ path: trusted, scope: "tree" }] }), mutableAlias), UNSUPPORTED_POLICY);
});
test("environment selection strips injections, pins PATH and supplies only the private temp", (context) => {
    const root = temporary(context);
    const home = directory(root, "home");
    const temp = directory(root, "temp");
    const host = {
        PATH: "/evil/bin:.", HOME: home, LANG: "C.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "Asia/Shanghai", TERM: "xterm-256color",
        LD_PRELOAD: "/evil.so", DYLD_INSERT_LIBRARIES: "/evil.dylib", BASH_ENV: "/evil.sh", ENV: "/evil.sh", NODE_OPTIONS: "--require=/evil.js",
        PYTHONPATH: "/evil", PERL5OPT: "-Mbad", RUBYOPT: "-rbad", GIT_CONFIG_COUNT: "1", TMPDIR: "/shared", DSH_SUBPROCESS_CONTROL: "pipe",
    };
    const actual = safeEnvironment(withRules({ temp: "private" }), host, temp);
    const canonicalTemp = fs.realpathSync.native(temp);
    assert.deepEqual(actual, {
        PATH: SAFE_PATH, HOME: fs.realpathSync.native(home), LANG: "C.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "Asia/Shanghai", TERM: "xterm-256color",
        TMPDIR: canonicalTemp, TMP: canonicalTemp, TEMP: canonicalTemp,
    });
    assert.equal(host.PATH, "/evil/bin:.");
    assert.deepEqual(safeEnvironment({ ...base(), environment: { inherit: [] } }, host, ""), { PATH: SAFE_PATH });
});
test("unsafe environment values, getters and nonprivate temporary paths are rejected", (context) => {
    for (const host of [{ HOME: "relative" }, { HOME: "/a-missing-sandbox-home" }, { LANG: "../../evil" }, { LC_ALL: "C\nEVIL=1" }, { TZ: ":/etc/passwd" }, { TZ: "Area/../etc" }, { TERM: "$(command)" }, { TERM: "a".repeat(65) }, { LANG: "\ud800" }]) {
        code(() => safeEnvironment(base(), host, ""), INVALID_POLICY);
    }
    let called = false;
    const host = {};
    Object.defineProperty(host, "LANG", { get() { called = true; return "C"; } });
    code(() => safeEnvironment(base(), host, ""), INVALID_POLICY);
    assert.equal(called, false);
    const root = temporary(context);
    const temp = directory(root, "temp");
    const policy = withRules({ temp: "private" });
    code(() => safeEnvironment(policy, {}, ""), INVALID_POLICY);
    fs.chmodSync(temp, 0o755);
    code(() => safeEnvironment(policy, {}, temp), INVALID_POLICY);
    fs.chmodSync(temp, 0o700);
    const alias = path.join(root, "temp-link");
    fs.symlinkSync(temp, alias);
    code(() => safeEnvironment(policy, {}, alias), INVALID_POLICY);
    code(() => safeEnvironment(base(), {}, temp), INVALID_POLICY);
});
//# sourceMappingURL=policy.test.js.map