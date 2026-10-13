/**
 * A canonical path string is not a filesystem identity: realpath on a
 * case-insensitive host may preserve the caller's spelling. Compare each
 * existing child ancestor's device/inode as well as literal containment.
 */
export declare function pathContains(parent: string, child: string): boolean;
export declare function pathsOverlap(a: string, b: string): boolean;
/** Protect a complete DSH source checkout or an enclosing npm dependency tree. */
export declare function dshInstallationRoot(packageDirectory: string): string;
