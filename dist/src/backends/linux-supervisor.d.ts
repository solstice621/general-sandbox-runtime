/** Defense in depth after the host replaces every unapproved inherited target
 * with /dev/null. This removes non-CLOEXEC leftovers while retaining Node's own
 * event-loop descriptors. This filter alone is not an inheritance boundary:
 * Node startup can mark inherited descriptors CLOEXEC before this code runs. */
export declare function closeAmbientDescriptors(approved: ReadonlySet<number>): void;
export declare function supervise(configFd: number, controlFd: number): void;
