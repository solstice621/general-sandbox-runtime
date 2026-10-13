# Policy schema and runtime validation

`policy.schema.json` uses JSON Schema draft 2020-12. It describes the v1 wire
format: exact field names, object shapes, supported values, literal path syntax,
and the six permitted environment names. Every object rejects additional
properties. Rule arrays and `environment.inherit` may be omitted and then mean
empty lists; explicit `null` is invalid. The internal `Rule.logical` value never
appears in policy JSON.

Schema validation is useful for editors and configuration tooling. It does not
replace `parsePolicy`, `check`, or the fresh validation performed by `run`.

The parser applies checks that JSON Schema cannot express over an already
decoded document: a maximum of 65,536 UTF-8 bytes including whitespace, exactly
one document, unique object keys at every depth, valid Unicode surrogate pairs,
and the literal integer token `1` for `version`. JSON Schema treats `1.0` and
`1e0` as numerically equal to `1`; the parser deliberately rejects those tokens.
The schema's per-path maximum length is only a necessary upper bound, not a
replacement for the whole-document byte limit.

Runtime filesystem validation is mandatory:

- Every declared path must exist, and its `file` or `tree` scope must match its
  object type. A missing protection path fails closed.
- Validation preserves the original logical spelling and separately records the
  resolved path. Revalidation checks their relationship again. Symlink chains
  are inspected hop by hop; a chain containing a link replaceable through an
  allowed directory is rejected.
- Filesystem identities supplement lexical comparisons, including on
  case-insensitive filesystems. Equivalent duplicate rules and write grants at
  or beneath a denial are rejected. A write grant above a more specific denial
  remains valid; the denial takes precedence.
- Regular files with preexisting hardlinks are rejected in explicit file rules,
  writable trees, and read-denied trees. The recursive audit is limited to
  100,000 entries per validation; incomplete, unreadable, or oversized audits
  produce `UNSUPPORTED_POLICY` rather than granting access after a partial scan.
- `addProtected` adds write denials for the Runner and trusted helpers and
  rejects overlap with read-denied regions. It audits a requested alias even
  when an existing broader denial already protects the resolved target.

The TypeScript object API validates plain data objects without invoking getters,
rejects unknown properties and sparse arrays, and uses the same document-size
bound. `validatePolicy` and `addProtected` return independent, deeply frozen
snapshots. Original logical paths remain non-enumerable properties on normalized
rules, so `JSON.stringify(policy)` emits the supported wire format. Filesystem
device/inode identities and link counts use `bigint`, avoiding JavaScript number
rounding. Directory audits stream entries with raw byte names and fail closed on
invalid UTF-8; they do not materialize unbounded directory listings.

The OS backend must still pin relevant paths, prevent ancestor replacement and
new hardlink bypasses, and enforce the requested filesystem, network, and IPC
boundary. Preflight validation is not protection against concurrent hostile
host-side filesystem changes. A prior successful `check` does not authorize a
later `run` without fresh checks.

Environment values are validated at startup, after their allowed names have
been selected. `HOME` must resolve to an existing absolute directory; locale,
timezone, and terminal values use narrow value checks. `PATH` is always
`/usr/bin:/bin:/usr/sbin:/sbin`. Loader, shell, and interpreter injection variables
are omitted. For private temp mode, the Runner supplies an existing real
directory with mode `0700`, and the target receives its path through `TMPDIR`,
`TMP`, and `TEMP`. The trusted caller must also start the Runner with a safe
environment because cleanup after `main` cannot undo loader injection.
The environment API accepts `NodeJS.ProcessEnv`, which already has one value per
name. It cannot recover duplicate entries from an earlier raw OS environment;
the trusted launcher owns that input normalization.
